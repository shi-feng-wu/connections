import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { fetchDiscordUser, mintSupabaseJWT } from './_discord.js';

// Mints a short-lived Supabase JWT for the verified Discord user to join the room's private
// Realtime channel (progress Broadcast + online Presence). The token is scoped to the room's
// CANONICAL SCOPE (g:<guild> or c:<channel>) — the same key the roster and leaderboard use, so
// everyone playing the room today shares one channel and a guess fans out to all of them. The
// `room` claim pins the topic via RLS (schema.sql), so a token for one room can't read or write
// any other. Only verified Discord users get one; no token / unconfigured → the client falls
// back to its backstop poll.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const guildId = typeof req.body?.guildId === 'string' ? req.body.guildId : null;
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope) {
    res.status(400).json({ error: 'missing room' });
    return;
  }
  const user = await fetchDiscordUser(req.body?.accessToken);
  if (!user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const token = mintSupabaseJWT(user, scope);
  if (!token) {
    res.status(503).json({ error: 'realtime auth unavailable' });
    return;
  }
  res.status(200).json({ token });
}
