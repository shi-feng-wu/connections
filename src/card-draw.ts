// Pure Canvas-2D drawing for the "who's playing today" card, with no environment
// imports so it runs on BOTH the server (api/_card.ts, @napi-rs/canvas → PNG) and the
// browser (src/preview.tsx, a live <canvas>). Keeping the draw in one place means the
// preview shows the exact pixels Discord gets — no separate replica to drift.
//
// The card borrows the live in-game view's vocabulary (src/roster.tsx + src/board.tsx):
// each player is a roster row — colored-initial avatar, four group slots that fill with
// their CATEGORY color as solved, mistake dots, and a status that reads at a glance
// (lucide Check for a solve, Trophy for the day's leader, X for out of guesses, an
// emerald "live" dot for anyone still playing). Spoiler-safe: color only ever means
// "solved" — a wrong guess only spends a mistake dot, never revealing a group.
import { LEVELS } from "./game.js";

// grid: one row per committed guess, four group-levels (0-3). Four of a kind ⟺ a solved
// group (a group is exactly its four words); anything else is a miss. sec: elapsed/finish
// time in seconds (null if unknown). Everything else is derived from the grid.
export type CardPlayer = {
  id: string;
  name: string;
  avatar?: string | null;
  grid?: number[][];
  sec?: number | null;
};

export type LoadImg = (url: string) => Promise<CanvasImageSource | null>;
// Path2D is a browser global but a named export in @napi-rs/canvas, so the caller
// injects it (alongside the avatar loader) rather than us referencing a global.
export type DrawEnv = {
  loadImg: LoadImg;
  Path2D: new (path: string) => Path2D;
};
export type CardOpts = { puzzleNo?: number; puzzleDate?: string };

// ---- palette (lifted from the app: brand.css / game.ts LEVELS / roster.tsx) ----
// Card background — a near-black surface (zinc-950) inside a thin zinc-800 border, so
// the card reads as a distinct framed panel in the channel. (Opaque, not transparent,
// so the light text stays legible regardless of the viewer's Discord theme.)
const BG = "#09090b"; // zinc-950
const CARD_R = 18; // rounded card corners (corners outside it stay transparent)
const PANEL = "rgba(24,24,27,0.6)"; // zinc-900/60 — composited over BG
const PANEL_BORDER = "#232327";
const TITLE = "#efefe6"; // warm off-white wordmark
const ZINC_600 = "#52525b";
const ZINC_500 = "#71717a";
const ZINC_400 = "#a1a1aa";
const ZINC_300 = "#d4d4d8";
const ZINC_100 = "#f4f4f5";
const ZINC_800 = "#27272a";
const ZINC_700 = "#3f3f46";
const EMERALD = "#34d399";
const WON_TIME = "#e4e4e7";
const BAR_EMPTY = ZINC_800;
const BAR_EMPTY_BORDER = "#2c2c30";
const ON_AVATAR = "#0c0c0c";
const CAT_COLOR = LEVELS.map((l) => l.color); // yellow, green, blue, purple

// Identity palette + hashing, mirrored from src/roster.tsx (deliberately NOT the
// category colors, so an avatar's color never reads as a solved group).
const AVCOL = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#c678dd",
  "#d19a66",
  "#56b6c2",
  "#cd74a8",
  "#e5c07b",
  "#7f9cf5",
  "#5bb3a0",
  "#df8a5a",
  "#9f86e0",
];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVCOL[h % AVCOL.length];
}
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

// ---- layout (px) ----
const PAD_X = 30;
const PAD_BOTTOM = 32;

// The "who's playing" card shares the recap's brand header (a four-color mark + "Now
// playing" eyebrow over the "Connections" wordmark and a "Puzzle # · date" subline,
// with the Playing / Solved counts anchored right and a full-width rule beneath). The
// header metrics live with the recap (RC_* constants); tiles start below its rule.
const HEADER_GAP = 48; // min gap between the header's left block and its right stats
// GRID_TOP (the first tile's top edge) is derived from the header rule (RC_RULE_Y) and so
// lives with the RC_* header metrics below — keeping it a literal here let it silently
// drift to a 2px gap when the header's top padding grew.

// Square tiles, four across, up to three rows (so at most 12 — MAX_CARDS).
const MAX_COLS = 4;
const GRID_GAP = 12;
const TILE_PAD = 13;
const PANEL_R = 11;

const AV = 32;
const AV_RING = 18; // ring box radius (avatar 32 + 2px pad)
const HEAD_GAP = 9;
const HEAD_H = 2 * AV_RING; // 36
const NAME_SIZE = 14;
const LABEL_SIZE = 9.5;
const TIME_SIZE = 12.5;
const ICON = 15;
const STATUS_GAP = 5;

const HEAD_TO_BARS = 12;
const BARS_TO_BOTTOM = 12;
const BAR_H = 15;
const BAR_GAP = 6;
const BAR_R = 7;
const DOT = 8;
const DOT_GAP = 5;
const BOTTOM_H = 15; // shared row: mistake dots (left) + icon & time (right)

const BARS_TOP_OFF = TILE_PAD + HEAD_H + HEAD_TO_BARS; // from tile top
const BARS_H = 4 * BAR_H + 3 * BAR_GAP; // 78
// Square: width == height, driven by the stacked content (avatar/name, four bars,
// then the dots/timer row).
const TILE =
  TILE_PAD +
  HEAD_H +
  HEAD_TO_BARS +
  BARS_H +
  BARS_TO_BOTTOM +
  BOTTOM_H +
  TILE_PAD; // 179
const PANEL_H = TILE;

const MAX_CARDS = 12; // 4 wide × 3 high

