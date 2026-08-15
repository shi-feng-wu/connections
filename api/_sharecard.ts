import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas';
import { LEVELS, MAX_MISTAKES } from '../src/game.js';

// The SHARE CARD: the spoiler-free daily result a player posts into chat as a Discord quick
// link (api/share-link.ts). Discord renders a quick link as a rich embed with a hero image,
// a title, a description, and a "Play" button — so this PNG is the hero, and it is the whole
// pitch to everyone who sees it.
//
// IT IS THE END SCREEN, RESTAGED — literally now: one centred column stacked in the game's
// own order, so the card reads as a miniature of the screen the player just finished on:
//   • the header lockup from components.tsx Header — serif "Disconnections" on the left, the
//     serif date over a small tracked "NO. 1170" on the right, over a hairline rule. That is
//     where the app puts the puzzle number, so that is where the card puts it.
//   • the guess grid in the middle, drawn in THE GAME'S OWN TILES: four-across rows the
//     board's proportions (wider than tall, height capped at the board's 80px, gap and
//     corner radius each 1/10 of tile height — the app's gap-2 + rounded-lg on an 80px
//     --tile-h), flat category-color fills like the solved bars.
//   • the stat row from board.tsx EndSummary along the bottom — mistake dots on the left,
//     then the clock icon with the m:ss solve time, a hairline divider, and the uppercase
//     outcome label over the serif "+score". The streak flame (season.tsx ramp) parks in the
//     row's empty middle. No prose: the app states these as icons and numerals, so does this.
//
// SPOILER-FREE IS LOAD-BEARING. The grid is one row of four colored tiles per guess, in the
// CATEGORY colors, and nothing else. No words, no group titles, no answers. A row of four
// matching tiles reads as a solved group, a mixed row as a miss — the same vocabulary the
// board and the "who's playing" card use, which is why someone who hasn't played yet learns
// nothing from it.
//
// Icons are drawn as canvas vector paths from lucide's exact `d` strings (the api/_card.ts
// idiom): the registered TTFs carry no emoji face, so an emoji glyph would render as tofu.
//
// Leading underscore keeps Vercel from treating this file as a route.

// Cropped to the content (owner call, 2026-08-14): the card is the 480px column inside a
// uniform PAD frame — equal padding on all four sides, dateline's cap top to the colophon's
// descenders — a portrait card kept deliberately small for Discord, not a hero box padded
// with dark. Discord never renders an image larger than its natural size, so the tight crop
// is also what keeps the card modest in chat.
const PAD = 48;
export const SHARE_CARD_W = 480 + 2 * PAD;
export const SHARE_CARD_H = 720;

// The QUICK-LINK HERO frame. Discord scales a hero image to fill the embed's width and
// CROPS its height — and the crop box is NOT one ratio: desktop showed ~43:24, mobile a
// ~2.8:1 letterbox (both observed live 2026-08-14; each time only the image's vertical
// middle survived). So the hero is composed like a COVER PHOTO, not a document: everything
// lives in a central horizontal band (HERO_BAND tall, centred), and the dark margins above
// and below are sacrificial crop allowance. Content is safe through a 3:1 window. The
// clipboard copy keeps the bare portrait, which stands alone where it's pasted.
export const SHARE_HERO_W = 1290;
export const SHARE_HERO_H = 720;
export const HERO_BAND = 420; // the crop-safe zone: SHARE_HERO_W / 3 ≈ 430, minus rounding

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
// STACKED: one centred column in the game's own order — header lockup on top, the guess grid
// in the middle, the stat row along the bottom, a 72px margin each side.
//
// COL_W is the app's own board width (the desktop harness lays the board out at ~480px), and
// like the app, EVERYTHING spans it — header rule, tiles, stat row — so at 4 rows the card's
// tiles are the game's tiles at 1:1 (114x80, gap 8, radius 8), not a rescaled impression.
const COL_W = 480;
const COL_L = Math.round((SHARE_CARD_W - COL_W) / 2);
const COL_R = COL_L + COL_W;

// Header lockup pinned at the top of the column. The wordmark scales to the app's proportion
// against the 480 board rather than the old split layout's display size (the measured shrink
// loop below still guards a long month).
const TITLE_SIZE = 42; // the serif wordmark
const DATE_SIZE = 22; // the serif dateline
const NO_SIZE = 17; // "NO. 1170", uppercase + tracked, like the app's — the legibility floor
const TITLE_BASE = 83; // the wordmark's baseline; puts the dateline's cap top at the PAD line
// The date/NO. block used to bottom-align on TITLE_BASE, which parked its optical centre a
// few px above the wordmark's (a two-line block against a single tall line). Dropping it 6px
// centres the block on the wordmark's cap-to-baseline middle instead; the NO. line dips just
// below the shared baseline, with clear air above the rule (no descenders in either line).
const DATE_BASE = TITLE_BASE - 20;
const NO_BASE = TITLE_BASE + 6;
const RULE_Y = TITLE_BASE + 22; // the lockup sits close over its rule, as the app's header does

