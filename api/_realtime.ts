import type { RosterDelta } from '../src/player.js';

// Server→relay push. The Vercel API POSTs a delta to the SSE relay (scripts/relay.mjs on Railway),
// which fans it out to every client holding an SSE stream for the room — O(1) per update no matter
// how many people are watching, and no socket stays open on Vercel (serverless-friendly).
//
// Replaces the old Supabase Realtime broadcast: a Discord Activity client can't reliably hold the
// proxied WebSocket Realtime needs, but it CAN hold an SSE stream from the relay. Supabase now sees
// zero realtime traffic, which is what was blowing past the free egress tier.
//
// Fire-and-forget by contract: a failed or dropped push just means the affected clients fall back
// to their backstop read, so callers must NOT put this on a latency-critical path (use waitUntil)
// and never depend on it landing. Leading underscore keeps Vercel from treating this as a route.

const RELAY_URL = process.env.RELAY_URL ?? ''; // https://<relay-host> (server-to-server, no proxy)
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''; // shared secret the relay checks on server pushes

// The room a delta fans out to: everyone in a guild shares g:<id>, a DM/group shares c:<id> — the
// canonical scope, byte-for-byte the same string the client subscribes with.
export async function broadcastRoom(
  scope: string,
  event: 'progress' | 'join',
  payload: RosterDelta,
): Promise<void> {
  if (!RELAY_URL || !RELAY_SECRET || !scope) return;
  try {
    const r = await fetch(`${RELAY_URL}/pub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-secret': RELAY_SECRET },
      body: JSON.stringify({ room: scope, event, payload }),
    });
    // A non-2xx means the relay rejected the push (most commonly a RELAY_SECRET mismatch → 401),
    // which silently kills ALL live deltas for that environment. Clients still self-heal via the
    // backstop read, but log it — otherwise this misconfig is invisible. delivered:0 is normal
    // (nobody watching), so we don't warn on it.
    if (!r.ok) console.warn(`[realtime] relay rejected ${event} push: ${r.status}`);
  } catch {
    /* clients self-heal via the backstop read */
  }
}
