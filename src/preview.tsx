import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// The card's font (the app UI uses different fonts). These live under src/, NOT
// api/_assets — under `vercel dev` anything served from /api/ is routed to the
// functions and 404s, which would fail this module's load and white-screen the whole
// preview. Dev-only copy of api/_assets/*.ttf; preview.tsx isn't in the prod build.
import {
  cardLayout,
  type CardPlayer,
  drawRecap,
  drawRoster,
  type RecapData,
  recapLayout,
} from "./card-draw";
import { DayTurnover, GameView, LoadingScreen } from "./components";
import { Game, MAX_MISTAKES, type Puzzle } from "./game";
import { DemoBoard, DemoGame, DemoRoster, Landing } from "./landing";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { PipThumbnail } from "./pip";
import type { PlayerState } from "./player";
import LibreFranklin500 from "./preview-assets/LibreFranklin-500.ttf?url";
import LibreFranklin600 from "./preview-assets/LibreFranklin-600.ttf?url";
import LibreFranklin700 from "./preview-assets/LibreFranklin-700.ttf?url";
import LibreFranklin800 from "./preview-assets/LibreFranklin-800.ttf?url";
import Newsreader700 from "./preview-assets/Newsreader-700.ttf?url";
import { Roster } from "./roster";
import { LedgerBody, type Standings } from "./season";

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
    {
      level: 1,
      category: "BACK ___",
      members: ["SALT", "STEAK", "BREAK", "JACK"],
    },
    {
      level: 2,
      category: "SPINE-ISH",
      members: ["SOAK", "POCKET", "SPINE", "TAR"],
    },
    { level: 3, category: "MISC", members: ["RACK", "SEA DOG", "SASH", "CUE"] },
  ],
  layout: [
    "SALT",
    "STEAK",
    "BREAK",
    "JACK",
    "SOAK",
    "POCKET",
    "SPINE",
    "TAR",
    "RACK",
    "SEA DOG",
    "SASH",
    "CUE",
    "BUTTER",
    "PIKACHU",
    "RUBBER DUCK",
    "SCHOOL BUS",
  ],
};

// Image-card puzzles: NYT periodically ships boards where cards are SVG art instead
// of text — April Fools glyphs (2025-04-01), but also illustration puzzles (Halloween
// 2025-10-31, "objects with teeth" 2024-12-12, …) and even a MIXED board with a single
// image card (2026-03-07). All are monochrome black line-art, so they render on the
// light/colored faces and invert to white on the dark selected tile. Real NYT URLs,
// fetched via the dev /api/card-image proxy (vite.config.ts); spec rows are
// [position, word, imageUrl|null] (null = a plain text card, for the mixed case).
const G = "https://games-assets.storage.googleapis.com/images/connections/";
const S3 =
  "https://games-phoenix-assets-prd.s3.us-east-1.amazonaws.com/images/connections/";
type ImgSpec = { cat: string; cards: [number, string, string | null][] }[];
function makeImagePuzzle(id: number, date: string, spec: ImgSpec): Puzzle {
  const layout: string[] = new Array(16);
  const images: Record<string, string> = {};
  for (const grp of spec)
    for (const [pos, word, url] of grp.cards) {
      layout[pos] = word;
      if (url) images[word] = url;
    }
  return {
    id,
    date,
    editor: "Wyna Liu",
    groups: spec.map((g, level) => ({ level, category: g.cat, members: g.cards.map((c) => c[1]) })),
    layout,
    images: Object.keys(images).length ? images : undefined,
  };
}

const aprilSpec: ImgSpec = [
  { cat: "CURRENCY SYMBOLS", cards: [
    [9, "$", G + "img-672-1741385500318.svg"], [7, "€", G + "img-672-1741385405264.svg"],
    [12, "£", G + "img-672-1741385535485.svg"], [15, "¥", G + "img-672-1741385550960.svg"] ] },
  { cat: "AND/TOGETHER WITH", cards: [
    [1, "&", G + "img-672-1741385375789.svg"], [11, "+", G + "img-672-1741385524739.svg"],
    [4, "N", G + "img-672-1741385471593.svg"], [2, "X", G + "img-672-1741385381316.svg"] ] },
  { cat: "EMOTICON MOUTHS", cards: [
    [10, "(", G + "img-672-1741385519456.svg"], [3, ")", G + "img-672-1741385387026.svg"],
    [5, "O", G + "img-672-1741385482138.svg"], [6, "P", G + "img-672-1741385400407.svg"] ] },
  { cat: '"RIGHT"', cards: [
    [14, "R", G + "img-672-1741385546677.svg"], [8, "→", G + "img-672-1741385493388.svg"],
    [0, "⊾", S3 + "img-672-1769525276972.svg"], [13, "✔", G + "img-672-1741385542012.svg"] ] },
];
const aprilPuzzle = makeImagePuzzle(672, "2025-04-01", aprilSpec);