// Stat row pinned at the bottom, the way the end footer sits under the board. Sized to seat
// dots + flame + clock + score inside the 480 column with the app's own crowding, not less.
const STAT_CY = 602; // the row's vertical centre
const DOT_R = 10;
const DOT_GAP = 10; // the app's footer ratio: gap = dot radius (gap-1.75 on h-3.5 dots)
const CLOCK_ICON = 23;
const TIME_SIZE = 23;
const LABEL_SIZE = 17;
const SCORE_SIZE = 40;
const FLAME_ICON = 27; // lucide's flame carries padding in its 24-box, so it runs a touch large
const FLAME_NUM = 23;
const DIV_H = 52; // the vertical hairline between the clock and the score block

// The grid zone between the rule and the score block's top edge; the grid centres in it.
// Tiles are THE GAME'S TILES, responsive the way the game is responsive: gap (gap-2) and
// corner radius (rounded-lg) are FIXED at 8px at every size — the app never scales either —
// and only tile height flexes (--tile-h clamps 52..80; here rows shrink it instead of
// viewport). Width is the board's formula, four across the 480 column: (480 - 3*8)/4 = the
// game's own 114x80 tile at 4 rows.
const TILE_H_MAX = 80;
const TILE_GAP = 8; // gap-2 — constant, like the app
const TILE_R = 8; // rounded-lg — constant, like the app
export const GRID_TOP = RULE_Y + 26;
export const GRID_BOT = STAT_CY - 38 - 26; // score-block top (label ascenders), minus breathing

// The colophon: the short URL, bottom-centre, tucked close under the stat row (same ~25px
// air the stats keep from the grid) — the equal 72px bottom pad IS its breathing room, not an
// extra zone. The quick link carries its own Play button, but the image travels without it —
// screenshots, forwards, image-only pastes — and this line keeps a way in on every copy.
// Lowercase (it is a URL, not a label), in the NO. line's quiet size and color. Baseline
// leaves the "pp" descenders sitting on the PAD-wide bottom margin.
const COLOPHON_BASE = SHARE_CARD_H - PAD - 4;

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

