import type { SupabaseClient } from '@supabase/supabase-js';
import { COPY } from '../src/discord-copy.js';
import { fill } from '../src/copy-util.js';
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

// Without a bot (DMs, group DMs), the card is edited via the launcher's interaction token, which
// Discord only honours for ~15 minutes. We use a slightly conservative window so an edit fired
// near the edge doesn't 404; past it the card freezes (the Play button keeps working regardless).
export const TOKEN_EDIT_WINDOW_MS = 14 * 60 * 1000; // 14 minutes

// Whether the card posted in this scope is still inside the 2h fresh-post window — within it a
// launch edits the existing card; past it a launch posts a fresh one. Null/unparseable = never
// posted → not in cooldown. Exported for tests.
export function withinPostCooldown(postedAt: string | null | undefined, now: number): boolean {
  if (!postedAt) return false;
  const t = Date.parse(postedAt);
  return !Number.isNaN(t) && now - t < CARD_POST_COOLDOWN_MS;
}

// Whether the interaction token that created a no-bot (DM/group-DM) card is still inside Discord's
// edit window, so the card can be PATCHed. Past it the token 404s and the card freezes. Null = no
// token stored → not editable. Exported for tests.
export function tokenStillEditable(tokenAt: string | null | undefined, now: number): boolean {
  if (!tokenAt) return false;
  const t = Date.parse(tokenAt);
  return !Number.isNaN(t) && now - t < TOKEN_EDIT_WINDOW_MS;
}

// The finalize cron (api/finalize-cards) flips a DM card to past tense in the final stretch before
// its interaction-token window closes. Exported so /api/refresh-card AGREES: any DM render inside
// this closing window (a guess-driven relay flush, a leading edit, or the cron itself) reads past
// tense — so a flush that races the cron can't leave the card stuck in present tense.
export const FINALIZE_LEAD_MS = 3 * 60 * 1000; // 3 min

// Whether a DM card's interaction token is inside the final FINALIZE_LEAD_MS before it expires — the
// window in which the caption should read past tense ("the round's wrapping up"). False if no token.
export function dmWindowClosing(tokenAt: string | null | undefined, now: number): boolean {
  if (!tokenAt) return false;
  const t = Date.parse(tokenAt);
  return !Number.isNaN(t) && now - t >= TOKEN_EDIT_WINDOW_MS - FINALIZE_LEAD_MS;
}

// Throttle live card edits so a flurry of events can't spam the webhook: an edit within
// the window is dropped (the next event carries the latest DB state). A new player tile
// (join) refreshes a bit faster than mid-game progress (update); a player who just
// finished bypasses the update throttle so the final grid always lands.
export const CARD_JOIN_THROTTLE_MS = 15_000; // 15s
// 30s: a counted guess now drives the card server-side (api/guess -> api/refresh-card), so the
// grids fill in during play; this caps that at one edit per 30s per card. Was 60s, which — because
// post-card seeds edited_at at launch — usually threw away every mid-game edit and left only the
// finish (the bypass below), making the card look like it "only updated on solve".
export const CARD_UPDATE_THROTTLE_MS = 30_000; // 30s

// Whether the card was edited within the update-throttle window (so a fresh edit should be skipped).
// Null/unset edited_at (e.g. a just-posted DM card) = not throttled. The cheap pre-check
// api/guess uses to skip a self-call it knows would be throttled; the authoritative gate is the
// atomic claimEditSlot below. Exported for tests.
export function withinUpdateThrottle(editedAt: string | null | undefined, now: number): boolean {
  if (!editedAt) return false;
  const t = Date.parse(editedAt);
  return !Number.isNaN(t) && now - t < CARD_UPDATE_THROTTLE_MS;
}

// Cheap gate for api/guess's server-side refresh trigger: is there a card in this room that's due
// for a re-render? Skips the /api/refresh-card self-call entirely when there's no card to edit
// (most guesses — user-install guilds, channels nobody launched in), when a DM card's interaction
// token has expired (frozen — refresh-card couldn't edit it anyway, so don't keep firing all day),
// or when the last edit is inside the 30s window and the player hasn't just finished (a finish
// always refreshes so the final grid lands). One indexed point-read on live_cards — far cheaper
// than spinning up the render function just to have it bail. The authoritative throttle is still
// claimEditSlot, so a race here only ever costs a wasted no-op self-call, never a double render.
export async function cardNeedsRefresh(
  db: SupabaseClient,
  scope: string,
  date: string,
  channelId: string,
  finished: boolean,
): Promise<boolean> {
  const { data } = await db
    .from('live_cards')
    .select('message_id, edited_at, token_at')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .eq('channel_id', channelId)
    .maybeSingle();
  if (!data?.message_id) return false; // no card established here -> nothing to refresh
  // A token-backed card (a DM, a group DM, or a bot-less server) is edited via the launcher's
  // interaction token, which Discord only honours for ~15 min. Past that it's frozen and refresh-card
  // bails before it can stamp edited_at — so without this the gate would (uselessly) fire on every
  // counted guess for the rest of the day. token_at is set ONLY on token-backed cards (the bot path
  // never sets it), so it identifies them regardless of scope; a bot-backed guild card never expires.
  if (data.token_at && !tokenStillEditable(data.token_at as string | null, Date.now())) {
    return false;
  }
  if (finished) return true; // the final grid always lands
  return !withinUpdateThrottle(data.edited_at as string | null, Date.now());
}