// Halloween 2025-10-31 #895: detailed line-art illustrations (a chair, a pumpkin, …)
// — the case that stresses tile/bar image sizing the most (vs. the bold April glyphs).
const halloweenSpec = [{"cat":"GOLDILOCKS","cards":[[8,"CHAIR",G+"img-895-1757706910364.svg"],[5,"BEAR",G+"img-895-1757706874238.svg"],[13,"PORRIDGE",G+"img-895-1757707251392.svg"],[3,"BED",G+"img-895-1757705840981.svg"]]},{"cat":"CINDERELLA","cards":[[15,"WAND",G+"img-895-1757707281139.svg"],[1,"PUMPKIN",G+"img-895-1757706798830.svg"],[6,"MOUSE",G+"img-895-1757705860939.svg"],[10,"SLIPPER",G+"img-895-1757707309688.svg"]]},{"cat":"POPEYE","cards":[[12,"PIPE",G+"img-895-1757707234261.svg"],[4,"ANCHOR",G+"img-895-1757706858499.svg"],[14,"SPINACH",G+"img-895-1757707269194.svg"],[11,"CAP",G+"img-895-1757705893678.svg"]]},{"cat":"MS. PAC-MAN","cards":[[0,"GHOST",G+"img-895-1757706782308.svg"],[9,"PELLETS",G+"img-895-1758821529822.svg"],[2,"BOW",G+"img-895-1757706839069.svg"],[7,"CHERRIES",G+"img-895-1757706896339.svg"]]}] as ImgSpec;
const halloweenPuzzle = makeImagePuzzle(895, "2025-10-31", halloweenSpec);

// Mixed 2026-03-07 #1028: 15 text cards + ONE image card ("THIS GAME"). Exercises the
// per-card fallback — that tile renders the image while its solved bar (not all four
// members have images) shows plain text.
const mixedSpec = [{"cat":"$1","cards":[[8,"BUCK",null],[15,"DOLLAR",null],[0,"ONE",null],[6,"SINGLE",null]]},{"cat":'"WHEREFORE ART THOU ROMEO?"',"cards":[[9,"ART",null],[7,"ROMEO",null],[1,"THOU",null],[13,"WHEREFORE",null]]},{"cat":'WORDS BEFORE "CASTLE"',"cards":[[10,"BOUNCY",null],[4,"NEW",null],[2,"SAND",null],[12,"WHITE",null]]},{"cat":"WHERE YOU MIGHT MAKE A CONNECTION","cards":[[3,"THIS GAME",S3+"img-1028-1769015007651.svg"],[11,"AIRPORT",null],[5,"DATING APP",null],[14,"INTERNET CAFE",null]]}] as ImgSpec;
const mixedPuzzle = makeImagePuzzle(1028, "2026-03-07", mixedSpec);

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

// April-Fools image puzzle, in progress: currency group solved (so a solved bar shows
// the glyph row), and two tiles selected (so the dark-tile white-invert shows).
const april = new Game(aprilPuzzle);
solveGroup(april, aprilPuzzle.groups[0].members);
april.toggle("&");
april.toggle("+");

// Same puzzle, won, so the end-screen spoiler/solved bars render their glyph rows.
const aprilWon = new Game(aprilPuzzle);
for (const g of aprilPuzzle.groups) solveGroup(aprilWon, g.members);

// Halloween illustration puzzle: one group solved (solved bar of illustrations) + two
// tiles selected (invert check on detailed line-art), and a won state for all four bars.
const halloween = new Game(halloweenPuzzle);
solveGroup(halloween, halloweenPuzzle.groups[0].members);
halloween.toggle("WAND");
halloween.toggle("PUMPKIN");
const halloweenWon = new Game(halloweenPuzzle);
for (const g of halloweenPuzzle.groups) solveGroup(halloweenWon, g.members);

// Mixed puzzle in progress: the image card ("THIS GAME") sits among text tiles; one
// text group solved so a plain text bar shows beside the image tile.
const mixed = new Game(mixedPuzzle);
solveGroup(mixed, mixedPuzzle.groups[0].members);
mixed.toggle("THIS GAME");
mixed.toggle("AIRPORT");

// mock room for the roster sidebar
const NOW = Date.now();
type Seed = {
  id: string;
  name: string;
  solved: number[];
  mistakesLeft: number;
  sec: number;
  done?: "won" | "lost";
  online?: boolean;
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
  {
    id: "p-jun",
    name: "Jun Park",
    solved: [0, 1, 2, 3],
    mistakesLeft: 3,
    sec: 134,
    done: "won",
    avatar: pfp("#2f6fed"),
  },
  {
    id: "p-aria",
    name: "Aria Voss",
    solved: [0, 1, 2, 3],
    mistakesLeft: 2,
    sec: 171,
    done: "won",
    avatar: pfp("#d9457a"),
  },
  {
    id: "p-theo",
    name: "Theo Lindqvist",
    solved: [0, 1, 2],
    mistakesLeft: 4,
    sec: 168,
    online: true,
  },
  {
    id: "p-mei",
    name: "Mei Tanaka",
    solved: [0, 1, 3],
    mistakesLeft: 3,
    sec: 200,
    online: true,
    avatar: pfp("#1f9e6a"),
  },
  {
    id: "p-noa",
    name: "Noa Friedman",
    solved: [1, 3],
    mistakesLeft: 3,
    sec: 252,
    online: true,
  },
  {
    id: "p-priya",
    name: "Priya Nair",
    solved: [0, 2],
    mistakesLeft: 2,
    sec: 211,
  },
  {
    id: "p-diego",
    name: "Diego Cruz",
    solved: [2, 3],
    mistakesLeft: 1,
    sec: 238,
  },
  {
    id: SELF_ID,
    name: "Mara Okafor",
    solved: [0],
    mistakesLeft: 3,
    sec: 182,
    online: true,
    avatar: pfp("#b06bd6"),
  },
  { id: "p-sam", name: "Sam Cohen", solved: [2], mistakesLeft: 1, sec: 245 },
  {
    id: "p-yuki",
    name: "Yuki Sato",
    solved: [3],
    mistakesLeft: 0,
    sec: 310,
    done: "lost",
  },
  {
    id: "p-omar",
    name: "Omar Haddad",
    solved: [],
    mistakesLeft: 4,
    sec: 8,
    online: true,
  },
];
const ROSTER: PlayerState[] = seeds.map((s) => ({
  userId: s.id,
  name: s.name,
  avatar: s.avatar,
  mistakesLeft: s.mistakesLeft,
  solvedCount: s.solved.length,
  solvedLevels: s.solved,
  picking: false,
  online: !!s.online,
  done: s.done ?? null,
  startedAt: NOW - s.sec * 1000,
  finishedAt: s.done ? NOW : null,
}));

