// Mockup PNG of how Discord renders the /share Components V2 card (the bordered Container),
// for visual review without posting to a real channel. Approximates Discord's dark message
// chrome + the framed container; the colour squares are drawn rects (≈ how Discord paints the
// unicode 🟦🟩🟨🟪), not real emoji glyphs.
//   npx tsx scripts/share-preview.mts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const OUT = process.argv[2] ?? '/tmp/share-v2-preview.png';
// In-game 4-dot mistake tracker: light = remaining (⚪), dark = spent (⚫). Example: a 2-mistake win.
const REMAINING = 2;
const DOT_LIGHT = '#c4c9ce'; // ⚪ remaining — visible on the dark card
const DOT_DARK = '#31373d'; // ⚫ spent — Twemoji dark slate; sits faint against the dark card

for (const w of [500, 600, 700, 800]) {
  GlobalFonts.registerFromPath(fileURLToPath(new URL(`../api/_assets/LibreFranklin-${w}.ttf`, import.meta.url)), 'Libre Franklin');
}

// Discord dark-theme chrome.
const CHAT_BG = '#313338';
const CARD_BG = '#2b2d31';
const CARD_BORDER = '#3f4147';
const TEXT_HEAD = '#f2f3f5';
const TEXT_MUTE = '#b5bac1';
const TEXT_DIM = '#949ba4';
const NAME = '#f2f3f5';
const BLURPLE = '#5865f2';

// The user's example grid, in level terms (0=yellow,1=green,2=blue,3=purple).
const GRID = [
  [2, 3, 2, 2],
  [2, 1, 2, 2],
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [2, 2, 2, 2],
  [3, 3, 3, 3],
];
// Approximate Discord/emoji square fills (NOT the in-game palette — /share emits unicode squares).
const SQ = ['#f2c84b', '#5ba644', '#4793d1', '#9b6cc9'];

const S = 2; // retina scale
const W = 560;
const H = 392;
const canvas = createCanvas(W * S, H * S);
const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
ctx.scale(S, S);

