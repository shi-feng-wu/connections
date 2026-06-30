import { Common, DiscordSDK } from "@discord/embedded-app-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardSnapshot } from "./board";
import {
  createTicket,
  listChat,
  loadAdminThread,
  loadInbox,
  openTicket,
  replyTicket,
  resetTodayProgress,
  sendAdminReply,
  type ChatApi,
  type ChatBundle,
} from "./chat";
import { primeTicketCache } from "./chatview";
import { DayTurnover, GameView, LoadingScreen } from "./components";
import { msUntilNextEtMidnight } from "./countdown";
import { Game, MAX_MISTAKES, type Puzzle } from "./game";
import { Landing } from "./landing";
import {
  currentSeasonStart,
  roomBoard,
  roomSelf,
  submitScore,
} from "./leaderboard";
import { PipThumbnail } from "./pip";
import type { PlayerState, RosterDelta } from "./player";
import { presenceSignature, setPresence, type PresenceInput } from "./presence";
import { RoomLive, type TilesMsg } from "./roomlive";
import type { RosterScope } from "./roster";
import { canonicalScope } from "./scope";
import type { Standings } from "./season";

const EMPTY_STANDINGS: Standings = { board: [], self: null };

// Merge one live delta (api/_realtime.ts, relayed over SSE) into the roster: patch the matching
// row, or insert a new player (a `join` carries identity). Delta payloads only include fields that
// changed, and JSON drops absent ones, so spreading the delta never clobbers a known value with
// an undefined. `channelId` rides onto the row harmlessly (it's not a PlayerState field the UI
// reads). The green ring isn't set here — it comes from Discord's participant list (the `roster`
// memo reads `participantIds`).
function mergeDelta(roster: PlayerState[], d: RosterDelta): PlayerState[] {
  const i = roster.findIndex((p) => p.userId === d.userId);
  if (i >= 0) {
    const next = roster.slice();
    next[i] = { ...next[i], ...d };
    return next;
  }
  return [
    ...roster,
    {
      name: "Player",
      mistakesLeft: MAX_MISTAKES,
      solvedCount: 0,
      solvedLevels: [],
      picking: false,
      done: null,
      startedAt: Date.now(),
      finishedAt: null,
      online: true,
      // ...d supplies userId (required) and overrides any field it carries.
      ...d,
    },
  ];
}

// Persist the Channel/Server toggle across launches. localStorage is per-origin (the
// activity's discordsays.com proxy), so the choice survives reopening the Activity. Wrapped
// because storage can throw in a partitioned/blocked iframe — there we just don't persist.
const SCOPE_KEY = "connections:scopeMode";
function readScopeMode(): RosterScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "server" ? "server" : "channel";
  } catch {
    return "channel";
  }
}
function writeScopeMode(mode: RosterScope): void {
  try {
    localStorage.setItem(SCOPE_KEY, mode);
  } catch {
    /* storage blocked — fine, just won't persist this session */
  }
}

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