// mock room leaderboard (both end-screen tabs)
// "This season": self is rank 9, below this top 5.
const SEASON: Standings = {
  board: [
    {
      user_id: "p-jun",
      name: "Jun Park",
      avatar: pfp("#2f6fed"),
      total: 12840,
      plays: 7,
      wins: 7,
      win_pct: 100,
      avg_mistakes: 1.1,
      streak: 12,
    },
    {
      user_id: "p-aria",
      name: "Aria Voss",
      avatar: pfp("#d9457a"),
      total: 11715,
      plays: 7,
      wins: 6,
      win_pct: 86,
      avg_mistakes: 1.6,
      streak: 9,
    },
    {
      user_id: "p-theo",
      name: "Theo Lindqvist",
      avatar: null,
      total: 11660,
      plays: 7,
      wins: 6,
      win_pct: 86,
      avg_mistakes: 1.4,
      streak: 7,
    },
    {
      user_id: "p-mei",
      name: "Mei Tanaka",
      avatar: pfp("#1f9e6a"),
      total: 10520,
      plays: 6,
      wins: 5,
      win_pct: 83,
      avg_mistakes: 1.8,
      streak: 5,
    },
    {
      user_id: "p-noa",
      name: "Noa Friedman",
      avatar: null,
      total: 9485,
      plays: 7,
      wins: 5,
      win_pct: 71,
      avg_mistakes: 2.0,
      streak: 4,
    },
  ] as BoardRow[],
  self: {
    rank: 9,
    total_players: 262,
    total: 8120,
    plays: 6,
    wins: 4,
    win_pct: 67,
    avg_mistakes: 1.9,
    streak: 5,
  } as SelfStanding,
};

