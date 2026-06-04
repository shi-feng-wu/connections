import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// The card's font (the app UI uses different fonts). These live under src/, NOT
// api/_assets — under `vercel dev` anything served from /api/ is routed to the
// functions and 404s, which would fail this module's load and white-screen the whole
// preview. Dev-only copy of api/_assets/*.ttf; preview.tsx isn't in the prod build.
import LibreFranklin500 from "./preview-assets/LibreFranklin-500.ttf?url";
import LibreFranklin600 from "./preview-assets/LibreFranklin-600.ttf?url";
import LibreFranklin700 from "./preview-assets/LibreFranklin-700.ttf?url";
import LibreFranklin800 from "./preview-assets/LibreFranklin-800.ttf?url";
import Newsreader700 from "./preview-assets/Newsreader-700.ttf?url";
import { Game, MAX_MISTAKES, type Puzzle } from "./game";
import { cardLayout, type CardPlayer, drawRecap, type RecapData, recapLayout, drawRoster } from "./card-draw";
import { GameView, LoadingScreen } from "./components";
import { PipThumbnail } from "./pip";
import type { BoardRow, SelfStanding } from "./leaderboard";
import type { Standings } from "./season";
import { Roster } from "./roster";
import type { PlayerState } from "./realtime";

const puzzle: Puzzle = {
  id: 123,
  date: "2026-05-31",
  editor: "Wyna Liu",
  groups: [
    {
      level: 0,
      category: "THINGS THAT ARE YELLOW",
      members: ["BUTTER", "PIKACHU", "RUBBER DUCK", "SCHOOL BUS"],
    },
    { level: 1, category: "BACK ___", members: ["SALT", "STEAK", "BREAK", "JACK"] },
    { level: 2, category: "SPINE-ISH", members: ["SOAK", "POCKET", "SPINE", "TAR"] },
    { level: 3, category: "MISC", members: ["RACK", "SEA DOG", "SASH", "CUE"] },
  ],
  layout: [
    "SALT", "STEAK", "BREAK", "JACK",
    "SOAK", "POCKET", "SPINE", "TAR",
    "RACK", "SEA DOG", "SASH", "CUE",
    "BUTTER", "PIKACHU", "RUBBER DUCK", "SCHOOL BUS",
  ],
};

const solveGroup = (g: Game, members: string[]): void => {
  g.clear();
  for (const m of members) g.toggle(m);
  g.submit();
};

// In progress: one group solved, two tiles selected.
const playing = new Game(puzzle);
solveGroup(playing, puzzle.groups[0].members);
playing.toggle("SOAK");
playing.toggle("SPINE");

// Results · won (perfect): all four groups, no mistakes.
const perfect = new Game(puzzle);
for (const g of puzzle.groups) solveGroup(perfect, g.members);

// Results · won: one wrong guess, then all four groups solved.
const won = new Game(puzzle);
solveGroup(won, ["SALT", "SOAK", "RACK", "BUTTER"]); // one from each group
for (const g of puzzle.groups) solveGroup(won, g.members);

// Results · lost: two groups solved, then four wrong guesses exhaust mistakes
// (groups 2 & 3 revealed). Coherent with score + "Solved 2 of 4".
const lost = new Game(puzzle);
solveGroup(lost, puzzle.groups[0].members);
solveGroup(lost, puzzle.groups[1].members);
[
  ["SOAK", "POCKET", "SPINE", "RACK"],
  ["SOAK", "POCKET", "TAR", "SEA DOG"],
  ["SPINE", "RACK", "SASH", "CUE"],
  ["SOAK", "RACK", "TAR", "CUE"],
].forEach((guess) => solveGroup(lost, guess));

// mock room for the roster sidebar
const NOW = Date.now();
type Seed = {
  id: string;
  name: string;
  solved: number[];
  mistakesLeft: number;
  sec: number;
  done?: "won" | "lost";
  picking?: boolean;
  avatar?: string;
};