function rr(x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// Background.
ctx.fillStyle = CHAT_BG;
ctx.fillRect(0, 0, W, H);

const AVX = 18;
const COLX = 70; // content column (right of the avatar)
let y = 20;

// --- "username used /share" reply-ish line ---------------------------------------
ctx.fillStyle = '#5865f2';
ctx.beginPath();
ctx.arc(AVX + 9, y + 8, 9, 0, Math.PI * 2); // tiny avatar
ctx.fill();
ctx.font = '600 13px "Libre Franklin"';
ctx.textBaseline = 'middle';
ctx.fillStyle = '#c9a4f5';
ctx.fillText('cheeseborgar', COLX, y + 8);
let tx = COLX + ctx.measureText('cheeseborgar').width + 6;
ctx.font = '500 13px "Libre Franklin"';
ctx.fillStyle = TEXT_DIM;
ctx.fillText('used', tx, y + 8);
tx += ctx.measureText('used').width + 7;
// "share" command chip.
ctx.font = '600 13px "Libre Franklin"';
const chipW = ctx.measureText('share').width + 14;
ctx.fillStyle = 'rgba(88,101,242,0.24)';
rr(tx, y, chipW, 19, 5);
ctx.fill();
ctx.fillStyle = '#c9cdfb';
ctx.fillText('share', tx + 7, y + 9);

y += 30;

// --- app header: avatar + "Connections" + APP badge + time -----------------------
// App avatar: a rounded four-colour mini grid (brand mark).
const a = AVX, ay = y, sz = 40;
ctx.save();
rr(a, ay, sz, sz, 12);
ctx.clip();
ctx.fillStyle = '#1e1f22';
ctx.fillRect(a, ay, sz, sz);
const cells = [SQ[0], SQ[2], SQ[3], SQ[1]];
const g = 9, gap = 3, ox = a + (sz - (g * 2 + gap)) / 2, oy = ay + (sz - (g * 2 + gap)) / 2;
[[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([cx, cy], i) => {
  ctx.fillStyle = cells[i];
  rr(ox + cx * (g + gap), oy + cy * (g + gap), g, g, 2);
  ctx.fill();
});
ctx.restore();

ctx.textBaseline = 'middle';
ctx.font = '600 15px "Libre Franklin"';
ctx.fillStyle = NAME;
ctx.fillText('Connections', COLX, ay + 9);
let hx = COLX + ctx.measureText('Connections').width + 8;
// APP badge.
ctx.font = '700 10px "Libre Franklin"';
const appW = ctx.measureText('APP').width + 10;
ctx.fillStyle = BLURPLE;
rr(hx, ay + 2, appW, 15, 4);
ctx.fill();
ctx.fillStyle = '#fff';
ctx.fillText('APP', hx + 5, ay + 10);
hx += appW + 8;
ctx.font = '500 12px "Libre Franklin"';
ctx.fillStyle = TEXT_DIM;
ctx.fillText('Today at 6:51 PM', hx, ay + 10);

y = ay + 30;

// --- the Components V2 Container (the framed card) -------------------------------
const cx = COLX;
const pad = 16;
const sqSize = 22, sqGap = 4;
const gridW = 4 * sqSize + 3 * sqGap;

// Plain Wordle-style title (normal weight, no bold), e.g. "Connections #1106 4/4".
const TITLE = 'Connections #1106 4/4';
// Measure widest text line to size the container.
ctx.font = '500 15px "Libre Franklin"';
const headW = ctx.measureText(TITLE).width;
const STAT_TAIL = ' ·  1:34 · 380 pts';
ctx.font = '500 13px "Libre Franklin"';
const statW = 4 * (14 + 5) + ctx.measureText(STAT_TAIL).width; // 4-dot tracker + tail
const innerW = Math.max(headW, gridW, statW);
const cardW = innerW + pad * 2;

const headH = 22, gridH = GRID.length * sqSize + (GRID.length - 1) * sqGap;
const vGap = 18; // Wordle-style breathing room — equal above and below the grid (the line-less spacers)
const cardH = pad + headH + vGap + gridH + vGap + 1 + 16 + 16 + pad;

// Card background + plain border (no accent stripe — matches Wordle's frame).
ctx.fillStyle = CARD_BG;
rr(cx, y, cardW, cardH, 8);
ctx.fill();
ctx.strokeStyle = CARD_BORDER;
ctx.lineWidth = 1;
rr(cx + 0.5, y + 0.5, cardW - 1, cardH - 1, 8);
ctx.stroke();

let iy = y + pad;
const ix = cx + pad;

// Title — plain normal-weight text (like Wordle's "Wordle 1828 4/6").
ctx.font = '500 15px "Libre Franklin"';
ctx.fillStyle = TEXT_HEAD;
ctx.textBaseline = 'top';
ctx.fillText(TITLE, ix, iy);
iy += headH + vGap;

// Grid squares.
for (const row of GRID) {
  let sx = ix;
  for (const lvl of row) {
    ctx.fillStyle = SQ[lvl];
    rr(sx, iy, sqSize, sqSize, 5);
    ctx.fill();
    sx += sqSize + sqGap;
  }
  iy += sqSize + sqGap;
}
iy += vGap - sqGap; // gap below the grid, matching the gap above it

// Divider.
ctx.strokeStyle = CARD_BORDER;
ctx.beginPath();
ctx.moveTo(ix, iy + 0.5);
ctx.lineTo(cx + cardW - pad, iy + 0.5);
ctx.stroke();
iy += 16;

// Subtext stat line: the in-game 4-dot mistake tracker (light ⚪ remaining, then dark ⚫ spent),
// then time, then score. The spent ⚫ are drawn at Twemoji's true dark slate so the preview is
// honest about their low contrast on the dark card.
ctx.textBaseline = 'middle';
const dotR = 7, dotGap = 5;
let fx = ix;
for (let i = 0; i < 4; i++) {
  ctx.fillStyle = i < REMAINING ? DOT_LIGHT : DOT_DARK;
  ctx.beginPath();
  ctx.arc(fx + dotR, iy + 8, dotR, 0, Math.PI * 2);
  ctx.fill();
  fx += dotR * 2 + dotGap;
}
ctx.font = '500 13px "Libre Franklin"';
ctx.fillStyle = TEXT_MUTE;
ctx.fillText(STAT_TAIL, fx - dotGap, iy + 8);

writeFileSync(OUT, canvas.toBuffer('image/png'));
console.log(OUT, 'written', `${W}x${H} @${S}x`);