// "All-time": bigger totals, deeper field, self at rank 14.
const ALLTIME: Standings = {
  board: [
    {
      user_id: "p-aria",
      name: "Aria Voss",
      avatar: pfp("#d9457a"),
      total: 188450,
      plays: 142,
      wins: 121,
      win_pct: 85,
      avg_mistakes: 1.4,
      streak: 9,
    },
    {
      user_id: "p-jun",
      name: "Jun Park",
      avatar: pfp("#2f6fed"),
      total: 181200,
      plays: 150,
      wins: 118,
      win_pct: 79,
      avg_mistakes: 1.5,
      streak: 12,
    },
    {
      user_id: "p-theo",
      name: "Theo Lindqvist",
      avatar: null,
      total: 165870,
      plays: 138,
      wins: 104,
      win_pct: 75,
      avg_mistakes: 1.6,
      streak: 7,
    },
    {
      user_id: "p-mei",
      name: "Mei Tanaka",
      avatar: pfp("#1f9e6a"),
      total: 140100,
      plays: 121,
      wins: 92,
      win_pct: 76,
      avg_mistakes: 1.7,
      streak: 5,
    },
    {
      user_id: "p-diego",
      name: "Diego Cruz",
      avatar: null,
      total: 132500,
      plays: 130,
      wins: 88,
      win_pct: 68,
      avg_mistakes: 2.1,
      streak: 3,
    },
  ] as BoardRow[],
  self: {
    rank: 14,
    total_players: 540,
    total: 96300,
    plays: 96,
    wins: 71,
    win_pct: 74,
    avg_mistakes: 1.7,
    streak: 5,
  } as SelfStanding,
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
        new FontFace("Libre Franklin", `url(${LibreFranklin500})`, {
          weight: "500",
        }),
        new FontFace("Libre Franklin", `url(${LibreFranklin600})`, {
          weight: "600",
        }),
        new FontFace("Libre Franklin", `url(${LibreFranklin700})`, {
          weight: "700",
        }),
        new FontFace("Libre Franklin", `url(${LibreFranklin800})`, {
          weight: "800",
        }),
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
  {
    id: "p-jun",
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
    id: "p-aria",
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
    id: "p-theo",
    name: "Theo Lindqvist",
    avatar: null,
    sec: 95,
    grid: [
      [0, 0, 0, 0],
      [3, 1, 2, 3],
    ],
  },
  {
    id: "p-mei",
    name: "Mei Tanaka",
    avatar: pfp("#1f9e6a"),
    sec: 14,
    grid: [],
  },
  {
    id: "p-noa",
    name: "Noa Friedman",
    avatar: null,
    sec: 108,
    grid: [
      [1, 1, 1, 1],
      [3, 3, 3, 3],
      [0, 0, 0, 0],
      [2, 2, 2, 2],
    ],
  },
  {
    id: "p-omar",
    name: "Omar Haddad",
    avatar: pfp("#e0a32e"),
    sec: 224,
    grid: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 3, 2, 2],
      [3, 2, 3, 3],
      [2, 3, 3, 2],
      [3, 2, 2, 3],
    ],
  },
];
const CARD_BUSY: CardPlayer[] = [
  ...CARD_ROOM,
  {
    id: "p-priya",
    name: "Priya Nair",
    avatar: pfp("#7f9cf5"),
    sec: 156,
    grid: [
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [3, 1, 3, 3],
      [1, 1, 1, 1],
      [3, 3, 3, 3],
    ],
  },
  {
    id: "p-diego",
    name: "Diego Cruz",
    avatar: null,
    sec: 61,
    grid: [[3, 3, 3, 3]],
  },
  {
    id: "p-yuki",
    name: "Yuki Sato",
    avatar: pfp("#56b6c2"),
    sec: 142,
    grid: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 2, 2, 2],
      [3, 3, 3, 3],
    ],
  },
  {
    id: "p-sam",
    name: "Sam Cohen",
    avatar: null,
    sec: 33,
    grid: [[2, 0, 2, 2]],
  },
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
  guildName: "Puzzle Club",
  channelName: "daily-connections",
  results: [
    {
      id: "p-noa",
      name: "Noa Friedman",
      avatar: pfp("#2f6fed"),
      solved: true,
      score: 96,
      mistakes: 0,
      solvedLevels: [2, 1, 0, 3],
      sec: 102,
    },
    {
      id: "p-theo",
      name: "Theo Lindqvist",
      avatar: null,
      solved: true,
      score: 91,
      mistakes: 0,
      solvedLevels: [3, 2, 1, 0],
      sec: 88,
    },
    {
      id: "p-jun",
      name: "Jun Park",
      avatar: pfp("#d9457a"),
      solved: true,
      score: 84,
      mistakes: 1,
      solvedLevels: [0, 1, 2, 3],
      sec: 141,
    },
    {
      id: "p-priya",
      name: "Priya Nair",
      avatar: null,
      solved: true,
      score: 77,
      mistakes: 1,
      solvedLevels: [1, 0, 3, 2],
      sec: 169,
    },
    {
      id: "p-aria",
      name: "Aria Voss",
      avatar: pfp("#1f9e6a"),
      solved: true,
      score: 68,
      mistakes: 2,
      solvedLevels: [3, 1, 2, 0],
      sec: 203,
    },
    {
      id: "p-yuki",
      name: "Yuki Sato",
      avatar: null,
      solved: true,
      score: 61,
      mistakes: 3,
      solvedLevels: [0, 2, 1, 3],
      sec: 247,
    },
    {
      id: "p-omar",
      name: "Omar Haddad",
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
      id: "p-noa",
      name: "Noa Friedman",
      avatar: pfp("#2f6fed"),
      total: 487,
      wins: 6,
      plays: 7,
    },
    {
      id: "p-jun",
      name: "Jun Park",
      avatar: pfp("#d9457a"),
      total: 441,
      wins: 4,
      plays: 7,
    },
    {
      id: "p-aria",
      name: "Aria Voss",
      avatar: pfp("#1f9e6a"),
      total: 408,
      wins: 3,
      plays: 7,
    },
    {
      id: "p-theo",
      name: "Theo Lindqvist",
      avatar: null,
      total: 372,
      wins: 3,
      plays: 6,
    },
    {
      id: "p-priya",
      name: "Priya Nair",
      avatar: null,
      total: 339,
      wins: 2,
      plays: 6,
    },
  ],
};

