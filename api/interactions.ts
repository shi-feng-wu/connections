import { createPublicKey, verify as edVerify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { botCardUrl, cardPayload, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Discord interactions webhook. Discord POSTs here for: the Entry Point command and
// the typed /connections command (both launch the Activity), the Play button on the
// daily recap, and a PING when the endpoint URL is saved.
//
// A launch command opens the Activity AND, where the app is installed to the server
// (so the bot is present), the bot posts the "who's playing" card as a REPLY to the
// launcher's "<user> used /connections" message. A LAUNCH_ACTIVITY response has no
// editable message of its own (Discord returns 10008) and doesn't hand back the launch
// message's id, so the bot finds that message by scanning the channel's recent messages
// for the launcher's command (findLaunchMessageId), then replies to it (`POST
// /channels/:id/messages` with message_reference) — and edits that one message in place
// all day (bot messages don't expire). User-installed launches (no bot in the guild) get
// no card, by design. See postLaunchCard.
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
// APPLICATION_COMMAND interactions named `connections`, and both launch the game.
// (The chat-input command also exists because the Entry Point one doesn't reliably
// show in the typed "/" menu.) `play` is kept as an alias in case `connections`
// collides with the Entry Point command name at registration time.
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
// the HTTP layer so it can be unit-tested without a request. Launch commands are
// handled out-of-band (see the handler), so this only covers PING, the recap's Play
// button, and the unsupported fallback.
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
// that posts/edits the room card. The Play button launches too, but it reuses an
// existing card through the Activity's /api/join rather than minting a new message.
function isLaunchCommand(body: Interaction): boolean {
  return body.type === APPLICATION_COMMAND && LAUNCH_COMMANDS.has(body.data?.name ?? '');
}

// Fields we read off a launch interaction beyond the routing ones above.
type DiscordUserLite = { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
type LaunchInteraction = Interaction & {
  id?: string;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string };
  member?: { user?: DiscordUserLite };
  user?: DiscordUserLite;
  // Present key "0" => the app is installed to this guild (the bot is in it); "1" => user install.
  authorizing_integration_owners?: Record<string, string>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A LAUNCH_ACTIVITY response doesn't hand back the launch message's id (its callback's
// response_message_id is null), so to reply we locate the "<user> used /connections"
// message by scanning the channel's recent messages for this user's most recent launch
// command. Newest-first, so the first match is this launch. Needs the bot's Read Message
// History permission (the same one a reply needs); a brief retry covers the message not
// being indexed the instant after launch. Returns null if it can't be found.
async function findLaunchMessageId(channelId: string, userId: string, botToken: string): Promise<string | null> {
  type Meta = { user?: { id?: string }; name?: string };
  type Msg = { id: string; interaction_metadata?: Meta; interaction?: Meta };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (!r.ok) {
        console.error('[findLaunch] list messages failed', r.status, await r.text().catch(() => ''));
        return null;
      }
      const msgs = (await r.json()) as Msg[];
      // Interaction messages this user triggered, newest first (Discord returns newest first).
      const mine = msgs.filter((m) => (m.interaction_metadata ?? m.interaction)?.user?.id === userId);
      // Prefer an explicit /connections command; else their most recent interaction message
      // (they just launched, so that's almost certainly the "used /connections" one).
      const named = mine.find((m) => {
        const name = m.interaction?.name ?? m.interaction_metadata?.name;
        return name !== undefined && LAUNCH_COMMANDS.has(name);
      });
      const match = named ?? mine[0];
      if (match) return match.id;
    } catch (e) {
      console.error('[findLaunch] threw', e instanceof Error ? e.message : e);
      return null;
    }
    await sleep(500);
  }
  console.warn('[findLaunch] no matching launch message found');
  return null;
}

// Best-effort: post (or refresh) the room's "who's playing" card as the bot, replying to
// the launcher's "<user> used /connections" message. One card per room per day: the first
// launch creates it (as a reply); later launches/joins/guesses edit that same message in
// place. Skipped where the app isn't installed to the guild (no bot). Runs after the
// launch reply is already sent, so any failure here never delays the game.
async function postLaunchCard(body: LaunchInteraction): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
  if (!botToken) {
    console.warn('[postLaunchCard] skip: no DISCORD_BOT_TOKEN');
    return;
  }
  // The card only exists where the bot is — a guild install (owners key "0"). A
  // user-installed launch with no server bot gets no card, by design.
  const owners = body.authorizing_integration_owners;
  if (!owners || !('0' in owners)) {
    console.log('[postLaunchCard] skip: not guild-installed (no bot)');
    return;
  }

  const guildId = typeof body.guild_id === 'string' ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === 'string'
      ? body.channel_id
      : typeof body.channel?.id === 'string'
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith('g:') || !channelId) {
    console.warn('[postLaunchCard] skip: no guild scope/channel', { guildId, channelId, scope });
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
    .select('players, message_id, channel_id')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  if (selErr) console.error('[postLaunchCard] live_cards select error (schema migrated?)', selErr.message);

  // renderRoster/mergePlayer pull @napi-rs/canvas; load them lazily so PING and other
  // light interactions don't pay the native-addon cold start.
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

  const auth = { Authorization: `Bot ${botToken}` };
  const cardChannel = (card?.channel_id as string | null | undefined) || channelId;
  let messageId = (card?.message_id as string | null | undefined) ?? null;

  // Edit the room's existing card in place; if it was deleted (404), make a fresh one.
  if (messageId) {
    const r = await sendCard(botCardUrl(cardChannel, messageId), cardPayload(), png, 'PATCH', 'card.png', auth);
    if (r.status === 404) {
      messageId = null;
    } else if (!r.ok) {
      console.error('[postLaunchCard] edit failed', r.status, await r.text().catch(() => ''));
    }
  }
  // Establish: post a fresh card as a reply to the launcher's /connections message.
  if (!messageId) {
    const launchMessageId = await findLaunchMessageId(channelId, u.id, botToken);
    const replyTo = launchMessageId ? { messageId: launchMessageId, channelId } : undefined;
    if (!replyTo) console.warn('[postLaunchCard] launch message not found — posting card without a reply');
    console.log('[postLaunchCard] creating card', { scope, replying: !!replyTo, players: players.length });
    let r = await sendCard(botCardUrl(channelId), cardPayload(replyTo), png, 'POST', 'card.png', auth);
    // If the REPLY specifically failed (e.g. the bot lacks Read Message History), still
    // post a plain card so something shows — and log it so the perm can be fixed.
    if (!r.ok && replyTo) {
      console.error('[postLaunchCard] reply failed, retrying without reply', r.status, await r.text().catch(() => ''));
      r = await sendCard(botCardUrl(channelId), cardPayload(), png, 'POST', 'card.png', auth);
    }
    if (r.ok) {
      messageId = ((await r.json()) as { id?: string }).id ?? null;
    } else {
      console.error('[postLaunchCard] create failed', r.status, await r.text().catch(() => ''));
      return;
    }
  }
  if (!messageId) return;

  const nowIso = new Date().toISOString();
  const { error: upErr } = await db.from('live_cards').upsert(
    {
      scope_id: scope,
      puzzle_date: date,
      players,
      message_id: messageId,
      channel_id: channelId,
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

  // After launching, the bot finds the "<user> used /connections" message and replies to
  // it with the card. waitUntil keeps the function alive past the response flush (a plain
  // await after res.json() can be frozen on Vercel). Best-effort — the launch already went.
  if (isLaunchCommand(body)) {
    waitUntil(
      postLaunchCard(body).catch((e) => {
        console.error('[postLaunchCard] threw', e instanceof Error ? e.message : e);
      }),
    );
  }
}
