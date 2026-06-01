import { createRoot } from "react-dom/client";
import "./index.css";
import { Game, type Puzzle } from "./game";
import { GameView, LoadingScreen } from "./components";
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

// wraps LoadingScreen the way State wraps GameView
function LoadState({ label, error }: { label: string; error?: boolean }) {
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <LoadingScreen error={error} onRetry={noop} />
    </section>
  );
}

// Preview states. A `#filter` in the URL (e.g. #lost, #perfect) narrows to
// states whose label includes it, letting the harness isolate one.
const STATES = [
  <LoadState key="ld" label="Loading" />,
  <LoadState key="er" label="Error · couldn’t load" error />,
  <State key="p" label="In progress" game={playing} />,
  <State key="pf" label="Results · won · perfect" game={perfect} />,
  <State key="w" label="Results · won" game={won} />,
  <State key="l" label="Results · lost" game={lost} revealed={[2, 3]} />,
];
const pick = decodeURIComponent(location.hash.slice(1)).toLowerCase();
const known = ["progress", "perfect", "won", "lost", "loading", "error"];
const shown = known.includes(pick)
  ? STATES.filter((s) => String(s.props.label).toLowerCase().includes(pick))
  : STATES;

createRoot(document.getElementById("preview")!).render(
  <div className="flex flex-col items-center gap-16 py-10">
    {shown}
    <section className="w-full max-w-[360px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Roster panel · standalone (click “see all”)
      </div>
      <Roster players={ROSTER} selfId={SELF_ID} defaultOpen={location.hash === "#seeall"} />
    </section>
  </div>,
);
