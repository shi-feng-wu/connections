import { DiscordSDK } from "@discord/embedded-app-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardSnapshot } from "./board";
import { GameView, LoadingScreen } from "./components";
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
import { canonicalScope } from "./scope";
import type { Standings } from "./season";

const EMPTY_STANDINGS: Standings = { board: [], self: null };

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

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

  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [self, setSelf] = useState<PlayerState | null>(null);
  // End-screen room leaderboard, two windows; fetched after a finish posts and on load.
  const [season, setSeason] = useState<Standings>(EMPTY_STANDINGS);
  const [allTime, setAllTime] = useState<Standings>(EMPTY_STANDINGS);
  const [gameKey, setGameKey] = useState("0");
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "blocked">(
    "loading",
  );

  function selfState(): PlayerState {
    const g = gameRef.current;
    return {
      userId: meRef.current.id,
      name: meRef.current.name,
      avatar: meRef.current.avatar,
      mistakesLeft: g?.mistakesLeft ?? MAX_MISTAKES,
      solvedCount: g?.solved.length ?? 0,
      solvedLevels: g ? g.solved.map((s) => s.level) : [],
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
        guesses: g.guesses,
      });
      await refreshLeaderboard();
    })();
  }

  // Signed auth ticket as a Bearer header for the gated reads. Empty when
  // standalone (DEV only), where those endpoints skip the check.
  function authHeaders(): Record<string, string> {
    const t = authTicketRef.current;
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  // Signed session: server-stamped start time bound to this puzzle date.
  // Best-effort; without it, finishes won't be scored.
  async function startSession(date: string): Promise<string | null> {
    try {
      const r = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ date }),
      });
      if (!r.ok) return null;
      return ((await r.json()) as { session?: string }).session ?? null;
    } catch {
      return null;
    }
  }

  async function loadPuzzle(opts: { date?: string; random?: boolean } = {}): Promise<void> {
    setPhase("loading");
    isDailyRef.current = !opts.random && !opts.date;
    const qs = new URLSearchParams();
    if (opts.date) qs.set("date", opts.date);
    if (opts.random) qs.set("random", "1");
    try {
      const res = await fetch("/api/puzzle?" + qs.toString(), { headers: authHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const puzzle = (await res.json()) as Puzzle;
      gameRef.current = new Game(puzzle);

      // Open a signed session to time and bind this game's score.
      sessionRef.current = await startSession(puzzle.date);

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

      const { code } = await sdk.commands.authorize({
        client_id: CLIENT_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        // `guilds` lets /api/score confirm membership before writing a guild board.
        scope: ["identify", "guilds"],
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
        players={roster}
        selfId={meRef.current.id}
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
      onFinish={onFinish}
    />
  );
}
