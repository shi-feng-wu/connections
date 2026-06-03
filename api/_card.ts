import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, type Image, loadImage } from '@napi-rs/canvas';
import { LEVELS } from '../src/game.js';

// Renders the "who's playing today" card to a PNG: one tile per player, each a
// circular avatar beside a fixed-size grid of their Connections guesses so far
// (the colour squares fill in as they play). Posted/edited on the channel webhook
// by /api/join (a new player joins) and /api/refresh-card (someone guesses); the
// roster is append-only — joining adds you, leaving never removes you.
// Leading underscore keeps Vercel from treating this file as a route.

// Lambda has no usable system fonts, so register bundled ones. new URL(import.meta.url)
// is the pattern @vercel/nft traces to bundle the .ttf into the function (belt-and-
// suspenders: vercel.json also pins them via includeFiles). Register once per cold start.
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(fileURLToPath(new URL('./_assets/Inter-Regular.ttf', import.meta.url)), 'Inter');
  GlobalFonts.registerFromPath(
    fileURLToPath(new URL('./_assets/Inter-SemiBold.ttf', import.meta.url)),
    'Inter SemiBold',
  );
  fontsReady = true;
}

// grid: each row is one guess as four group-levels (0-3); a correct guess is four of
// a kind, a wrong one is mixed. Derived by replaying the player's committed guesses
// (see api/_livecard.ts). Absent/empty → the all-blank grid (hasn't guessed yet).
export type CardPlayer = { id: string; name: string; avatar?: string | null; grid?: number[][] };

// How long after posting the card before a new join bumps a fresh message instead of
// editing in place. Event-driven (only a real new join can trigger it), so a quiet
// room sees one card and an active one sees it resurface a few times a day. Tune here.
export const CARD_REPOST_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Whether a new join should post a fresh card (bump) vs edit the existing one: bump if
// there's no card yet, or it's been at least the cooldown since the last *post*.
export function shouldRepost(
  lastPostedAtMs: number | null,
  nowMs: number,
  cooldownMs: number = CARD_REPOST_COOLDOWN_MS,
): boolean {
  if (!lastPostedAtMs) return true;
  return nowMs - lastPostedAtMs >= cooldownMs;
}

// Append-only merge: add a player iff not already present (by id). Returns whether it
// changed so the caller can skip a re-render/edit on a rejoin. This is what gives the
// card its "added on join, never removed on leave" behaviour.
export function mergePlayer(
  players: CardPlayer[],
  p: CardPlayer,
): { players: CardPlayer[]; changed: boolean } {
  if (players.some((x) => x.id === p.id)) return { players, changed: false };
  return { players: [...players, p], changed: true };
}

// Layout (px). A Connections game runs at most seven guesses (three misses plus four
// solves), so a 4×7 grid never clips; unplayed rows render as blank cells.
const GRID_COLS = 4;
const GRID_ROWS = 7;
const CELL = 24;
const CELL_GAP = 5;
const CELL_R = 5;
const GRID_W = GRID_COLS * CELL + (GRID_COLS - 1) * CELL_GAP;
const GRID_H = GRID_ROWS * CELL + (GRID_ROWS - 1) * CELL_GAP;

const AV = 88; // avatar diameter
const NAME_GAP = 10;
const NAME_H = 20;

const BOX_PAD = 20;
const AVCOL_W = Math.max(AV, 120); // avatar column; widened so names have room
const AVGRID_GAP = 20;
const BOX_W = BOX_PAD + AVCOL_W + AVGRID_GAP + GRID_W + BOX_PAD;
const BOX_H = 2 * BOX_PAD + Math.max(GRID_H, AV + NAME_GAP + NAME_H);
const BOX_R = 14;
const BOX_GAP = 16;
const MAX_COLS = 2; // player tiles per row (Wordle-style)

const OUTER_PAD = 30;
const HEADER_H = 82;
const MAX_CARDS = 12; // bound the image; overflow is summarised in the header

const PAGE = '#1a1b1e';
const BOX_BG = '#232529';
const BOX_BORDER = '#393b41';
const TITLE = '#f2f3f5';
const SUBTITLE = '#9499a0';
const NAME = '#dbdee1';
const RING = '#52555c';
const EMPTY = '#2c2e33';
const EMPTY_BORDER = '#3c3e44';
const CELL_COLOR = LEVELS.map((l) => l.color);