// No-play day: every active channel still gets a card. The results column stands in dashed
// "ghost" rows, the subline reads "No Plays", and the streak resets to 0 (the "Streak broken!
// Nobody got it… new day 🌞" copy rides in the Discord message body).
const CARD_RECAP_EMPTY: RecapData = {
  ...CARD_RECAP,
  streak: 0,
  results: [],
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
      if (ctx)
        await drawRoster(ctx, players, opts, layout, {
          loadImg: loadCardImg,
          Path2D: window.Path2D,
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [players]);
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <canvas
        ref={ref}
        className="rounded-xl shadow-lg"
        style={{ width: "min(560px, 100%)" }}
      />
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
      if (ctx)
        await drawRecap(ctx, data, layout, {
          loadImg: loadCardImg,
          Path2D: window.Path2D,
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
      </div>
      <canvas
        ref={ref}
        className="rounded-xl shadow-lg"
        style={{ width: "min(880px, 100%)" }}
      />
    </section>
  );
}

const SIMBTN =
  "cursor-pointer rounded-full border border-zinc-700 bg-zinc-900 px-3.5 py-1.5 text-[12px] font-semibold text-zinc-200 transition hover:bg-zinc-800 hover:text-white disabled:cursor-default disabled:opacity-40";
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
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
    [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((b) => b.textContent?.trim() === label);
  const select = (words: string[]): void =>
    words.forEach((w) => tile(w)?.click());
  // Submit is disabled until the 4-tile selection lands on the next render, and
  // .click() on a disabled button is a no-op — so wait for it to enable, then click.
  const submitGuess = async (): Promise<void> => {
    await until(() => btn("Submit") != null && !btn("Submit")!.disabled);
    btn("Submit")?.click();
  };
  // live counts read off the DOM, so the driver waits on real readiness rather
  // than fixed timers (robust on any machine speed).
  const tilesLeft = (): number =>
    ref.current?.querySelectorAll('[data-flip]:not([data-flip^="bar-"])')
      .length ?? 0;
  const mistakesLeft = (): number =>
    [
      ...(ref.current?.querySelectorAll<HTMLElement>("[data-dot]") ?? []),
    ].filter((d) => d.className.includes("bg-zinc-300")).length;

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
  // group + 1 other), so the transient "One away…" chip pops into the footer's
  // middle, between the mistake dots and the shuffle button.
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
        <button
          className={SIMBTN}
          disabled={running}
          onClick={() => void simulateSolve()}
        >
          Simulate solve
        </button>
        <button
          className={SIMBTN}
          disabled={running}
          onClick={() => void simulateFail()}
        >
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
        season={SEASON}
        allTime={ALLTIME}
        initialRevealed={revealed}
        onPresence={noop}
        onFinish={noop}
        // Bot-less-guild path, so the end states show the recap pitch (GameView only
        // renders it once the run is over, so in-progress states stay clean).
        onAddBot={noop}
      />
    </section>
  );
}

// A true device-width frame. An <iframe> loading the harness at a fixed CSS width gives
// its content a REAL narrow viewport, so width media queries (min-[800px]:) and 100dvh
// resolve against the phone size — unlike a plain width-capped <div>, which still sees
// the desktop viewport and would mis-switch to the 50/50 layout. Lets us eyeball 320px
// (the small-Android floor; Android's Display-Size accessibility setting shrinks the CSS
// viewport further, so a 360px phone can land here) right in the page, no CDP needed. The
// iframe loads an isolated #state, which never re-renders device frames, so no recursion.
function DeviceFrame({
  width,
  hash,
  note,
}: {
  width: number;
  hash: string;
  note: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <iframe
        src={`/preview.html#${hash}`}
        title={`${width}px · ${hash}`}
        style={{ width, height: 720 }}
        className="rounded-[26px] border-[7px] border-zinc-800 bg-black shadow-2xl"
      />
      <div className="text-[11px] tabular-nums text-zinc-500">
        {width}px · {note}
      </div>
    </div>
  );
}

// The end screen at Android's narrow widths — the layout most prone to horizontal
// overflow (the lost footer's status label sits beside the score). 320px is the
// small-device floor.
function DeviceFrames() {
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Narrow device widths · end screen (Android floor)
      </div>
      <div className="flex flex-wrap items-start justify-center gap-6">
        <DeviceFrame
          width={320}
          hash="lost"
          note="small Android · Display-Size scaled"
        />
        <DeviceFrame width={360} hash="lost" note="most common Android" />
      </div>
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

// The midnight day-rollover veil (src/components.tsx DayTurnover). It's a `fixed inset-0`
// overlay, so to show it inline among the other previews it's framed in a box with a
// `transform` — a transformed ancestor becomes the containing block for `position: fixed`,
// which clips the overlay to this card instead of covering the whole page.
function TurnoverState() {
  return (
    <section className="w-full max-w-[940px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Day turnover · midnight veil
      </div>
      <div
        className="relative h-[440px] w-full overflow-hidden rounded-xl ring-1 ring-zinc-800"
        style={{ transform: "translateZ(0)" }}
      >
        <DayTurnover active date="2026-06-06" number={1169} />
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
      <LoadingScreen
        error={error}
        blocked={blocked}
        onRetry={noop}
        date="2026-06-06"
        number={1169}
        // bot-less-guild path so the harness shows the targeted tip
        tip
      />
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
  <State key="ap" label="April · image puzzle · in progress" game={april} />,
  <State key="apw" label="April · image puzzle · won" game={aprilWon} />,
  <State key="hw" label="Halloween · image puzzle · in progress" game={halloween} />,
  <State key="hww" label="Halloween · image puzzle · won" game={halloweenWon} />,
  <State key="mx" label="Mixed · image puzzle · in progress" game={mixed} />,
];
const pick = decodeURIComponent(location.hash.slice(1)).toLowerCase();
const known = [
  "progress",
  "perfect",
  "won",
  "lost",
  "april",
  "halloween",
  "mixed",
  "image",
  "loading",
  "error",
  "blocked",
  "simulate",
  "feedback",
  "card",
  "pip",
  "scope",
  "recap",
  "turnover",
  "device",
  "landing",
  "demo",
  "standings",
  "room",
  "reel",
  "cover",
  "bg",
];
// #simulate and #feedback both isolate the Simulate playground (#feedback also
// auto-fires a one-away guess to surface the header feedback pill); #card isolates the
// Discord "who's playing" card; #pip isolates the collapsed PIP thumbnail.
const onlySim = pick === "simulate" || pick === "feedback";
const onlyCard = pick === "card";
const onlyPip = pick === "pip";
// #scope isolates the roster panel that carries the Channel/Server toggle; #recap
// isolates the daily recap card (server/channel eyebrow).
const onlyScope = pick === "scope";
const onlyRecap = pick === "recap";
// #turnover isolates the midnight day-rollover veil (src/components.tsx DayTurnover),
// shown over a sample in-progress board so you can check the lockup over real content.
const onlyTurnover = pick === "turnover";
// #landing isolates the public landing page (src/landing.tsx) — what a plain
// browser visit to the production deployment gets instead of the game.
const onlyLanding = pick === "landing";
// #demo isolates JUST the self-playing board (landing.tsx DemoBoard), full-bleed and
// centered on the dark stage — the clean source for recording a gameplay demo video
// (the Discord activity store preview, à la Wordle). No page chrome, no labels.
const onlyDemo = pick === "demo";
// #standings isolates the static leaderboard panel; #room isolates the self-playing
// LIVE room (rows reordering past each other) — scene B of the preview reel.
const onlyStandings = pick === "standings";
const onlyRoom = pick === "room";
// #reel isolates the self-playing desktop view (board + live room) for the 16:9 preview.
const onlyReel = pick === "reel";
// #cover and #bg isolate the Discord App-Directory still art (1024×576).
const onlyCover = pick === "cover";
const onlyBg = pick === "bg";
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
const showTurnover = pick === "" || onlyTurnover;
// #device isolates the narrow-width device frames (320/360px iframes of the end screen).
const showDevice = pick === "" || pick === "device";

// ——— shared fragments (used by both the organized full page and the isolated views)

const PIPS = (
  <div className="flex w-full max-w-[1240px] flex-wrap items-start justify-center gap-8 px-4">
    <PipState
      label="PIP thumbnail · in progress (976×608)"
      game={playing}
      w={488}
      h={304}
    />
    <PipState
      label="PIP thumbnail · lost"
      game={lost}
      revealed={[2, 3]}
      w={488}
      h={304}
    />
    <PipState label="PIP thumbnail · won" game={won} w={488} h={304} />
    <PipState label="PIP thumbnail · loading" game={null} w={488} h={304} />
    <PipState
      label="PIP thumbnail · narrow PIP (square)"
      game={playing}
      w={320}
      h={320}
    />
  </div>
);

const ROSTER_LIVE = (
  <section key="r-live" className="w-full max-w-[360px] px-4">
    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
      Roster panel · standalone (Live tab)
    </div>
    <Roster players={ROSTER} selfId={SELF_ID} />
  </section>
);
const ROSTER_EMPTY = (
  <section key="r-empty" className="w-full max-w-[360px] px-4">
    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
      Roster panel · no scores yet (Season tab → placeholder)
    </div>
    <Roster
      players={ROSTER}
      selfId={SELF_ID}
      season={{ board: [], self: null }}
      allTime={{ board: [], self: null }}
      view="season"
      onViewChange={noop}
    />
  </section>
);
const ROSTER_SEASON = (
  <section key="r-season" className="w-full max-w-[418px]">
    <div className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
      Roster panel · season standings (Season tab, ~rail width)
    </div>
    <Roster
      players={ROSTER}
      selfId={SELF_ID}
      season={SEASON}
      allTime={ALLTIME}
      view="season"
      onViewChange={noop}
      scope="channel"
      onScopeChange={noop}
    />
  </section>
);

const CARDS = (
  <>
    <Card label="Discord card · who's playing today" players={CARD_ROOM} />
    <Card label="Discord card · busy room" players={CARD_BUSY} />
    <Card label="Discord card · single player" players={CARD_SOLO} />
  </>
);
// The plain-browser landing page. Its demo board self-plays on a loop, so the
// full stacked page hosts a second live driver beside #simulate — fine for
// eyeballing; isolate with #landing for clean screenshots.
const LANDING = (
  <section key="landing" className="w-full max-w-[940px] px-4">
    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
      Landing page · plain browser visit
    </div>
    <Landing />
  </section>
);

// Just the self-playing board, centered full-screen — recorded into the activity's
// gameplay preview video. Bare (no amber label) so the capture is clean.
const DEMO = (
  <div className="flex min-h-dvh w-full items-center justify-center p-4">
    <div className="w-full max-w-[460px]">
      <DemoBoard />
    </div>
  </div>
);

// Just the room leaderboard (Roster's Live / Season / All-time tabs), centered and
// framed to match #demo's board — scene B of the activity preview reel ("…and climb
// the leaderboard"). Uncontrolled so the recorder can click between tabs.
// Prior-visit ranks for the position-change arrows, exercising every case against
// SEASON's order (jun 1, aria 2, theo 3, mei 4, noa 5): jun climbed (▲1), aria slipped
// (▼1), theo unchanged (no arrow), mei jumped (▲2), noa absent → new (no arrow).
const PREV_RANKS: Record<string, number> = {
  "p-jun": 2,
  "p-aria": 1,
  "p-theo": 3,
  "p-mei": 6,
};

const STANDINGS = (
  // top-aligned (not centered) so switching tabs — which changes the list height —
  // never shifts the tab row, keeping the recorder's capture clip stable.
  <div className="flex min-h-dvh w-full flex-col items-center gap-10 px-4 pt-[120px]">
    <div className="w-full max-w-[460px]">
      <Roster
        players={ROSTER}
        selfId={SELF_ID}
        season={SEASON}
        allTime={ALLTIME}
      />
    </div>
    {/* Direct LedgerBody with a fixed prevRanks so the position-change arrows render
        deterministically (the Roster above keys off localStorage, so it shows none on a
        first visit). */}
    <div className="flex w-full max-w-[460px] flex-col">
      <div className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Position changes (prevRanks fixture)
      </div>
      <LedgerBody data={SEASON} selfId={SELF_ID} prevRanks={PREV_RANKS} />
    </div>
  </div>
);

// The self-playing LIVE room (landing.tsx DemoRoster): players' grids fill in and
// their rows reorder past each other tick by tick — scene B of the preview reel
// (the live multiplayer hook Wordle can't show). Bare/centered for a clean capture.
const ROOM = (
  <div className="flex min-h-dvh w-full items-center justify-center px-4">
    <div className="w-full max-w-[460px]">
      <DemoRoster />
    </div>
  </div>
);

// The full self-playing desktop view (board solving + live room reordering, side by
// side) — source for the 16:9 Discord activity Video Preview (640×360). Centered on
// the dark stage; GameView scales itself to fill the viewport.
const REEL = (
  <div className="flex min-h-dvh w-full items-center justify-center overflow-hidden px-6">
    <div className="w-full max-w-[1100px]">
      <DemoGame />
    </div>
  </div>
);

// ——— Discord App-Directory still art (16:9, 1024×576), rendered to PNG ———
// Same brand system as the game: dark stage, the four category colors, off-white
// tiles, the Newsreader (font-display) wordmark.
const C4 = ["#f9df6d", "#a0c35a", "#b0c4ef", "#ba81c5"];
function ArtTile({ label, s }: { label: string; s: CSSProperties }) {
  return (
    <div
      style={s}
      className="absolute flex items-center justify-center rounded-[14px] bg-[#efefe6] font-sans text-[16px] font-extrabold uppercase tracking-tight text-[#121212] shadow-[0_22px_48px_rgba(0,0,0,0.55)]"
    >
      {label}
    </div>
  );
}
function ArtBar({ color, s }: { color: string; s: CSSProperties }) {
  return (
    <div
      style={{ ...s, background: color }}
      className="absolute rounded-[14px] shadow-[0_22px_48px_rgba(0,0,0,0.45)]"
    />
  );
}

// Cover Art — Wordle-style: minimal, centered, one tight lockup. The brick logo, a
// tall condensed slab-serif wordmark, a small muted tagline, on flat neutral grey. NOTE:
// the exported docs/activity-cover.png bakes the type in licensed NYTKarnak Condensed —
// the EXACT Wordle wordmark face (confirmed via the live page: NYTKarnak Condensed,
// weight 700), a condensed slab serif. NOT Cheltenham (bracketed old-style) and NOT the
// wide regular Karnak (reads blocky/short). The dev stand-in below is font-display
// (Newsreader), so this preview only approximates the bake; keep sizes/spacing in sync.
// Just the brick logo + condensed slab wordmark, nudged down (pt-[132px]) so the pair sits
// roughly centered on the flat neutral grey. The bake uses NYTKarnak Condensed 700;
// font-display (Newsreader) is the dev stand-in here.
const COVER = (
  <div className="flex h-dvh w-full flex-col items-center justify-start bg-[#d8d8d6] pt-[132px] text-black">
    <img
      src="/connections-icon.png"
      alt=""
      className="mb-[22px] h-[140px] w-[140px] object-contain"
    />
    <h1 className="font-display text-[188px] font-bold leading-[0.84] tracking-[-0.015em]">
      Connections
    </h1>
  </div>
);

// Background — grid-view overlay: art clustered at the edges, center left clear.
const BG = (
  <div className="relative h-dvh w-full overflow-hidden bg-[#0a0a0b]">
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          "radial-gradient(680px 460px at 0% 0%, rgba(249,223,109,0.12), transparent 55%)," +
          "radial-gradient(680px 460px at 100% 0%, rgba(160,195,90,0.12), transparent 55%)," +
          "radial-gradient(680px 460px at 0% 100%, rgba(176,196,239,0.12), transparent 55%)," +
          "radial-gradient(680px 460px at 100% 100%, rgba(186,129,197,0.14), transparent 55%)",
      }}
    />
    {/* TL */}
    <ArtBar color={C4[0]} s={{ top: -42, left: 36, width: 210, height: 88, transform: "rotate(-14deg)" }} />
    <ArtTile label="SERVER" s={{ top: 66, left: -40, width: 150, height: 102, transform: "rotate(-12deg)", opacity: 0.95 }} />
    <ArtTile label="EMOTE" s={{ top: 150, left: 78, width: 150, height: 102, transform: "rotate(8deg)", opacity: 0.82 }} />
    {/* TR */}
    <ArtBar color={C4[1]} s={{ top: -42, right: 36, width: 210, height: 88, transform: "rotate(14deg)" }} />
    <ArtTile label="RIVER" s={{ top: 66, right: -40, width: 150, height: 102, transform: "rotate(12deg)", opacity: 0.95 }} />
    <ArtTile label="LAVA" s={{ top: 150, right: 78, width: 150, height: 102, transform: "rotate(-8deg)", opacity: 0.82 }} />
    {/* BL */}
    <ArtBar color={C4[2]} s={{ bottom: -42, left: 36, width: 210, height: 88, transform: "rotate(14deg)" }} />
    <ArtTile label="CHAT" s={{ bottom: 66, left: -40, width: 150, height: 102, transform: "rotate(12deg)", opacity: 0.95 }} />
    <ArtTile label="CALL" s={{ bottom: 150, left: 78, width: 150, height: 102, transform: "rotate(-8deg)", opacity: 0.82 }} />
    {/* BR */}
    <ArtBar color={C4[3]} s={{ bottom: -42, right: 36, width: 210, height: 88, transform: "rotate(-14deg)" }} />
    <ArtTile label="NITRO" s={{ bottom: 66, right: -40, width: 150, height: 102, transform: "rotate(-12deg)", opacity: 0.95 }} />
    <ArtTile label="PING" s={{ bottom: 150, right: 78, width: 150, height: 102, transform: "rotate(8deg)", opacity: 0.82 }} />
    {/* keep the center clear for the UI */}
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          "radial-gradient(closest-side at 50% 50%, rgba(10,10,11,0.97) 36%, rgba(10,10,11,0.6) 58%, transparent 82%)",
      }}
    />
  </div>
);

