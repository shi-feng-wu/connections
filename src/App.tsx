import { Common, DiscordSDK } from "@discord/embedded-app-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardSnapshot } from "./board";
import { DayTurnover, GameView, LoadingScreen } from "./components";
import { msUntilNextEtMidnight } from "./countdown";
import { PipThumbnail } from "./pip";
import type { RosterScope } from "./roster";
import { Game, MAX_MISTAKES, type Puzzle } from "./game";
import {
  currentSeasonStart,
  roomBoard,
  roomSelf,
  submitScore,
} from "./leaderboard";
import {
  joinRoom,
  setRealtimeAuth,
  updatePresence,
  type PlayerState,
} from "./realtime";
import { type PresenceInput, presenceSignature, setPresence } from "./presence";
import { canonicalScope } from "./scope";
import type { Standings } from "./season";

const EMPTY_STANDINGS: Standings = { board: [], self: null };

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
  // Access token proves identity to /api/score & /api/realtime-token (they need
  // live Discord data); the signed auth ticket from /api/token gates the cheap
  // reads (/api/puzzle, /api/start) without a Discord round-trip each call. Signed
  // session from /api/start anchors solve timing server-side.
  const accessTokenRef = useRef<string | null>(null);
  const authTicketRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // True once a Realtime JWT is held, so presence joins the private channel.
  const realtimeAuthedRef = useRef(false);
  const joinedRef = useRef(false);
  const didInit = useRef(false);
  const loadSeq = useRef(0);
  // Trailing-debounce for the live card refresh (see refreshCard): collapses a burst
  // of guesses into one webhook edit shortly after the player stops.
  const cardRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const [players, setPlayers] = useState<PlayerState[]>([]);
  // Live presence accumulates: once a player has been seen this session they stay in the
  // roster even after they leave (state frozen at last-seen). presentIds marks who's
  // currently in the Activity, which drives the green "online" ring. seenRef is the
  // keep-everyone store the displayed list is rebuilt from on each sync.
  const seenRef = useRef<Map<string, PlayerState>>(new Map());
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set());
  // The room's persistent roster from /api/roster: everyone who joined this guild's daily
  // today (even those who left before you opened), state replayed from committed guesses.
  // Seeds the roster *under* live presence — presence overlays the live ones and adds the
  // green ring. Empty for non-guild contexts, where presence is the only source.
  const [serverRoster, setServerRoster] = useState<PlayerState[]>([]);
  const [self, setSelf] = useState<PlayerState | null>(null);
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
  // Midnight day-rollover veil (src/components.tsx DayTurnover): `resetting` drives the
  // overlay; the ref guards swapToNewDay so the precise timer and the 30s poll can't both
  // fire a swap; newDayDate is the date we're rolling into, shown on the veil.
  const [resetting, setResetting] = useState(false);
  const resettingRef = useRef(false);
  const [newDayDate, setNewDayDate] = useState<string | undefined>(undefined);
  // Discord activity layout: FOCUSED (0) normally, PIP (1) when collapsed. Drives the
  // compact thumbnail swap.
  const [layoutMode, setLayoutMode] = useState<number>(
    Common.LayoutModeTypeObject.FOCUSED,
  );

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

  // Presence sync → accumulate. Every player ever seen this session stays in `players`
  // (left players frozen at their last state); presentIds is just who's here right now, so
  // a departed player keeps their row but loses the green ring.
  function handlePresenceSync(current: PlayerState[]): void {
    for (const p of current) seenRef.current.set(p.userId, p);
    setPlayers([...seenRef.current.values()]);
    setPresentIds(new Set(current.map((p) => p.userId)));
  }

  // Board pushes its snapshot on each change; wrap with identity + timestamps,
  // broadcast to the room.
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
      finishedAt: snap.done && g.durationMs != null ? g.startedAt + g.durationMs : null,
    };
    setSelf(player);
    void updatePresence(player);
    pushPresence();
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
      guildIdRef.current && scopeModeRef.current === "channel" ? channelIdRef.current : null;
    const [sBoard, sSelf, aBoard, aSelf] = await Promise.all([
      roomBoard(scopeId, monthStart, 50, chan),
      roomSelf(scopeId, monthStart, me, chan),
      roomBoard(scopeId, null, 50, chan),
      roomSelf(scopeId, null, me, chan),
    ]);
    setSeason({ board: sBoard, self: sSelf });
    setAllTime({ board: aBoard, self: aSelf });
  }

  // Pull the room's persistent roster (joiners who came/went, replayed from their
  // committed guesses) and merge it under live presence. Any room-scoped daily — a guild
  // (g:) or a DM/group (c:); it self-gates on the scope and the server returns [] otherwise.
  // Best-effort: a failure keeps the last roster.
  async function fetchServerRoster(): Promise<void> {
    if (!isDailyRef.current || !authTicketRef.current || !scopeRef.current) return;
    try {
      const r = await fetch("/api/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          guildId: guildIdRef.current,
          channelId: channelIdRef.current,
          scopeMode: scopeModeRef.current,
        }),
      });
      if (!r.ok) return;
      const d = (await r.json()) as { players?: PlayerState[] };
      if (Array.isArray(d.players)) setServerRoster(d.players);
    } catch {
      /* keep the last roster */
    }
  }

  // Mint (or re-mint) the Realtime JWT and authorize the presence client so it can join the
  // private channel. Used at handshake and again as the room's `reauth` callback — a long
  // session whose token expires re-mints here and stays private instead of dropping to public.
  // Returns true once a token is held; false (no token / network error) keeps the public fallback.
  async function mintRealtimeToken(): Promise<boolean> {
    const accessToken = accessTokenRef.current;
    if (!accessToken) return false;
    try {
      const r = await fetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Token scoped to this room only (see realtime.messages RLS).
        body: JSON.stringify({ accessToken, room: roomRef.current }),
      });
      const token = r.ok ? ((await r.json()) as { token?: string }).token : null;
      if (token) {
        setRealtimeAuth(token);
        realtimeAuthedRef.current = true;
        return true;
      }
    } catch {
      /* presence stays on the public fallback channel */
    }
    return false;
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
    // Push the finished grid to the room card now (the server lets a finished player
    // skip the edit throttle, so the final board always lands).
    scheduleCardRefresh(true);
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
    if (!isDailyRef.current || !authTicketRef.current) return Promise.resolve(true);
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

  async function sendGuess(date: string, guess: string[], attempt = 0): Promise<boolean> {
    try {
      const r = await fetch("/api/guess", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ date, guess }),
      });
      if (r.ok) {
        const ok = ((await r.json()) as { ok?: boolean }).ok !== false;
        // Committed → reflect the new grid on the room card (debounced, best-effort).
        if (ok) scheduleCardRefresh();
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

  // Edit the room's "who's playing today" card so the player's guess grid fills in
  // live (like the Wordle card). Best-effort and fire-and-forget — the card is a
  // nicety and must never delay or block play. Only the daily on a guild has a card;
  // the server throttles the edits and establishing the card stays in /api/interactions.
  function refreshCard(): void {
    if (!isDailyRef.current || !authTicketRef.current || !guildIdRef.current) return;
    void fetch("/api/refresh-card", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        guildId: guildIdRef.current,
        channelId: channelIdRef.current,
      }),
    }).catch(() => {
      /* no refresh this time */
    });
  }

  // Trailing-debounce so a flurry of guesses collapses into one edit after the player
  // pauses; a finish refreshes immediately (the server lets a finished grid skip its
  // throttle) so the final board always lands.
  function scheduleCardRefresh(immediate = false): void {
    if (cardRefreshTimer.current) clearTimeout(cardRefreshTimer.current);
    if (immediate) {
      cardRefreshTimer.current = null;
      refreshCard();
      return;
    }
    cardRefreshTimer.current = setTimeout(() => {
      cardRefreshTimer.current = null;
      refreshCard();
    }, 1500);
  }

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

  async function loadPuzzle(opts: { date?: string; random?: boolean } = {}): Promise<void> {
    setPhase("loading");
    // New board → let the first presence push through (a different puzzle/status).
    lastPresenceSig.current = "";
    isDailyRef.current = !opts.random && !opts.date;
    // The persistent room roster is daily-scoped; practice/by-date shows presence only.
    if (!isDailyRef.current) setServerRoster([]);
    const qs = new URLSearchParams();
    if (opts.date) qs.set("date", opts.date);
    if (opts.random) qs.set("random", "1");
    try {
      const res = await fetch("/api/puzzle?" + qs.toString(), { headers: authHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const puzzle = (await res.json()) as Puzzle;

      // Open/resume the day, then rebuild the game from the committed guesses so a
      // relaunch resumes the exact board (mistakes, solved groups) instead of
      // resetting. Only the daily is tracked; random/by-date practice starts clean.
      const start = isDailyRef.current ? await startSession(puzzle.date) : null;
      const game = Game.fromGuesses(puzzle, start?.guesses ?? [], start?.startedAt);
      // Rehydrated finished game: stamp the duration the server scored (last guess
      // minus start) so the end-screen hero matches the locked score and stays
      // stable across reopens, instead of inflating with wall-clock since start.
      if (game.status !== "playing" && start) {
        game.durationMs = Math.max(1000, start.updatedAt - start.startedAt);
      }
      gameRef.current = game;
      sessionRef.current = start?.session ?? null;

      const s = selfState();
      setSelf(s);
      if (!joinedRef.current) {
        joinRoom(roomRef.current, handlePresenceSync, {
          private: realtimeAuthedRef.current,
          // getSelf lets the supervisor's rejoin/heartbeat broadcast CURRENT progress, not a
          // stale snapshot; reauth re-mints the JWT so a token expiry recovers private (above).
          getSelf: selfState,
          reauth: mintRealtimeToken,
        });
        joinedRef.current = true;
      } else {
        await updatePresence(s);
      }
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
    if (resettingRef.current || !isDailyRef.current || !g || etDate() === g.puzzle.date) {
      return;
    }
    resettingRef.current = true;
    setNewDayDate(etDate());
    setResetting(true);
    await sleep(540); // let the veil fade fully opaque (500ms) over the old board first
    await loadPuzzle();
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
      // access_token: live identity for /api/score & /api/realtime-token. auth: the
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

      // Realtime JWT so presence joins the private channel (only verified users
      // can broadcast). Falls back to a public channel if unavailable.
      await mintRealtimeToken();

      // Add this player to the channel's "who's playing today" card (append-only; the
      // server edits the room's live card — the launcher's /connections message — via the
      // interaction token). Fire-and-forget: the card is a nicety and must never block play.
      void fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: access_token,
          guildId: guildIdRef.current,
          channelId: channelIdRef.current,
        }),
      }).catch(() => {
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
      } else if (!import.meta.env.DEV) {
        // Opened outside Discord in a real build — nothing to play here.
        setPhase("blocked");
        return;
      }
      // Embedded + authenticated, or the DEV-only standalone fallback.
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

  // Keep the persistent room roster fresh while playing: new joiners, and the progress of
  // players who are offline (not in live presence). Any room-scoped daily (guild or DM) —
  // fetchServerRoster self-gates; cleared on unmount. Live players already update via presence.
  useEffect(() => {
    if (!isEmbedded) return;
    const id = setInterval(() => {
      // Daily reset (fallback): a client left open across midnight ET is pinned to the old
      // day. The precise timer below swaps at the exact reset, but backgrounded tabs throttle
      // it — so the poll re-checks every 30s and swaps too, including mid-game. Once the new
      // puzzle is out the old one is closed, so no one keeps playing it: an unfinished old
      // board just ends unscored, and a finish after midnight is already rejected server-side
      // by the session.date !== todayET() gate in api/score.ts.
      const g = gameRef.current;
      if (isDailyRef.current && g && etDate() !== g.puzzle.date) {
        void swapToNewDay();
        return;
      }
      void fetchServerRoster();
      // Keep the season/all-time boards live too — a steady poll catches scores from
      // players we never saw in presence (joined + left between syncs). Near-real-time
      // updates ride on the presence-driven refresh below; this is the safety net.
      void refreshLeaderboard();
    }, 30_000);
    return () => clearInterval(id);
  }, [isEmbedded]);

  // Precise midnight-ET swap: a self-rescheduling one-shot timer fires at the exact reset
  // (+2s so NYT has published the new puzzle), then re-arms for the next day. swapToNewDay
  // is single-flight and self-checks the date, so a foreground tab gets the swap the instant
  // the new puzzle is live; the 30s poll above is the robust fallback for throttled tabs.
  useEffect(() => {
    if (!isEmbedded) return;
    let timer = 0;
    const arm = (): void => {
      timer = window.setTimeout(
        () => {
          void swapToNewDay();
          arm();
        },
        msUntilNextEtMidnight() + 2000,
      );
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [isEmbedded]);

  // Everyone in the room with own latest snapshot overlaid (presence sync can
  // lag own actions).
  const roster = useMemo(() => {
    // Persistent joiners form the base; live presence overlays the ones currently here
    // (fresher state), and your own local state wins for you.
    const byId = new Map<string, PlayerState>();
    for (const p of serverRoster) byId.set(p.userId, p);
    for (const p of players) byId.set(p.userId, p);
    if (self) byId.set(self.userId, self);
    // Tag presence: you're always here; everyone else is online while in the live set.
    return [...byId.values()].map((p) => ({
      ...p,
      online: p.userId === meRef.current.id || presentIds.has(p.userId),
    }));
  }, [serverRoster, players, self, presentIds]);

  // Live leaderboard, the near-real-time path: when another player wraps the daily their
  // season/all-time totals change server-side a beat later (once their score write lands),
  // so we refresh ~2.5s after first seeing them finish. The board then reshuffles and the
  // FLIP rows slide to their new ranks. Own finishes already refresh via onFinish; the 30s
  // poll backstops anyone we miss here.
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

  const retry = (): void => {
    void (async () => {
      await loadPuzzle();
      await refreshLeaderboard();
    })();
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
      />
    ) : (
      <GameView
        game={gameRef.current}
        gameKey={gameKey}
        players={roster}
        selfId={meRef.current.id}
        selfName={meRef.current.name}
        selfAvatar={meRef.current.avatar}
        season={season}
        allTime={allTime}
        // Channel/Server toggle only in a guild — a DM/group (c: scope) has no distinction.
        scope={guildIdRef.current ? scopeMode : undefined}
        onScopeChange={guildIdRef.current ? setScopeMode : undefined}
        onPresence={onPresence}
        onCommit={commitGuess}
        onFinish={onFinish}
        initialRevealed={revealedLevelsOf(gameRef.current)}
      />
    );

  return (
    <>
      {content}
      <DayTurnover active={resetting} date={newDayDate} />
    </>
  );
}
