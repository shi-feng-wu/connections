import type { RosterDelta } from '../src/player.js';

// Server-side Realtime broadcast. One HTTPS POST to Supabase's broadcast REST endpoint fans a
// message out to every client subscribed to the room's channel — Supabase does the per-viewer
// delivery, so this is O(1) per update no matter how many people are watching, and no socket has
// to stay open (serverless-friendly).
//
// The room channel is PUBLIC (no `private` flag). On a private channel the realtime server
// re-evaluates the realtime.messages RLS per recipient during fan-out and only the sender passes,
// so broadcasts never reach other subscribers (confirmed: self-echo works, cross-client doesn't).
// Public has no per-message RLS, so every subscriber receives every broadcast. The payload is the
// public "who's playing" roster, the same data the bot already posts in-channel.
//
// Fire-and-forget by contract: a failed or dropped broadcast just means the affected clients fall
// back to their backstop read, so callers must NOT put this on a latency-critical path (use
// waitUntil) and never depend on it landing. Leading underscore keeps Vercel from treating this
// file as a route.

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

// The channel a room's clients subscribe to: everyone in a guild shares room:g:<id>, a DM/group
// shares room:c:<id>, where the suffix is the canonical scope.
export function roomTopic(scope: string): string {
  return `room:${scope}`;
}

export async function broadcastRoom(scope: string, event: 'progress' | 'join', payload: RosterDelta): Promise<void> {
  const apikey = ANON_KEY || SERVICE_KEY;
  if (!SUPABASE_URL || !scope || !apikey) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${apikey}`,
      },
      body: JSON.stringify({
        messages: [{ topic: roomTopic(scope), event, payload }],
      }),
    });
  } catch {
    /* clients self-heal via the backstop read */
  }
}
