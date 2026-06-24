import type { RosterDelta } from '../src/player.js';
import { mintSupabaseJWT } from './_discord.js';

// Server-side Realtime broadcast. One HTTPS POST to Supabase's broadcast REST endpoint fans a
// message out to every client subscribed to the room's private channel — Supabase does the
// per-viewer delivery, so this is O(1) per update no matter how many people are watching, and no
// socket has to stay open (serverless-friendly).
//
// IMPORTANT: the broadcast is authorized with a room-scoped JWT (role authenticated, room claim
// = scope), exactly like a client — NOT the service-role key. The service token has no `room`
// claim, so the realtime server accepts the POST (202) but doesn't bind it to the private channel
// and subscribers never receive it. The room JWT makes the realtime.messages RLS pass for
// room:<scope> and routes the message to that channel's subscribers.
//
// Fire-and-forget by contract: a failed or dropped broadcast just means the affected clients fall
// back to their backstop read, so callers must NOT put this on a latency-critical path (use
// waitUntil) and never depend on it landing. Leading underscore keeps Vercel from treating this
// file as a route.

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

// The private channel a room's clients subscribe to. Must match the topic the realtime.messages
// RLS policy authorizes: 'room:' || the JWT's `room` claim (see mintSupabaseJWT + schema.sql),
// where the claim is the canonical scope. So everyone in a guild shares room:g:<id>, and a
// DM/group shares room:c:<id>.
export function roomTopic(scope: string): string {
  return `room:${scope}`;
}

export async function broadcastRoom(scope: string, event: 'progress' | 'join', payload: RosterDelta): Promise<void> {
  if (!SUPABASE_URL || !scope) return;
  const token = mintSupabaseJWT({ id: 'server-broadcast', name: 'server' }, scope);
  const apikey = ANON_KEY || SERVICE_KEY;
  if (!token || !apikey) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ topic: roomTopic(scope), event, payload, private: true }],
      }),
    });
  } catch {
    /* clients self-heal via the backstop read */
  }
}
