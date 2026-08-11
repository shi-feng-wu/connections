import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { LEVELS, MAX_MISTAKES } from '../src/game.js';

// The SHARE CARD: the spoiler-free daily result a player posts into chat as a Discord
// quick link (api/share-link.ts). Discord renders a quick link as a rich embed with a
// 43:24 hero image, a title, a description, and a "Play" button — so this PNG is the
// hero, and it is the whole pitch to everyone who sees it.
//
// SPOILER-FREE IS LOAD-BEARING. The card carries the guess grid the way Wordle's does:
// one row of four colored squares per guess, in the CATEGORY colors, and nothing else.
// No words, no group titles, no answers. A row of four matching squares reads as a
// solved group, a mixed row as a miss — exactly the vocabulary the in-game board and
// the "who's playing" card already use (see src/card-draw.ts), which is why someone
// who hasn't played yet learns nothing from it.
//
// Sized 1290x720 = 43:24 exactly, the ratio Discord crops quick-link images to.
//
// The drawing is deliberately self-contained (no src/card-draw.ts import beyond the
// shared LEVELS palette): that module's layout constants are tuned for the ~460-810px
// roster/recap cards, and this card is 1290px on a different composition. Fonts and the
// PNG encode follow api/_card.ts exactly. Leading underscore keeps Vercel from treating
// this file as a route.

// 43:24 — Discord's quick-link hero ratio. 1290x720 keeps the serif wordmark crisp on a
// desktop embed without pushing the base64 payload up (flat fills compress hard).
export const SHARE_CARD_W = 1290;
export const SHARE_CARD_H = 720;

// ---- palette (same values src/card-draw.ts draws the roster/recap cards with; kept here
// so this file has no dependency on that module's private layout constants) ----
const BG = '#09090b'; // zinc-950 — the card surface
const TITLE = '#e8eaee'; // cool off-white wordmark
const ZINC_500 = '#71717a';
const ZINC_400 = '#a1a1aa';
const ZINC_300 = '#d4d4d8';
const ZINC_700 = '#3f3f46';
const DIVIDER = '#232327';
const EMERALD = '#34d399'; // emerald-400 — the app's "solved" accent
const DOT_LEFT = ZINC_300; // a mistake still in hand (the board's light dot)
const DOT_SPENT = ZINC_700; // a spent mistake (the board's dark dot)
const CAT_COLOR = LEVELS.map((l) => l.color); // yellow, green, blue, purple

// ---- layout (px) ----
const PAD = 76;
// The card splits left/right: brand + stats in the left column, the grid on the right,
// with a hairline between them. A 43:24 frame is far too wide to stack them.
const SPLIT_X = 700; // the vertical hairline
const GRID_LEFT = 756; // left edge of the grid region
const GRID_RIGHT = SHARE_CARD_W - PAD;

const EYE_SIZE = 17;
const MARK = 15; // one square of the four-color brand mark
const MARK_GAP = 5;
const MARK_TO_TEXT = 16;
const TITLE_SIZE = 62;
const SUB_SIZE = 25;
const STAT_SIZE = 28;
const STREAK_SIZE = 24;
const DOT_R = 11;
const DOT_GAP = 12;

// Tile geometry. Squares grow to fill the right column but never past TILE_MAX, and
// shrink so even the longest possible game (7 committed guesses) clears the frame.
const TILE_MAX = 100;
const TILE_GAP = 18;
const GRID_MAX_H = SHARE_CARD_H - 2 * PAD;

// Lambda has no usable system fonts, so register the brand families. These are the SAME
// STATIC per-weight instances api/_card.ts registers — the canvas backend matches a face
// by its embedded OS/2 weight and will NOT interpolate a variable font's wght axis, so a
// variable file alone renders every weight thin. new URL(import.meta.url) is the pattern
// @vercel/nft traces to bundle the .ttf into the function (vercel.json also pins them via
// includeFiles). Register once per cold start.
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

