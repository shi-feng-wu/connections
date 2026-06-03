import { createPublicKey, verify as edVerify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { cardPayload, interactionFollowupUrl, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Discord interactions webhook. Discord POSTs here for: the typed /connections command,
// the App-Launcher Entry Point command, the card/recap "Play now!" button, and a PING.
//
// A launch command is answered with LAUNCH_ACTIVITY (the game auto-opens), then we post
// the "who's playing" card as an interaction FOLLOWUP — an interaction-bound message (like
// the Wordle card) that needs no bot to create. The app owns it, so /api/join and
// /api/refresh-card edit it via the bot token (no 15-minute limit) to keep it live all
// day. The card's "Play now!" button launches too. (A LAUNCH_ACTIVITY response also leaves
// a "<user> used /connections" line, so the followup card lands just under it.)
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

type Interaction = { type?: number; data?: { custom_id?: string; name?: string } };

// Whether this interaction is a launch command (slash or Entry Point) — the case that
// launches AND posts the followup card. The Play button launches too, but it reuses the
// existing card via /api/join rather than posting a new one.
function isLaunchCommand(body: Interaction): boolean {
  return body.type === APPLICATION_COMMAND && LAUNCH_COMMANDS.has(body.data?.name ?? '');
}

// Pure routing of a verified interaction to its inline response body. Kept separate from
// the HTTP layer so it can be unit-tested without a request. Launch commands and the Play
// button both open the Activity; the card is posted as a followup afterward (see handler).
export function routeInteraction(body: Interaction): object {
  if (body.type === PING) return { type: PONG };
  if (isLaunchCommand(body)) return { type: LAUNCH_ACTIVITY };
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

// Post the room's "who's playing" card as an interaction followup, right after the launch.
// The followup is interaction-bound (like the Wordle card) and needs no bot; the bot then
// keeps it live (see /api/join, /api/refresh-card). Runs after the launch ACK is already
// sent, so a failure here never blocks opening the game.
async function postFollowupCard(body: LaunchInteraction): Promise<void> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? '';
  const token = body.token ?? '';
  if (!appId || !token) {
    console.warn('[card] skip: no appId/token', { hasAppId: !!appId, hasToken: !!token });
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
    console.warn('[card] skip: no guild scope/channel', { guildId, channelId, scope });
    return;
  }

  // Identity comes from the (Discord-verified) interaction, so no OAuth round-trip.
  const u = body.member?.user ?? body.user;
  if (!u?.id) {
    console.warn('[card] skip: no user on interaction');
    return;
  }
  const player: CardPlayer = {
    id: u.id,
    name: u.global_name ?? u.username ?? 'Player',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
  };

  const db = admin();
  if (!db) {
    console.warn('[card] skip: no db (admin client unconfigured)');
    return;
  }

  const date = todayET();
  const { data: card, error: selErr } = await db
    .from('live_cards')
    .select('players')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  if (selErr) console.error('[card] live_cards select error (schema migrated?)', selErr.message);

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

  // Post the card as a followup (wait=true returns it so we learn the message id, which the
  // bot edits afterward and /api/refresh-card / join keep current).
  const r = await sendCard(interactionFollowupUrl(appId, token), cardPayload(), png, 'POST', 'card.png');
  if (!r.ok) {
    console.error('[card] followup failed', r.status, await r.text().catch(() => ''));
    return;
  }
  const messageId = ((await r.json()) as { id?: string }).id ?? null;
  console.log('[card] followup posted', { scope, messageId, players: players.length });
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
  if (upErr) console.error('[card] live_cards upsert error (schema migrated?)', upErr.message);
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

  // ACK first (Discord enforces a 3s deadline) — this is the LAUNCH_ACTIVITY that opens the
  // game.
  res.status(200).json(routeInteraction(body));

  // Then post the card as a followup. waitUntil keeps the function alive past the response
  // flush (a plain await after res.json() can be frozen on Vercel).
  if (isLaunchCommand(body)) {
    waitUntil(
      postFollowupCard(body).catch((e) => {
        console.error('[card] threw', e instanceof Error ? e.message : e);
      }),
    );
  }
}
