import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Discord interactions webhook. Discord POSTs here for the Play button on the
// daily recap (and a PING when the endpoint URL is saved). The activity launch
// itself is the native Entry Point command, handled by Discord — this endpoint
// only needs to PONG the verification ping and turn a Play click into a launch.
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

// Chat-input (type 1) command names that should open the Activity. The type-4 Entry
// Point command covers the App Launcher but doesn't reliably show in the typed "/"
// menu; a normal slash command does, and launches the game by replying with
// LAUNCH_ACTIVITY. `play` is kept as an alias in case `connections` collides with the
// Entry Point command name at registration time.
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
  let body: Interaction;
  try {
    body = JSON.parse(raw) as Interaction;
  } catch {
    res.status(400).json({ error: 'bad body' });
    return;
  }
  res.status(200).json(routeInteraction(body));
}
