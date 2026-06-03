import { createPublicKey, verify as edVerify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { activeToken, cardEditUrl, cardPayload, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Discord interactions webhook. Discord POSTs here for: the Entry Point command and
// the typed /connections command (both launch the Activity), the Play button on the
// daily recap, and a PING when the endpoint URL is saved. We reply LAUNCH_ACTIVITY to
// open the game. Routing the Entry Point command here (handler APP_HANDLER, set by
// scripts/register-commands.mjs) is deliberate: it stops Discord from launching the
// Activity itself and auto-posting its invite card to the channel on every launch.
//
// After replying, a launch command also turns the launcher's "<user> used /connections"
// message into the room's live "who's playing" card by editing that interaction
// response in place (via the interaction token — no bot, no webhook in the guild). One
// card per room: a launch while a prior card's token is still alive edits THAT card; the
// first launch after it expires (~15 min) establishes a fresh one. See postLaunchCard.
//
// Every request is Ed25519-signed; an unverified request must get a 401 (Discord
// rejects the endpoint at setup time otherwise). The signature covers the exact
// request bytes, so the body parser is disabled and the raw stream is read.

export const config = { api: { bodyParser: false } };

// Discord interaction + callback type numbers we use.
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const LAUNCH_ACTIVITY = 12;
const EPHEMERAL = 64; // message flag

// Command names that should open the Activity. Both the type-4 Entry Point command
// (App Launcher, handler APP_HANDLER) and the type-1 chat-input command arrive as
// APPLICATION_COMMAND interactions named `connections`, and both launch the game by
// replying with LAUNCH_ACTIVITY. (The chat-input command also exists because the
// Entry Point one doesn't reliably show in the typed "/" menu.) `play` is kept as an
// alias in case `connections` collides with the Entry Point command name at
// registration time.
const LAUNCH_COMMANDS = new Set(['connections', 'play']);

// 32-byte raw Ed25519 public key -> a KeyObject, via the fixed SPKI DER prefix.
// crypto can't ingest the bare key, but wrapping it in the standard Ed25519 SPKI
// header is exact and avoids pulling in a dependency.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDiscordSig(
  rawBody: string,
  sigHex: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  if (!publicKeyHex || !sigHex || !timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    // Ed25519 takes a null algorithm; message is timestamp + raw body.
    return edVerify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

type Interaction = { type?: number; data?: { custom_id?: string; name?: string } };

// Pure routing of a verified interaction to its response body. Kept separate from
// the HTTP layer so it can be unit-tested without a request.
export function routeInteraction(body: Interaction): object {
  if (body.type === PING) return { type: PONG };
  // A typed slash command (e.g. /connections) launches the Activity.
  if (body.type === APPLICATION_COMMAND && LAUNCH_COMMANDS.has(body.data?.name ?? '')) {
    return { type: LAUNCH_ACTIVITY };
  }
  // The recap's "Play" button launches the Activity.
  if (body.type === MESSAGE_COMPONENT && body.data?.custom_id === PLAY_CUSTOM_ID) {
    return { type: LAUNCH_ACTIVITY };
  }
  return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Unsupported interaction.', flags: EPHEMERAL } };
}

// Whether this interaction is a launch command (slash or Entry Point), the only case
// that establishes/refreshes the room card. The Play button launches too, but it reuses
// an existing card through the Activity's /api/join rather than minting a new message.
function isLaunchCommand(body: Interaction): boolean {
  return body.type === APPLICATION_COMMAND && LAUNCH_COMMANDS.has(body.data?.name ?? '');
}

// Fields we read off a launch interaction beyond the routing ones above.
type DiscordUserLite = { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
type LaunchInteraction = Interaction & {
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string };
  member?: { user?: DiscordUserLite };
  user?: DiscordUserLite;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Best-effort: fill the launcher's "<user> used /connections" message with the room's
// live "who's playing" card, editing that interaction response in place via its token.
// A launch while a prior card's token is still alive edits THAT card (one card per room);
// the first launch after it expires establishes a fresh one on its own response. Runs
// after the launch reply is already sent, so any failure here never delays the game.
async function postLaunchCard(body: LaunchInteraction): Promise<void> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? '';
  const myToken = body.token ?? '';
  if (!appId || !myToken) {
    console.warn('[postLaunchCard] skip: no appId/token', { hasAppId: !!appId, hasToken: !!myToken });
    return;
  }

  // The card only makes sense in a guild channel (mirrors /api/join's scope gate).
  const guildId = typeof body.guild_id === 'string' ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === 'string'
      ? body.channel_id
      : typeof body.channel?.id === 'string'
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith('g:')) {
    console.warn('[postLaunchCard] skip: not a guild scope', { guildId, channelId, scope });
    return;
  }

  // Identity comes from the (Discord-verified) interaction, so no OAuth round-trip:
  // invoking a guild command already proves membership.
  const u = body.member?.user ?? body.user;
  if (!u?.id) {
    console.warn('[postLaunchCard] skip: no user on interaction');
    return;
  }
  const player: CardPlayer = {
    id: u.id,
    name: u.global_name ?? u.username ?? 'Player',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
  };

  const db = admin();
  if (!db) {
    console.warn('[postLaunchCard] skip: no db (admin client unconfigured)');
    return;
  }

  const date = todayET();
  const { data: card, error: selErr } = await db
    .from('live_cards')
    .select('players, interaction_token, token_at')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  if (selErr) console.error('[postLaunchCard] live_cards select error (schema migrated?)', selErr.message);

  // renderRoster/mergePlayer pull @napi-rs/canvas; load them lazily so PING and other
  // light interactions don't pay the native-addon cold start.
  const { mergePlayer, renderRoster } = await import('./_card.js');
  const existing: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
  const { players } = mergePlayer(existing, player);

  // Edit the room's active card while its establishing launch's token is still alive;
  // otherwise THIS launch establishes a fresh card on its own response.
  const now = Date.now();
  const stored = activeToken(card, now);
  let useToken = stored ?? myToken;
  let tokenAt = stored ? (card?.token_at as string) : new Date(now).toISOString();

  let puzzle: Puzzle | null = null;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    /* title falls back to no number; grids render blank */
  }
  const renderPlayers = puzzle ? await withGrids(db, puzzle, date, players) : players;
  const png = await renderRoster(renderPlayers, { puzzleNo: puzzle?.id, puzzleDate: date });

  console.log('[postLaunchCard] editing @original', { scope, establishing: useToken === myToken, players: players.length });
  let r = await sendCard(cardEditUrl(appId, useToken), cardPayload(), png, 'PATCH');
  // The stored card's message was deleted → restart the card on this launch's own response.
  if (!r.ok && r.status === 404 && useToken !== myToken) {
    useToken = myToken;
    tokenAt = new Date(now).toISOString();
    r = await sendCard(cardEditUrl(appId, useToken), cardPayload(), png, 'PATCH');
  }
  // Establishing on our own response can race Discord creating the message → retry once.
  if (!r.ok && r.status === 404 && useToken === myToken) {
    await sleep(600);
    r = await sendCard(cardEditUrl(appId, useToken), cardPayload(), png, 'PATCH');
  }
  if (!r.ok) {
    console.error('[postLaunchCard] @original edit failed', r.status, await r.text().catch(() => ''));
  }

  const nowIso = new Date().toISOString();
  const { error: upErr } = await db.from('live_cards').upsert(
    {
      scope_id: scope,
      puzzle_date: date,
      players,
      interaction_token: useToken,
      token_at: tokenAt,
      posted_at: tokenAt, // when the current card was established
      edited_at: nowIso, // anchors the live-edit throttle in /api/refresh-card
      updated_at: nowIso,
    },
    { onConflict: 'scope_id,puzzle_date' },
  );
  if (upErr) console.error('[postLaunchCard] live_cards upsert error (schema migrated?)', upErr.message);
}

async function rawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const raw = await rawBody(req);
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!verifyDiscordSig(raw, String(sig ?? ''), String(ts ?? ''), process.env.DISCORD_PUBLIC_KEY ?? '')) {
    res.status(401).json({ error: 'invalid request signature' });
    return;
  }
  let body: LaunchInteraction;
  try {
    body = JSON.parse(raw) as LaunchInteraction;
  } catch {
    res.status(400).json({ error: 'bad body' });
    return;
  }

  // Reply first so opening the game is never delayed (Discord enforces a 3s deadline).
  res.status(200).json(routeInteraction(body));

  // Render + fill the launcher's message AFTER replying. waitUntil keeps the function
  // alive for this work — on Vercel a plain `await` after res.json() can be frozen the
  // moment the response flushes, so the card would silently never post. Best-effort.
  if (isLaunchCommand(body)) {
    waitUntil(
      postLaunchCard(body).catch((e) => {
        console.error('[postLaunchCard] threw', e instanceof Error ? e.message : e);
      }),
    );
  }
}
