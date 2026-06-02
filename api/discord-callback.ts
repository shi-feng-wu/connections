import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { type IncomingWebhook, resolveRedirectUri, webhookToRecapRow } from './_oauth.js';
import { verifyState } from './_session.js';

// Finishes the "add to server" flow started by /api/install. Discord redirects the
// admin here with a code; we exchange it for a token whose payload carries the
// incoming webhook Discord just created in the channel they picked, then persist that
// webhook so the daily cron can post the recap straight to it — no bot in the guild.
//
// The page is rendered as plain HTML because a human lands on it in a browser.

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#e7e9ee;background:#1e1f22}
h1{font-size:1.4rem} code{background:#2b2d31;padding:.1em .4em;border-radius:.3em}</style>
<h1>${title}</h1>${body}`;
}

function html(res: VercelResponse, status: number, title: string, body: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(page(title, body));
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // The user declined on Discord's consent screen.
  if (req.query.error) {
    html(res, 200, 'Setup cancelled', '<p>No problem — nothing was changed. You can close this tab.</p>');
    return;
  }

  // A code only counts if it belongs to a flow this server started and is still fresh.
  if (!verifyState(req.query.state)) {
    html(res, 400, 'Link expired', '<p>This setup link is invalid or expired. Please start again.</p>');
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    html(res, 400, 'Missing code', '<p>Discord did not return an authorization code.</p>');
    return;
  }

  const clientId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET ?? '';
  const db = admin();
  if (!clientId || !clientSecret || !db) {
    html(res, 503, 'Not configured', '<p>The server is missing OAuth or database configuration.</p>');
    return;
  }

  try {
    // redirect_uri must byte-match the one /api/install sent, so derive it identically.
    const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host;
    const redirectUri = resolveRedirectUri(host, process.env.OAUTH_REDIRECT_URI);

    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = (await r.json()) as { webhook?: IncomingWebhook };
    if (!r.ok) {
      html(res, 502, 'Discord rejected the setup', '<p>The authorization could not be completed. Please try again.</p>');
      return;
    }

    // webhook.incoming wasn't granted (or not a guild channel) → nothing to post to.
    const row = webhookToRecapRow(data.webhook, new Date().toISOString());
    if (!row) {
      html(
        res,
        400,
        'No channel selected',
        '<p>The daily recap needs a channel. Re-run setup and pick a channel to post in.</p>',
      );
      return;
    }

    // last-write-wins per room; re-running setup just repoints the recap.
    const { error } = await db.from('recap_channels').upsert(row, { onConflict: 'scope_id' });
    if (error) {
      html(res, 500, 'Could not save', '<p>We received the webhook but failed to store it. Please try again.</p>');
      return;
    }

    html(
      res,
      200,
      'Daily recap enabled ✅',
      `<p>Connections will post yesterday's results to the channel you selected, every day after the midnight reset.</p>
<p>You can close this tab.</p>`,
    );
  } catch {
    html(res, 500, 'Something went wrong', '<p>Setup failed unexpectedly. Please try again.</p>');
  }
}
