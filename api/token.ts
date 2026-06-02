import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchDiscordUser } from './_discord.js';
import { signAuth } from './_session.js';

// Exchanges the embedded SDK's OAuth code for an access token. Client secret stays
// server-side here. Also confirms the identity once (the single Discord round-trip
// of the session) and mints a short-lived signed `auth` ticket, so /api/puzzle and
// /api/start can gate on a cheap HMAC instead of re-checking the token every call.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const code = (req.body?.code ?? '') as string;
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.VITE_DISCORD_CLIENT_ID ?? '',
        client_secret: process.env.DISCORD_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = (await r.json()) as { access_token?: string };
    if (!r.ok || !data.access_token) {
      res.status(r.ok ? 502 : r.status).json(data);
      return;
    }
    // Verify the freshly minted token resolves to a real user, then vouch for it.
    const user = await fetchDiscordUser(data.access_token);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.status(200).json({
      access_token: data.access_token,
      auth: signAuth({ uid: user.id, iat: Date.now() }),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
