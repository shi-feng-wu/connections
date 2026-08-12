import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas';
import { LEVELS, MAX_MISTAKES } from '../src/game.js';

// The SHARE CARD: the spoiler-free daily result a player posts into chat as a Discord quick
// link (api/share-link.ts). Discord renders a quick link as a rich embed with a 43:24 hero
// image, a title, a description, and a "Play" button — so this PNG is the hero, and it is the
// whole pitch to everyone who sees it.
//
// IT IS THE END SCREEN, RESTAGED. Everything on the left column is lifted from the finished
// game's own UI so a player recognises their result instantly and a stranger sees the real
// product:
//   • the header lockup from components.tsx Header — serif "Disconnections" on the left, the
//     serif date over a small tracked "NO. 1170" on the right, over a hairline rule. That is
//     where the app puts the puzzle number, so that is where the card puts it.
//   • the stat row from board.tsx EndSummary — mistake dots on the left, then the clock icon
//     with the m:ss solve time, a hairline divider, and the uppercase outcome label over the
//     serif "+score". No prose: the app states these as icons and numerals, and so does this.
//   • the streak from season.tsx Streak — a filled flame plus the count, in the same
//     warm/cold color ramp, parked in the row's empty middle (the stage the app's own
//     transient chip uses).
//
// SPOILER-FREE IS LOAD-BEARING. The right column carries the guess grid the way Wordle's does:
// one row of four colored squares per guess, in the CATEGORY colors, and nothing else. No
// words, no group titles, no answers. A row of four matching squares reads as a solved group,
// a mixed row as a miss — the same vocabulary the board and the "who's playing" card use,
// which is why someone who hasn't played yet learns nothing from it.
//
// Icons are drawn as canvas vector paths from lucide's exact `d` strings (the api/_card.ts
// idiom): the registered TTFs carry no emoji face, so an emoji glyph would render as tofu.
//
// Leading underscore keeps Vercel from treating this file as a route.

// 43:24 — Discord's quick-link hero ratio. 1290x720 keeps the serif wordmark crisp on a
// desktop embed without pushing the base64 payload up (flat fills compress hard).
export const SHARE_CARD_W = 1290;
export const SHARE_CARD_H = 720;

// ---- palette (the app's own tokens: brand.css / game.ts LEVELS / season.tsx) ----
const BG = '#09090b'; // zinc-950 — the card surface
const TITLE = '#e8eaee'; // cool off-white wordmark + score, as the app renders both
const ZINC_200 = '#e4e4e7';
const ZINC_300 = '#d4d4d8';
const ZINC_400 = '#a1a1aa';
const ZINC_500 = '#71717a';
const ZINC_600 = '#52525b';
const ZINC_700 = '#3f3f46';
const EMERALD = '#34d399'; // emerald-400 — the app's "solved" accent
const RULE = 'rgba(255,255,255,0.08)'; // the header's border-white/[0.08]
const DIVIDER = 'rgba(255,255,255,0.10)'; // the stat row's bg-white/10 hairline
const FLAME_HOT = '#fb923c'; // orange-400 — a week or better
const FLAME_WARM = 'rgba(253,186,116,0.7)'; // orange-300/70 — a young streak
const DOT_LEFT = ZINC_300; // a mistake still in hand (bg-zinc-300)
const DOT_SPENT = ZINC_700; // a spent mistake (bg-zinc-700)
const CAT_COLOR = LEVELS.map((l) => l.color); // yellow, green, blue, purple

// ---- lucide icon paths (the exact `d` strings the app renders) ----
// Clock: the end footer's solve-time glyph, at its strokeWidth={2.25}.
const ICON_CLOCK = { d: 'M12 6v6l4 2', sw: 2.25, circle: true };
// Flame: the standings' streak glyph. The app draws it FILLED (fill="currentColor",
// strokeWidth={0}), so this one is filled, not stroked.
const ICON_FLAME =
  'M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4';

// ---- layout (px) ----
const PAD = 76;
// The card splits left/right: the end-screen lockup in the left column, the grid on the right.
// A 43:24 frame is far too wide to stack them. No divider between the columns — the header
// rule and the grid's own mass separate them, and the card stays quiet.
const LEFT_RIGHT = 720; // right edge of the left column (wordmark rule + stat row end here)
const GRID_LEFT = 780;
const GRID_RIGHT = SHARE_CARD_W - PAD;

