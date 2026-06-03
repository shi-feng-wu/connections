import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { type CardPlayer, cardLayout, drawRoster } from '../src/card-draw.js';

// Renders the "who's playing today" card to a PNG: one tile per player, each a
// circular avatar beside a fixed-size grid of their Connections guesses so far (the
// colour squares fill in as they play). The actual drawing lives in src/card-draw.ts
// so the browser preview can render the exact same pixels; this file is the server
// (@napi-rs/canvas) wrapper — fonts, image loading, PNG encode. Posted/edited on the
// channel webhook by /api/join (a new player joins) and /api/refresh-card (someone
// guesses); the roster is append-only — joining adds you, leaving never removes you.
// Leading underscore keeps Vercel from treating this file as a route.

export type { CardPlayer };

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

// How long after posting the card before a new join bumps a fresh message instead of
// editing in place. Event-driven (only a real new join can trigger it), so a quiet
// room sees one card and an active one sees it resurface a few times a day. Tune here.
// TEMP (testing): set to 0 so every join posts a FRESH card. Restore to
// 2 * 60 * 60 * 1000 (2 hours) when done testing.
export const CARD_REPOST_COOLDOWN_MS = 0;

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

export async function renderRoster(
  players: CardPlayer[],
  opts: { puzzleNo?: number } = {},
): Promise<Buffer> {
  ensureFonts();
  const { W, height } = cardLayout(players);
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  await drawRoster(ctx, players, opts, async (url) => {
    try {
      return (await loadImage(url)) as unknown as CanvasImageSource;
    } catch {
      return null;
    }
  });
  return canvas.toBuffer('image/png');
}
