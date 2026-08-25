import { useEffect, useMemo, useRef, useState } from "react";
import { Board } from "./board";
import { GameView } from "./components";
import { Game, type Puzzle } from "./game";
import type { PlayerState } from "./player";
import { Roster, type RosterView } from "./roster";
import type { Standings } from "./season";

// SELF-PLAYING SCENES — harness only, never shipped.
//
// These are the sources we record the Discord App Directory art from: the gameplay
// preview video (#demo), the live-room scene (#room) and the 16:9 reel (#reel). They
// drive the REAL components by clicking their DOM, so what gets recorded is the actual
// game code rather than a mock-up.
//
// They used to live in landing.tsx and doubled as the landing page's decoration. The
// landing now plays today's real board instead, so the drivers moved here — imported
// only by src/preview.tsx, which is not an entry of the production build (vite builds
// index.html alone), so none of this reaches a visitor's bundle.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const noop = (): void => {};
const reducedMotion = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Stand-in "Discord photo": data-URI silhouette, so the demos render offline.
export const pfp = (bg: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='${bg}'/><circle cx='32' cy='25' r='13' fill='#ffffff'/><rect x='12' y='42' width='40' height='26' rx='13' fill='#ffffff'/></svg>`,
  );

// ——— Self-playing board ———————————————————————————————————————————————
// A made-up, Discord-flavored puzzle (never a real board, so a recording can't
// spoil a live day): the demo solves itself on the REAL Board component, so the
// pop→gather→morph choreography is the actual game code, not a replica.
const DEMO_PUZZLE: Puzzle = {
  id: 424242, // never a real puzzle id, so its spoiler/localStorage keys can't collide
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
// then remount and loop. The wrapper is pointer-events-none, so it can be
// watched but not played.
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
    // rows, measured) and the taller Season table scrolls internally instead of
    // growing the page. The flip can't move anything.
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
// multiplayer in one frame.
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
