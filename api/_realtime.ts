import type { RosterDelta } from '../src/player.js';

// Server-side Realtime broadcast. One HTTPS POST to Supabase's broadcast REST endpoint fans
// a message out to every client subscribed to the room's private channel — Supabase does the
// per-viewer delivery, so this is O(1) per update no matter how many people are watching, and
// no socket has to stay open (serverless-friendly). The service-role key authorizes the write
// past the realtime.messages RLS; `private: true` marks it for the authorized channel.
//
// Fire-and-forget by contract: a failed or dropped broadcast just means the affected clients
// fall back to their backstop poll, so callers must NOT put this on a latency-critical path
// (use waitUntil) and never depend on it landing. Leading underscore keeps Vercel from
// treating this file as a route.

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// The private channel a room's clients subscribe to. Must match the topic the realtime.messages
// RLS policy authorizes: 'room:' || the JWT's `room` claim (see mintSupabaseJWT + schema.sql),
// where the claim is the canonical scope. So everyone in a guild shares room:g:<id>, and a
// DM/group shares room:c:<id>.
export function roomTopic(scope: string): string {
  return `room:${scope}`;
}

export async function broadcastRoom(scope: string, event: 'progress' | 'join', payload: RosterDelta): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY || !scope) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ topic: roomTopic(scope), event, payload, private: true }],
      }),
    });
  } catch {
    /* clients self-heal via the backstop poll */
  }
}
