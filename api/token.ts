import type { VercelRequest, VercelResponse } from '@vercel/node';

// Exchanges the embedded SDK's OAuth code for an access token. Client secret
// stays server-side here.
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
    if (!r.ok) {
      res.status(r.status).json(data);
      return;
    }
    res.status(200).json({ access_token: data.access_token });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