const RECAPS = (
  <>
    <Recap label="Discord recap · daily reset post" data={CARD_RECAP} />
    <Recap
      label="Discord recap · nobody played (streak broken)"
      data={CARD_RECAP_EMPTY}
    />
  </>
);

// ——— page chrome, full (no-hash) view only. Isolated #views stay bare sections so
// screenshot workflows keep a clean capture. The hash is read ONCE at load, so the
// filter links force a reload after the browser applies the new hash.

const FILTERS = [
  "progress",
  "perfect",
  "won",
  "lost",
  "april",
  "halloween",
  "mixed",
  "image",
  "loading",
  "error",
  "blocked",
  "simulate",
  "feedback",
  "scope",
  "card",
  "recap",
  "pip",
  "device",
  "turnover",
  "landing",
];
const reload = (): void => void setTimeout(() => location.reload(), 0);

function PageHeader() {
  return (
    <header className="w-full max-w-[1240px] px-6">
      <h1 className="font-display text-[28px] font-bold leading-none tracking-[-0.01em] text-[#efefe6]">
        Connections <span className="text-zinc-500">· UI preview</span>
      </h1>
      <p className="mt-2.5 max-w-[72ch] text-[13px] leading-relaxed text-zinc-500">
        Every surface below renders from mock data — no Discord, no Supabase, no
        /api. A hash filter isolates one section for screenshots; the links
        reload because the hash is only read at load.
      </p>
      <nav
        className="mt-4 flex flex-wrap gap-1.5"
        aria-label="Isolate a section"
      >
        {FILTERS.map((h) => (
          <a
            key={h}
            href={`#${h}`}
            onClick={reload}
            className="rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          >
            #{h}
          </a>
        ))}
      </nav>
    </header>
  );
}

