import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthorizeUrl, resolveRedirectUri } from './_oauth.js';
import { signState } from './_session.js';

// "Add to your server" entry point for the daily recap. Sends an admin to Discord's
// consent screen with scope webhook.incoming; on approval Discord creates a webhook
// in the channel they pick and bounces back to /api/discord-callback with a code.
// Share this URL (or link a button to it) instead of the plain Activity install link
// when you want a server to get the midnight recap.
export default function handler(req: VercelRequest, res: VercelResponse): void {
  const clientId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
  if (!clientId) {
    res.status(503).json({ error: 'oauth not configured' });
    return;
  }
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host;
  const redirectUri = resolveRedirectUri(host, process.env.OAUTH_REDIRECT_URI);
  const url = buildAuthorizeUrl(clientId, redirectUri, signState());
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url);
}