// Deterministic placeholder colour from a user id, for players without an avatar.
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

function initial(name: string): string {
  const c = name.trim()[0];
  return c ? c.toUpperCase() : '?';
}

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

// Truncate to fit maxW with an ellipsis (ctx must already have the name font set).
function fitText(ctx: Ctx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export async function renderRoster(
  players: CardPlayer[],
  opts: { puzzleNo?: number } = {},
): Promise<Buffer> {
  ensureFonts();

  const shown = players.slice(0, MAX_CARDS);
  const cols = Math.max(1, Math.min(MAX_COLS, shown.length));
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const W = OUTER_PAD * 2 + cols * BOX_W + (cols - 1) * BOX_GAP;
  const height = OUTER_PAD + HEADER_H + rows * BOX_H + (rows - 1) * BOX_GAP + OUTER_PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = PAGE;
  ctx.fillRect(0, 0, W, height);

  // Header, centred like the Wordle card.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TITLE;
  ctx.font = '600 36px "Inter SemiBold"';
  ctx.fillText(`Connections${opts.puzzleNo ? ` #${opts.puzzleNo}` : ''}`, W / 2, OUTER_PAD + 38);
  ctx.fillStyle = SUBTITLE;
  ctx.font = '400 18px Inter';
  const total = players.length;
  const extra = total > MAX_CARDS ? ` · showing ${MAX_CARDS}` : '';
  ctx.fillText(`${total} ${total === 1 ? 'player' : 'players'} playing today${extra}`, W / 2, OUTER_PAD + 66);

  // Resolve avatars in parallel; a failed/absent one renders as a colour+initial.
  const images = await Promise.all(
    shown.map(async (p): Promise<Image | null> => {
      if (!p.avatar) return null;
      try {
        return await loadImage(p.avatar);
      } catch {
        return null;
      }
    }),
  );

  shown.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bx = OUTER_PAD + col * (BOX_W + BOX_GAP);
    const by = OUTER_PAD + HEADER_H + row * (BOX_H + BOX_GAP);

    // Tile.
    roundRect(ctx, bx, by, BOX_W, BOX_H, BOX_R);
    ctx.fillStyle = BOX_BG;
    ctx.fill();
    ctx.strokeStyle = BOX_BORDER;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Avatar + name, vertically centred in the tile's avatar column.
    const blockTop = by + BOX_PAD + (BOX_H - 2 * BOX_PAD - (AV + NAME_GAP + NAME_H)) / 2;
    const cx = bx + BOX_PAD + AVCOL_W / 2;
    const cy = blockTop + AV / 2;
    const img = images[i];

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, AV / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      ctx.drawImage(img, cx - AV / 2, cy - AV / 2, AV, AV);
    } else {
      ctx.fillStyle = colorFor(p.id);
      ctx.fillRect(cx - AV / 2, cy - AV / 2, AV, AV);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 34px "Inter SemiBold"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initial(p.name), cx, cy + 1);
    }
    ctx.restore();

    ctx.strokeStyle = RING;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, AV / 2 + 1, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = NAME;
    ctx.font = '400 16px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fitText(ctx, p.name, AVCOL_W + 8), cx, blockTop + AV + NAME_GAP);

    // Guess grid, vertically centred against the avatar.
    const gx = bx + BOX_PAD + AVCOL_W + AVGRID_GAP;
    const gy = by + (BOX_H - GRID_H) / 2;
    const grid = p.grid;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const x = gx + c * (CELL + CELL_GAP);
        const y = gy + r * (CELL + CELL_GAP);
        const lvl = grid?.[r]?.[c];
        roundRect(ctx, x, y, CELL, CELL, CELL_R);
        if (typeof lvl === 'number' && lvl >= 0 && lvl < CELL_COLOR.length) {
          ctx.fillStyle = CELL_COLOR[lvl];
          ctx.fill();
        } else {
          ctx.fillStyle = EMPTY;
          ctx.fill();
          ctx.strokeStyle = EMPTY_BORDER;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  });

  return canvas.toBuffer('image/png');
}