// Stand-in "Discord photo": data-URI silhouette so it renders offline in the
// screenshot harness and exercises the <img> path. No avatar falls back to the
// initial placeholder.
const pfp = (bg: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='${bg}'/><circle cx='32' cy='25' r='13' fill='#ffffff'/><rect x='12' y='42' width='40' height='26' rx='13' fill='#ffffff'/></svg>`,
  );

const SELF_ID = "guest-mara";
const seeds: Seed[] = [
  { id: "p-jun", name: "Jun Park", solved: [0, 1, 2, 3], mistakesLeft: 3, sec: 134, done: "won", avatar: pfp("#2f6fed") },
  { id: "p-aria", name: "Aria Voss", solved: [0, 1, 2, 3], mistakesLeft: 2, sec: 171, done: "won", avatar: pfp("#d9457a") },
  { id: "p-theo", name: "Theo Lindqvist", solved: [0, 1, 2], mistakesLeft: 4, sec: 168, picking: true },
  { id: "p-mei", name: "Mei Tanaka", solved: [0, 1, 3], mistakesLeft: 3, sec: 200, avatar: pfp("#1f9e6a") },
  { id: "p-noa", name: "Noa Friedman", solved: [1, 3], mistakesLeft: 3, sec: 252, picking: true },
  { id: "p-priya", name: "Priya Nair", solved: [0, 2], mistakesLeft: 2, sec: 211 },
  { id: "p-diego", name: "Diego Cruz", solved: [2, 3], mistakesLeft: 1, sec: 238 },
  { id: SELF_ID, name: "Mara Okafor", solved: [0], mistakesLeft: 3, sec: 182, avatar: pfp("#b06bd6") },
  { id: "p-sam", name: "Sam Cohen", solved: [2], mistakesLeft: 1, sec: 245 },
  { id: "p-yuki", name: "Yuki Sato", solved: [3], mistakesLeft: 0, sec: 310, done: "lost" },
  { id: "p-omar", name: "Omar Haddad", solved: [], mistakesLeft: 4, sec: 8 },
];
const ROSTER: PlayerState[] = seeds.map((s) => ({
  userId: s.id,
  name: s.name,
  avatar: s.avatar,
  mistakesLeft: s.mistakesLeft,
  solvedCount: s.solved.length,
  solvedLevels: s.solved,
  picking: !!s.picking,
  done: s.done ?? null,
  startedAt: NOW - s.sec * 1000,
  finishedAt: s.done ? NOW : null,
}));

// mock room leaderboard (both end-screen tabs)
const SELF_NAME = "Mara Okafor";
const SELF_AVATAR = pfp("#b06bd6");

// "This season": self is rank 9, below this top 5.
const SEASON: Standings = {
  board: [
    { user_id: "p-jun",  name: "Jun Park",       avatar: pfp("#2f6fed"), total: 12840, plays: 7, wins: 7, win_pct: 100, avg_mistakes: 1.1, streak: 12 },
    { user_id: "p-aria", name: "Aria Voss",      avatar: pfp("#d9457a"), total: 11715, plays: 7, wins: 6, win_pct: 86,  avg_mistakes: 1.6, streak: 9 },
    { user_id: "p-theo", name: "Theo Lindqvist", avatar: null,           total: 11660, plays: 7, wins: 6, win_pct: 86,  avg_mistakes: 1.4, streak: 7 },
    { user_id: "p-mei",  name: "Mei Tanaka",     avatar: pfp("#1f9e6a"), total: 10520, plays: 6, wins: 5, win_pct: 83,  avg_mistakes: 1.8, streak: 5 },
    { user_id: "p-noa",  name: "Noa Friedman",   avatar: null,           total: 9485,  plays: 7, wins: 5, win_pct: 71,  avg_mistakes: 2.0, streak: 4 },
  ] as BoardRow[],
  self: { rank: 9, total_players: 262, total: 8120, plays: 6, wins: 4, win_pct: 67, avg_mistakes: 1.9, streak: 5 } as SelfStanding,
};

// "All-time": bigger totals, deeper field, self at rank 14.
const ALLTIME: Standings = {
  board: [
    { user_id: "p-aria", name: "Aria Voss",      avatar: pfp("#d9457a"), total: 188450, plays: 142, wins: 121, win_pct: 85, avg_mistakes: 1.4, streak: 9 },
    { user_id: "p-jun",  name: "Jun Park",       avatar: pfp("#2f6fed"), total: 181200, plays: 150, wins: 118, win_pct: 79, avg_mistakes: 1.5, streak: 12 },
    { user_id: "p-theo", name: "Theo Lindqvist", avatar: null,           total: 165870, plays: 138, wins: 104, win_pct: 75, avg_mistakes: 1.6, streak: 7 },
    { user_id: "p-mei",  name: "Mei Tanaka",     avatar: pfp("#1f9e6a"), total: 140100, plays: 121, wins: 92,  win_pct: 76, avg_mistakes: 1.7, streak: 5 },
    { user_id: "p-diego",name: "Diego Cruz",     avatar: null,           total: 132500, plays: 130, wins: 88,  win_pct: 68, avg_mistakes: 2.1, streak: 3 },
  ] as BoardRow[],
  self: { rank: 14, total_players: 540, total: 96300, plays: 96, wins: 71, win_pct: 74, avg_mistakes: 1.7, streak: 5 } as SelfStanding,
};

const noop = (): void => {};

// The "who's playing today" Discord card, drawn live on a browser <canvas> with the
// SAME code the server uses for the PNG (src/card-draw.ts) — so this preview is the
// real thing, not a replica. Register the SAME static per-weight font instances the
// server registers (api/_card.ts) — one FontFace per weight — so the preview matches
// the PNG exactly. (The canvas backend won't interpolate a variable font's weight, so
// the server ships static slices; the preview mirrors them.) Offline, no network.
let fontsReady: Promise<void> | null = null;
function ensureBrandFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const faces = [
        new FontFace("Libre Franklin", `url(${LibreFranklin500})`, { weight: "500" }),
        new FontFace("Libre Franklin", `url(${LibreFranklin600})`, { weight: "600" }),
        new FontFace("Libre Franklin", `url(${LibreFranklin700})`, { weight: "700" }),
        new FontFace("Libre Franklin", `url(${LibreFranklin800})`, { weight: "800" }),
        new FontFace("Newsreader", `url(${Newsreader700})`, { weight: "700" }),
      ];
      await Promise.all(faces.map((f) => f.load()));
      faces.forEach((f) => document.fonts.add(f));
    })();
  }
  return fontsReady;
}

// Browser avatar loader (the server passes @napi-rs/canvas loadImage instead).
const loadCardImg = (url: string): Promise<CanvasImageSource | null> =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });

// Sample roster (matches the design mock): a win with one miss, a perfect win (the
// room leader → Trophy), a player mid-game, one who hasn't guessed, and a loss. Each
// grid is one row per guess (four group-levels 0..3); sec = elapsed/finish time.
const CARD_ROOM: CardPlayer[] = [
  { id: "p-jun", name: "Jun Park", avatar: pfp("#2f6fed"), sec: 134, grid: [[2, 1, 2, 2], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1], [3, 3, 3, 3]] },
  { id: "p-aria", name: "Aria Voss", avatar: pfp("#d9457a"), sec: 171, grid: [[3, 3, 3, 3], [0, 1, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]] },
  { id: "p-theo", name: "Theo Lindqvist", avatar: null, sec: 95, grid: [[0, 0, 0, 0], [3, 1, 2, 3]] },
  { id: "p-mei", name: "Mei Tanaka", avatar: pfp("#1f9e6a"), sec: 14, grid: [] },
  { id: "p-noa", name: "Noa Friedman", avatar: null, sec: 108, grid: [[1, 1, 1, 1], [3, 3, 3, 3], [0, 0, 0, 0], [2, 2, 2, 2]] },
  { id: "p-omar", name: "Omar Haddad", avatar: pfp("#e0a32e"), sec: 224, grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 3, 2, 2], [3, 2, 3, 3], [2, 3, 3, 2], [3, 2, 2, 3]] },
];
const CARD_BUSY: CardPlayer[] = [
  ...CARD_ROOM,
  { id: "p-priya", name: "Priya Nair", avatar: pfp("#7f9cf5"), sec: 156, grid: [[2, 2, 2, 2], [0, 0, 0, 0], [3, 1, 3, 3], [1, 1, 1, 1], [3, 3, 3, 3]] },
  { id: "p-diego", name: "Diego Cruz", avatar: null, sec: 61, grid: [[3, 3, 3, 3]] },
  { id: "p-yuki", name: "Yuki Sato", avatar: pfp("#56b6c2"), sec: 142, grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]] },
  { id: "p-sam", name: "Sam Cohen", avatar: null, sec: 33, grid: [[2, 0, 2, 2]] },
];
const CARD_SOLO: CardPlayer[] = [CARD_ROOM[2]]; // Theo, mid-game

// The daily recap posted on the Connections reset: yesterday's results beside the
// month's season standings (mirrors the design mock + scripts/card-preview.mts).
const CARD_RECAP: RecapData = {
  puzzleNo: 1169,
  puzzleDate: "2026-05-30",
  season: "May",
  streak: 12,
  winRate: 84,
  results: [
    { id: "p-noa", name: "Noa Friedman", avatar: pfp("#2f6fed"), solved: true, score: 96, mistakes: 0, sec: 102 },
    { id: "p-theo", name: "Theo Lindqvist", avatar: null, solved: true, score: 91, mistakes: 0, sec: 88 },
    { id: "p-jun", name: "Jun Park", avatar: pfp("#d9457a"), solved: true, score: 84, mistakes: 1, sec: 141 },
    { id: "p-priya", name: "Priya Nair", avatar: null, solved: true, score: 77, mistakes: 1, sec: 169 },
    { id: "p-aria", name: "Aria Voss", avatar: pfp("#1f9e6a"), solved: true, score: 68, mistakes: 2, sec: 203 },
    { id: "p-yuki", name: "Yuki Sato", avatar: null, solved: true, score: 61, mistakes: 3, sec: 247 },
    { id: "p-omar", name: "Omar Haddad", avatar: null, solved: false, score: 12, mistakes: 4, sec: null },
  ],
  standings: [
    { id: "p-noa", name: "Noa Friedman", avatar: pfp("#2f6fed"), total: 487, wins: 6, plays: 7 },
    { id: "p-jun", name: "Jun Park", avatar: pfp("#d9457a"), total: 441, wins: 4, plays: 7 },
    { id: "p-aria", name: "Aria Voss", avatar: pfp("#1f9e6a"), total: 408, wins: 3, plays: 7 },
    { id: "p-theo", name: "Theo Lindqvist", avatar: null, total: 372, wins: 3, plays: 6 },
    { id: "p-priya", name: "Priya Nair", avatar: null, total: 339, wins: 2, plays: 6 },
  ],
};

function Card({ label, players }: { label: string; players: CardPlayer[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureBrandFonts().catch(() => {}); // fall back to a system font if it won't load
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const scratch = document.createElement("canvas").getContext("2d");
      if (!scratch) return;
      const opts = { puzzleNo: 1170, puzzleDate: "2026-05-31" };
      const layout = cardLayout(scratch, players, opts);
      canvas.width = layout.W; // true pixel size (CSS scales it down to fit the page)
      canvas.height = layout.height;
      const ctx = canvas.getContext("2d");
      if (ctx) await drawRoster(ctx, players, opts, layout, { loadImg: loadCardImg, Path2D: window.Path2D });
    })();
    return () => {
      cancelled = true;
    };
  }, [players]);
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">{label}</div>
      <canvas ref={ref} className="rounded-xl shadow-lg" style={{ width: "min(560px, 100%)" }} />
    </section>
  );
}

// The daily recap card, drawn live on a browser <canvas> with the SAME code the
// server uses for the PNG (src/card-draw.ts:drawRecap) — so this preview is the real
// thing. Width is fixed (878px), so no scratch-measure pass is needed.
function Recap({ label, data }: { label: string; data: RecapData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureBrandFonts().catch(() => {});
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const layout = recapLayout(data);
      canvas.width = layout.W; // true pixel size (CSS scales it down to fit the page)
      canvas.height = layout.height;
      const ctx = canvas.getContext("2d");
      if (ctx) await drawRecap(ctx, data, layout, { loadImg: loadCardImg, Path2D: window.Path2D });
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">{label}</div>
      <canvas ref={ref} className="rounded-xl shadow-lg" style={{ width: "min(880px, 100%)" }} />
    </section>
  );
}

const SIMBTN =
  "cursor-pointer rounded-full border border-zinc-700 bg-zinc-900 px-3.5 py-1.5 text-[12px] font-semibold text-zinc-200 transition hover:bg-zinc-800 hover:text-white disabled:cursor-default disabled:opacity-40";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeout = 8000): Promise<void> => {
  const start = performance.now();
  while (!cond() && performance.now() - start < timeout) await delay(80);
};

// Interactive playground: a fresh, live GameView that the buttons drive through
// the real board (clicking tiles + Submit), so the solve/fail choreography and
// the end-screen transition play exactly as in the app. Reset re-mounts a new game.
function Simulate() {
  const [key, setKey] = useState(0);
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const game = useMemo(() => new Game(puzzle), [key]);

  const tile = (w: string): HTMLElement | null | undefined =>
    ref.current?.querySelector<HTMLElement>(`[data-flip="${CSS.escape(w)}"]`);
  const btn = (label: string): HTMLButtonElement | undefined =>
    [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === label,
    );
  const select = (words: string[]): void => words.forEach((w) => tile(w)?.click());
  // Submit is disabled until the 4-tile selection lands on the next render, and
  // .click() on a disabled button is a no-op — so wait for it to enable, then click.
  const submitGuess = async (): Promise<void> => {
    await until(() => btn("Submit") != null && !btn("Submit")!.disabled);
    btn("Submit")?.click();
  };
  // live counts read off the DOM, so the driver waits on real readiness rather
  // than fixed timers (robust on any machine speed).
  const tilesLeft = (): number =>
    ref.current?.querySelectorAll('[data-flip]:not([data-flip^="bar-"])').length ?? 0;
  const mistakesLeft = (): number =>
    [...(ref.current?.querySelectorAll<HTMLElement>("[data-dot]") ?? [])].filter((d) =>
      d.className.includes("bg-zinc-300"),
    ).length;

  async function simulateSolve(): Promise<void> {
    if (running) return;
    setRunning(true);
    for (const g of puzzle.groups) {
      const before = tilesLeft();
      btn("Deselect all")?.click();
      select(g.members);
      await submitGuess();
      await until(() => tilesLeft() <= before - 4); // group accepted + removed
      await delay(450); // let the morph settle before the next guess
    }
    setRunning(false);
  }

  async function simulateFail(): Promise<void> {
    if (running) return;
    setRunning(true);
    const cols = puzzle.groups.map((g) => g.members);
    // one tile from each group is never a real group, so every guess is wrong;
    // a different column each round keeps the four guesses distinct.
    for (let i = 0; i < MAX_MISTAKES; i++) {
      const before = mistakesLeft();
      btn("Deselect all")?.click();
      select(cols.map((c) => c[i]));
      await submitGuess();
      await until(() => mistakesLeft() < before); // mistake registered
      await delay(350);
    }
    setRunning(false);
  }

  function reset(): void {
    setKey((k) => k + 1);
    window.scrollTo({ top: 0 });
  }

  // #feedback isolates this playground and auto-fires a one-away guess (3 of one
  // group + 1 other), so the transient "One away…" pill shows up in the header
  // score slot — the same spot the end-screen hero lands.
  useEffect(() => {
    if (location.hash.toLowerCase() !== "#feedback") return;
    void (async () => {
      await until(() => tilesLeft() >= 16);
      select([
        puzzle.groups[0].members[0],
        puzzle.groups[0].members[1],
        puzzle.groups[0].members[2],
        puzzle.groups[1].members[0],
      ]);
      await submitGuess();
    })();
  }, []);

  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
          Simulate
        </span>
        <button className={SIMBTN} disabled={running} onClick={() => void simulateSolve()}>
          Simulate solve
        </button>
        <button className={SIMBTN} disabled={running} onClick={() => void simulateFail()}>
          Simulate fail
        </button>
        <button className={SIMBTN} onClick={reset}>
          Reset
        </button>
      </div>
      <div ref={ref}>
        <GameView
          key={key}
          game={game}
          gameKey={`sim-${key}`}
          players={ROSTER}
          selfId={SELF_ID}
          selfName={SELF_NAME}
          selfAvatar={SELF_AVATAR}
          season={SEASON}
          allTime={ALLTIME}
          onPresence={noop}
          onFinish={noop}
        />
      </div>
    </section>
  );
}

function State({
  label,
  game,
  revealed,
}: {
  label: string;
  game: Game;
  revealed?: number[];
}) {
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <GameView
        game={game}
        gameKey={label}
        players={ROSTER}
        selfId={SELF_ID}
        selfName={SELF_NAME}
        selfAvatar={SELF_AVATAR}
        season={SEASON}
        allTime={ALLTIME}
        initialRevealed={revealed}
        onPresence={noop}
        onFinish={noop}
      />
    </section>
  );
}

// The collapsed picture-in-picture thumbnail (src/pip.tsx). Rendered in a fixed box
// at the minimized window's ~16:10 ratio (≈976×608) — the size Discord gives it — to
// check the centered board mini at a glance. A couple of sizes confirm it scales.
function PipState({
  label,
  game,
  revealed,
  w,
  h,
}: {
  label: string;
  game: Game | null;
  revealed?: number[];
  w: number;
  h: number;
}) {
  return (
    <section className="px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <div
        style={{ width: w, height: h }}
        className="overflow-hidden rounded-xl ring-1 ring-zinc-800"
      >
        <PipThumbnail game={game} revealed={revealed} />
      </div>
    </section>
  );
}

// wraps LoadingScreen the way State wraps GameView
function LoadState({
  label,
  error,
  blocked,
}: {
  label: string;
  error?: boolean;
  blocked?: boolean;
}) {
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <LoadingScreen error={error} blocked={blocked} onRetry={noop} />
    </section>
  );
}

// Preview states. A `#filter` in the URL (e.g. #lost, #perfect) narrows to
// states whose label includes it, letting the harness isolate one.
const STATES = [
  <LoadState key="ld" label="Loading" />,
  <LoadState key="er" label="Error · couldn’t load" error />,
  <LoadState key="bl" label="Blocked · open in Discord" blocked />,
  <State key="p" label="In progress" game={playing} />,
  <State key="pf" label="Results · won · perfect" game={perfect} />,
  <State key="w" label="Results · won" game={won} />,
  <State key="l" label="Results · lost" game={lost} revealed={[2, 3]} />,
];
const pick = decodeURIComponent(location.hash.slice(1)).toLowerCase();
const known = ["progress", "perfect", "won", "lost", "loading", "error", "blocked", "simulate", "feedback", "card", "pip"];
// #simulate and #feedback both isolate the Simulate playground (#feedback also
// auto-fires a one-away guess to surface the header feedback pill); #card isolates the
// Discord "who's playing" card; #pip isolates the collapsed PIP thumbnail.
const onlySim = pick === "simulate" || pick === "feedback";
const onlyCard = pick === "card";
const onlyPip = pick === "pip";
const shown =
  known.includes(pick) && !onlySim && !onlyCard && !onlyPip
    ? STATES.filter((s) => String(s.props.label).toLowerCase().includes(pick))
    : onlyCard || onlyPip
      ? []
      : STATES;
// Simulate playground rides on top by default; #simulate / #feedback isolate it. The
// cards + PIP thumbnails ride at the bottom by default; #card / #pip isolate them.
const showSim = pick === "" || onlySim;
const showCards = pick === "" || onlyCard;
const showPips = pick === "" || onlyPip;

createRoot(document.getElementById("preview")!).render(
  <div className="flex flex-col items-center gap-16 py-10">
    {showSim && <Simulate />}
    {!onlySim && shown}
    {showPips && (
      <div className="flex flex-col items-center gap-8">
        <PipState label="PIP thumbnail · in progress (976×608)" game={playing} w={488} h={304} />
        <PipState label="PIP thumbnail · lost" game={lost} revealed={[2, 3]} w={488} h={304} />
        <PipState label="PIP thumbnail · won" game={won} w={488} h={304} />
        <PipState label="PIP thumbnail · loading" game={null} w={488} h={304} />
        <PipState label="PIP thumbnail · narrow PIP (square)" game={playing} w={320} h={320} />
      </div>
    )}
    {showCards && <Card label="Discord card · who's playing today" players={CARD_ROOM} />}
    {showCards && <Card label="Discord card · busy room" players={CARD_BUSY} />}
    {showCards && <Card label="Discord card · single player" players={CARD_SOLO} />}
    {showCards && <Recap label="Discord recap · daily reset post" data={CARD_RECAP} />}
    {!onlySim && !onlyCard && (
      <section className="w-full max-w-[360px] px-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
          Roster panel · standalone (Live tab)
        </div>
        <Roster players={ROSTER} selfId={SELF_ID} />
      </section>
    )}
  </div>,
);
