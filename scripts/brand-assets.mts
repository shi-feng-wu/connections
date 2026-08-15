// Render the site's brand PNGs — the homepage OG image and the two favicons — straight from
// the app's own tokens, so the picture a link preview shows is the picture the landing page
// shows.
//   npx tsx scripts/brand-assets.mts
//
// index.html already points at all three (`/og.png`, `/favicon.png`, `/apple-touch-icon.png`);
// this script is what puts them there. Re-run it whenever the wordmark, the tagline or the
// landing's atmosphere changes — the output is deterministic, so a re-run with nothing changed
// rewrites byte-identical files.
//
// WHY A SCRIPT AND NOT A CHECKED-IN EXPORT. The card family (api/_card.ts, api/_sharecard.ts)
// already draws the brand with @napi-rs/canvas out of the same static TTFs; drawing these here
// too means the OG wordmark is the SAME face at the SAME tracking as the one on the share card
// a player posts, rather than a screenshot that drifts the first time a token moves.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');
// Optional second destination (the orchestrator's scratchpad, CI artifact dir, wherever) —
// `npx tsx scripts/brand-assets.mts /some/dir` drops a copy of each file there too.
const ALSO = process.argv[2];

// ---- fonts -----------------------------------------------------------------------------
// The SAME static per-weight instances the card renderers register (api/_sharecard.ts
// ensureFonts). @napi-rs/canvas matches a face by its embedded OS/2 weight and will NOT
// interpolate a variable font's wght axis, so a variable file renders bold text thin.
for (const w of [500, 600, 700, 800]) {
  GlobalFonts.registerFromPath(join(here, '..', 'api', '_assets', `LibreFranklin-${w}.ttf`), 'Libre Franklin');
}
GlobalFonts.registerFromPath(join(here, '..', 'api', '_assets', 'Newsreader-700.ttf'), 'Newsreader');

// ---- palette (src/landing.tsx + brand.css) ----------------------------------------------
const BG = '#000000'; // the landing's ground, and index.html's theme-color
const TITLE = '#e8eaee'; // the wordmark's cool off-white, as components.tsx Header sets it
const ZINC_400 = '#a1a1aa'; // the landing's body/tagline tone

// NO WASH LAYER (owner call, 2026-08-15). The landing's two faint corner washes were carried in
// here at ~2x alpha, because a thumbnail-sized lossy re-encode quantises the page's own 0.05/0.06
// away to flat black. Cranking them to survive that was the problem: what reads as atmosphere
// behind a full page reads as a smudge behind a wordmark in a link preview. The ground is flat.

// ---- geometry --------------------------------------------------------------------------
const OG_W = 1200;
const OG_H = 630; // the og:image:width/height pinned in index.html
const OG_MARGIN = 112; // generous — the lockup never comes near the crop edges
const WORDMARK = 'Disconnections';
const TAGLINE = 'The daily puzzle, played together.'; // the landing h1, verbatim

type Ctx = CanvasRenderingContext2D;

function renderOG(): Buffer {
  const canvas = createCanvas(OG_W, OG_H);
  const ctx = canvas.getContext('2d') as unknown as Ctx;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, OG_W, OG_H);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Wordmark: Newsreader bold at the header's -0.025em tracking, shrunk only if a future
  // wordmark would crowd the margins.
  let titleSize = 128;
  const room = OG_W - 2 * OG_MARGIN;
  const setTitle = (): void => {
    ctx.font = `700 ${titleSize}px Newsreader`;
    ctx.letterSpacing = `${(-0.025 * titleSize).toFixed(2)}px`;
  };
  for (let i = 0; i < 10; i++) {
    setTitle();
    if (ctx.measureText(WORDMARK).width <= room) break;
    titleSize -= 4;
  }
  setTitle();
  const tm = ctx.measureText(WORDMARK);
  ctx.letterSpacing = '0px';

  const tagSize = 36;
  const setTag = (): void => {
    ctx.font = `500 ${tagSize}px "Libre Franklin"`;
    ctx.letterSpacing = '0.2px'; // a whisker open, so the sans doesn't read cramped under the serif
  };
  setTag();
  const gm = ctx.measureText(TAGLINE);
  ctx.letterSpacing = '0px';

  // Optical centring on the INK, not on font metrics: the block runs from the wordmark's cap
  // top to the tagline's descenders, centred on the canvas and lifted a hair (a block sitting
  // dead-centre reads low).
  const gap = Math.round(titleSize * 0.29); // wordmark baseline → tagline cap top
  const inkH = tm.actualBoundingBoxAscent + gap + gm.actualBoundingBoxAscent + gm.actualBoundingBoxDescent;
  const inkTop = Math.round((OG_H - inkH) / 2) - 6;
  const titleBase = Math.round(inkTop + tm.actualBoundingBoxAscent);
  const tagBase = Math.round(titleBase + gap + gm.actualBoundingBoxAscent);

  setTitle();
  ctx.fillStyle = TITLE;
  ctx.fillText(WORDMARK, Math.round((OG_W - tm.width) / 2), titleBase);
  ctx.letterSpacing = '0px';

  setTag();
  ctx.fillStyle = ZINC_400;
  ctx.fillText(TAGLINE, Math.round((OG_W - gm.width) / 2), tagBase);
  ctx.letterSpacing = '0px';

  // Nothing else. The identity is the Newsreader wordmark alone — no emblem, no tile row:
  // a lone 2x2 (or 1x4) of category-colour squares reads as the old Connections mark this
  // project deliberately dropped.
  return canvas.toBuffer('image/png');
}

// The app icon. No mark ships in this repo, so the icon is the wordmark's first letter in the
// same Newsreader bold — a lettermark, not an emblem — filling `fill` of the square by CAP
// HEIGHT and optically centred on its own ink box (glyph side bearings are not symmetric, so
// centring the advance width would sit it visibly left).
function renderIcon(size: number, fill: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, size, size);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // Solve for the point size whose cap height is `fill` of the square.
  ctx.font = `700 100px Newsreader`;
  const capAt100 = ctx.measureText('D').actualBoundingBoxAscent;
  const px = Math.round((size * fill * 100) / capAt100);
  ctx.font = `700 ${px}px Newsreader`;
  const m = ctx.measureText('D');
  const inkW = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
  const x = Math.round((size - inkW) / 2 + m.actualBoundingBoxLeft);
  const y = Math.round((size + m.actualBoundingBoxAscent) / 2);

  ctx.fillStyle = TITLE;
  ctx.fillText('D', x, y);
  return canvas.toBuffer('image/png');
}

const OUT: Array<[string, Buffer, string]> = [
  ['og.png', renderOG(), `${OG_W}x${OG_H}`],
  // 96px browser favicon, and the 180px iOS home-screen icon — the latter a touch smaller in
  // its box, because iOS rounds the corners in and a tight glyph would crowd the mask.
  ['favicon.png', renderIcon(96, 0.65), '96x96'],
  ['apple-touch-icon.png', renderIcon(180, 0.58), '180x180'],
];

for (const [name, buf, dims] of OUT) {
  const dest = join(PUBLIC, name);
  writeFileSync(dest, buf);
  console.log(`${dest}  ${dims}  ${buf.length} bytes`);
  if (ALSO) {
    mkdirSync(ALSO, { recursive: true });
    copyFileSync(dest, join(ALSO, name));
  }
}
if (ALSO) console.log(`copies → ${ALSO}`);
