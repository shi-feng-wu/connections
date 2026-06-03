import type { SupabaseClient } from '@supabase/supabase-js';
import { Game, type Puzzle } from '../src/game.js';
import type { CardPlayer } from './_card.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Shared plumbing for the "who's playing today" card, used by /api/join (a new player
// joins) and /api/refresh-card (someone guesses). Rendering itself lives in _card.ts;
// this module turns stored rosters into render-ready players and posts them to the
// room's webhook. Leading underscore keeps Vercel from treating it as a route.

// Throttle live edits so a flurry of guesses can't spam the webhook. A refresh inside
// this window is dropped (the next event carries the latest state from the DB); a
// player who just finished bypasses it so the final grid always lands.
// TEMP (testing): set to 0 so every guess edits the card immediately. Restore to 2500
// when done testing.
export const CARD_EDIT_THROTTLE_MS = 0;

// Attach each player's current Connections grid by replaying their committed guesses.
// One query for the whole roster; players who haven't guessed get an empty grid.
export async function withGrids(
  db: SupabaseClient,
  puzzle: Puzzle,
  date: string,
  players: CardPlayer[],
): Promise<CardPlayer[]> {
  if (!players.length) return players;
  const { data } = await db
    .from('progress')
    .select('user_id, guesses')
    .in(
      'user_id',
      players.map((p) => p.id),
    )
    .eq('puzzle_date', date);
  const byId = new Map<string, string[][]>();
  for (const row of (data as { user_id: string; guesses: unknown }[] | null) ?? []) {
    if (Array.isArray(row.guesses)) byId.set(row.user_id, row.guesses as string[][]);
  }
  return players.map((p) => {
    const guesses = byId.get(p.id);
    return { ...p, grid: guesses ? Game.fromGuesses(puzzle, guesses).history : [] };
  });
}

// Whether a grid (rows of four group-levels) shows a finished game: four groups solved
// (a win) or four misses (a loss). A correct guess is four of a kind; anything else is
// a miss. Lets a just-finished player's refresh skip the edit throttle.
export function gridFinished(grid: number[][] | undefined): boolean {
  if (!grid) return false;
  let solved = 0;
  let misses = 0;
  for (const row of grid) (row.every((l) => l === row[0]) ? solved++ : misses++);
  return solved >= 4 || misses >= 4;
}

// The Discord message: the rendered PNG plus the "Play" button. The image is the
// hero (it carries the title and player count, like the Wordle card), so the embed is
// just a frame for it — no title/description to duplicate what's already drawn.
export function cardPayload(): object {
  return {
    embeds: [{ image: { url: 'attachment://card.png' }, color: 0x5865f2 }],
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: 'Play today', custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'card.png' }],
  };
}

// Send the card as a multipart message (image attachment). POST creates, PATCH edits
// an existing message. Returns the raw Response.
export async function sendCard(
  url: string,
  payload: object,
  png: Buffer,
  method: 'POST' | 'PATCH',
): Promise<Response> {
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'card.png');
  return fetch(url, { method, body: form });
}
