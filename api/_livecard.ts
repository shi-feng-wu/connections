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

// Attach each player's current Connections grid (replayed from their committed guesses)
// and their time: finish duration for a completed game, else elapsed-so-far. One query
// for the whole roster; players who haven't guessed get an empty grid and a null time.
type ProgressRow = { user_id: string; guesses: unknown; started_at: string | null; updated_at: string | null };
export async function withGrids(
  db: SupabaseClient,
  puzzle: Puzzle,
  date: string,
  players: CardPlayer[],
): Promise<CardPlayer[]> {
  if (!players.length) return players;
  const { data } = await db
    .from('progress')
    .select('user_id, guesses, started_at, updated_at')
    .in(
      'user_id',
      players.map((p) => p.id),
    )
    .eq('puzzle_date', date);
  const byId = new Map<string, ProgressRow>();
  for (const row of (data as ProgressRow[] | null) ?? []) byId.set(row.user_id, row);
  const now = Date.now();
  return players.map((p) => {
    const row = byId.get(p.id);
    const guesses = row && Array.isArray(row.guesses) ? (row.guesses as string[][]) : [];
    const game = Game.fromGuesses(puzzle, guesses);
    // Finished → updated_at is the last guess (finish); still playing → now.
    let sec: number | null = null;
    if (row?.started_at) {
      const start = Date.parse(row.started_at);
      const end = game.status !== 'playing' && row.updated_at ? Date.parse(row.updated_at) : now;
      if (!Number.isNaN(start)) sec = Math.max(0, Math.round((end - start) / 1000));
    }
    return { ...p, grid: game.history, sec };
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

// Send a card as a multipart message (image attachment). POST creates, PATCH edits
// an existing message. `filename` must match the attachment referenced by the payload
// (card.png for the live card, recap.png for the daily recap). Returns the raw Response.
export async function sendCard(
  url: string,
  payload: object,
  png: Buffer,
  method: 'POST' | 'PATCH',
  filename = 'card.png',
  headers?: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
  // No Content-Type header: fetch sets the multipart boundary itself. `headers` carries
  // a bot Authorization when posting to a channel (the cron); webhook/interaction URLs
  // authorize via a token in the path and pass none.
  return fetch(url, { method, body: form, headers });
}

// The card lives on a Discord interaction response, editable via the interaction token.
// Discord keeps a token valid for 15 minutes; we stop a touch under that so an edit
// started near the edge still lands. A launch inside the window edits the same card; the
// first launch after it expires establishes a fresh one (see /api/interactions).
export const INTERACTION_TOKEN_TTL_MS = 14.5 * 60 * 1000;

// The token that can still edit the room's active card, or null once the establishing
// launch's window has elapsed (caller then establishes a new card on its own response).
export function activeToken(
  card: { interaction_token?: string | null; token_at?: string | null } | null | undefined,
  nowMs: number,
): string | null {
  const token = card?.interaction_token;
  const at = card?.token_at ? Date.parse(card.token_at) : NaN;
  if (!token || Number.isNaN(at) || nowMs - at >= INTERACTION_TOKEN_TTL_MS) return null;
  return token;
}

// PATCH target for an interaction's original response (the "<user> used /connections"
// message). application_id is public; the token in the path is what authorizes the edit,
// so no bot token is involved. with_components keeps the Play button on the message.
export function cardEditUrl(appId: string, token: string): string {
  return `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original?with_components=true`;
}