// A titled band: section heading, hairline rule, and the isolating hash for the part
// it wraps. The per-item amber labels stay — the band is the level above them.
function Group({
  title,
  hash,
  children,
}: {
  title: string;
  hash?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex w-full flex-col items-center gap-9">
      <div className="flex w-full max-w-[1240px] items-center gap-4 px-6">
        <h2 className="whitespace-nowrap text-[13px] font-bold uppercase tracking-[0.2em] text-zinc-200">
          {title}
        </h2>
        <span className="h-px flex-1 bg-white/10" aria-hidden />
        {hash && (
          <a
            href={`#${hash}`}
            onClick={reload}
            className="whitespace-nowrap text-[11px] font-semibold text-zinc-600 transition-colors hover:text-zinc-300"
          >
            #{hash}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

const fullPage = (
  <div className="flex flex-col items-center gap-24 pb-28 pt-12">
    <PageHeader />
    <Group title="Game states">
      <div className="flex w-full flex-col items-center gap-14">{STATES}</div>
    </Group>
    <Group title="Playground" hash="simulate">
      <Simulate />
    </Group>
    <Group title="Roster panels" hash="scope">
      <div className="flex w-full max-w-[1240px] flex-wrap items-start justify-center gap-8 px-4">
        {ROSTER_LIVE}
        {ROSTER_EMPTY}
        {ROSTER_SEASON}
      </div>
    </Group>
    <Group title="Discord cards" hash="card">
      <div className="flex w-full flex-col items-center gap-12">
        {CARDS}
        {RECAPS}
      </div>
    </Group>
    <Group title="PIP thumbnails" hash="pip">
      {PIPS}
    </Group>
    <Group title="Device widths" hash="device">
      <DeviceFrames />
    </Group>
    <Group title="Overlays" hash="turnover">
      <TurnoverState />
    </Group>
    <Group title="Landing page" hash="landing">
      {LANDING}
    </Group>
  </div>
);

createRoot(document.getElementById("preview")!).render(
  pick === "" ? (
    fullPage
  ) : onlyDemo ? (
    DEMO
  ) : onlyStandings ? (
    STANDINGS
  ) : onlyRoom ? (
    ROOM
  ) : onlyReel ? (
    REEL
  ) : onlyCover ? (
    COVER
  ) : onlyBg ? (
    BG
  ) : (
    <div className="flex flex-col items-center gap-16 py-10">
      {onlyLanding && LANDING}
      {showTurnover && <TurnoverState />}
      {showDevice && <DeviceFrames />}
      {showSim && <Simulate />}
      {!onlySim && shown}
      {showPips && PIPS}
      {showCards && CARDS}
      {(showCards || onlyRecap) && RECAPS}
      {!onlySim &&
        !onlyCard &&
        !onlyScope &&
        !onlyRecap &&
        !onlyTurnover &&
        !onlyLanding &&
        ROSTER_LIVE}
      {!onlySim &&
        !onlyCard &&
        !onlyScope &&
        !onlyRecap &&
        !onlyTurnover &&
        !onlyLanding &&
        ROSTER_EMPTY}
      {!onlySim &&
        !onlyCard &&
        !onlyRecap &&
        !onlyTurnover &&
        !onlyLanding &&
        ROSTER_SEASON}
    </div>
  ),
);
