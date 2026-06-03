import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, Path2D } from '@napi-rs/canvas';
import {
  type CardOpts,
  type CardPlayer,
  cardLayout,
  drawRecap,
  drawRoster,
  type RecapData,
  recapLayout,
} from '../src/card-draw.js';

// Renders the "who's playing today" card to a PNG: one roster-row tile per player
// (colored-initial avatar, four category solved-bars, mistake dots, and a Check /
// Trophy / X / live-dot status), matched to the live in-game view. The actual drawing
// lives in src/card-draw.ts so the browser preview can render the exact same pixels;
// this file is the server (@napi-rs/canvas) wrapper — fonts, image loading, PNG encode.
// Posted/edited on the channel webhook by /api/join (a new player joins) and
// /api/refresh-card (someone guesses); the roster is append-only — joining adds you,
// leaving never removes you. Leading underscore keeps Vercel from treating it as a route.

export type { CardPlayer, RecapData };

// Lambda has no usable system fonts, so register the brand families. These are STATIC
// per-weight instances sliced from the variable TTFs (fonttools varLib.instancer): the
// canvas backend matches a face by its embedded OS/2 weight and does NOT interpolate a
// variable font's wght axis from the `font` shorthand — registering the variable file
// alone renders every weight at its default (~400), which is why the card looked thin.
// One face per weight the card actually draws (Libre Franklin 500/600/700/800,
// Newsreader 700 at opsz 38 for the display wordmark). new URL(import.meta.url) is the
// pattern @vercel/nft traces to bundle the .ttf into the function (belt-and-suspenders:
// vercel.json also pins them via includeFiles). Register once per cold start.
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

export async function renderRoster(players: CardPlayer[], opts: CardOpts = {}): Promise<Buffer> {
  ensureFonts();
  // Measure on a scratch context (header width sets the card's floor), size, then draw.
  const measure = createCanvas(4, 4).getContext('2d') as unknown as CanvasRenderingContext2D;
  const layout = cardLayout(measure, players, opts);
  const canvas = createCanvas(layout.W, layout.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  await drawRoster(ctx, players, opts, layout, {
    loadImg: async (url) => {
      try {
        return (await loadImage(url)) as unknown as CanvasImageSource;
      } catch {
        return null;
      }
    },
    Path2D: Path2D as unknown as new (path: string) => Path2D,
  });
  return canvas.toBuffer('image/png');
}

// Renders the daily recap card to a PNG: a two-column leaderboard (yesterday's
// results + season standings) in the same brand chrome as the roster card. Posted
// by /api/cron-recap on the Connections reset, exactly like the "who's playing" card.
export async function renderRecap(data: RecapData): Promise<Buffer> {
  ensureFonts();
  const layout = recapLayout(data);
  const canvas = createCanvas(layout.W, layout.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  await drawRecap(ctx, data, layout, {
    loadImg: async (url) => {
      try {
        return (await loadImage(url)) as unknown as CanvasImageSource;
      } catch {
        return null;
      }
    },
    Path2D: Path2D as unknown as new (path: string) => Path2D,
  });
  return canvas.toBuffer('image/png');
}