// "August 11, 2026" — the card's subline, matching the roster/recap cards' fmtDateFull.
export function fmtDateFull(s?: string): string {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? `${MON_FULL[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '';
}

// The one-line result read under the mistake dots. Spoiler-free by construction: it
// only ever names the outcome and a count, never a word or a category.
export function outcomeLine(solved: boolean, mistakes: number): string {
  if (!solved) return 'Out of guesses';
  if (mistakes === 0) return 'Perfect solve';
  return `Solved with ${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
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

// Tile size + origin for `rows` guess rows, so the grid always sits optically centred in
// the right column however long the game ran. Exported for the layout test: these are the
// only numbers that move between a 4-row and a 7-row card.
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

function drawCard(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  const rows = d.grid.slice(0, 8);
  const showStreak = typeof d.streak === 'number' && d.streak >= 2;

  // ---- surface. Full-bleed, not rounded: Discord clips a quick-link hero to its own
  // embed container, so transparent corners of ours would just show the chat behind.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  // ---- left column: brand mark + eyebrow, serif wordmark, date subline, rule, stats.
  // The block is centred as a whole, so dropping the streak line doesn't leave it
  // hanging high in the frame.
  const top = showStreak ? 205 : 235;
  const eyeBase = top;
  const titleBase = eyeBase + 72;
  const subBase = titleBase + 42;
  const ruleY = subBase + 52;
  const dotsY = ruleY + 62;
  const statBase = dotsY + 58;
  const streakBase = statBase + 52;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Four-color brand mark. NOT the retired four-squares emblem — this is the same small
  // category swatch row the recap card's header carries, ahead of the eyebrow text.
  let mx = PAD;
  for (let c = 0; c < 4; c++) {
    roundRect(ctx, mx, eyeBase - MARK, MARK, MARK, 2.5);
    ctx.fillStyle = CAT_COLOR[c];
    ctx.fill();
    mx += MARK + MARK_GAP;
  }
  const eyeX = PAD + 4 * (MARK + MARK_GAP) - MARK_GAP + MARK_TO_TEXT;
  ctx.fillStyle = ZINC_500;
  ctx.font = `700 ${EYE_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = '2.7px'; // 0.16em
  ctx.fillText(d.puzzleNo ? `DAILY RESULT · #${d.puzzleNo}` : 'DAILY RESULT', eyeX, eyeBase);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = TITLE;
  ctx.font = `700 ${TITLE_SIZE}px Newsreader`;
  ctx.letterSpacing = '-1.24px'; // -0.02em
  ctx.fillText('Disconnections', PAD, titleBase);
  ctx.letterSpacing = '0px';

  const sub = fmtDateFull(d.puzzleDate);
  if (sub) {
    ctx.fillStyle = ZINC_500;
    ctx.font = `500 ${SUB_SIZE}px "Libre Franklin"`;
    ctx.fillText(sub, PAD, subBase);
  }

  ctx.fillStyle = DIVIDER;
  ctx.fillRect(PAD, ruleY, SPLIT_X - 60 - PAD, 1);

  // Mistake tracker, the in-game four dots: light = still in hand, dark = spent. Reads
  // "how close was this" at a glance without naming anything.
  const left = Math.max(0, MAX_MISTAKES - d.mistakes);
  for (let i = 0; i < MAX_MISTAKES; i++) {
    ctx.beginPath();
    ctx.arc(PAD + DOT_R + i * (2 * DOT_R + DOT_GAP), dotsY, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = i < left ? DOT_LEFT : DOT_SPENT;
    ctx.fill();
  }

  ctx.fillStyle = d.solved ? EMERALD : ZINC_400;
  ctx.font = `700 ${STAT_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = '-0.3px';
  ctx.fillText(outcomeLine(d.solved, d.mistakes), PAD, statBase);
  ctx.letterSpacing = '0px';

  if (showStreak) {
    ctx.fillStyle = ZINC_400;
    ctx.font = `600 ${STREAK_SIZE}px "Libre Franklin"`;
    ctx.fillText(`${d.streak} day streak`, PAD, streakBase);
  }

  // ---- the hairline between the two columns.
  ctx.fillStyle = DIVIDER;
  ctx.fillRect(SPLIT_X, 140, 1, SHARE_CARD_H - 280);

  // ---- right column: the spoiler-free grid. One row per guess, four category squares.
  const { size, x, y } = gridMetrics(rows.length);
  const r = Math.round(size * 0.18);
  rows.forEach((row, ri) => {
    for (let ci = 0; ci < 4; ci++) {
      const lvl = row[ci];
      roundRect(
        ctx,
        x + ci * (size + TILE_GAP),
        y + ri * (size + TILE_GAP),
        size,
        size,
        r,
      );
      ctx.fillStyle = CAT_COLOR[lvl] ?? ZINC_700;
      ctx.fill();
    }
  });
}

// Render the share card to a PNG. Network-free (no avatars, no remote images), so it
// never blocks on a CDN the way the roster card can.
export async function renderShareCard(d: ShareCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(SHARE_CARD_W, SHARE_CARD_H);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  drawCard(ctx, d);
  return canvas.toBuffer('image/png');
}