// Tile geometry + origin for `rows` guess rows, centred in the grid zone however long the
// game ran. Exported for the layout test: these are the only numbers that move between a
// 4-row and a 7-row card. Gap stays the app's constant 8 and only the height shrinks (the
// game's own responsive rule), so a long game compresses rows without spilling past the zone.
export function gridMetrics(rows: number): {
  tileW: number;
  tileH: number;
  gap: number;
  x: number;
  y: number;
} {
  const n = Math.max(1, rows);
  const fit = Math.floor((GRID_BOT - GRID_TOP - (n - 1) * TILE_GAP) / n);
  const tileH = Math.max(8, Math.min(TILE_H_MAX, fit));
  const tileW = Math.floor((COL_W - 3 * TILE_GAP) / 4);
  const w = 4 * tileW + 3 * TILE_GAP;
  const h = n * tileH + (n - 1) * TILE_GAP;
  return {
    tileW,
    tileH,
    gap: TILE_GAP,
    x: COL_L + Math.round((COL_W - w) / 2),
    y: Math.round(GRID_TOP + (GRID_BOT - GRID_TOP - h) / 2),
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
  const room = COL_W - rightW - 40;
  for (let i = 0; i < 8; i++) {
    ctx.font = `700 ${titleSize}px Newsreader`;
    ctx.letterSpacing = `${-0.02 * titleSize}px`;
    if (ctx.measureText('Disconnections').width <= room) break;
    titleSize -= 3;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = TITLE;
  ctx.fillText('Disconnections', COL_L, TITLE_BASE);
  ctx.letterSpacing = '0px';

  ctx.textAlign = 'right';
  if (date) {
    ctx.fillStyle = ZINC_300;
    ctx.font = `700 ${DATE_SIZE}px Newsreader`;
    ctx.fillText(date, COL_R, DATE_BASE);
  }
  if (no) {
    ctx.fillStyle = ZINC_600;
    ctx.font = `600 ${NO_SIZE}px "Libre Franklin"`;
    ctx.letterSpacing = '1.36px';
    ctx.fillText(no, COL_R, NO_BASE);
    ctx.letterSpacing = '0px';
  }
  ctx.textAlign = 'left';

  ctx.fillStyle = RULE;
  ctx.fillRect(COL_L, RULE_Y, COL_W, 1);
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
    ctx.arc(COL_L + DOT_R + i * (2 * DOT_R + DOT_GAP), STAT_CY, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = i < left ? DOT_LEFT : DOT_SPENT;
    ctx.fill();
  }
  const dotsRight = COL_L + MAX_MISTAKES * (2 * DOT_R + DOT_GAP) - DOT_GAP;

  // ---- the score block (right): the uppercase status over the serif "+score", right-aligned
  // at the column edge. The label always draws (it comes from the replay); the number only
  // when the player actually has a scored row.
  const label = outcomeLabel(d.solved, d.mistakes);
  const scoreVal = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;
  const hasScore = scoreVal !== null;
  ctx.textAlign = 'right';
  ctx.fillStyle = d.solved ? EMERALD : ZINC_400;
  ctx.font = `600 ${LABEL_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = '2.72px'; // 0.16em, the app's tracking
  // Normally the label rides above the number; with no number under it, it centres on the row
  // instead of hanging high over empty space.
  ctx.fillText(label, COL_R, hasScore ? STAT_CY - 18 : STAT_CY + 6);
  const labelW = ctx.measureText(label).width;
  ctx.letterSpacing = '0px';

  let scoreW = 0;
  if (hasScore) {
    ctx.fillStyle = TITLE;
    ctx.font = `700 ${SCORE_SIZE}px Newsreader`;
    ctx.letterSpacing = `${-0.02 * SCORE_SIZE}px`;
    const text = `+${scoreVal.toLocaleString('en-US')}`;
    ctx.fillText(text, COL_R, STAT_CY + 20);
    scoreW = ctx.measureText(text).width;
    ctx.letterSpacing = '0px';
  }
  let clusterLeft = COL_R - Math.max(labelW, scoreW);

  // ---- the clock (right of the flame, left of the divider). Dropped whole when the duration
  // is unknown — an older scores row, or a game that never scored — divider included.
  const time = fmtClock(d.durationMs);
  if (time) {
    clusterLeft -= 20;
    ctx.fillStyle = DIVIDER;
    ctx.fillRect(clusterLeft, STAT_CY - DIV_H / 2, 1, DIV_H);
    clusterLeft -= 20;

    ctx.textAlign = 'right';
    ctx.fillStyle = ZINC_400;
    ctx.font = `600 ${TIME_SIZE}px "Libre Franklin"`;
    ctx.fillText(time, clusterLeft, STAT_CY + 8);
    clusterLeft -= ctx.measureText(time).width + 11;
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
    const w = FLAME_ICON + 8 + numW;
    const x = dotsRight + Math.max(20, (clusterLeft - dotsRight - w) / 2);
    drawIcon(ctx, ICON_FLAME, x, STAT_CY - FLAME_ICON / 2 - 1, FLAME_ICON, streak >= 7 ? FLAME_HOT : FLAME_WARM, {
      fill: true,
    });
    ctx.fillStyle = ZINC_200;
    ctx.fillText(String(streak), x + FLAME_ICON + 8, STAT_CY + 8);
  }
  ctx.textAlign = 'left';
}

// The card's corner radius — the SAME 30px the roster/recap cards use (src/card-draw.ts
// CARD_R), for the same reason: Discord re-clips inline media to a fixed-DP rounded mask,
// which on a high-density phone maps to ~24–36 image px, so a smaller radius gets its corner
// turn shaved off. Corners outside it stay transparent.
const CARD_R = 30;

function drawCard(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  // ---- surface. Rounded like the family's other cards, transparent past the radius.
  ctx.fillStyle = BG;
  roundRect(ctx, 0, 0, SHARE_CARD_W, SHARE_CARD_H, CARD_R);
  ctx.fill();

  drawHeader(ctx, d);
  drawStats(ctx, d);

  // ---- colophon (see COLOPHON_BASE): the NO. line's size and color, lowercase, centred.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ZINC_600;
  ctx.font = `600 ${NO_SIZE}px "Libre Franklin"`;
  ctx.letterSpacing = '1.36px';
  ctx.fillText('disconnections.app', SHARE_CARD_W / 2, COLOPHON_BASE);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  // ---- the spoiler-free grid, in the game's tiles. One row per guess, four category tiles
  // at the app's fixed 8px radius (roundRect clamps it on a degenerate sliver-short tile).
  const rows = d.grid.slice(0, 8);
  const { tileW, tileH, gap, x, y } = gridMetrics(rows.length);
  rows.forEach((row, ri) => {
    for (let ci = 0; ci < 4; ci++) {
      roundRect(ctx, x + ci * (tileW + gap), y + ri * (tileH + gap), tileW, tileH, TILE_R);
      ctx.fillStyle = CAT_COLOR[row[ci]] ?? ZINC_700;
      ctx.fill();
    }
  });
}

// The hero restages the portrait's pieces SIDE BY SIDE inside the crop-safe band: the
// header lockup + stat row on the left (drawHeader/drawStats translated into the band —
// their own constants are portrait-anchored), the guess grid on the right. No colophon:
// the embed itself carries the app name, description and Play button.
const HERO_COL_DX = 42; // shifts the 480 column from portrait x (48) to hero x (90)
const HERO_HEADER_DY = 227; // portrait header (rule at 105) → rule at 332, upper band
const HERO_STATS_DY = -186; // portrait stat row (cy 602) → cy 416, lower band
const HERO_GRID_L = SHARE_HERO_W - 90 - COL_W; // right-aligned, mirroring the left margin

function drawHero(ctx: CanvasRenderingContext2D, d: ShareCardData): void {
  // Full-bleed, no rounding: Discord's own mask shapes the hero's frame, and transparent
  // corners of ours would just show whatever the client paints behind the crop.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SHARE_HERO_W, SHARE_HERO_H);

  ctx.save();
  ctx.translate(HERO_COL_DX, HERO_HEADER_DY);
  drawHeader(ctx, d);
  ctx.restore();
  ctx.save();
  ctx.translate(HERO_COL_DX, HERO_STATS_DY);
  drawStats(ctx, d);
  ctx.restore();

  // The grid, game tiles as ever (constant 8px gap, width 114), height fitted to the band
  // instead of the portrait's grid zone, centred on the band's middle.
  const rows = d.grid.slice(0, 8);
  const n = Math.max(1, rows.length);
  const tileH = Math.max(8, Math.min(TILE_H_MAX, Math.floor((HERO_BAND - (n - 1) * TILE_GAP) / n)));
  const tileW = Math.floor((COL_W - 3 * TILE_GAP) / 4);
  const h = n * tileH + (n - 1) * TILE_GAP;
  const y = Math.round((SHARE_HERO_H - h) / 2);
  rows.forEach((row, ri) => {
    for (let ci = 0; ci < 4; ci++) {
      roundRect(
        ctx,
        HERO_GRID_L + ci * (tileW + TILE_GAP),
        y + ri * (tileH + TILE_GAP),
        tileW,
        tileH,
        TILE_R,
      );
      ctx.fillStyle = CAT_COLOR[row[ci]] ?? ZINC_700;
      ctx.fill();
    }
  });
}

// The portrait ships at 2x its layout size. Discord displays an inline image at NATURAL
// size until it exceeds the surface's max box — and the attachment box and the link-unfurl
// box have different caps, so a 576x720 card rendered natural-size on one surface and
// scaled on the other showed at two different sizes side by side (observed live
// 2026-08-14). At 2x every surface is past its cap and scales down to its own box, so the
// displayed sizes converge — and the card reads retina-crisp instead of upscaled. The hero
// already exceeds every cap at 1x.
const CARD_SCALE = 2;

// Render the share card to a PNG. Network-free (no avatars, no remote images), so it never
// blocks on a CDN the way the roster card can. `hero: true` renders the crop-safe wide
// banner the quick-link mint ships; default is the bare portrait for the clipboard copy.
//
// `scale` overrides CARD_SCALE for the one surface where SMALLER is correct: the
// share-moment ATTACHMENT. Attachments display at natural size up to a box that is LARGER
// than the link-unfurl box, so a 2x attachment rendered visibly bigger than /share and a
// pasted link beside it. Discord's own proxy serves the unfurl of this card at exactly
// 576x720 (measured 2026-08-14), so a 1x upload makes the attachment's natural size land
// on the same displayed size as the unfurl — all three surfaces finally match.
export async function renderShareCard(
  d: ShareCardData,
  opts: { hero?: boolean; scale?: number } = {},
): Promise<Buffer> {
  ensureFonts();
  if (opts.hero) {
    const canvas = createCanvas(SHARE_HERO_W, SHARE_HERO_H);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    drawHero(ctx, d);
    return canvas.toBuffer('image/png');
  }
  const scale = opts.scale ?? CARD_SCALE;
  const canvas = createCanvas(SHARE_CARD_W * scale, SHARE_CARD_H * scale);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  ctx.scale(scale, scale);
  drawCard(ctx, d);
  return canvas.toBuffer('image/png');
}
