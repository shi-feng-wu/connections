import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchDiscordUser, mintSupabaseJWT } from './_discord.js';

// Mints a short-lived Supabase JWT for the verified Discord user to join the
// private Realtime presence channel. No token falls back to a public channel
// (dev); in production the private channel's RLS keeps unauthenticated clients
// out, so presence can't be spoofed anonymously.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Room (Discord activity instance id) the token is scoped to. The JWT carries it
  // as a claim and the channel RLS only authorizes the matching topic, so the token
  // is good for this one room and no other.
  const room = typeof req.body?.room === 'string' ? req.body.room : '';
  if (!room) {
    res.status(400).json({ error: 'missing room' });
    return;
  }
  const user = await fetchDiscordUser(req.body?.accessToken);
  if (!user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const token = mintSupabaseJWT(user, room);
  if (!token) {
    res.status(503).json({ error: 'realtime auth unavailable' });
    return;
  }
  res.status(200).json({ token });
}