// Header lockup, ~2x the app's Header so it holds at embed scale.
const TITLE_SIZE = 54; // the serif wordmark
const DATE_SIZE = 25; // the serif dateline
const NO_SIZE = 17; // "NO. 1170", uppercase + tracked, like the app's
const TITLE_BASE = 272; // the wordmark's baseline; the NO. line bottom-aligns with it
const DATE_BASE = TITLE_BASE - 26;
const RULE_Y = TITLE_BASE + 34;

// Stat row, ~1.75x the app's end footer. It sits well below the rule on purpose: in the app
// the header and the end footer bracket the whole board, and letting them bracket the card's
// left column the same way keeps the two columns visually the same height.
const STAT_CY = RULE_Y + 140; // the row's vertical centre
const DOT_R = 12;
const DOT_GAP = 12;
const CLOCK_ICON = 26;
const TIME_SIZE = 26;
const LABEL_SIZE = 18;
const SCORE_SIZE = 46;
const FLAME_ICON = 31; // lucide's flame carries padding in its 24-box, so it runs a touch large
const FLAME_NUM = 26;
const DIV_H = 60; // the vertical hairline between the clock and the score block

// Square tiles. They grow to fill the right column but never past TILE_MAX, and shrink so
// even the longest possible game clears the frame.
const TILE_MAX = 92;
const TILE_GAP = 18;
const GRID_MAX_H = SHARE_CARD_H - 2 * PAD;

// Lambda has no usable system fonts, so register the brand families. These are the SAME
// STATIC per-weight instances api/_card.ts registers — the canvas backend matches a face by
// its embedded OS/2 weight and will NOT interpolate a variable font's wght axis, so a variable
// file alone renders every weight thin. new URL(import.meta.url) is the pattern @vercel/nft
// traces to bundle the .ttf into the function (vercel.json also pins them via includeFiles).
// Register once per cold start.
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const reg = (file: string, family: string): void => {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`./_assets/${file}`, import.meta.url)), family);
  };
  for (const w of [500, 600, 700, 800]) reg(`LibreFranklin-${w}.ttf`, 'Libre Franklin');
  reg('Newsreader-700.ttf', 'Newsreader');
  fontsReady = true;
}

