import { createPublicKey, verify as edVerify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { cardPayload, interactionCardUrl, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Discord interactions webhook. Discord POSTs here for: the typed /connections command,
// the App-Launcher Entry Point command, the card/recap "Play now!" button, and a PING.
//
// The typed /connections is answered with a DEFERRED response, then we fill that response
// (@original) with the "who's playing" card — so the card lands natively under "<user>
// used /connections", a real, attributed message, exactly like the Wordle card. The
// interaction creates the message; the app then owns it, so /api/join and /api/refresh-card
// edit it via the bot token (no 15-minute limit) to keep it live all day. "Play now!" and
// the Entry Point command launch the Activity. (This is why /connections no longer
// auto-opens: a launch response can't also leave an editable message — the card carries a
// Play button instead.)
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
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const LAUNCH_ACTIVITY = 12;
const EPHEMERAL = 64; // message flag

// Application command type (interaction data.type) for the App-Launcher Entry Point
// command, which launches the Activity directly; a typed chat command (any other type)
// can carry a normal message response, so we fill it with the card instead.
const PRIMARY_ENTRY_POINT = 4;

// Command names that should open the Activity. Both the Entry Point command (App Launcher)
// and the chat-input command arrive as APPLICATION_COMMAND interactions named `connections`.
// `play` is kept as an alias in case `connections` collides with the Entry Point command
// name at registration time.
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

type Interaction = { type?: number; data?: { custom_id?: string; name?: string; type?: number } };

// Whether a launch-command interaction should DEFER (so we can fill the response with the
// card): the typed chat command, but not the Entry Point command (which must launch).
function isCardCommand(body: Interaction): boolean {
  return (
    body.type === APPLICATION_COMMAND &&
    LAUNCH_COMMANDS.has(body.data?.name ?? '') &&
    body.data?.type !== PRIMARY_ENTRY_POINT
  );
}

// Pure routing of a verified interaction to its inline response body. Kept separate from
// the HTTP layer so it can be unit-tested without a request. The typed /connections defers
// (the card is filled in afterward); the Entry Point command and Play button launch.
export function routeInteraction(body: Interaction): object {
  if (body.type === PING) return { type: PONG };
  if (body.type === APPLICATION_COMMAND && LAUNCH_COMMANDS.has(body.data?.name ?? '')) {
    return isCardCommand(body)
      ? { type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE }
      : { type: LAUNCH_ACTIVITY };
  }
  // The card/recap "Play now!" button launches the Activity.
  if (body.type === MESSAGE_COMPONENT && body.data?.custom_id === PLAY_CUSTOM_ID) {
    return { type: LAUNCH_ACTIVITY };
  }
  return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Unsupported interaction.', flags: EPHEMERAL } };
}

// Fields we read off the launch interaction beyond the routing ones above.
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

// Fill the deferred /connections response with the room's "who's playing" card, so it
// shows under "<user> used /connections" (a real, attributed message). Edits @original via
// the interaction token — no bot, works in any context; the bot then keeps it live (see
// /api/join, /api/refresh-card). Runs after the deferred ACK is already sent, so a failure
// here just leaves the "thinking" state — it never blocks the command.
async function fillCard(body: LaunchInteraction): Promise<void> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? '';
  const token = body.token ?? '';
  if (!appId || !token) {
    console.warn('[fillCard] skip: no appId/token', { hasAppId: !!appId, hasToken: !!token });
    return;
  }

  // The card is a room board, so only guild channels get one (mirrors /api/join's gate).
  const guildId = typeof body.guild_id === 'string' ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === 'string'
      ? body.channel_id
      : typeof body.channel?.id === 'string'
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith('g:') || !channelId) {
    console.warn('[fillCard] skip: no guild scope/channel', { guildId, channelId, scope });
    return;
  }

  // Identity comes from the (Discord-verified) interaction, so no OAuth round-trip.
  const u = body.member?.user ?? body.user;
  if (!u?.id) {
    console.warn('[fillCard] skip: no user on interaction');
    return;
  }
  const player: CardPlayer = {
    id: u.id,
    name: u.global_name ?? u.username ?? 'Player',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
  };

  const db = admin();
  if (!db) {
    console.warn('[fillCard] skip: no db (admin client unconfigured)');
    return;
  }

  const date = todayET();
  const { data: card, error: selErr } = await db
    .from('live_cards')
    .select('players')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  if (selErr) console.error('[fillCard] live_cards select error (schema migrated?)', selErr.message);

  // renderRoster/mergePlayer pull @napi-rs/canvas; load them lazily so PING and the Play
  // button (which never render) don't pay the native-addon cold start.
  const { mergePlayer, renderRoster } = await import('./_card.js');
  const existing: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
  const { players } = mergePlayer(existing, player);

  let puzzle: Puzzle | null = null;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    /* title falls back to no number; grids render blank */
  }
  const renderPlayers = puzzle ? await withGrids(db, puzzle, date, players) : players;
  const png = await renderRoster(renderPlayers, { puzzleNo: puzzle?.id, puzzleDate: date });

  // Replace the deferred "thinking" response with the card; the returned message id is what
  // the bot edits afterward (and what /api/refresh-card / join keep current).
  const r = await sendCard(interactionCardUrl(appId, token), cardPayload(), png, 'PATCH', 'card.png');
  if (!r.ok) {
    console.error('[fillCard] edit @original failed', r.status, await r.text().catch(() => ''));
    return;
  }
  const messageId = ((await r.json()) as { id?: string }).id ?? null;
  console.log('[fillCard] card posted', { scope, messageId, players: players.length });
  if (!messageId) return;

  const nowIso = new Date().toISOString();
  const { error: upErr } = await db.from('live_cards').upsert(
    {
      scope_id: scope,
      puzzle_date: date,
      players,
      message_id: messageId,
      channel_id: channelId,
      posted_at: nowIso,
      edited_at: nowIso, // anchors the live-edit throttle in /api/refresh-card
      updated_at: nowIso,
    },
    { onConflict: 'scope_id,puzzle_date' },
  );
  if (upErr) console.error('[fillCard] live_cards upsert error (schema migrated?)', upErr.message);
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

  // ACK first (Discord enforces a 3s deadline): a deferred ack for the card command, an
  // inline launch otherwise.
  res.status(200).json(routeInteraction(body));

  // Then fill the deferred response with the card. waitUntil keeps the function alive past
  // the response flush (a plain await after res.json() can be frozen on Vercel).
  if (isCardCommand(body)) {
    waitUntil(
      fillCard(body).catch((e) => {
        console.error('[fillCard] threw', e instanceof Error ? e.message : e);
      }),
    );
  }
}
