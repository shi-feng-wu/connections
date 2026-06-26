import type { SupabaseClient } from '@supabase/supabase-js';
import { Game, type Puzzle } from '../src/game.js';
import type { CardPlayer } from './_card.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Shared plumbing for the "who's playing today" card, used by /api/join (a new player
// joins) and /api/refresh-card (someone guesses). Rendering itself lives in _card.ts;
// this module turns stored rosters into render-ready players and posts them to the
// room's webhook. Leading underscore keeps Vercel from treating it as a route.

// At most one "who's playing" card per room per this window: a launch older than the
// last post starts a fresh card; launches/joins within it edit the current one in place.
export const CARD_POST_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Throttle live card edits so a flurry of events can't spam the webhook: an edit within
// the window is dropped (the next event carries the latest DB state). A new player tile
// (join) refreshes a bit faster than mid-game progress (update); a player who just
// finished bypasses the update throttle so the final grid always lands.
export const CARD_JOIN_THROTTLE_MS = 15_000; // 15s
export const CARD_UPDATE_THROTTLE_MS = 60_000; // 60s

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

// Whether a player has already finished (won or lost) today's puzzle, replayed from their
// committed guesses (the same authoritative record /api/score scores). A finished player
// isn't "playing", so a Join/Play click from them shouldn't add them to the room card or
// spin up a new one. Needs the puzzle to replay; callers that couldn't fetch it skip the
// check and proceed (fail open — never drop a card over a transient puzzle-fetch blip).
export async function playerFinished(
  db: SupabaseClient,
  puzzle: Puzzle,
  userId: string,
  date: string,
): Promise<boolean> {
  const { data } = await db
    .from('progress')
    .select('guesses')
    .eq('user_id', userId)
    .eq('puzzle_date', date)
    .maybeSingle();
  const guesses = data && Array.isArray(data.guesses) ? (data.guesses as string[][]) : [];
  return Game.fromGuesses(puzzle, guesses).status !== 'playing';
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

// Message flag (1 << 12): the message posts silently — no push/desktop ping. Every
// live "who's playing" card (and its edits) is routine churn, so it's suppressed; only
// the daily recap (recapPayload, no flag) is allowed to notify.
const SUPPRESS_NOTIFICATIONS = 1 << 12;

// The Discord message: the rendered PNG plus the "Play" button. The image is the hero
// (it carries the title and player count, like the Wordle card), so it's sent as a bare
// inline attachment — no embed, so Discord draws no frame/border or coloured side bar
// around it; the PNG sits directly in the message. Pass `replyTo` on the initial post so
// the card replies to the launcher's "<user> used /connections" message
// (fail_if_not_exists:false → a normal message if it's gone). Posted silently.
export function cardPayload(replyTo?: { messageId: string; channelId: string }): object {
  const base = {
    flags: SUPPRESS_NOTIFICATIONS,
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: 'Play now!', custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'card.png' }],
  };
  if (!replyTo) return base;
  return {
    ...base,
    message_reference: { message_id: replyTo.messageId, channel_id: replyTo.channelId, fail_if_not_exists: false },
  };
}

// A lightweight, static "Play" invite for a context where we can't keep a live card — a
// DM/group DM, where there's no bot to edit a card all day. Posted as a PUBLIC interaction
// followup (needs no bot or channel permission): a one-line announce plus the same "Play now!"
// button as the card, so anyone in the chat can open the activity. It never updates (no
// roster), so it carries no attachment and is never edited. Posted silently like the card.
export function playInvitePayload(launcherName: string): object {
  return {
    content: `${launcherName} is playing today’s Connections`,
    flags: SUPPRESS_NOTIFICATIONS,
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: 'Play now!', custom_id: PLAY_CUSTOM_ID }] },
    ],
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

// POST target for an interaction FOLLOWUP message. After /api/interactions answers the
// launch command with LAUNCH_ACTIVITY (which auto-opens the game), it posts the card as a
// followup on the interaction token — so the card is interaction-bound (like the Wordle
// card) without needing the bot. wait=true returns the created message so we learn its id;
// after that the app owns it, so the bot edits it in place via botCardUrl (no token limit).
export function interactionFollowupUrl(appId: string, token: string): string {
  return `https://discord.com/api/v10/webhooks/${appId}/${token}?wait=true&with_components=true`;
}

// PATCH target for the card in a channel, by message id, using the bot token (the bot can
// edit it because the app authored the interaction response). /api/join and
// /api/refresh-card use this to keep the card live all day, past the interaction token's
// 15-minute window. The bot must be in the guild, so live edits are guild-install only.
export function botCardUrl(channelId: string, messageId?: string): string {
  const base = `https://discord.com/api/v10/channels/${channelId}/messages`;
  return messageId ? `${base}/${messageId}` : base;
}