// Guild-install ("Add to Server") link for the end-screen recap prompt — same scopes +
// permissions as the /enable-posts button. KEEP IN SYNC with api/interactions.ts
// installUrl() and scripts/configure-install.mjs. s
const INSTALL_PERMISSIONS = "117760";
function installUrl(): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}` +
    `&integration_type=0&scope=bot+applications.commands&permissions=${INSTALL_PERMISSIONS}`
  );
}

// Last-known "does this server have the bot" per guild, so the loading tip can target
// bot-less servers from the very first frame of a repeat launch — /api/join (the live
// answer) lands seconds later. Wrapped like the other storage helpers: a blocked iframe
// just means no cache, and the prompts wait for the live value.
const BOT_KEY = "conn-bot-installed:";
function readBotInstalled(guildId: string): boolean | null {
  try {
    const v = localStorage.getItem(BOT_KEY + guildId);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function writeBotInstalled(guildId: string, installed: boolean): void {
  try {
    localStorage.setItem(BOT_KEY + guildId, installed ? "1" : "0");
  } catch {
    /* storage blocked — fine, just won't pre-target the next launch's tip */
  }
}

// Today's ET calendar date (YYYY-MM-DD), matching the server's todayET so the client can
// detect the midnight-ET daily reset and reload the new day's puzzle.
function etDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// The cold-start loader wants the puzzle's number, but NYT ids aren't derivable from the
// date (they skip — e.g. Jun 6 → Jun 7 jumps by two), so the only source is a loaded
// puzzle. We stash the last daily {date, id} and read it back when it's still today's, so
// a reopen later the same day shows the number on the loader. The very first load of a new
// day has nothing cached yet → the pill is simply omitted until the puzzle lands.
const LAST_PUZZLE_KEY = "conn-last-daily";
function rememberPuzzle(date: string, id: number): void {
  try {
    localStorage.setItem(LAST_PUZZLE_KEY, JSON.stringify({ date, id }));
  } catch {
    /* storage blocked — fine, the loader just won't show a number this session */
  }
}
function cachedPuzzleNo(date: string): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_PUZZLE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { date?: string; id?: number };
    return v?.date === date && typeof v.id === "number" ? v.id : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// What /api/start hands back: the signed session, the pinned start time, the last
// write time, and the committed guess list to rehydrate the board from.
type StartInfo = {
  session: string | null;
  startedAt: number;
  updatedAt: number;
  guesses: string[][];
};

// Groups the player actually deduced, excluding the back-fill a loss adds to
// `solved`. Matches what the Board broadcasts during play, so a rehydrated finished
// loss doesn't report four solved in the roster.
function deducedLevels(g: Game): number[] {
  return g.deducedLevels; // shared with the server-side roster replay (/api/roster)
}

// Loss back-fill levels (solved minus deduced). Seeds the Board's revealed-on-loss
// bars when rehydrating a finished loss, so they render dimmed rather than as solves.
function revealedLevelsOf(g: Game): number[] {
  if (g.status !== "lost") return [];
  const deduced = new Set(deducedLevels(g));
  return g.solved.map((s) => s.level).filter((l) => !deduced.has(l));
}

// Outside Discord: standalone with a guest identity and a room from `?room=`
// (lets two browser tabs share live progress for testing).
export function App({
  isEmbedded,
  initialRoom,
}: {
  isEmbedded: boolean;
  initialRoom: string;
}) {
  // Game model lives in a ref and the Board owns its own render loop; App only
  // re-renders for network values (players, self) and lifecycle (phase, gameKey).
  const gameRef = useRef<Game | null>(null);
  const meRef = useRef<{ id: string; name: string; avatar?: string }>({
    id: "guest-" + Math.random().toString(36).slice(2, 8),
    name: "Guest " + Math.floor(Math.random() * 1000),
  });
  const roomRef = useRef(initialRoom);
  // Raw guild/channel ids, sent verbatim to /api/score which verifies guild
  // membership before writing. Client can't pick which server's board it lands on.
  const guildIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);
  // Season leaderboard owner, canonical g:/c: form (guild, else channel in a DM/
  // group chat). Null standalone. Must match the scope /api/score derives.
  const scopeRef = useRef<string | null>(null);
  // Only the daily counts toward the leaderboard. Enforced server-side too.
  const isDailyRef = useRef(true);
  // Access token proves identity to /api/score & /api/join (they need
  // live Discord data); the signed auth ticket from /api/token gates the cheap
  // reads (/api/puzzle, /api/start) without a Discord round-trip each call. Signed
  // session from /api/start anchors solve timing server-side.
  const accessTokenRef = useRef<string | null>(null);
  const authTicketRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const didInit = useRef(false);
  const loadSeq = useRef(0);
  // Serial chain for background guess commits (see commitGuess): each commit runs
  // after the previous settles, so the server records them in submission order and
  // two in-flight POSTs can't double-append the same guess.
  const commitChain = useRef<Promise<unknown>>(Promise.resolve());
  // Discord SDK handle, set once the embedded handshake succeeds (null standalone),
  // so post-load code can drive Rich Presence. lastPresenceSig dedupes setActivity
  // calls — see pushPresence.
  const sdkRef = useRef<DiscordSDK | null>(null);
  const lastPresenceSig = useRef<string>("");
  // When this player opened the Activity (this launch). Anchors the Rich Presence
  // elapsed timer so it counts from joining, not the game's pinned started_at
  // (first-ever open, used for scoring) — which on a reopen is hours stale.
  const joinedAtRef = useRef<number>(Date.now());

  // The room's roster from /api/roster (polled every 15s): everyone who played this room's daily
  // today, replayed from committed guesses, each carrying the green "online" ring when their
  // heartbeat is live. Your own row is overlaid from local state (see the `roster` memo) so it
  // never lags the poll. Empty for non-guild / non-daily contexts, where the roster is just you.
  const [serverRoster, setServerRoster] = useState<PlayerState[]>([]);
  const [self, setSelf] = useState<PlayerState | null>(null);
  // Realtime (src/roomlive.ts) is the fast path: progress/join broadcasts merge into
  // serverRoster the instant a guess lands. serverRosterRef mirrors serverRoster so a broadcast
  // handler can tell a known player from a new one without a stale closure. Live updates are
  // purely additive over the cold-start read; if the socket drops, the next read reconciles.
  const serverRosterRef = useRef<PlayerState[]>([]);
  const roomLiveRef = useRef<RoomLive | null>(null);
  // Green "online" ring = whoever Discord reports is in this Activity instance right now (the
  // bottom-left participant tray), pushed via the SDK. Anyone in this set gets a ring; everyone
  // else (finishers/abandoners who've left) doesn't. You're in it yourself, so your own ring
  // falls out naturally.
  const [participantIds, setParticipantIds] = useState<Set<string>>(new Set());
  // Live tile selection per player (Wordle-style "picking"), from the WS broadcast. Merged into
  // the roster memo; cleared to [] when a player deselects or submits.
  const [pickingByUser, setPickingByUser] = useState<Record<string, string[]>>(
    {},
  );
  // Pickers we've already pulled a fresh roster read for (their join broadcast was missed), so a
  // burst of their tile messages triggers exactly one refetch, not one per message.
  const tileFetchRequested = useRef<Set<string>>(new Set());
  // Serialize roster reads. Many triggers (cold start, reconnect, foreground, scope toggle, an
  // unknown-player delta) can fire fetchServerRoster at once; each ends in a full setServerRoster
  // replace, so overlapping reads can resolve out of order and clobber freshly-merged live rows.
  // One read at a time, with a single trailing re-read if more were requested mid-flight.
  const rosterFetching = useRef(false);
  const rosterRefetchQueued = useRef(false);
  // End-screen room leaderboard, two windows; fetched after a finish posts and on load.
  const [season, setSeason] = useState<Standings>(EMPTY_STANDINGS);
  const [allTime, setAllTime] = useState<Standings>(EMPTY_STANDINGS);
  // Shared Channel/Server toggle for the roster + leaderboard. Defaults to the channel the
  // player launched in (matches the per-channel card/recap); switching widens to the guild.
  // The ref mirrors it so the 30s poll's captured closures read the current mode, not a stale one.
  const [scopeMode, setScopeMode] = useState<RosterScope>(readScopeMode);
  const scopeModeRef = useRef<RosterScope>(scopeMode);
  const [gameKey, setGameKey] = useState("0");
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "blocked">(
    "loading",
  );
  // Dev-only: in a plain browser (not embedded in Discord) we still want the embedded-only chat/
  // inbox usable for local testing. mockEmbedded ungates JUST that surface and pairs with the stub
  // identity set at boot; the live roster/presence stay Discord-only. The backend (/api/chat) takes
  // the stub via isLocalDev(), so threads read/write against the local Supabase.
  const mockEmbedded = !isEmbedded && import.meta.env.DEV;
  // Whether this guild has the bot (guild install): the live answer from /api/join,
  // seeded from the per-guild localStorage cache at handshake so a repeat launch
  // targets the loading tip immediately. null = unknown / not a guild → show nothing.
  const [botInstalled, setBotInstalled] = useState<boolean | null>(null);
  // Player↔dev chat badge state, loaded after the handshake: whether a reply is waiting (the
  // dot on the Feedback entry) and whether this player is a dev (surfaces the admin Inbox).
  const [chatUnread, setChatUnread] = useState(false);
  const [chatIsDev, setChatIsDev] = useState(false);
  // Midnight day-rollover veil (src/components.tsx DayTurnover): `resetting` drives the
  // overlay; the ref guards swapToNewDay so the precise timer and the 30s poll can't both
  // fire a swap; newDayDate is the date we're rolling into, shown on the veil; newDayNo is
  // the new puzzle's number, resolved once it loads mid-veil (before the reveal).
  const [resetting, setResetting] = useState(false);
  const resettingRef = useRef(false);
  const [newDayDate, setNewDayDate] = useState<string | undefined>(undefined);
  const [newDayNo, setNewDayNo] = useState<number | undefined>(undefined);
  // Discord activity layout: FOCUSED (0) normally, PIP (1) when collapsed. Drives the
  // compact thumbnail swap.
  const [layoutMode, setLayoutMode] = useState<number>(
    Common.LayoutModeTypeObject.FOCUSED,
  );
  // Ref mirror so the roster poll's interval closure reads the current layout, not the
  // one captured at mount (synced by the layout effect next to the poll below).
  const layoutModeRef = useRef<number>(Common.LayoutModeTypeObject.FOCUSED);

  function selfState(): PlayerState {
    const g = gameRef.current;
    // Deduced-only (no loss back-fill), matching the Board's broadcast.
    const solved = g ? deducedLevels(g) : [];
    return {
      userId: meRef.current.id,
      name: meRef.current.name,
      avatar: meRef.current.avatar,
      mistakesLeft: g?.mistakesLeft ?? MAX_MISTAKES,
      solvedCount: solved.length,
      solvedLevels: solved,
      picking: false,
      done: g ? (g.status === "playing" ? null : g.status) : null,
      startedAt: g?.startedAt ?? Date.now(),
      finishedAt: g && g.durationMs != null ? g.startedAt + g.durationMs : null,
    };
  }

  // Board pushes its snapshot on each change; wrap with identity + timestamps and update the
  // local "self" row (which overlays the polled roster, so your own progress is instant) plus
  // Discord Rich Presence.
  function onPresence(snap: BoardSnapshot): void {
    const g = gameRef.current;
    if (!g) return;
    const player: PlayerState = {
      userId: meRef.current.id,
      name: meRef.current.name,
      avatar: meRef.current.avatar,
      mistakesLeft: snap.mistakesLeft,
      solvedCount: snap.solvedLevels.length,
      solvedLevels: snap.solvedLevels,
      picking: snap.picking,
      done: snap.done,
      startedAt: g.startedAt,
      finishedAt:
        snap.done && g.durationMs != null ? g.startedAt + g.durationMs : null,
    };
    setSelf(player);
    pushPresence();
    // Live tile selection to the room over the WS (client→client; see roomlive.sendTiles).
    if (isDailyRef.current) {
      roomLiveRef.current?.sendTiles({
        userId: meRef.current.id,
        channelId: channelIdRef.current,
        selected: snap.selected ?? [],
      });
    }
  }

  // Mirror the game onto the player's Discord profile (Rich Presence). Embedded
  // only — sdkRef is null standalone, so this no-ops in the browser. Signature-
  // gated so the board's per-tap snapshots can't spam Discord's rate-limited
  // setActivity: only a solve, a mistake, or the finish changes the card.
  function pushPresence(): void {
    const sdk = sdkRef.current;
    const g = gameRef.current;
    if (!sdk || !g) return;
    const input: PresenceInput = {
      // Deduced groups only (excludes the loss back-fill), matching the roster.
      solvedCount: deducedLevels(g).length,
      total: g.puzzle.groups.length,
      mistakesLeft: g.mistakesLeft,
      status: g.status,
      puzzleNo: g.puzzle.id,
      joinedAt: joinedAtRef.current,
      durationMs: g.durationMs,
    };
    const sig = presenceSignature(input);
    if (sig === lastPresenceSig.current) return;
    lastPresenceSig.current = sig;
    void setPresence(sdk, input);
  }

  // Both end-screen tabs: this season (month) and all-time (since = null), each
  // board rows + own standing. No-op without a room scope/Supabase.
  async function refreshLeaderboard(): Promise<void> {
    const scopeId = scopeRef.current;
    if (!scopeId) return;
    const me = meRef.current.id;
    const monthStart = currentSeasonStart();
    // Channel view narrows to this channel; server view (or no channel) spans the guild.
    // No guild → a DM/group is a single-channel scope with no Channel/Server toggle, so
    // never narrow (it's redundant and would drop legacy rows with a null channel_id).
    const chan =
      guildIdRef.current && scopeModeRef.current === "channel"
        ? channelIdRef.current
        : null;
    const [sBoard, sSelf, aBoard, aSelf] = await Promise.all([
      roomBoard(scopeId, monthStart, 50, chan),
      roomSelf(scopeId, monthStart, me, chan),
      roomBoard(scopeId, null, 50, chan),
      roomSelf(scopeId, null, me, chan),
    ]);
    setSeason({ board: sBoard, self: sSelf });
    setAllTime({ board: aBoard, self: aSelf });
  }

  // The cold-start read for the Live tab: everyone who played this room's daily today (finishers
  // + abandoners), replayed server-side from their committed guesses. NOT polled — it runs on
  // load, on reconnect/foreground, and a 5-min safety net; Realtime broadcasts carry the live
  // updates in between, and Discord's participant list drives the online ring. A room-scoped GET;
  // the signed ticket rides in `x-ct` (a custom header, not Authorization, so the edge gate in
  // middleware.ts can verify it without blocking caching). Best-effort: a failure keeps the last
  // roster.
  async function fetchServerRoster(): Promise<void> {
    const ticket = authTicketRef.current;
    if (!isDailyRef.current || !ticket || !scopeRef.current) return;
    // Coalesce: if a read is already running, request a single trailing re-read (so a scope change
    // mid-flight still lands) instead of racing a second concurrent replace.
    if (rosterFetching.current) {
      rosterRefetchQueued.current = true;
      return;
    }
    rosterFetching.current = true;
    try {
      const qs = new URLSearchParams();
      if (guildIdRef.current) qs.set("g", guildIdRef.current);
      if (channelIdRef.current) qs.set("c", channelIdRef.current);
      qs.set("view", scopeModeRef.current);
      const r = await fetch("/api/roster?" + qs.toString(), {
        headers: { "x-ct": ticket },
      });
      if (r.ok) {
        const d = (await r.json()) as { players?: PlayerState[] };
        if (Array.isArray(d.players)) setServerRoster(d.players);
      }
    } catch {
      /* keep the last roster */
    } finally {
      rosterFetching.current = false;
      if (rosterRefetchQueued.current) {
        rosterRefetchQueued.current = false;
        void fetchServerRoster();
      }
    }
  }

  // A live delta arrived (someone guessed or joined). Merge it into the roster instantly.
  // Channel view ignores deltas from other channels of the guild (the roster is narrowed). A
  // progress delta for a player we have no identity for yet (rare: their join never landed
  // here) can't be rendered, so fall back to one backstop fetch to pick up their row. Reads
  // refs only, so the value captured by the relay handler stays correct across renders.
  function applyDelta(d: RosterDelta): void {
    if (
      scopeModeRef.current === "channel" &&
      guildIdRef.current &&
      d.channelId &&
      channelIdRef.current &&
      d.channelId !== channelIdRef.current
    ) {
      return;
    }
    const known = serverRosterRef.current.some((p) => p.userId === d.userId);
    if (!known && typeof d.name !== "string") {
      void fetchServerRoster();
      return;
    }
    setServerRoster((prev) => mergeDelta(prev, d));
  }

  // A live tile-selection broadcast arrived — store it per player for the roster to render.
  function handleTiles(t: TilesMsg): void {
    const filteredOut =
      scopeModeRef.current === "channel" &&
      !!guildIdRef.current &&
      !!t.channelId &&
      !!channelIdRef.current &&
      t.channelId !== channelIdRef.current;
    if (filteredOut) return;
    // Pure cosmetic overlay: paint the selection onto the player's existing roster row.
    setPickingByUser((prev) => ({ ...prev, [t.userId]: t.selected }));
    // If we don't have this picker yet — their join landed before we subscribed and the cold-start
    // read missed them — pull the authoritative roster once (they really opened the room, so the
    // read includes their real row). We never synthesize a row from tile data.
    const known = serverRosterRef.current.some((p) => p.userId === t.userId);
    if (
      !known &&
      t.userId !== meRef.current.id &&
      !tileFetchRequested.current.has(t.userId)
    ) {
      tileFetchRequested.current.add(t.userId);
      void fetchServerRoster();
    }
  }

  function onFinish(): void {
    const g = gameRef.current;
    if (!g) return;
    // Final card (won/lost + solve time), independent of scoring — practice games
    // that don't submit still update the profile.
    pushPresence();
    // Server verifies identity, replays, and scores. Requires the daily, a signed
    // session, and a Discord token; guests and replays don't earn season rows.
    const session = sessionRef.current;
    const accessToken = accessTokenRef.current;
    if (!isDailyRef.current || !session || !accessToken) return;
    void (async () => {
      await submitScore({
        session,
        accessToken,
        guildId: guildIdRef.current,
        channelId: channelIdRef.current,
      });
      await refreshLeaderboard();
    })();
    // The room card's final grid is pushed server-side from /api/guess (the finishing guess is
    // counted, so it triggers a refresh that bypasses the throttle) — no client call needed.
  }

  // Commit a guess to the server's authoritative record BEFORE its result is shown
  // (see /api/guess). Returns whether the board may advance: true once the guess is
  // safely recorded, false on a network/persist failure so the Board asks the player
  // to retry rather than revealing — then abandoning — an uncommitted result.
  // Standalone (no auth ticket) and practice (non-daily) have nothing to track, so
  // they advance locally.
  // Record one guess to the player's authoritative daily record. The board reveals the
  // result optimistically (it's computed locally and matches the server's), so this
  // runs in the background instead of gating the reveal on the round-trip — that round-
  // trip is what made every guess feel laggy on a real network. Commits are chained so
  // they land in submission order, and use keepalive so an in-flight commit still
  // completes if the Activity is closed mid-reveal (preserving record-before-leave for
  // the common case). Resolves false only after retries are exhausted, so the board can
  // surface a quiet "couldn't save" note. Standalone/local (no ticket) is a no-op.
  function commitGuess(guess: string[]): Promise<boolean> {
    if (!isDailyRef.current || !authTicketRef.current)
      return Promise.resolve(true);
    const g = gameRef.current;
    if (!g) return Promise.resolve(true);
    const date = g.puzzle.date;
    const link = commitChain.current.then(() => sendGuess(date, guess));
    // keep the chain alive regardless of this link's outcome, but don't swallow the
    // result the caller awaits.
    commitChain.current = link.then(
      () => {},
      () => {},
    );
    return link;
  }

  async function sendGuess(
    date: string,
    guess: string[],
    attempt = 0,
  ): Promise<boolean> {
    try {
      const r = await fetch("/api/guess", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        // guildId/channelId let the server fan this guess out over Realtime to the room's
        // other players (api/_realtime.ts); they don't affect scoring (/api/score re-derives).
        body: JSON.stringify({
          date,
          guess,
          guildId: guildIdRef.current,
          channelId: channelIdRef.current,
        }),
      });
      if (r.ok) {
        const ok = ((await r.json()) as { ok?: boolean }).ok !== false;
        // The room card is refreshed server-side from /api/guess on the counted guess — no client
        // call needed (the server is the authoritative trigger, like the live roster).
        return ok;
      }
    } catch {
      /* network blip → fall through to retry */
    }
    // The reveal already happened; we just need the record to land eventually. A couple
    // of backed-off retries cover a transient blip, then we give up (the rare divergence
    // is the accepted cost of the optimistic reveal).
    if (attempt < 2) {
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      return sendGuess(date, guess, attempt + 1);
    }
    return false;
  }

  // (The room's live card is refreshed server-side from /api/guess on every counted guess — the
  // same authoritative event that drives the live roster — so there's no client-side refresh call.)

  // Signed auth ticket as a Bearer header for the gated reads. Empty when
  // standalone (DEV only), where those endpoints skip the check.
  function authHeaders(): Record<string, string> {
    const t = authTicketRef.current;
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  // Opens (or resumes) the day server-side: a signed session that times + binds the
  // score, the pinned start time, and the committed guess list to rebuild the board
  // from. Best-effort; without it a fresh in-memory game starts and won't score.
  async function startSession(date: string): Promise<StartInfo | null> {
    try {
      const r = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ date }),
      });
      if (!r.ok) return null;
      const d = (await r.json()) as Partial<StartInfo>;
      return {
        session: d.session ?? null,
        startedAt: typeof d.startedAt === "number" ? d.startedAt : Date.now(),
        updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Date.now(),
        guesses: Array.isArray(d.guesses) ? d.guesses : [],
      };
    } catch {
      return null;
    }
  }

  async function loadPuzzle(
    opts: { date?: string; random?: boolean } = {},
  ): Promise<void> {
    setPhase("loading");
    // New board → let the first Rich Presence push through (a different puzzle/status).
    lastPresenceSig.current = "";
    isDailyRef.current = !opts.random && !opts.date;
    // The room roster is daily-scoped; practice/by-date shows only you (no poll).
    if (!isDailyRef.current) setServerRoster([]);
    const qs = new URLSearchParams();
    if (opts.date) qs.set("date", opts.date);
    if (opts.random) qs.set("random", "1");
    try {
      const res = await fetch("/api/puzzle?" + qs.toString(), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(String(res.status));
      const puzzle = (await res.json()) as Puzzle;

      // Open/resume the day, then rebuild the game from the committed guesses so a
      // relaunch resumes the exact board (mistakes, solved groups) instead of
      // resetting. Only the daily is tracked; random/by-date practice starts clean.
      const start = isDailyRef.current ? await startSession(puzzle.date) : null;
      const game = Game.fromGuesses(
        puzzle,
        start?.guesses ?? [],
        start?.startedAt,
      );
      // Rehydrated finished game: stamp the duration the server scored (last guess
      // minus start) so the end-screen hero matches the locked score and stays
      // stable across reopens, instead of inflating with wall-clock since start.
      if (game.status !== "playing" && start) {
        game.durationMs = Math.max(1000, start.updatedAt - start.startedAt);
      }
      gameRef.current = game;
      sessionRef.current = start?.session ?? null;
      // Cache the daily's number so a reopen later today can show it on the loader.
      if (isDailyRef.current) rememberPuzzle(puzzle.date, puzzle.id);

      setSelf(selfState());
      setGameKey(`${puzzle.id}-${loadSeq.current++}`);
      setPhase("ready");
      pushPresence();
      void fetchServerRoster();
    } catch {
      setPhase("error");
    }
  }

  // Swap to the new day's puzzle at the midnight-ET rollover, veiled by the DayTurnover
  // overlay so the live board doesn't hard-cut. Both the precise timer and the 30s poll
  // call this; resettingRef makes it single-flight, and it no-ops unless the daily is loaded
  // and the ET date has actually moved past it. Choreography: fade the veil over the old
  // board, swap underneath, hold a beat so a cached (instant) load still reads as a
  // deliberate turnover, then drop the veil to reveal the fresh board.
  async function swapToNewDay(): Promise<void> {
    const g = gameRef.current;
    if (
      resettingRef.current ||
      !isDailyRef.current ||
      !g ||
      etDate() === g.puzzle.date
    ) {
      return;
    }
    resettingRef.current = true;
    setNewDayDate(etDate());
    setNewDayNo(undefined); // clear last turnover's number; the new one resolves post-load
    setResetting(true);
    await sleep(540); // let the veil fade fully opaque (500ms) over the old board first
    await loadPuzzle();
    // The new puzzle is now in hand (behind the still-opaque veil); surface its number so
    // the lockup shows the next day's No. before the veil lifts to reveal the board. Guard
    // on the loaded date so a failed swap (gameRef still on yesterday) can't show a number
    // that mismatches the new date — the pill just stays omitted instead.
    const loaded = gameRef.current;
    if (loaded && loaded.puzzle.date === etDate())
      setNewDayNo(loaded.puzzle.id);
    await sleep(620); // hold the "new puzzle" beat so a cached load still registers
    setResetting(false);
    resettingRef.current = false;
  }

  // Runs the Discord handshake and returns true once a verified access token is in
  // hand. A plain browser can't get here: `ready()` needs a real Discord parent and
  // `authorize()` needs Discord to mint the code. A false return (or a stuck
  // handshake, hence the timeout) gates the app behind the "Open in Discord" screen.
  async function setupDiscord(): Promise<boolean> {
    try {
      const sdk = new DiscordSDK(CLIENT_ID);
      sdkRef.current = sdk; // so pushPresence() can drive Rich Presence post-handshake
      // ready() never resolves outside Discord; cap the wait so a forged ?frame_id
      // lands on the blocked screen instead of hanging on "Loading…".
      await Promise.race([
        sdk.ready(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("discord-ready-timeout")), 8000),
        ),
      ]);
      // Same channel launch = same instance.
      roomRef.current = sdk.instanceId;
      // Season scope persists across launches (instanceId resets). Prefer the guild
      // (whole server shares one season); fall back to channel in a DM/group chat.
      // Raw ids go to /api/score (which authorizes); canonical g:/c: keys the reads.
      guildIdRef.current = sdk.guildId ?? null;
      channelIdRef.current = sdk.channelId ?? null;
      scopeRef.current = canonicalScope(sdk.guildId, sdk.channelId);
      // Seed install status from the last launch's answer so the loading tip (visible
      // before /api/join responds) is already targeted; the live value overwrites it below.
      if (sdk.guildId) setBotInstalled(readBotInstalled(sdk.guildId));

      // Collapsing the activity puts it into Discord's picture-in-picture layout.
      // Track that so the app can swap to a compact board thumbnail (see render)
      // instead of letting Discord shrink the full UI into the tiny window.
      void sdk
        .subscribe("ACTIVITY_LAYOUT_MODE_UPDATE", (data) => {
          setLayoutMode(data.layout_mode);
        })
        .catch(() => {
          /* non-fatal: the thumbnail just won't engage if the subscription fails */
        });

      // The green "online" ring: whoever Discord reports is in this Activity instance right now
      // (the participant tray), pushed live. Seed it with the current list. Non-fatal — a failure
      // just means no rings until the next update; the roster itself is unaffected.
      void sdk
        .subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", (data) => {
          setParticipantIds(new Set(data.participants.map((p) => p.id)));
        })
        .catch(() => {});
      void sdk.commands
        .getInstanceConnectedParticipants()
        .then((d) =>
          setParticipantIds(new Set(d.participants.map((p) => p.id))),
        )
        .catch(() => {});

      const { code } = await sdk.commands.authorize({
        client_id: CLIENT_ID,
        response_type: "code",
        state: "",
        // Keep `prompt: "none"`. The embedded SDK uses Discord's RPC OAuth2 flow, which
        // forbids a redirect_uri ("Redirect URI cannot be used in the RPC ... flow"),
        // while the full consent flow requires one ("Missing redirect_uri"). prompt:none
        // takes the short-circuit path that needs no redirect and returns a code when the
        // user has already granted these scopes (consent is collected by Discord at
        // activity-launch time).
        prompt: "none",
        // `guilds` lets /api/score confirm membership before writing a guild board;
        // `rpc.activities.write` lets the Activity set Rich Presence (the "Playing
        // Connections" profile card, see presence.ts). Discord collects consent for
        // these at launch, so prompt:none still returns a code; adding a scope just
        // re-prompts once at the next launch.
        scope: ["identify", "guilds", "rpc.activities.write"],
      });
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) return false;
      const { access_token, auth } = (await res.json()) as {
        access_token?: string;
        auth?: string;
      };
      if (!access_token || !auth) return false;
      // access_token: live identity for /api/score & /api/join. auth: the
      // signed ticket gating the cheap reads. The server resolves the real user
      // from the token, so the client can't claim to be someone else.
      accessTokenRef.current = access_token;
      authTicketRef.current = auth;

      // Display identity (the server still trusts only the token). Non-fatal: a
      // failure here shouldn't lock out an otherwise-authenticated player.
      try {
        const auth = await sdk.commands.authenticate({ access_token });
        if (auth?.user) {
          const u = auth.user;
          meRef.current = {
            id: u.id,
            name: u.global_name ?? u.username,
            // CDN avatar; `a_` (animated) hashes still return a static .png frame.
            // No hash: leave unset, roster shows the color+initial placeholder.
            avatar: u.avatar
              ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
              : undefined,
          };
        }
      } catch (e) {
        console.warn("Discord authenticate failed:", e);
      }

      // Add this player to the channel's "who's playing today" card (append-only; the
      // server edits the room's live card — the launcher's /connections message — via the
      // interaction token). Fire-and-forget: the card is a nicety and must never block play.
      // The response also carries botInstalled — whether this server has the bot — which
      // targets the install prompts (loading tip, end-screen recap pitch).
      const launchGuild = guildIdRef.current;
      void fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: access_token,
          guildId: launchGuild,
          channelId: channelIdRef.current,
        }),
      })
        .then(async (r) => {
          if (!r.ok || !launchGuild) return;
          const d = (await r.json()) as { botInstalled?: boolean | null };
          if (typeof d.botInstalled === "boolean") {
            setBotInstalled(d.botInstalled);
            writeBotInstalled(launchGuild, d.botInstalled);
          }
        })
        .catch(() => {
          /* no card this time */
        });

      return true;
    } catch (e) {
      console.warn("Discord auth failed:", e);
      return false;
    }
  }

  // Bootstrap once: require the Discord handshake, then load today's puzzle.
  // Guarded against the dev double-effect.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void (async () => {
      if (isEmbedded) {
        // Production gate: no playable app without a completed Discord handshake.
        if (!(await setupDiscord())) {
          setPhase("blocked");
          return;
        }
      } else if (mockEmbedded) {
        // DEV standalone: skip the Discord handshake and stub an identity so the chat/inbox works
        // in a plain browser. The backend accepts it via isLocalDev(); see mockEmbedded above.
        meRef.current = {
          id: "local-dev",
          name: "Local Dev",
          avatar: undefined,
        };
        accessTokenRef.current = "dev";
        authTicketRef.current = "dev";
      } else {
        // Opened outside Discord in a real build — nothing to play here.
        setPhase("blocked");
        return;
      }
      // Embedded + authenticated, or the DEV standalone fallback.
      await loadPuzzle();
      await refreshLeaderboard();
    })();
  }, []);

  // Toggling Channel/Server re-scopes both the roster and the leaderboard: sync the ref the
  // poll's closures read, then refetch both at the new scope. Self-gating fetches no-op until
  // the room refs are set, so the initial mount is harmless.
  useEffect(() => {
    scopeModeRef.current = scopeMode;
    writeScopeMode(scopeMode);
    if (!isEmbedded) return;
    void fetchServerRoster();
    void refreshLeaderboard();
  }, [scopeMode]);

  // Not a poll — a 5-minute safety net. Realtime broadcasts carry others' progress live and
  // Discord's participant list drives the ring, so the roster read only has to backstop a
  // silently-dropped broadcast (a missed join especially). Skipped while collapsed/hidden (the
  // expand + visibility effects catch up on return). Also the daily-reset fallback: a client
  // left open across midnight ET is pinned to the old day — the precise timer below swaps at the
  // exact reset, but a throttled tab can miss it, so re-check here too. Once the new puzzle is
  // out the old one is closed (an unfinished old board ends unscored; a post-midnight finish is
  // rejected by the session.date !== todayET() gate in api/score.ts).
  useEffect(() => {
    if (!isEmbedded) return;
    const id = setInterval(() => {
      const g = gameRef.current;
      if (isDailyRef.current && g && etDate() !== g.puzzle.date) {
        void swapToNewDay();
        return;
      }
      if (
        layoutModeRef.current === Common.LayoutModeTypeObject.PIP ||
        document.hidden
      )
        return;
      void fetchServerRoster();
    }, 300_000);
    return () => clearInterval(id);
  }, [isEmbedded]);

  // Sync the layout ref the poll reads, and catch the roster up the moment the player
  // expands out of PIP (the poll skipped while collapsed, so it may be a while stale).
  useEffect(() => {
    const wasPip = layoutModeRef.current === Common.LayoutModeTypeObject.PIP;
    layoutModeRef.current = layoutMode;
    if (
      isEmbedded &&
      wasPip &&
      layoutMode !== Common.LayoutModeTypeObject.PIP
    ) {
      // The Realtime socket may have died silently while collapsed — re-establish it, then
      // catch the roster up in case any deltas were missed during the gap.
      void roomLiveRef.current?.resync();
      void fetchServerRoster();
    }
  }, [layoutMode]);

  // Mirror the roster into a ref so the Realtime delta handler can tell a known player from a
  // new one without re-binding the channel subscription on every render.
  useEffect(() => {
    serverRosterRef.current = serverRoster;
  }, [serverRoster]);

  // Join the room's Realtime channel once the daily is ready and we have identity. Fast path:
  // progress/join broadcasts merge instantly and Presence drives the online ring, with the poll
  // above demoted to a 5-minute backstop (plus a reconcile on every reconnect). connect() is
  // idempotent; if Realtime is unavailable (no socket / no token) onLive(false) keeps us on the
  // poll — purely additive.
  useEffect(() => {
    if (phase !== "ready" || !isEmbedded || !isDailyRef.current) return;
    const scope = scopeRef.current;
    const ticket = authTicketRef.current;
    if (!scope || !ticket) return;
    let rl = roomLiveRef.current;
    if (!rl) {
      rl = new RoomLive();
      roomLiveRef.current = rl;
    }
    void rl.connect({
      scope,
      ticket,
      // On every reconnect, re-read the roster: the relay keeps no backlog, so deltas pushed while
      // the stream was down (a blip, or a relay redeploy) are only recoverable this way.
      handlers: {
        onDelta: applyDelta,
        onTiles: handleTiles,
        onReconnect: () => void fetchServerRoster(),
      },
    });
  }, [phase, isEmbedded]);

  // Tear the channel down on unmount. (On a real Activity close the iframe is destroyed and this
  // never runs — the EventSource/SDK RPC die with it; this is for the dev/HMR remount path.)
  useEffect(
    () => () => {
      void roomLiveRef.current?.disconnect();
      roomLiveRef.current = null;
    },
    [],
  );

  // A hidden tab can drop the socket silently; re-establish it (and catch up) when the tab is
  // visible again — the hidden-tab analog of the PIP-expand recovery above.
  useEffect(() => {
    if (!isEmbedded) return;
    const onVisible = (): void => {
      if (document.hidden) return;
      void roomLiveRef.current?.resync();
      void fetchServerRoster();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isEmbedded]);

  // The season/all-time boards move only when someone finishes, and a fresh finish already
  // fires a targeted refresh (the effect below, and onFinish for your own) — so this poll is
  // purely the safety net for finishers we never catch mid-game; 3 minutes is plenty, and a
  // backgrounded tab skips it entirely (it isn't looking at the board, and the mount/scope/
  // finish refreshes catch it up the moment it returns).
  useEffect(() => {
    if (!isEmbedded) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      void refreshLeaderboard();
    }, 180_000);
    return () => clearInterval(id);
  }, [isEmbedded]);

  // The player↔dev chat handlers, bound to this player's identity (refs) + the current puzzle.
  // Stable, so the chat UI loads its inbox once on mount instead of refetching every render.
  // Reads go through the cheap signed ticket; writes/admin actions through the live Discord token.
  const chatApi = useMemo<ChatApi>(
    () => ({
      list: () => listChat(authTicketRef.current ?? ""),
      open: (threadId) => openTicket(authTicketRef.current ?? "", threadId),
      create: (text, category, subject) =>
        createTicket({
          accessToken: accessTokenRef.current ?? "",
          text,
          category,
          subject,
          puzzle: gameRef.current?.puzzle.id ?? null,
        }),
      reply: (threadId, text) =>
        replyTicket(accessTokenRef.current ?? "", threadId, text),
      admin: {
        inbox: () => loadInbox(accessTokenRef.current ?? ""),
        thread: (threadId) =>
          loadAdminThread(accessTokenRef.current ?? "", threadId),
        reply: (threadId, text) =>
          sendAdminReply(accessTokenRef.current ?? "", threadId, text),
        resetProgress: () => resetTodayProgress(accessTokenRef.current ?? ""),
      },
    }),
    [],
  );

  // Once the handshake is done, list tickets for the unread dot + the dev's Inbox entry, and
  // re-check when the tab regains focus (a reply may have landed while away). Embedded only:
  // preview/landing have no ticket and fall back to the local form.
  useEffect(() => {
    if ((!isEmbedded && !mockEmbedded) || phase !== "ready") return;
    const refresh = (): void => {
      void chatApi.list().then((l) => {
        if (!l) return;
        primeTicketCache(l.tickets); // seed the Feedback page so its first open shows instantly
        setChatUnread(l.unread);
        setChatIsDev(l.isDev);
      });
    };
    refresh();
    const onVisible = (): void => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isEmbedded, mockEmbedded, phase, chatApi]);

  // Precise midnight-ET swap: a self-rescheduling one-shot timer fires at the exact reset
  // (+2s so NYT has published the new puzzle), then re-arms for the next day. swapToNewDay
  // is single-flight and self-checks the date, so a foreground tab gets the swap the instant
  // the new puzzle is live; the 30s poll above is the robust fallback for throttled tabs.
  useEffect(() => {
    if (!isEmbedded) return;
    let timer = 0;
    const arm = (): void => {
      timer = window.setTimeout(() => {
        void swapToNewDay();
        arm();
      }, msUntilNextEtMidnight() + 2000);
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [isEmbedded]);

  // The roster with your own local state overlaid, so your row never lags. Online ring = whoever
  // Discord says is in the Activity instance right now (participantIds); you're always in that
  // set, so your own ring is guarded true in case the list hasn't loaded yet.
  const roster = useMemo(() => {
    const byId = new Map<string, PlayerState>();
    for (const p of serverRoster) byId.set(p.userId, p);
    if (self) byId.set(self.userId, self);
    return [...byId.values()].map((p) => ({
      ...p,
      online:
        p.userId === meRef.current.id ? true : participantIds.has(p.userId),
      pickingWords: pickingByUser[p.userId],
    }));
  }, [serverRoster, self, participantIds, pickingByUser]);

  // Live leaderboard, the near-real-time path: when another player wraps the daily their
  // season/all-time totals change server-side a beat later (once their score write lands),
  // so we refresh ~2.5s after first seeing them finish. The board then reshuffles and the
  // FLIP rows slide to their new ranks. Own finishes already refresh via onFinish; the
  // 2-minute poll backstops anyone we miss here.
  const seenFinishers = useRef<Set<string>>(new Set());
  const lbRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isEmbedded) return;
    let freshFinish = false;
    for (const p of roster) {
      if (!p.done || seenFinishers.current.has(p.userId)) continue;
      seenFinishers.current.add(p.userId);
      if (p.userId !== meRef.current.id) freshFinish = true;
    }
    if (!freshFinish) return;
    if (lbRefreshTimer.current) clearTimeout(lbRefreshTimer.current);
    lbRefreshTimer.current = setTimeout(() => void refreshLeaderboard(), 2500);
  }, [roster, isEmbedded]);
  useEffect(
    () => () => {
      if (lbRefreshTimer.current) clearTimeout(lbRefreshTimer.current);
    },
    [],
  );

  // Collapsed into Discord's picture-in-picture window: show the compact board
  // thumbnail (full-bleed) rather than the shrunken full UI. Takes precedence over
  // every other phase so it works mid-load too.
  if (layoutMode === Common.LayoutModeTypeObject.PIP) {
    return (
      <div className="fixed inset-0 z-50">
        <PipThumbnail
          game={gameRef.current}
          revealed={gameRef.current ? revealedLevelsOf(gameRef.current) : []}
        />
      </div>
    );
  }

  // Opened in a plain browser (the README links here): the game stays
  // Discord-only, so show the project's landing page instead of the bare
  // blocked loader. Embedded-but-blocked (a failed/forged handshake inside
  // Discord) keeps the small "Open in Discord" message below.
  if (phase === "blocked" && !isEmbedded) {
    return <Landing />;
  }

  const retry = (): void => {
    void (async () => {
      await loadPuzzle();
      await refreshLeaderboard();
    })();
  };
  // Embedded-only recovery from a failed Discord handshake. A transient cold-start / RPC hiccup in
  // setupDiscord() returns false and dead-ends the player on the "blocked" screen with no way out;
  // this re-runs the WHOLE handshake (authorize() mints a fresh single-use OAuth code each call, so
  // a retry is clean) and then loads the puzzle. Deliberately a manual button, not an auto-loop: a
  // genuinely-not-in-Discord frame would otherwise sit through repeated 8s ready() timeouts before
  // showing anything. A "mounted" launch beacon with no following /api/token is the server-side
  // fingerprint of the failures this recovers.
  const retryHandshake = (): void => {
    if (!isEmbedded) return;
    setPhase("loading");
    void (async () => {
      if (!(await setupDiscord())) {
        setPhase("blocked");
        return;
      }
      await loadPuzzle();
      await refreshLeaderboard();
    })();
  };
  // Open Discord's guild-install consent (the same link as /enable-posts' button) in the
  // user's browser. Embedded-only by construction: botInstalled is only ever set after a
  // Discord handshake, so the prompt never renders standalone where sdkRef is null.
  const addBot = (): void => {
    void sdkRef.current?.commands
      .openExternalLink({ url: installUrl() })
      .catch(() => {
        /* user dismissed Discord's leave-app dialog — nothing to do */
      });
  };
  // The chat bundle the footer's Feedback page (and the dev Inbox) runs on: the bound api plus
  // the badge state. Embedded only — preview/landing pass nothing and get the local-only form.
  const chatBundle: ChatBundle | undefined =
    isEmbedded || mockEmbedded
      ? {
          api: chatApi,
          unread: chatUnread,
          isDev: chatIsDev,
          onUnread: setChatUnread,
        }
      : undefined;
  // Open an external URL (the footer's Ko-fi link). Embedded, it must go through the Discord
  // SDK (which shows the leave-app consent); standalone, sdkRef is null so we window.open.
  const openExternal = (url: string): void => {
    const sdk = sdkRef.current;
    if (sdk) {
      void sdk.commands.openExternalLink({ url }).catch(() => {
        /* user dismissed Discord's leave-app dialog — nothing to do */
      });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };
  // Loading takes precedence (gameRef null until first fetch); error only once a fetch has
  // failed; blocked when opened outside Discord. The DayTurnover veil overlays whichever of
  // these is showing, so the midnight swap (ready → loading → ready) plays out underneath it.
  const content =
    phase !== "ready" || !gameRef.current ? (
      <LoadingScreen
        error={phase === "error"}
        blocked={phase === "blocked"}
        onRetry={retry}
        // Embedded-blocked is a recoverable handshake failure (non-embedded blocked renders
        // <Landing/> above and never reaches here), so offer a retry instead of a dead end.
        onRetryHandshake={isEmbedded ? retryHandshake : undefined}
        date={etDate()}
        number={cachedPuzzleNo(etDate())}
        // Tip only where it can act: a guild that positively lacks the bot. Installed
        // servers and DMs (botInstalled null) load clean.
        tip={botInstalled === false}
      />
    ) : (
      <GameView
        game={gameRef.current}
        gameKey={gameKey}
        players={roster}
        selfId={meRef.current.id}
        season={season}
        allTime={allTime}
        // stable room id for the standings position-change snapshot (null standalone).
        roomKey={scopeRef.current}
        // current ET day — the position-change baseline resets at the midnight-ET rollover.
        today={etDate()}
        // Channel/Server toggle only in a guild — a DM/group (c: scope) has no distinction.
        scope={guildIdRef.current ? scopeMode : undefined}
        onScopeChange={guildIdRef.current ? setScopeMode : undefined}
        // End-screen recap pitch, only where it means something: a guild that positively
        // lacks the bot (false, not null/unknown — never pitch a server that has it).
        onAddBot={
          guildIdRef.current && botInstalled === false ? addBot : undefined
        }
        onPresence={onPresence}
        onCommit={commitGuess}
        onFinish={onFinish}
        chat={chatBundle}
        onOpenExternal={openExternal}
        initialRevealed={revealedLevelsOf(gameRef.current)}
      />
    );

  return (
    <>
      {content}
      <DayTurnover active={resetting} date={newDayDate} number={newDayNo} />
    </>
  );
}
