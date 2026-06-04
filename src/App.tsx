import { Common, DiscordSDK } from "@discord/embedded-app-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardSnapshot } from "./board";
import { GameView, LoadingScreen } from "./components";
import { PipThumbnail } from "./pip";
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

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

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
  const deduced = new Set<number>();
  for (const row of g.history) if (row.every((l) => l === row[0])) deduced.add(row[0]);
  return g.solved.map((s) => s.level).filter((l) => deduced.has(l));
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
  const [self, setSelf] = useState<PlayerState | null>(null);
  // End-screen room leaderboard, two windows; fetched after a finish posts and on load.
  const [season, setSeason] = useState<Standings>(EMPTY_STANDINGS);
  const [allTime, setAllTime] = useState<Standings>(EMPTY_STANDINGS);
  const [gameKey, setGameKey] = useState("0");
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "blocked">(
    "loading",
  );
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
    const [sBoard, sSelf, aBoard, aSelf] = await Promise.all([
      roomBoard(scopeId, monthStart),
      roomSelf(scopeId, monthStart, me),
      roomBoard(scopeId, null),
      roomSelf(scopeId, null, me),
    ]);
    setSeason({ board: sBoard, self: sSelf });
    setAllTime({ board: aBoard, self: aSelf });
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
  async function commitGuess(guess: string[]): Promise<boolean> {
    if (!isDailyRef.current || !authTicketRef.current) return true;
    const g = gameRef.current;
    if (!g) return true;
    try {
      const r = await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ date: g.puzzle.date, guess }),
      });
      if (!r.ok) return false;
      const ok = ((await r.json()) as { ok?: boolean }).ok !== false;
      // Committed → reflect the new grid on the room card (debounced, best-effort).
      if (ok) scheduleCardRefresh();
      return ok;
    } catch {
      return false;
    }
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
        joinRoom(roomRef.current, s, setPlayers, {
          private: realtimeAuthedRef.current,
        });
        joinedRef.current = true;
      } else {
        await updatePresence(s);
      }
      setGameKey(`${puzzle.id}-${loadSeq.current++}`);
      setPhase("ready");
      pushPresence();
    } catch {
      setPhase("error");
    }
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
      try {
        const r = await fetch("/api/realtime-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Token scoped to this room only (see realtime.messages RLS).
          body: JSON.stringify({ accessToken: access_token, room: roomRef.current }),
        });
        const token = r.ok ? ((await r.json()) as { token?: string }).token : null;
        if (token) {
          setRealtimeAuth(token);
          realtimeAuthedRef.current = true;
        }
      } catch {
        /* presence stays on the public fallback channel */
      }

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

  // Everyone in the room with own latest snapshot overlaid (presence sync can
  // lag own actions).
  const roster = useMemo(() => {
    const byId = new Map(players.map((p) => [p.userId, p] as const));
    if (self) byId.set(self.userId, self);
    return [...byId.values()];
  }, [players, self]);

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

  if (phase !== "ready" || !gameRef.current) {
    const retry = (): void => {
      void (async () => {
        await loadPuzzle();
        await refreshLeaderboard();
      })();
    };
    // Loading takes precedence (gameRef null until first fetch); error only once
    // a fetch has failed; blocked when opened outside Discord.
    return (
      <LoadingScreen
        error={phase === "error"}
        blocked={phase === "blocked"}
        onRetry={retry}
      />
    );
  }

  return (
    <GameView
      game={gameRef.current}
      gameKey={gameKey}
      players={roster}
      selfId={meRef.current.id}
      selfName={meRef.current.name}
      selfAvatar={meRef.current.avatar}
      season={season}
      allTime={allTime}
      onPresence={onPresence}
      onCommit={commitGuess}
      onFinish={onFinish}
      initialRevealed={revealedLevelsOf(gameRef.current)}
    />
  );
}
