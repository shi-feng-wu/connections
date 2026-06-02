import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, type Image, loadImage } from '@napi-rs/canvas';

// Renders the "who's playing today" roster card to a PNG. Posted/edited on the
// channel webhook by /api/join as people join (append-only; nobody is removed).
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

export type CardPlayer = { id: string; name: string; avatar?: string | null };

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

// Layout (px).
const W = 720;
const PAD = 36;
const HEADER_H = 92;
const AV = 72; // avatar diameter
const COLS = 6;
const CELL_W = (W - 2 * PAD) / COLS;
const NAME_GAP = 12;
const ROW_GAP = 26;
const CELL_H = AV + NAME_GAP + 20 + ROW_GAP;
const MAX_AVATARS = 48; // bound the image; overflow is summarised in the header

const BG = '#1e1f22';
const TITLE = '#f2f3f5';
const SUBTITLE = '#b5bac1';
const NAME = '#dbdee1';
const RING = '#5865f2';

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

// Truncate to fit maxW with an ellipsis (ctx must already have the name font set).
function fitText(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

export async function renderRoster(
  players: CardPlayer[],
  opts: { puzzleNo?: number } = {},
): Promise<Buffer> {
  ensureFonts();

  const shown = players.slice(0, MAX_AVATARS);
  const rows = Math.max(1, Math.ceil(shown.length / COLS));
  const height = PAD + HEADER_H + rows * CELL_H + PAD - ROW_GAP;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext('2d');

  // Background.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, height);

  // Header.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TITLE;
  ctx.font = '600 34px "Inter SemiBold"';
  ctx.fillText(`Connections${opts.puzzleNo ? ` #${opts.puzzleNo}` : ''}`, PAD, PAD + 34);
  ctx.fillStyle = SUBTITLE;
  ctx.font = '400 18px Inter';
  const total = players.length;
  const extra = total > MAX_AVATARS ? ` (showing ${MAX_AVATARS})` : '';
  ctx.fillText(`${total} ${total === 1 ? 'player' : 'players'} playing today${extra}`, PAD, PAD + 62);

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
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cx = PAD + col * CELL_W + CELL_W / 2;
    const top = PAD + HEADER_H + row * CELL_H;
    const cy = top + AV / 2;
    const img = images[i];

    // Circular avatar (or coloured initial fallback).
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
      ctx.font = '600 30px "Inter SemiBold"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initial(p.name), cx, cy + 1);
    }
    ctx.restore();

    // Subtle ring.
    ctx.strokeStyle = RING;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, AV / 2 + 1, 0, Math.PI * 2);
    ctx.stroke();

    // Name under the avatar.
    ctx.fillStyle = NAME;
    ctx.font = '400 16px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fitText(ctx, p.name, CELL_W - 8), cx, top + AV + NAME_GAP);
  });

  return canvas.toBuffer('image/png');
}