// Atomically claim the next edit slot for a card so a burst of near-simultaneous guesses can't each
// render it. Stamps edited_at only when it's unset (a freshly posted DM card) or older than the
// throttle window; a finished grid always claims (the final board must land). Returns whether THIS
// call won the slot — only the winner should render + PATCH. The conditional UPDATE is the lock:
// concurrent callers race on the same row and exactly one comes back with a row. Stamping before the
// render (rather than after a successful PATCH) is deliberate — it's what dedupes the burst; the
// rare cost is that a failed PATCH burns the 30s window, which the next guess recovers.
export async function claimEditSlot(
  db: SupabaseClient,
  scope: string,
  date: string,
  channelId: string,
  finished: boolean,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const base = db
    .from('live_cards')
    .update({ edited_at: nowIso })
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .eq('channel_id', channelId);
  if (finished) {
    await base;
    return true;
  }
  const threshold = new Date(Date.now() - CARD_UPDATE_THROTTLE_MS).toISOString();
  // null edited_at (a just-posted DM card) or older than the window -> claimable.
  const { data } = await base.or(`edited_at.is.null,edited_at.lt.${threshold}`).select('scope_id');
  return Array.isArray(data) && data.length > 0;
}

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
// (a win) or four misses (a loss). A correct guess is four of a kind; anything else is a
// miss. Used to tell whether every player on a guild card has finished (so the "who's
// playing" line flips to past tense — see playingLine / api/refresh-card).
export function gridFinished(grid: number[][] | undefined): boolean {
  if (!grid) return false;
  let solved = 0;
  let misses = 0;
  for (const row of grid) (row.every((l) => l === row[0]) ? solved++ : misses++);
  return solved >= 4 || misses >= 4;
}

// The card's message-content caption, e.g. "Alice is playing!" / "Alice and Bob are playing!" /
// "Alice, Bob and 3 others are playing!" Lists up to three names; beyond that it caps to two plus
// "and N others" so a busy room stays one short line. `past` flips the verb to was/were — used once
// a guild card's whole roster has finished, or by the finalize cron just before a DM card's edit
// window closes (api/finalize-cards). Empty roster → no caption.
export function playingLine(names: string[], past: boolean): string {
  const list = names.filter((n) => n && n.trim().length > 0);
  const n = list.length;
  if (n === 0) return '';
  const verb = n === 1 ? (past ? 'was' : 'is') : past ? 'were' : 'are';
  let subject: string;
  if (n === 1) subject = list[0];
  else if (n === 2) subject = `${list[0]} and ${list[1]}`;
  else if (n === 3) subject = `${list[0]}, ${list[1]} and ${list[2]}`;
  else subject = `${list[0]}, ${list[1]} and ${n - 2} others`;
  // Wording (incl. the trailing punctuation) lives in src/discord-copy.md → card.playing.
  return fill(COPY['card.playing'], { subject, verb });
}

// Message flag (1 << 12): the message posts silently — no push/desktop ping. Every
// live "who's playing" card (and its edits) is routine churn, so it's suppressed; only
// the daily recap (recapPayload, no flag) is allowed to notify.
const SUPPRESS_NOTIFICATIONS = 1 << 12;

// The Discord message: the rendered PNG plus the "Play" button, and an optional `content` caption
// ("X is/are playing"). The image is the hero (it carries the title and player count, like the
// Wordle card), so it's sent as a bare inline attachment — no embed, so Discord draws no
// frame/border or coloured side bar around it; the PNG sits directly in the message. Pass `replyTo`
// on the initial post so the card replies to the launcher's "<user> used /connections" message
// (fail_if_not_exists:false → a normal message if it's gone). Posted silently.
export function cardPayload(opts?: {
  content?: string;
  replyTo?: { messageId: string; channelId: string };
}): object {
  const { content, replyTo } = opts ?? {};
  const base: Record<string, unknown> = {
    flags: SUPPRESS_NOTIFICATIONS,
    // The caption interpolates user-controlled display names, so deny ALL mentions — a name like
    // "@everyone" or "<@123>" must never ping (mirrors api/_feedback.ts). The image carries no text
    // mentions either, so this is always safe.
    allowed_mentions: { parse: [] },
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: COPY['button.play'], custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'card.png' }],
  };
  // Always send content on an edit so the caption stays in sync (an edit that omits it would leave
  // the previous text in place); '' clears it when there's no roster.
  if (content !== undefined) base.content = content;
  if (replyTo) {
    base.message_reference = {
      message_id: replyTo.messageId,
      channel_id: replyTo.channelId,
      fail_if_not_exists: false,
    };
  }
  return base;
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

// PATCH target for a specific interaction-followup message, by id, on the same token (no bot
// needed). Keeps the DM/group-DM card live for the token's ~15-minute window (TOKEN_EDIT_WINDOW_MS).
export function interactionMessageUrl(appId: string, token: string, messageId: string): string {
  return `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/${messageId}`;
}

// PATCH target for the card in a channel, by message id, using the bot token (the bot can
// edit it because the app authored the interaction response). /api/join and
// /api/refresh-card use this to keep the card live all day, past the interaction token's
// 15-minute window. The bot must be in the guild, so live edits are guild-install only.
export function botCardUrl(channelId: string, messageId?: string): string {
  const base = `https://discord.com/api/v10/channels/${channelId}/messages`;
  return messageId ? `${base}/${messageId}` : base;
}
