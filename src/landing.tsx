import { useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "./assets/connections-nyt.png";
import { Board } from "./board";
import {
  cardLayout,
  type CardPlayer,
  drawRecap,
  drawRoster,
  type RecapData,
  recapLayout,
} from "./card-draw";
import { GameView } from "./components";
import { Game, type Puzzle } from "./game";
import type { PlayerState } from "./player";
import { Roster, type RosterView } from "./roster";
import type { Standings } from "./season";

// The public landing page, shown when the production deployment is opened in a
// plain browser (the GitHub README links here). The game itself stays
// Discord-only — /api/puzzle rejects unauthenticated reads — so this page sells
// the project instead, with the real components demoing themselves: the Board
// self-plays a made-up puzzle, the Roster replays a simulated room, and the
// Discord cards are drawn by the same canvas code the bot ships as PNGs.

const GITHUB = "https://github.com/shi-feng-wu/connections";
const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
// Discord's app-install dialog. Without a client id (bare dev preview) fall
// back to the repo so the button never 404s.
const INSTALL = CLIENT_ID
  ? `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}`
  : GITHUB;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const noop = (): void => {};
const reducedMotion = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Stand-in "Discord photo": data-URI silhouette, so the demos render offline.
const pfp = (bg: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='${bg}'/><circle cx='32' cy='25' r='13' fill='#ffffff'/><rect x='12' y='42' width='40' height='26' rx='13' fill='#ffffff'/></svg>`,
  );

// ——— Self-playing board ———————————————————————————————————————————————
// A made-up, Discord-flavored puzzle (no NYT data): the demo solves itself on
// the REAL Board component, so the pop→gather→morph choreography on this page
// is the actual game code, not a replica.
const DEMO_PUZZLE: Puzzle = {
  id: 424242, // never a real NYT id, so its spoiler/localStorage keys can't collide
  date: "2026-01-01",
  editor: "",
  groups: [
    {
      level: 0,
      category: "HEARD ON DISCORD",
      members: ["SERVER", "NITRO", "EMOTE", "PING"],
    },
    {
      level: 1,
      category: "THINGS THAT STREAM",
      members: ["RIVER", "LAVA", "TEARS", "TWITCH"],
    },
    {
      level: 2,
      category: "GROUP ___",
      members: ["CHAT", "CALL", "THERAPY", "PROJECT"],
    },
    {
      level: 3,
      category: "___BOARD",
      members: ["KEY", "LEADER", "SURF", "DASH"],
    },
  ],
  layout: [
    "KEY",
    "RIVER",
    "CHAT",
    "NITRO",
    "TWITCH",
    "SERVER",
    "LEADER",
    "CALL",
    "PING",
    "THERAPY",
    "LAVA",
    "SURF",
    "PROJECT",
    "EMOTE",
    "TEARS",
    "DASH",
  ],
};

// The win screen blurs the last category as a spoiler unless it's been seen;
// a non-interactive demo could never tap to reveal, so mark the demo puzzle's
// categories seen up front (same key Board persists to).
try {
  localStorage.setItem(`conn-spoiler-${DEMO_PUZZLE.id}`, "[0,1,2,3]");
} catch {
  /* storage blocked — the demo just shows the covered bar */
}

// Drives the real Board through a full solve by clicking its DOM (the same
// technique as the preview harness's Simulate playground): select a group with
// a human-ish stagger, submit, wait for the morph, repeat; hold the end screen,
// then remount and loop. The wrapper is pointer-events-none, so visitors can
// watch but not play.
export function DemoBoard() {
  const [key, setKey] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // Reduced motion: skip the driver entirely and show the finished board.
  const still = useMemo(reducedMotion, []);
  const game = useMemo(() => {
    const g = new Game(DEMO_PUZZLE);
    if (still) {
      for (const grp of DEMO_PUZZLE.groups) {
        g.clear();
        for (const m of grp.members) g.toggle(m);
        g.submit();
      }
    }
    return g;
  }, [key, still]);

  useEffect(() => {
    if (still) return;
    let alive = true;
    const root = ref.current;
    const tile = (w: string): HTMLElement | null | undefined =>
      root?.querySelector<HTMLElement>(`[data-flip="${CSS.escape(w)}"]`);
    const submitBtn = (): HTMLButtonElement | undefined =>
      [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Submit",
      );
    const tilesLeft = (): number =>
      root?.querySelectorAll('[data-flip]:not([data-flip^="bar-"])').length ?? 0;
    const until = async (cond: () => boolean, timeout = 6000): Promise<void> => {
      const start = performance.now();
      while (alive && !cond() && performance.now() - start < timeout)
        await sleep(80);
    };

    void (async () => {
      await sleep(1400); // let the page reveal land before the demo starts
      for (const grp of DEMO_PUZZLE.groups) {
        if (!alive) return;
        const before = tilesLeft();
        for (const w of grp.members) {
          tile(w)?.click();
          await sleep(170);
        }
        await sleep(420); // beat between "found them" and submitting
        await until(() => submitBtn() != null && !submitBtn()!.disabled);
        submitBtn()?.click();
        await until(() => tilesLeft() <= before - 4); // group accepted + removed
        await sleep(820);
      }
      await sleep(5200); // hold the end screen, then start over
      if (alive) setKey((k) => k + 1);
    })();
    return () => {
      alive = false;
    };
  }, [key, still]);

  return (
    <div
      ref={ref}
      aria-hidden
      data-demo-board
      className="pointer-events-none select-none"
    >
      <Board key={key} game={game} onPresence={noop} onFinish={noop} />
    </div>
  );
}

// ——— Self-playing room ————————————————————————————————————————————————
// The real Roster replaying a scripted morning in a room: grids fill in tick by
// tick, players finish (or run out of guesses) and take their ranks, then the
// rail flips to the Season standings before the day restarts.
const TICK_MS = 1500;
type RoomSeed = {
  id: string;
  name: string;
  avatar?: string;
  order: [number, number, number, number]; // solve order (group levels)
  solveTicks: number[]; // tick at which each group lands (ascending; 4 = win)
  mistakeTicks: number[]; // ticks that cost a guess (4 of them = loss)
  base: number; // head start in seconds, so live times differ
};
const ROOM: RoomSeed[] = [
  {
    id: "d-jun",
    name: "Jun Park",
    avatar: pfp("#2f6fed"),
    order: [0, 1, 2, 3],
    solveTicks: [1, 3, 5, 7],
    mistakeTicks: [4],
    base: 51,
  },
  {
    id: "d-aria",
    name: "Aria Voss",
    avatar: pfp("#d9457a"),
    order: [3, 0, 1, 2],
    solveTicks: [2, 4, 7, 9],
    mistakeTicks: [],
    base: 38,
  },
  {
    id: "d-theo",
    name: "Theo Lindqvist",
    order: [1, 0, 3, 2],
    solveTicks: [3, 6, 9, 12],
    mistakeTicks: [5, 8],
    base: 24,
  },
  {
    id: "d-mei",
    name: "Mei Tanaka",
    avatar: pfp("#1f9e6a"),
    order: [0, 2, 1, 3],
    solveTicks: [4, 8, 11, 13],
    mistakeTicks: [2],
    base: 12,
  },
  {
    id: "d-yuki",
    name: "Yuki Sato",
    order: [2, 0, 1, 3],
    solveTicks: [5, 10],
    mistakeTicks: [3, 6, 9, 12], // fourth mistake ends the run
    base: 5,
  },
  {
    id: "d-omar",
    name: "Omar Haddad",
    avatar: pfp("#e0a32e"),
    order: [1, 3, 0, 2],
    solveTicks: [6, 11, 14],
    mistakeTicks: [8],
    base: 0,
  },
];
const ROOM_TICKS = 15; // past the last scripted event
const SEASON_AT = ROOM_TICKS + 1; // flip the rail to Season standings…
const RESET_AT = SEASON_AT + 4; // …hold a few beats, then start the day over

function roomAtTick(t: number, cycleStart: number): PlayerState[] {
  return ROOM.map((p, i) => {
    const solvedLevels = p.order.slice(
      0,
      p.solveTicks.filter((s) => s <= t).length,
    );
    const mistakes = p.mistakeTicks.filter((m) => m <= t).length;
    const lostAt = p.mistakeTicks.length === 4 ? p.mistakeTicks[3] : Infinity;
    const wonAt = p.solveTicks.length === 4 ? p.solveTicks[3] : Infinity;
    const doneAt = Math.min(lostAt, wonAt);
    const done = t >= doneAt ? (wonAt <= lostAt ? "won" : "lost") : null;
    const startedAt = cycleStart - p.base * 1000;
    return {
      userId: p.id,
      name: p.name,
      avatar: p.avatar,
      mistakesLeft: 4 - mistakes,
      solvedCount: solvedLevels.length,
      solvedLevels,
      // a light flicker of the "picking" ring across the still-playing rows
      picking: !done && (t + i) % 3 === 1,
      online: true,
      done,
      startedAt,
      finishedAt: done ? startedAt + (p.base + doneAt * 1.5) * 1000 + 60_000 : null,
    };
  });
}

// Season / all-time standings behind the rail's other tabs (and the demo's
// season flip). Static mock — the shape the room_board SQL returns.
const row = (
  id: string,
  name: string,
  avatar: string | undefined,
  total: number,
  plays: number,
  wins: number,
  avg: number,
  streak: number,
) => ({
  user_id: id,
  name,
  avatar: avatar ?? null,
  total,
  plays,
  wins,
  win_pct: Math.round((wins / plays) * 100),
  avg_mistakes: avg,
  streak,
});
const DEMO_SEASON: Standings = {
  board: [
    row("d-aria", "Aria Voss", pfp("#d9457a"), 11715, 7, 6, 1.6, 9),
    row("d-jun", "Jun Park", pfp("#2f6fed"), 11430, 7, 6, 1.1, 6),
    row("d-theo", "Theo Lindqvist", undefined, 10660, 7, 5, 1.4, 7),
    row("d-mei", "Mei Tanaka", pfp("#1f9e6a"), 9520, 6, 5, 1.8, 5),
    row("d-omar", "Omar Haddad", pfp("#e0a32e"), 8485, 7, 4, 2.0, 2),
    row("d-yuki", "Yuki Sato", undefined, 7110, 6, 3, 2.3, 0),
  ],
  self: null,
};
const DEMO_ALLTIME: Standings = {
  board: [
    row("d-jun", "Jun Park", pfp("#2f6fed"), 181200, 150, 118, 1.5, 6),
    row("d-aria", "Aria Voss", pfp("#d9457a"), 178450, 142, 121, 1.4, 9),
    row("d-mei", "Mei Tanaka", pfp("#1f9e6a"), 140100, 121, 92, 1.7, 5),
    row("d-theo", "Theo Lindqvist", undefined, 135870, 138, 84, 1.6, 7),
    row("d-omar", "Omar Haddad", pfp("#e0a32e"), 122500, 130, 78, 2.1, 2),
    row("d-yuki", "Yuki Sato", undefined, 96300, 96, 61, 2.3, 0),
  ],
  self: null,
};

export function DemoRoster() {
  const still = useMemo(reducedMotion, []);
  // Freeze a mid-race frame under reduced motion; otherwise tick the script.
  const [tick, setTick] = useState(still ? 9 : 0);
  const [view, setView] = useState<RosterView>("live");
  const cycleStart = useRef(Date.now());

  useEffect(() => {
    if (still) return;
    const id = setInterval(() => {
      setTick((t) => {
        const next = t + 1;
        if (next === SEASON_AT) setView("season");
        if (next >= RESET_AT) {
          setView("live");
          cycleStart.current = Date.now();
          return 0;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [still]);

  const players = useMemo(
    () => roomAtTick(tick, cycleStart.current),
    [tick],
  );

  return (
    // Fixed-height flex column — the rail's own panel mode: both tab panels are
    // flex-1/min-h-0, so the Live list fills the box exactly (382px = tabs + 6
    // rows, measured) and the taller Season table scrolls internally under its
    // list-fade instead of growing the page. The flip can't move anything.
    <div
      aria-hidden
      data-demo-roster
      className="pointer-events-none flex h-[382px] flex-col select-none"
    >
      <Roster
        players={players}
        selfId=""
        view={view}
        onViewChange={noop}
        season={DEMO_SEASON}
        allTime={DEMO_ALLTIME}
      />
    </div>
  );
}

// ——— Self-playing desktop view ————————————————————————————————————————
// The real GameView (board + live roster rail, the 50/50 desktop layout) driving
// itself: the board self-solves while the room's rows reorder past each other beside
// it. Used to record the 16:9 Discord activity "Video Preview" — gameplay AND live
// multiplayer in one frame. Not on the landing page itself; harness/recording only.
export function DemoGame() {
  const still = useMemo(reducedMotion, []);
  const ref = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState(0);
  const game = useMemo(() => new Game(DEMO_PUZZLE), [key]);
  const cycleStart = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const players = useMemo(() => roomAtTick(tick, cycleStart.current), [tick]);

  // Snappy, recording-only pacing so a full solve + several roster reshuffles fit a
  // short clip at NATURAL speed — no post-hoc speed-up, no frame interpolation.
  const ROOM_TICK = 800;

  // tick the room (rows reorder)
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setTick((t) => t + 1), ROOM_TICK);
    return () => clearInterval(id);
  }, [key, still]);

  // drive the board solve through the GameView's DOM (same technique as DemoBoard)
  useEffect(() => {
    if (still) return;
    let alive = true;
    const root = ref.current;
    const tile = (w: string): HTMLElement | null | undefined =>
      root?.querySelector<HTMLElement>(`[data-flip="${CSS.escape(w)}"]`);
    const submitBtn = (): HTMLButtonElement | undefined =>
      [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Submit",
      );
    const tilesLeft = (): number =>
      root?.querySelectorAll('[data-flip]:not([data-flip^="bar-"])').length ?? 0;
    const until = async (cond: () => boolean, t = 6000): Promise<void> => {
      const s = performance.now();
      while (alive && !cond() && performance.now() - s < t) await sleep(80);
    };
    void (async () => {
      await sleep(300);
      for (const grp of DEMO_PUZZLE.groups) {
        if (!alive) return;
        const before = tilesLeft();
        for (const w of grp.members) {
          tile(w)?.click();
          await sleep(60);
        }
        await sleep(70);
        await until(() => {
          const b = submitBtn();
          return b != null && !b.disabled;
        });
        submitBtn()?.click();
        await until(() => tilesLeft() <= before - 4);
        await sleep(100);
      }
      await sleep(1600); // hold the finished board + standings, then restart
      if (alive) {
        cycleStart.current = Date.now();
        setTick(0);
        setKey((k) => k + 1);
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, still]);

  return (
    <div ref={ref} aria-hidden data-demo-game className="pointer-events-none select-none">
      <GameView
        game={game}
        gameKey={String(key)}
        players={players}
        selfId=""
        season={DEMO_SEASON}
        allTime={DEMO_ALLTIME}
        onPresence={noop}
        onFinish={noop}
      />
    </div>
  );
}

// ——— Discord cards, drawn live ————————————————————————————————————————
// Same canvas code the server runs to render the PNGs it posts (card-draw.ts);
// the browser draws with the page's own fonts, so nothing extra ships.
async function ensureCanvasFonts(): Promise<void> {
  await Promise.all(
    [
      '500 16px "Libre Franklin"',
      '600 16px "Libre Franklin"',
      '700 16px "Libre Franklin"',
      '800 16px "Libre Franklin"',
      "700 16px Newsreader",
    ].map((f) => document.fonts.load(f)),
  ).catch(() => {
    /* fall back to whatever's loaded — the card still draws */
  });
}

const loadCardImg = (url: string): Promise<CanvasImageSource | null> =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });

// A room mid-race for the "who's playing" card: each grid row is one guess.
const CARD_ROOM: CardPlayer[] = [
  {
    id: "d-jun",
    name: "Jun Park",
    avatar: pfp("#2f6fed"),
    sec: 134,
    grid: [
      [2, 1, 2, 2],
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [3, 3, 3, 3],
    ],
  },
  {
    id: "d-aria",
    name: "Aria Voss",
    avatar: pfp("#d9457a"),
    sec: 171,
    grid: [
      [3, 3, 3, 3],
      [0, 1, 0, 0],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ],
  },
  {
    id: "d-theo",
    name: "Theo Lindqvist",
    avatar: null,
    sec: 95,
    grid: [
      [0, 0, 0, 0],
      [3, 1, 2, 3],
    ],
  },
  {
    id: "d-mei",
    name: "Mei Tanaka",
    avatar: pfp("#1f9e6a"),
    sec: 14,
    grid: [],
  },
  {
    id: "d-omar",
    name: "Omar Haddad",
    avatar: pfp("#e0a32e"),
    sec: 108,
    grid: [
      [1, 1, 1, 1],
      [3, 3, 3, 3],
      [0, 0, 0, 0],
      [2, 2, 2, 2],
    ],
  },
];

// The daily recap posted at the midnight-ET reset: yesterday's results beside
// the month's standings.
const CARD_RECAP: RecapData = {
  puzzleNo: 1169,
  puzzleDate: "2026-06-09",
  season: "June",
  streak: 12,
  winRate: 84,
  guildName: "Puzzle Club",
  channelName: "daily-connections",
  results: [
    {
      id: "d-omar",
      name: "Omar Haddad",
      avatar: pfp("#e0a32e"),
      solved: true,
      score: 96,
      mistakes: 0,
      solvedLevels: [2, 1, 0, 3],
      sec: 102,
    },
    {
      id: "d-theo",
      name: "Theo Lindqvist",
      avatar: null,
      solved: true,
      score: 91,
      mistakes: 0,
      solvedLevels: [3, 2, 1, 0],
      sec: 88,
    },
    {
      id: "d-jun",
      name: "Jun Park",
      avatar: pfp("#2f6fed"),
      solved: true,
      score: 84,
      mistakes: 1,
      solvedLevels: [0, 1, 2, 3],
      sec: 141,
    },
    {
      id: "d-aria",
      name: "Aria Voss",
      avatar: pfp("#d9457a"),
      solved: true,
      score: 68,
      mistakes: 2,
      solvedLevels: [3, 1, 2, 0],
      sec: 203,
    },
    {
      id: "d-yuki",
      name: "Yuki Sato",
      avatar: null,
      solved: false,
      score: 12,
      mistakes: 4,
      solvedLevels: [3, 1],
      sec: null,
    },
  ],
  standings: [
    {
      id: "d-aria",
      name: "Aria Voss",
      avatar: pfp("#d9457a"),
      total: 487,
      wins: 6,
      plays: 7,
    },
    {
      id: "d-jun",
      name: "Jun Park",
      avatar: pfp("#2f6fed"),
      total: 441,
      wins: 4,
      plays: 7,
    },
    {
      id: "d-theo",
      name: "Theo Lindqvist",
      avatar: null,
      total: 372,
      wins: 3,
      plays: 6,
    },
    {
      id: "d-mei",
      name: "Mei Tanaka",
      avatar: pfp("#1f9e6a"),
      total: 339,
      wins: 2,
      plays: 6,
    },
  ],
};

function RosterCard() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureCanvasFonts();
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const scratch = document.createElement("canvas").getContext("2d");
      if (!scratch) return;
      const opts = { puzzleNo: 1170, puzzleDate: "2026-06-10" };
      const layout = cardLayout(scratch, CARD_ROOM, opts);
      canvas.width = layout.W; // true pixel size; CSS scales it to fit
      canvas.height = layout.height;
      const ctx = canvas.getContext("2d");
      if (ctx)
        await drawRoster(ctx, CARD_ROOM, opts, layout, {
          loadImg: loadCardImg,
          Path2D: window.Path2D,
        });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <canvas
      ref={ref}
      className="w-full rounded-xl shadow-2xl ring-1 ring-white/10"
      aria-label="The who's-playing card the bot posts to the channel"
    />
  );
}

function RecapCard() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureCanvasFonts();
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const layout = recapLayout(CARD_RECAP);
      canvas.width = layout.W;
      canvas.height = layout.height;
      const ctx = canvas.getContext("2d");
      if (ctx)
        await drawRecap(ctx, CARD_RECAP, layout, {
          loadImg: loadCardImg,
          Path2D: window.Path2D,
        });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <canvas
      ref={ref}
      className="w-full rounded-xl shadow-2xl ring-1 ring-white/10"
      aria-label="The daily recap card posted after the midnight reset"
    />
  );
}

// ——— Page furniture ———————————————————————————————————————————————————

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 127.14 96.36" className={className} fill="currentColor" aria-hidden>
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

// Staggered page-load reveal: tabIn is declared with `both`, so a delayed
// element holds opacity 0 until its turn. Append `animate-tab-in` to the
// element's classes and take the delay from here.
const riseDelay = (i: number): { animationDelay: string } => ({
  animationDelay: `${i * 90}ms`,
});

// Section heading, the game's display serif.
function H2({ children }: { children: string }) {
  return (
    <h2 className="text-balance font-display text-[28px] font-bold tracking-[-0.01em] text-[#efefe6]">
      {children}
    </h2>
  );
}

export function Landing() {
  return (
    <div className="relative w-full py-10">
      {/* Atmosphere: two ultra-faint category-color washes over the black. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(560px 420px at 12% -4%, rgba(249,223,109,0.05), transparent 70%)," +
            "radial-gradient(640px 480px at 96% 32%, rgba(186,129,197,0.06), transparent 70%)",
        }}
      />

      {/* Wordmark, the game header's own lockup (components.tsx Header). */}
      <header className="flex animate-tab-in items-center gap-2.5" style={riseDelay(0)}>
        <img
          src={iconUrl}
          alt=""
          className="h-[27px] w-[27px] flex-none object-contain"
        />
        <span className="font-display text-[27px] font-bold leading-none tracking-[-0.025em] text-[#efefe6] [text-box:trim-both_cap_alphabetic]">
          Connections
        </span>
      </header>

      {/* Hero: the app's own desktop split — pitch where the board goes, demo where the rail goes. */}
      <section className="mt-14 grid items-center gap-12 min-[820px]:mt-20 min-[820px]:grid-cols-[1fr_minmax(0,420px)] min-[820px]:gap-14">
        <div className="flex flex-col items-start gap-6">
          <h1
            className="animate-tab-in text-balance font-display text-[42px] font-bold leading-[1.04] tracking-[-0.015em] text-[#efefe6] min-[820px]:text-[54px]"
            style={riseDelay(1)}
          >
            The daily Connections, played together.
          </h1>
          <p
            className="max-w-[46ch] animate-tab-in text-pretty font-sans text-[15px] leading-[1.75] text-zinc-400"
            style={riseDelay(2)}
          >
            Launch it in a Discord channel or call and everyone gets the same
            daily board. Watch each other's grids fill in live, race the
            clock, and climb your server's season leaderboard.
          </p>
          <div
            className="flex animate-tab-in flex-wrap items-center gap-3"
            style={riseDelay(3)}
          >
            <a
              href={INSTALL}
              className="flex items-center gap-2.5 rounded-full border border-zinc-100 bg-zinc-100 px-5.5 py-2.5 text-sm font-semibold text-zinc-900 transition-opacity duration-150 ease-out hover:opacity-85"
            >
              <DiscordIcon className="h-4 w-4" />
              Add to Discord
            </a>
            <a
              href={GITHUB}
              className="flex items-center gap-2.5 rounded-full border border-zinc-700 px-5.5 py-2.5 text-sm font-semibold text-zinc-200 transition-colors duration-150 ease-out hover:border-zinc-500"
            >
              <GitHubIcon className="h-4 w-4" />
              View source
            </a>
          </div>
          <p
            className="max-w-[48ch] animate-tab-in text-pretty font-sans text-[12.5px] leading-relaxed text-zinc-600"
            style={riseDelay(4)}
          >
            Works as a user install too, but{" "}
            <span className="font-semibold text-zinc-400">Add to server</span>{" "}
            is the full experience: that's what lets the bot post the live
            cards and daily recaps.
          </p>
        </div>
        <div className="animate-tab-in" style={riseDelay(5)}>
          <DemoBoard />
        </div>
      </section>

      {/* The room, live: the real rail replaying a scripted morning. The 418px
          column is the game's own rail width. */}
      <section className="mt-28 grid items-center gap-12 min-[820px]:grid-cols-[minmax(0,418px)_1fr] min-[820px]:gap-14">
        <DemoRoster />
        <div className="flex flex-col items-start gap-5 max-[819px]:-order-1">
          <H2>Watch the room race.</H2>
          <p className="max-w-[48ch] text-pretty font-sans text-[14px] leading-[1.8] text-zinc-400">
            Everyone on today's puzzle shows up beside your board, their grids
            filling in guess by guess. Colors only, so nothing spoils. Finishers
            take a time and a rank while the rest of the room plays on.
          </p>
          <p className="max-w-[48ch] text-pretty font-sans text-[14px] leading-[1.8] text-zinc-400">
            Wins feed monthly seasons and all-time standings kept per server:
            streaks, win rates, average mistakes. Only your first finish of the
            daily counts, so replays can't farm points.
          </p>
        </div>
      </section>

      {/* The Discord cards, drawn by the bot's own renderer. */}
      <section className="mt-28 flex flex-col gap-5">
        <H2>It posts back to the channel.</H2>
        <p className="max-w-[62ch] text-pretty font-sans text-[14px] leading-[1.8] text-zinc-400">
          A who's-playing card sits in the channel and live-edits as the room
          races; after the midnight-ET reset, a recap lands with yesterday's
          podium and the season so far. Both below are drawn in your browser by
          the same canvas code the bot uses to render its PNGs.
        </p>
        <div className="mt-2 grid items-start gap-10 min-[820px]:grid-cols-[5fr_7fr]">
          <div className="flex flex-col gap-3">
            <RosterCard />
            <p className="text-pretty font-sans text-[12.5px] text-zinc-600">
              Today's room, mid-race. Grids edit in as guesses commit.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <RecapCard />
            <p className="text-pretty font-sans text-[12.5px] text-zinc-600">
              The daily recap: yesterday's results beside the season standings.
            </p>
          </div>
        </div>
      </section>

      <footer className="mt-28 flex flex-col gap-4 border-t border-white/10 pt-7 pb-2 min-[820px]:flex-row min-[820px]:items-center min-[820px]:justify-between">
        <p className="max-w-[58ch] text-pretty font-sans text-[12px] leading-relaxed text-zinc-600">
          A personal project, not affiliated with or endorsed by The New York
          Times. Puzzle content and the Connections name are NYT's.
        </p>
        <nav className="flex items-center gap-5 font-sans text-[12px] font-semibold text-zinc-500">
          <a href={GITHUB} className="transition-colors hover:text-zinc-200">
            GitHub
          </a>
          <a href={`${GITHUB}/blob/main/LICENSE`} className="transition-colors hover:text-zinc-200">
            MIT License
          </a>
          <a href="/privacy.html" className="transition-colors hover:text-zinc-200">
            Privacy
          </a>
          <a href="/terms.html" className="transition-colors hover:text-zinc-200">
            Terms
          </a>
        </nav>
      </footer>
    </div>
  );
}