const MON_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// "August 11, 2026" — the dateline, matching the app Header's toLocaleDateString.
export function fmtDateFull(s?: string): string {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? `${MON_FULL[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '';
}

// m:ss, exactly as the end footer's fmtClock renders the solve time.
export function fmtClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The end footer's status word, uppercased the way its CSS does. PERFECT is a win with every
// mistake still in hand — the same predicate the app uses.
export function outcomeLabel(solved: boolean, mistakes: number): string {
  if (!solved) return 'FAILED';
  return mistakes <= 0 ? 'PERFECT' : 'SOLVED';
}

export type ShareCardData = {
  puzzleNo?: number | null;
  puzzleDate?: string;
  // One row per committed guess, four group-levels (0-3) each — exactly Game.history.
  grid: number[][];
  solved: boolean;
  mistakes: number;
  // The player's current daily streak. Drawn only at 2+ (a 1-day "streak" is just today).
  streak?: number | null;
  // From the player's own scores row. Either can be missing (an unscored game, an older row
  // with no duration), and a missing stat is DROPPED rather than filled with a placeholder.
  score?: number | null;
  durationMs?: number | null;
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// A lucide icon in its 24x24 viewBox, drawn at `size` with top-left (x, y). Stroked by
// default (lucide's own round caps/joins); `fill` paints it solid instead, which is how the
// app renders the streak flame.
function drawIcon(
  ctx: CanvasRenderingContext2D,
  d: string,
  x: number,
  y: number,
  size: number,
  color: string,
  opts: { sw?: number; fill?: boolean; circle?: boolean } = {},
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  const path = new Path2D(d) as unknown as Path2D;
  if (opts.fill) {
    ctx.fillStyle = color;
    ctx.fill(path);
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.sw ?? 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // lucide's clock is a <circle> plus a <path>; Path2D can't carry the circle element, so
    // it's stroked here in the same transformed space.
    if (opts.circle) {
      ctx.beginPath();
      ctx.arc(12, 12, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.stroke(path);
  }
  ctx.restore();
}

// Tile size + origin for `rows` guess rows, so the grid always sits optically centred in the
// right column however long the game ran. Exported for the layout test: these are the only
// numbers that move between a 4-row and a 7-row card.
export function gridMetrics(rows: number): { size: number; x: number; y: number } {
  const n = Math.max(1, rows);
  const byHeight = Math.floor((GRID_MAX_H + TILE_GAP) / n) - TILE_GAP;
  const byWidth = Math.floor((GRID_RIGHT - GRID_LEFT - 3 * TILE_GAP) / 4);
  const size = Math.max(8, Math.min(TILE_MAX, byHeight, byWidth));
  const w = 4 * size + 3 * TILE_GAP;
  const h = n * size + (n - 1) * TILE_GAP;
  return {
    size,
    x: GRID_LEFT + Math.round((GRID_RIGHT - GRID_LEFT - w) / 2),
    y: Math.round((SHARE_CARD_H - h) / 2),
  };
}

// The app Header, restaged: serif wordmark hard left, the serif date over a small tracked
// "NO. 1170" hard right, a hairline rule beneath. The wordmark shrinks (never the dateline)
// if a long month would otherwise crowd it — measured, not guessed.
function drawHeader(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  ctx.textBaseline = 'alphabetic';
  const date = fmtDateFull(d.puzzleDate);
  const no = d.puzzleNo ? `NO. ${d.puzzleNo}` : '';

  ctx.textAlign = 'right';
  let dateW = 0;
  if (date) {
    ctx.font = `700 ${DATE_SIZE}px Newsreader`;
    dateW = ctx.measureText(date).width;
  }
  let noW = 0;
  if (no) {
    ctx.font = `600 ${NO_SIZE}px "Libre Franklin"`;
    ctx.letterSpacing = '1.36px'; // 0.08em, the app's tracking
    noW = ctx.measureText(no).width;
    ctx.letterSpacing = '0px';
  }
  const rightW = Math.max(dateW, noW);

  // Wordmark, shrunk only as far as it must be to clear the dateline.
  let titleSize = TITLE_SIZE;
  const room = LEFT_RIGHT - PAD - rightW - 40;
  for (let i = 0; i < 8; i++) {
    ctx.font = `700 ${titleSize}px Newsreader`;
    ctx.letterSpacing = `${-0.02 * titleSize}px`;
    if (ctx.measureText('Disconnections').width <= room) break;
    titleSize -= 3;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = TITLE;
  ctx.fillText('Disconnections', PAD, TITLE_BASE);
  ctx.letterSpacing = '0px';

  ctx.textAlign = 'right';
  if (date) {
    ctx.fillStyle = ZINC_300;
    ctx.font = `700 ${DATE_SIZE}px Newsreader`;
    ctx.fillText(date, LEFT_RIGHT, DATE_BASE);
  }
  if (no) {
    ctx.fillStyle = ZINC_600;
    ctx.font = `600 ${NO_SIZE}px "Libre Franklin"`;
    ctx.letterSpacing = '1.36px';
    ctx.fillText(no, LEFT_RIGHT, TITLE_BASE);
    ctx.letterSpacing = '0px';
  }
  ctx.textAlign = 'left';

  ctx.fillStyle = RULE;
  ctx.fillRect(PAD, RULE_Y, LEFT_RIGHT - PAD, 1);
}

// The end footer, restaged: dots hard left, the clock/divider/score cluster hard right, the
// streak flame in the middle. Returns nothing — every piece self-gates on whether its value
// is actually known, so an unscored game simply shows fewer stats.
function drawStats(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  ctx.textBaseline = 'alphabetic';

  // ---- mistake dots (left). Light = still in hand, dark = spent, remaining first.
  const left = Math.max(0, MAX_MISTAKES - d.mistakes);
  for (let i = 0; i < MAX_MISTAKES; i++) {
    ctx.beginPath();
    ctx.arc(PAD + DOT_R + i * (2 * DOT_R + DOT_GAP), STAT_CY, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = i < left ? DOT_LEFT : DOT_SPENT;
    ctx.fill();
  }
  const dotsRight = PAD + MAX_MISTAKES * (2 * DOT_R + DOT_GAP) - DOT_GAP;

  // ---- the score block (right): the uppercase status over the serif "+score", right-aligned
  // at the column edge. The label always draws (it comes from the replay); the number only
  // when the player actually has a scored row.
  const label = outcomeLabel(d.solved, d.mistakes);
  const scoreVal = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;
  const hasScore = scoreVal !== null;
  ctx.textAlign = 'right';
  ctx.fillStyle = d.solved ? EMERALD : ZINC_400;
  ctx.font = `600 ${LABEL_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = '2.88px'; // 0.16em, the app's tracking
  // Normally the label rides above the number; with no number under it, it centres on the row
  // instead of hanging high over empty space.
  ctx.fillText(label, LEFT_RIGHT, hasScore ? STAT_CY - 20 : STAT_CY + 6);
  const labelW = ctx.measureText(label).width;
  ctx.letterSpacing = '0px';

  let scoreW = 0;
  if (hasScore) {
    ctx.fillStyle = TITLE;
    ctx.font = `700 ${SCORE_SIZE}px Newsreader`;
    ctx.letterSpacing = `${-0.02 * SCORE_SIZE}px`;
    const text = `+${scoreVal.toLocaleString('en-US')}`;
    ctx.fillText(text, LEFT_RIGHT, STAT_CY + 22);
    scoreW = ctx.measureText(text).width;
    ctx.letterSpacing = '0px';
  }
  let clusterLeft = LEFT_RIGHT - Math.max(labelW, scoreW);

  // ---- the clock (right of the flame, left of the divider). Dropped whole when the duration
  // is unknown — an older scores row, or a game that never scored — divider included.
  const time = fmtClock(d.durationMs);
  if (time) {
    clusterLeft -= 26;
    ctx.fillStyle = DIVIDER;
    ctx.fillRect(clusterLeft, STAT_CY - DIV_H / 2, 1, DIV_H);
    clusterLeft -= 26;

    ctx.textAlign = 'right';
    ctx.fillStyle = ZINC_400;
    ctx.font = `600 ${TIME_SIZE}px "Libre Franklin"`;
    ctx.fillText(time, clusterLeft, STAT_CY + 9);
    clusterLeft -= ctx.measureText(time).width + 13;
    drawIcon(ctx, ICON_CLOCK.d, clusterLeft - CLOCK_ICON, STAT_CY - CLOCK_ICON / 2, CLOCK_ICON, ZINC_500, {
      sw: ICON_CLOCK.sw,
      circle: true,
    });
    clusterLeft -= CLOCK_ICON;
  }

  // ---- the streak flame, centred in what's left between the dots and the cluster. Same
  // warm/cold ramp the standings use; below 2 it isn't a streak worth a glyph.
  const streak = d.streak;
  if (typeof streak === 'number' && streak >= 2) {
    ctx.textAlign = 'left';
    ctx.font = `700 ${FLAME_NUM}px "Libre Franklin"`;
    const numW = ctx.measureText(String(streak)).width;
    const w = FLAME_ICON + 9 + numW;
    const x = dotsRight + Math.max(24, (clusterLeft - dotsRight - w) / 2);
    drawIcon(ctx, ICON_FLAME, x, STAT_CY - FLAME_ICON / 2 - 1, FLAME_ICON, streak >= 7 ? FLAME_HOT : FLAME_WARM, {
      fill: true,
    });
    ctx.fillStyle = ZINC_200;
    ctx.fillText(String(streak), x + FLAME_ICON + 9, STAT_CY + 9);
  }
  ctx.textAlign = 'left';
}

function drawCard(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  // ---- surface. Full-bleed, not rounded: Discord clips a quick-link hero to its own embed
  // container, so transparent corners of ours would just show the chat behind.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  drawHeader(ctx, d);
  drawStats(ctx, d);

  // ---- right column: the spoiler-free grid. One row per guess, four category squares.
  const rows = d.grid.slice(0, 8);
  const { size, x, y } = gridMetrics(rows.length);
  const r = Math.round(size * 0.18);
  rows.forEach((row, ri) => {
    for (let ci = 0; ci < 4; ci++) {
      roundRect(ctx, x + ci * (size + TILE_GAP), y + ri * (size + TILE_GAP), size, size, r);
      ctx.fillStyle = CAT_COLOR[row[ci]] ?? ZINC_700;
      ctx.fill();
    }
  });
}

// Render the share card to a PNG. Network-free (no avatars, no remote images), so it never
// blocks on a CDN the way the roster card can.
export async function renderShareCard(d: ShareCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(SHARE_CARD_W, SHARE_CARD_H);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  drawCard(ctx, d);
  return canvas.toBuffer('image/png');
}