const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function fmtDate(s?: string): string {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? `${MON[+m[2] - 1]} ${+m[3]}` : "";
}
// "Puzzle #1170 · May 31" (the card's subline), or whichever pieces we have.
function nowPlayingSubline(opts: CardOpts): string {
  const parts: string[] = [];
  if (opts.puzzleNo) parts.push(`Puzzle #${opts.puzzleNo}`);
  const d = fmtDate(opts.puzzleDate);
  if (d) parts.push(d);
  return parts.join(" · ");
}
// The header's right-anchored stats: how many players are in the room, and how many of
// them have solved today (Solved is accented emerald, the app's "solved" color).
function nowPlayingStats(players: CardPlayer[]): BrandStat[] {
  const solved = players.filter((p) => derive(p.grid).done === "won").length;
  return [
    { num: String(players.length), unit: "", label: "PLAYING", accent: false },
    { num: String(solved), unit: "", label: "SOLVED", accent: true },
  ];
}
function fmtTime(sec?: number | null): string {
  if (sec == null) return "—";
  const total = Math.floor(sec);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

type Derived = {
  solved: number[];
  mistakes: number;
  mistakesLeft: number;
  done: "won" | "lost" | null;
  perfect: boolean;
  played: number;
};
function derive(grid: number[][] | undefined): Derived {
  const g = grid ?? [];
  const solved: number[] = [];
  let mistakes = 0;
  for (const row of g) {
    if (
      Array.isArray(row) &&
      row.length === 4 &&
      row.every((l) => l === row[0])
    )
      solved.push(row[0]);
    else mistakes++;
  }
  const done = solved.length >= 4 ? "won" : mistakes >= 4 ? "lost" : null;
  return {
    solved,
    mistakes,
    mistakesLeft: 4 - mistakes,
    done,
    perfect: done === "won" && mistakes === 0,
    played: g.length,
  };
}

// Among winners, the leader (fewest mistakes, then fastest) earns the Trophy.
function leaderId(players: CardPlayer[]): string | null {
  const won = players.filter((p) => derive(p.grid).done === "won");
  if (!won.length) return null;
  won.sort(
    (a, b) =>
      derive(a.grid).mistakes - derive(b.grid).mistakes ||
      (a.sec ?? 1e9) - (b.sec ?? 1e9),
  );
  return won[0].id;
}

// ---- lucide icon paths (exact `d` strings, as used in the app) ----
const ICON_CHECK = { d: "M20 6 9 17l-5-5", sw: 2.8 };
const ICON_X = { d: "M18 6 6 18 M6 6 18 18", sw: 2.6 };
const ICON_TROPHY = {
  d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6 M18 9h1.5a2.5 2.5 0 0 0 0-5H18 M4 22h16 M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22 M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22 M18 2H6v7a6 6 0 0 0 12 0V2Z",
  sw: 2.25,
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Lucide icon in a 24×24 viewBox, drawn at `size` with top-left (x,y), stroked `color`.
function drawIcon(
  ctx: CanvasRenderingContext2D,
  Path2DCtor: DrawEnv["Path2D"],
  icon: { d: string; sw: number },
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = icon.sw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2DCtor(icon.d));
  ctx.restore();
}

// The card's rounded background — a rounded-rect fill of BG; the corners outside the
// radius stay transparent so the card reads as a rounded panel on the channel.
function fillCardBg(
  ctx: CanvasRenderingContext2D,
  W: number,
  height: number,
): void {
  ctx.fillStyle = BG;
  roundRect(ctx, 0, 0, W, height, CARD_R);
  ctx.fill();
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (maxW <= 0 || ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW)
    t = t.slice(0, -1);
  return `${t}…`;
}

// A roster avatar: the colored-initial circle, the player's photo clipped over it
// (when loaded), and the zinc-700 identity ring. `size` is the photo diameter; the
// ring sits 2px outside it (matching roster.tsx's padded ring), so the visual box is
// size + 4. Shared by the card tiles (32px) and the recap rows (30px).
function drawAvatar(
  ctx: CanvasRenderingContext2D,
  p: { id: string; name: string },
  img: CanvasImageSource | null,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = colorFor(p.id);
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  if (img) {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  } else {
    ctx.fillStyle = ON_AVATAR;
    ctx.font = `800 ${Math.round(size * 0.42)}px "Libre Franklin"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(p.name), cx, cy + 1);
  }
  ctx.restore();
  ctx.strokeStyle = ZINC_700;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2 + 1.25, 0, Math.PI * 2);
  ctx.stroke();
}

export type CardLayout = {
  shown: CardPlayer[];
  cols: number;
  rows: number;
  panelW: number;
  W: number;
  height: number;
  leader: string | null;
};

// Pixel dimensions of the card for a given roster (the canvas the caller must size).
// `measure` is any 2D context with the fonts registered — used only for text widths.
export function cardLayout(
  measure: CanvasRenderingContext2D,
  players: CardPlayer[],
  opts: CardOpts = {},
): CardLayout {
  const shown = players.slice(0, MAX_CARDS);
  const cols = Math.max(1, Math.min(MAX_COLS, shown.length));
  const rows = Math.max(1, Math.ceil(shown.length / cols));

  // The header (left block + the right-anchored stats) can be wider than a single
  // column (e.g. solo), so let it set the card's floor.
  const subline = nowPlayingSubline(opts);
  const stats = nowPlayingStats(players);
  const leftW = brandHeaderLeftWidth(measure, "NOW PLAYING", subline);
  const headerW = leftW + HEADER_GAP + statsClusterWidth(measure, stats);

  const gridW = cols * TILE + (cols - 1) * GRID_GAP;
  const innerW = Math.max(gridW, headerW);
  const panelW = TILE; // fixed — tiles stay square (a wide header just widens the card)
  const W = Math.round(innerW + 2 * PAD_X);
  const height = Math.round(
    GRID_TOP + rows * PANEL_H + (rows - 1) * GRID_GAP + PAD_BOTTOM,
  );
  return { shown, cols, rows, panelW, W, height, leader: leaderId(shown) };
}

// Draw the whole card onto ctx (already sized to `layout`). Caller registers the
// Newsreader / Libre Franklin fonts and supplies the avatar loader + Path2D.
export async function drawRoster(
  ctx: CanvasRenderingContext2D,
  players: CardPlayer[],
  opts: CardOpts,
  layout: CardLayout,
  env: DrawEnv,
): Promise<void> {
  const { shown, cols, panelW, W, height, leader } = layout;

  // Rounded near-black card background (border stroked last, below).
  fillCardBg(ctx, W, height);

  // ---- header (shared with the recap): "Now playing" eyebrow + brand mark over the
  // wordmark and a "Puzzle # · date" subline, with the Playing / Solved counts anchored
  // to the card's right edge, then a full-width rule above the tiles ----
  drawBrandHeader(
    ctx,
    {
      eyebrow: "NOW PLAYING",
      subline: nowPlayingSubline(opts),
      stats: nowPlayingStats(players),
    },
    PAD_X,
    W - PAD_X,
  );

  // ---- avatars resolved in parallel; a missing one is the colored-initial fallback ----
  const images = await Promise.all(
    shown.map((p) =>
      p.avatar ? env.loadImg(p.avatar) : Promise.resolve(null),
    ),
  );

  shown.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const px = PAD_X + col * (panelW + GRID_GAP);
    const py = GRID_TOP + row * (PANEL_H + GRID_GAP);
    const s = derive(p.grid);

    // panel surface
    roundRect(ctx, px, py, panelW, PANEL_H, PANEL_R);
    ctx.fillStyle = PANEL;
    ctx.fill();
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();

    // ---- avatar (colored initial, photo over) + ring ----
    const avCx = px + TILE_PAD + AV_RING;
    const avCy = py + TILE_PAD + AV_RING;
    drawAvatar(ctx, p, images[i], avCx, avCy, AV);

    // ---- state → label + icon + time colors (end-screen wording) ----
    let label: string;
    let labelColor: string;
    let timeColor: string;
    let timeWeight: number;
    let kind: "check" | "trophy" | "x" | "live";
    if (s.done === "won") {
      label = s.perfect ? "Perfect" : "Solved";
      labelColor = EMERALD;
      kind = p.id === leader ? "trophy" : "check";
      timeColor = WON_TIME;
      timeWeight = 600;
    } else if (s.done === "lost") {
      label = "Out of guesses";
      labelColor = ZINC_500;
      kind = "x";
      timeColor = ZINC_600;
      timeWeight = 500;
    } else if (s.played === 0) {
      label = "No guesses yet"; // shorter than "hasn't guessed yet" to fit the square tile
      labelColor = ZINC_500;
      kind = "live";
      timeColor = ZINC_400;
      timeWeight = 500;
    } else {
      label = `${s.solved.length}/4 groups`;
      labelColor = ZINC_400;
      kind = "live";
      timeColor = ZINC_400;
      timeWeight = 500;
    }

    // ---- name + status label (status icon/time live in the bottom row now) ----
    const idX = px + TILE_PAD + HEAD_H + HEAD_GAP;
    const nameMaxW = px + panelW - TILE_PAD - idX;
    ctx.textAlign = "left";
    ctx.fillStyle = ZINC_100;
    ctx.font = `600 ${NAME_SIZE}px "Libre Franklin"`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, p.name, nameMaxW), idX, py + TILE_PAD + 14);
    ctx.fillStyle = labelColor;
    ctx.font = `600 ${LABEL_SIZE}px "Libre Franklin"`;
    ctx.letterSpacing = "0.8px"; // tracking on the uppercase label
    ctx.fillText(
      fitText(ctx, label.toUpperCase(), nameMaxW),
      idX,
      py + TILE_PAD + 28,
    );
    ctx.letterSpacing = "0px";

    // ---- four group slots: a category bar per solved group, flat slot for the rest ----
    const order = [...s.solved].sort((a, b) => a - b);
    const barX = px + TILE_PAD;
    const barW = panelW - 2 * TILE_PAD;
    for (let b = 0; b < 4; b++) {
      const by = py + BARS_TOP_OFF + b * (BAR_H + BAR_GAP);
      roundRect(ctx, barX, by, barW, BAR_H, BAR_R);
      if (b < order.length) {
        ctx.fillStyle = CAT_COLOR[order[b]];
        ctx.fill();
      } else {
        ctx.fillStyle = BAR_EMPTY;
        ctx.fill();
        ctx.strokeStyle = BAR_EMPTY_BORDER;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ---- bottom row: mistake dots (left) + status icon & time (right), in line ----
    const rowY = py + BARS_TOP_OFF + BARS_H + BARS_TO_BOTTOM + BOTTOM_H / 2;
    for (let d = 0; d < 4; d++) {
      const dcx = barX + DOT / 2 + d * (DOT + DOT_GAP);
      ctx.fillStyle = d < s.mistakesLeft ? ZINC_300 : ZINC_700;
      ctx.beginPath();
      ctx.arc(dcx, rowY, DOT / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // The status icon sits just right of the mistake dots — anchored to the dots,
    // not the time (which is drawn flush to the tile's right edge), so it never
    // shifts as the time grows.
    const statusLeft = barX + DOT + 3 * (DOT + DOT_GAP) + STATUS_GAP * 2;
    if (kind === "live") {
      const dx = statusLeft + ICON / 2;
      ctx.fillStyle = "rgba(52,211,153,0.22)"; // emerald-400 @ 22% — the live dot's halo
      ctx.beginPath();
      ctx.arc(dx, rowY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = EMERALD;
      ctx.beginPath();
      ctx.arc(dx, rowY, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const icon =
        kind === "x" ? ICON_X : kind === "trophy" ? ICON_TROPHY : ICON_CHECK;
      const iconColor = kind === "x" ? ZINC_500 : ZINC_100;
      drawIcon(
        ctx,
        env.Path2D,
        icon,
        statusLeft,
        rowY - ICON / 2,
        ICON,
        iconColor,
      );
    }
    const timeStr = fmtTime(p.sec);
    ctx.fillStyle = timeColor;
    ctx.font = `${timeWeight} ${TIME_SIZE}px "Libre Franklin"`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(timeStr, px + panelW - TILE_PAD, rowY + 1);
  });
}

// =====================================================================
// DAILY RECAP — the reset post, as an image (drawn here, rendered to PNG by
// api/_card.ts:renderRecap, posted by api/cron-recap.ts). Same brand chrome as
// the card — serif wordmark, ranked roster rows, mistake dots, lucide
// Check / X / Trophy — over two columns: yesterday's results (points · mistakes ·
// time · solved) beside the month's season standings (total points, games won).
// A four-color brand mark + "Daily recap" eyebrow sit over the wordmark, with the
// room's win streak and win rate anchored to the right. Spoiler-safe is moot here
// (the puzzle's over), so this is pure leaderboard, no group colors.
// =====================================================================

// One finisher of yesterday's puzzle (from the day_results RPC), shaped for drawing.
export type RecapResult = {
  id: string;
  name: string;
  avatar?: string | null;
  solved: boolean;
  score: number;
  mistakes: number;
  sec?: number | null;
};
// One season-standings row (from the room_board RPC), shaped for drawing.
export type RecapStanding = {
  id: string;
  name: string;
  avatar?: string | null;
  total: number;
  wins: number;
  plays: number;
};
export type RecapData = {
  puzzleNo?: number;
  puzzleDate?: string; // "2026-05-30" → "May 30"
  season?: string; // standings window label, e.g. "May"
  streak?: number | null; // room win streak in days (null hides the stat)
  longest?: number | null; // room's all-time longest win streak in days (null hides the stat)
  winRate?: number | null; // room season solve rate %, 0–100 (null hides the stat)
  guildName?: string | null; // server name for the room eyebrow (null → "DAILY RECAP")
  channelName?: string | null; // channel name, bare or with '#' (null hides the channel)
  results: RecapResult[];
  standings: RecapStanding[];
};

// ---- recap layout (px) ----
const RC_PAD_X = 50;
const RC_PAD_TOP = 46;
const RC_PAD_BOTTOM = 46;
const RC_RESULTS_W = 452; // left column (results) width
const RC_STAND_W = 340; // right column (season standings) width
const RC_COL_GAP = 26;
const RC_W = RC_PAD_X * 2 + RC_RESULTS_W + RC_COL_GAP + RC_STAND_W; // 878

// header rhythm (baselines from canvas top)
const RC_MARK = 9; // brand-mark square
const RC_MARK_GAP = 3;
const RC_MARK_TO_TEXT = 10;
const RC_EYE_SIZE = 11;
const RC_EYE_BASE = RC_PAD_TOP + RC_MARK; // 55
const RC_TITLE_SIZE = 38;
const RC_TITLE_BASE = RC_PAD_TOP + 52; // 98
const RC_SUB_SIZE = 12.5;
const RC_SUB_BASE = RC_TITLE_BASE + 28; // 126

// right-anchored stat cluster (win streak · win rate)
const RC_STAT_NUM = 30;
const RC_STAT_UNIT = 16;
const RC_STAT_LBL = 10;
const RC_STAT_NUM_BASE = 86;
const RC_STAT_LBL_BASE = 108;
const RC_STAT_GAP = 22;
const RC_STAT_DIV_TOP = 70;
const RC_STAT_DIV_H = 36;

const RC_RULE_Y = RC_SUB_BASE + 18; // 144 — the full-width divider under the header
// The "who's playing" tiles start 20px below that rule. Derived from RC_RULE_Y (not a
// literal) so the breathing room tracks the header automatically — see the note by HEADER_GAP.
const GRID_TOP = RC_RULE_Y + 20; // 164
const RC_CAP_SIZE = 11;
const RC_CAP_BASE = RC_RULE_Y + 31; // section caption baseline
const RC_LIST_TOP = RC_CAP_BASE + 12; // first row's top edge

const RC_ROW_H = 47;
const RC_ROW_GAP = 2;
const RC_ROW_R = 10;
const RC_AV = 30; // recap avatar diameter
const RC_DOT = 7;
const RC_DOT_GAP = 5;

const RC_EMERALD_UNIT = "#7fd9b0"; // emerald-400 mixed ~65% toward zinc-500 (streak unit)
const RC_RANK_BRONZE = "#cd9a6b";
const RC_DIVIDER = "#232327";
const RC_RULE_DIV = "#2a2a2e";
const RC_WL = "#e4e4e7";
// Room eyebrow (recap): the community identity reads first (brighter zinc-300), then the
// channel trailing dimmer with a middot that matches the subline separators and a quiet
// brand-blue hash. Truncates so it stays clear of the right-anchored stat cluster.
const RC_ROOM_SEP = "#3f3f46"; // zinc-700, same as the subline middots
const RC_ROOM_HASH = "#6aa0e0"; // the brand mark's blue — a nod to a Discord channel
const RC_EYE_SERVER_MAX = 210; // px cap on the server name before the channel
const RC_EYE_MAX_RIGHT = 470; // px from leftX the room eyebrow may reach before truncating

// "See the full leaderboard" CTA centered in the empty bottom-right area, beneath the
// season standings: "/connections" in accent emerald over two muted lines pointing at the
// full in-app leaderboard. No container — just centered text.
const RC_BLURB_GAP = 14; // min gap below the last standings row
const RC_BLURB_H = 52; // reserved height for the three centered lines
const RC_SLASH = "rgba(52,211,153,0.66)"; // the leading "/", a touch dimmer than the word

function rankColor(i: number): string {
  if (i === 0) return CAT_COLOR[0]; // yellow
  if (i === 1) return ZINC_300;
  if (i === 2) return RC_RANK_BRONZE;
  return ZINC_600;
}

// ---- shared brand header (recap + "who's playing" card) ----
// A four-color brand mark + uppercase eyebrow over the serif "Connections" wordmark
// and a sans subline, with up to two right-anchored stats (big number + optional unit,
// uppercase label, an emerald accent for one) split by a hairline divider, then a
// full-width rule. drawRecap and drawRoster both render this so the two cards' heads
// stay literally identical — only the eyebrow text, subline, and stats differ.
type BrandStat = { num: string; unit: string; label: string; accent: boolean };
// When set, the eyebrow line shows the room ("Server · #channel") instead of the static
// label string — used by the recap. channel is the bare name (no leading '#').
type Room = { server: string; channel: string | null };
// titleSuffix joins the wordmark in the same serif (the recap's "Connections Recap").
type BrandHeaderOpts = {
  eyebrow: string;
  subline: string;
  stats: BrandStat[];
  room?: Room | null;
  titleSuffix?: string | null;
};

// brand marks span 4·(mark+gap) − the trailing gap; then a fixed gap to the eyebrow text
const RC_EYE_TEXT_X =
  4 * (RC_MARK + RC_MARK_GAP) - RC_MARK_GAP + RC_MARK_TO_TEXT; // 55

// One right-aligned stat (number + optional unit on a shared baseline, label beneath).
// Returns the cluster's left edge so the caller can place a divider / the next stat.
function drawStat(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  stat: BrandStat,
): number {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  let unitW = 0;
  if (stat.unit) {
    ctx.fillStyle = stat.accent ? RC_EMERALD_UNIT : ZINC_500;
    ctx.font = `600 ${RC_STAT_UNIT}px "Libre Franklin"`;
    ctx.fillText(stat.unit, rightX, RC_STAT_NUM_BASE);
    unitW = ctx.measureText(stat.unit).width;
  }
  const gap = stat.unit ? 1 : 0; // unit sits 1px right of the number
  const numRight = rightX - unitW - gap;
  ctx.fillStyle = stat.accent ? EMERALD : ZINC_100;
  ctx.font = `700 ${RC_STAT_NUM}px "Libre Franklin"`;
  ctx.letterSpacing = "-0.6px";
  ctx.fillText(stat.num, numRight, RC_STAT_NUM_BASE);
  const numW = ctx.measureText(stat.num).width;
  ctx.letterSpacing = "0px";
  ctx.fillStyle = ZINC_500;
  ctx.font = `700 ${RC_STAT_LBL}px "Libre Franklin"`;
  ctx.letterSpacing = "1px"; // 0.1em
  ctx.fillText(stat.label, rightX, RC_STAT_LBL_BASE);
  const lblW = ctx.measureText(stat.label).width;
  ctx.letterSpacing = "0px";
  return rightX - Math.max(unitW + gap + numW, lblW);
}

// Width of one stat's box (the wider of its number+unit and its label).
function statWidth(ctx: CanvasRenderingContext2D, stat: BrandStat): number {
  ctx.font = `700 ${RC_STAT_NUM}px "Libre Franklin"`;
  ctx.letterSpacing = "-0.6px";
  const numW = ctx.measureText(stat.num).width;
  ctx.letterSpacing = "0px";
  let unitW = 0;
  if (stat.unit) {
    ctx.font = `600 ${RC_STAT_UNIT}px "Libre Franklin"`;
    unitW = ctx.measureText(stat.unit).width;
  }
  ctx.font = `700 ${RC_STAT_LBL}px "Libre Franklin"`;
  ctx.letterSpacing = "1px";
  const lblW = ctx.measureText(stat.label).width;
  ctx.letterSpacing = "0px";
  return Math.max(numW + (stat.unit ? 1 + unitW : 0), lblW);
}

// Draw the stat cluster right-to-left from `rightX`, with a divider between stats.
function drawStatCluster(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  stats: BrandStat[],
): void {
  let right = rightX;
  for (let i = stats.length - 1; i >= 0; i--) {
    const left = drawStat(ctx, right, stats[i]);
    if (i > 0) {
      right = left - RC_STAT_GAP;
      ctx.fillStyle = RC_RULE_DIV;
      ctx.fillRect(right, RC_STAT_DIV_TOP, 1, RC_STAT_DIV_H);
      right -= 1 + RC_STAT_GAP;
    }
  }
}

// Total width the stat cluster occupies (boxes + dividers + the gaps around them).
function statsClusterWidth(
  ctx: CanvasRenderingContext2D,
  stats: BrandStat[],
): number {
  let w = 0;
  stats.forEach((s, i) => {
    w += statWidth(ctx, s);
    if (i > 0) w += 2 * RC_STAT_GAP + 1; // divider + a gap each side
  });
  return w;
}

// Width of the header's left block (the widest of eyebrow, wordmark, subline).
function brandHeaderLeftWidth(
  ctx: CanvasRenderingContext2D,
  eyebrow: string,
  subline: string,
): number {
  ctx.font = `700 ${RC_EYE_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = "1.8px";
  const eyeW = RC_EYE_TEXT_X + ctx.measureText(eyebrow).width;
  ctx.letterSpacing = "0px";
  ctx.font = `700 ${RC_TITLE_SIZE}px Newsreader`;
  ctx.letterSpacing = "-0.76px";
  const titleW = ctx.measureText("Connections").width;
  ctx.letterSpacing = "0px";
  ctx.font = `500 ${RC_SUB_SIZE}px "Libre Franklin"`;
  const subW = ctx.measureText(subline).width;
  return Math.max(eyeW, titleW, subW);
}

// The recap eyebrow when the room is known: "Server · #channel" in place of the static
// "DAILY RECAP" label — the community's name first (zinc-300), the channel trailing dimmer
// with a brand-blue hash. Truncates the server, then the channel, to stay clear of the stats.
function drawRoomEyebrow(
  ctx: CanvasRenderingContext2D,
  leftX: number,
  room: Room,
): void {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let x = leftX + RC_EYE_TEXT_X;
  const maxRight = leftX + RC_EYE_MAX_RIGHT;

  ctx.font = `700 ${RC_EYE_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = "0.6px";
  const server = fitText(ctx, room.server, RC_EYE_SERVER_MAX);
  ctx.fillStyle = ZINC_300;
  ctx.fillText(server, x, RC_EYE_BASE);
  x += ctx.measureText(server).width;
  ctx.letterSpacing = "0px";

  const channel = room.channel?.replace(/^#/, "") ?? "";
  if (channel && x < maxRight) {
    ctx.font = `700 ${RC_EYE_SIZE}px "Libre Franklin"`;
    ctx.fillStyle = RC_ROOM_SEP;
    x += 7;
    ctx.fillText("·", x, RC_EYE_BASE);
    x += ctx.measureText("·").width + 7;

    ctx.font = `600 ${RC_EYE_SIZE}px "Libre Franklin"`;
    ctx.fillStyle = RC_ROOM_HASH;
    ctx.fillText("#", x, RC_EYE_BASE);
    x += ctx.measureText("#").width;

    ctx.fillStyle = ZINC_500;
    ctx.letterSpacing = "0.2px";
    ctx.fillText(fitText(ctx, channel, maxRight - x), x, RC_EYE_BASE);
    ctx.letterSpacing = "0px";
  }
}

// Draw the whole brand header between [leftX, rightX] (stats anchored at rightX).
function drawBrandHeader(
  ctx: CanvasRenderingContext2D,
  opts: BrandHeaderOpts,
  leftX: number,
  rightX: number,
): void {
  let mx = leftX;
  for (let c = 0; c < 4; c++) {
    roundRect(ctx, mx, RC_EYE_BASE - RC_MARK, RC_MARK, RC_MARK, 2.5);
    ctx.fillStyle = CAT_COLOR[c];
    ctx.fill();
    mx += RC_MARK + RC_MARK_GAP;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if (opts.room) {
    drawRoomEyebrow(ctx, leftX, opts.room);
  } else {
    ctx.fillStyle = ZINC_500;
    ctx.font = `700 ${RC_EYE_SIZE}px "Libre Franklin"`;
    ctx.letterSpacing = "1.8px"; // 0.16em of 11px
    ctx.fillText(opts.eyebrow, leftX + RC_EYE_TEXT_X, RC_EYE_BASE);
    ctx.letterSpacing = "0px";
  }

  ctx.fillStyle = TITLE;
  ctx.font = `700 ${RC_TITLE_SIZE}px Newsreader`;
  ctx.letterSpacing = "-0.76px"; // -0.02em
  // titleSuffix joins the wordmark in the same serif (the recap's "Connections Recap").
  const wordmark = opts.titleSuffix
    ? `Connections ${opts.titleSuffix}`
    : "Connections";
  ctx.fillText(wordmark, leftX, RC_TITLE_BASE);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = ZINC_500;
  ctx.font = `500 ${RC_SUB_SIZE}px "Libre Franklin"`;
  ctx.fillText(opts.subline, leftX, RC_SUB_BASE);

  if (opts.stats.length) drawStatCluster(ctx, rightX, opts.stats);

  // full-width rule under the header
  ctx.fillStyle = RC_DIVIDER;
  ctx.fillRect(leftX, RC_RULE_Y, rightX - leftX, 1);
}

export type RecapLayout = {
  results: RecapResult[];
  standings: RecapStanding[];
  W: number;
  height: number;
};

// How many rows each column shows. Yesterday's results can be long in a busy room;
// cap so the image stays a sane height (the text recap kept all of them, but an image
// of 25 rows is unwieldy). Standings already arrive capped by room_board's p_limit.
const RC_MAX_RESULTS = 12;

// Bottom edge of a column of `n` rows (RC_LIST_TOP for 0 rows).
function colBottom(n: number): number {
  return RC_LIST_TOP + n * RC_ROW_H + Math.max(0, n - 1) * RC_ROW_GAP;
}

// The recap's content bottom (before pad) and the standings-column bottom. The standings
// column carries the CTA blurb beneath it, so its side can run taller than the results
// column; the card grows to fit whichever is longer. Shared by layout (height) and draw
// (centering the blurb in the [standBottom, contentBottom] gap).
function recapBottoms(
  resultsRows: number,
  standRows: number,
): { standBottom: number; contentBottom: number } {
  const resultsBottom = colBottom(Math.max(resultsRows, 1));
  const standBottom = colBottom(standRows);
  const contentBottom = Math.max(
    resultsBottom,
    standBottom + RC_BLURB_GAP + RC_BLURB_H,
  );
  return { standBottom, contentBottom };
}

export function recapLayout(data: RecapData): RecapLayout {
  const results = data.results.slice(0, RC_MAX_RESULTS);
  const standings = data.standings.slice();
  const { contentBottom } = recapBottoms(results.length, standings.length);
  const height = Math.round(contentBottom + RC_PAD_BOTTOM);
  return { results, standings, W: RC_W, height };
}

// "Puzzle #1169 · May 30 · 6/7 solved today" — whichever pieces are known.
function recapSubline(data: RecapData): string {
  const parts: string[] = [];
  if (data.puzzleNo) parts.push(`Puzzle #${data.puzzleNo}`);
  const d = fmtDate(data.puzzleDate);
  if (d) parts.push(d);
  const solved = data.results.filter((r) => r.solved).length;
  parts.push(`${solved}/${data.results.length} solved`);
  return parts.join(" · ");
}

// Recap header stats: win streak (emerald), longest streak, then win rate, each shown only
// when known (null hides it). Left-to-right order; drawStatCluster anchors them to the
// right edge.
function recapStats(data: RecapData): BrandStat[] {
  const stats: BrandStat[] = [];
  if (data.streak != null)
    stats.push({
      num: String(data.streak),
      unit: "d",
      label: "WIN STREAK",
      accent: true,
    });
  if (data.longest != null)
    stats.push({
      num: String(data.longest),
      unit: "d",
      label: "LONGEST",
      accent: false,
    });
  if (data.winRate != null)
    stats.push({
      num: String(data.winRate),
      unit: "%",
      label: "WIN RATE",
      accent: false,
    });
  return stats;
}

// Mistake dots for a recap row, centered vertically on `cy`, right edge at `rightX`.
function drawDots(
  ctx: CanvasRenderingContext2D,
  mistakesLeft: number,
  rightX: number,
  cy: number,
): void {
  const span = 4 * RC_DOT + 3 * RC_DOT_GAP;
  const left = rightX - span;
  for (let d = 0; d < 4; d++) {
    const dcx = left + RC_DOT / 2 + d * (RC_DOT + RC_DOT_GAP);
    ctx.fillStyle = d < mistakesLeft ? ZINC_300 : ZINC_700;
    ctx.beginPath();
    ctx.arc(dcx, cy, RC_DOT / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// A "<n> pts" cluster (big tabular number + small uppercase unit), baseline-aligned
// and right-justified to `rightX`. Returns the cluster's left edge.
function drawPts(
  ctx: CanvasRenderingContext2D,
  value: number,
  rightX: number,
  baseline: number,
): number {
  const num = String(value);
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ZINC_600;
  ctx.font = `600 10px "Libre Franklin"`;
  ctx.letterSpacing = "0.6px";
  const unit = "PTS";
  ctx.fillText(unit, rightX, baseline);
  const unitW = ctx.measureText(unit).width;
  ctx.letterSpacing = "0px";
  const numRight = rightX - unitW - 4;
  ctx.fillStyle = ZINC_100;
  ctx.font = `700 16px "Libre Franklin"`;
  ctx.fillText(num, numRight, baseline);
  return numRight - ctx.measureText(num).width;
}

// The CTA centered in the empty bottom-right area beneath the season standings: an emerald
// "/connections" (the accent color carries the "this is a command" read — the canvas has no
// mono font) over two muted lines pointing at the full in-app leaderboard. Centered within
// [areaTop, areaBottom] of the standings column. Quiet and secondary — the recap is the hero.
function drawRecapBlurb(
  ctx: CanvasRenderingContext2D,
  sX: number,
  areaTop: number,
  areaBottom: number,
): void {
  const centerX = sX + RC_STAND_W / 2;
  const cy = (areaTop + areaBottom) / 2;
  ctx.textBaseline = "alphabetic";

  // line 1: "/connections" (emerald, dimmed slash), horizontally centered as one unit
  ctx.textAlign = "left";
  ctx.font = `700 14px "Libre Franklin"`;
  ctx.letterSpacing = "0.1px";
  const slashW = ctx.measureText("/").width;
  const restW = ctx.measureText("connections").width;
  const startX = centerX - (slashW + restW) / 2;
  ctx.fillStyle = RC_SLASH;
  ctx.fillText("/", startX, cy - 15);
  ctx.fillStyle = EMERALD;
  ctx.fillText("connections", startX + slashW, cy - 15);
  ctx.letterSpacing = "0px";

  // lines 2 & 3: muted descriptor, centered
  ctx.textAlign = "center";
  ctx.fillStyle = ZINC_300;
  ctx.font = `600 12px "Libre Franklin"`;
  ctx.fillText("See the full leaderboard", centerX, cy + 4);
  ctx.fillStyle = ZINC_500;
  ctx.font = `500 11px "Libre Franklin"`;
  ctx.fillText("season & all-time · server standings", centerX, cy + 21);
  ctx.textAlign = "left";
}

export async function drawRecap(
  ctx: CanvasRenderingContext2D,
  data: RecapData,
  layout: RecapLayout,
  env: DrawEnv,
): Promise<void> {
  const { results, standings, W, height } = layout;

  // Rounded near-black card background (see drawRoster); border stroked last.
  fillCardBg(ctx, W, height);

  // ---- header (shared with the "who's playing" card): eyebrow + wordmark + subline,
  // with win streak (emerald) · win rate anchored right, then the full-width rule ----
  drawBrandHeader(
    ctx,
    {
      eyebrow: "DAILY RECAP",
      // When the server name is known, the eyebrow becomes "Server · #channel" (the recap's
      // room); otherwise it falls back to the static "DAILY RECAP" label.
      room: data.guildName
        ? { server: data.guildName, channel: data.channelName ?? null }
        : null,
      // The wordmark reads "Connections recap" — "recap" as a smaller, dimmer serif descriptor.
      titleSuffix: "Recap",
      subline: recapSubline(data),
      stats: recapStats(data),
    },
    RC_PAD_X,
    W - RC_PAD_X,
  );

  // ---- resolve avatars for both columns in parallel ----
  const all = [...results, ...standings];
  const images = await Promise.all(
    all.map((r) => (r.avatar ? env.loadImg(r.avatar) : Promise.resolve(null))),
  );
  const imgAt = (idx: number): CanvasImageSource | null => images[idx] ?? null;

  // Shared row chrome: panel + rank + avatar + name, returning the name's right bound.
  const drawRowBase = (
    blockX: number,
    blockW: number,
    rowTop: number,
    rank: number,
    person: { id: string; name: string },
    img: CanvasImageSource | null,
    nameRight: number,
  ): { cy: number } => {
    const cy = rowTop + RC_ROW_H / 2;
    roundRect(ctx, blockX, rowTop, blockW, RC_ROW_H, RC_ROW_R);
    ctx.fillStyle = PANEL;
    ctx.fill();

    const contentLeft = blockX + 8;
    // rank
    ctx.fillStyle = rankColor(rank);
    ctx.font = `700 13px "Libre Franklin"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(rank + 1), contentLeft + 11, cy + 1);
    // avatar (22px rank col + 11 gap, then 34px ring col)
    drawAvatar(ctx, person, img, contentLeft + 22 + 11 + 17, cy, RC_AV);
    // name
    const nameLeft = contentLeft + 22 + 11 + 34 + 11;
    ctx.fillStyle = ZINC_100;
    ctx.font = `600 14.5px "Libre Franklin"`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      fitText(ctx, person.name, nameRight - nameLeft),
      nameLeft,
      cy + 1,
    );
    return { cy };
  };

  // ---- left column: yesterday's results ----
  ctx.fillStyle = ZINC_500;
  ctx.font = `700 ${RC_CAP_SIZE}px "Libre Franklin"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "1.2px";
  ctx.fillText("YESTERDAY’S RESULTS", RC_PAD_X + 2, RC_CAP_BASE);
  ctx.letterSpacing = "0px";

  const rRight = RC_PAD_X + RC_RESULTS_W - 12; // content right edge
  const statusCx = rRight - 10;
  const ptsRight = rRight - 20 - 11; // status col (20) + gap
  const timeRight = ptsRight - 56 - 11; // pts col (56) + gap
  const dotsRight = timeRight - 46 - 11; // time col (46) + gap
  results.forEach((r, i) => {
    const rowTop = RC_LIST_TOP + i * (RC_ROW_H + RC_ROW_GAP);
    const { cy } = drawRowBase(
      RC_PAD_X,
      RC_RESULTS_W,
      rowTop,
      i,
      r,
      imgAt(i),
      dotsRight - 14,
    );
    drawDots(ctx, 4 - r.mistakes, dotsRight, cy);
    // time
    ctx.fillStyle = ZINC_400;
    ctx.font = `500 13px "Libre Franklin"`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtTime(r.sec), timeRight, cy + 1);
    // points
    drawPts(ctx, r.score, ptsRight, cy + 5);
    // status icon: Trophy for the winner (#1), Check for a solve, X for a loss
    const icon = !r.solved ? ICON_X : i === 0 ? ICON_TROPHY : ICON_CHECK;
    const color = r.solved ? EMERALD : ZINC_600;
    drawIcon(ctx, env.Path2D, icon, statusCx - 8, cy - 8, 16, color);
  });

  // ---- right column: season standings ----
  const sX = RC_PAD_X + RC_RESULTS_W + RC_COL_GAP;
  ctx.fillStyle = ZINC_500;
  ctx.font = `700 ${RC_CAP_SIZE}px "Libre Franklin"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "1.2px";
  const seasonCap = data.season
    ? `SEASON STANDINGS · ${data.season.toUpperCase()}`
    : "SEASON STANDINGS";
  ctx.fillText(seasonCap, sX + 2, RC_CAP_BASE);
  ctx.letterSpacing = "0px";

  const sRight = sX + RC_STAND_W - 12; // content right edge
  const sPtsRight = sRight; // pts col (64) right-aligned to the edge
  standings.forEach((r, i) => {
    const rowTop = RC_LIST_TOP + i * (RC_ROW_H + RC_ROW_GAP);
    // win/loss "6/7 won" sits left of the 64px pts column with an 11px gap; reserve room
    const wlRight = sPtsRight - 64 - 11;
    const { cy } = drawRowBase(
      sX,
      RC_STAND_W,
      rowTop,
      i,
      r,
      imgAt(results.length + i),
      wlRight - 64,
    );
    // "6" (bold) + "/7 won" (muted), baseline-aligned, right-justified to wlRight
    const base = cy + 5;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";
    ctx.fillStyle = ZINC_600;
    ctx.font = `500 11px "Libre Franklin"`;
    const suffix = `/${r.plays} won`;
    ctx.fillText(suffix, wlRight, base);
    const sufW = ctx.measureText(suffix).width;
    ctx.fillStyle = RC_WL;
    ctx.font = `700 14px "Libre Franklin"`;
    ctx.fillText(String(r.wins), wlRight - sufW, base);
    // total points
    drawPts(ctx, r.total, sPtsRight, base);
  });

  // ---- CTA centered in the bottom-right area: open /connections for the full leaderboard ----
  const { standBottom, contentBottom } = recapBottoms(
    results.length,
    standings.length,
  );
  drawRecapBlurb(ctx, sX, standBottom, contentBottom);
}
