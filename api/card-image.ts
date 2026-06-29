import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from './_query.js';

// Same-origin proxy for NYT Connections card images. The April-Fools "image puzzle"
// format (e.g. 2025-04-01) renders each card as an SVG glyph hosted on NYT's asset
// CDNs instead of plain text. Inside the Discord Activity the game runs in an iframe
// whose CSP only permits same-origin / Discord-proxied requests, so the browser can't
// load those external hosts directly — routing them through this endpoint (same
// origin) rides Discord's proxy automatically, and works unchanged in a standalone
// browser too. The puzzle stores the original NYT URL; the client wraps it as
// /api/card-image?u=<encoded url> (see src/board.tsx).
//
// Host-allowlisted so it can't be abused as an open proxy. Left unauthenticated on
// purpose: these are public NYT assets (the puzzle itself is already auth-gated), and
// an <img> can't attach the bearer ticket. Immutable, so cached hard.

// The two NYT asset hosts seen in the v2 feed; the S3 region is left flexible.
const ALLOWED_HOST =
  /^(games-assets\.storage\.googleapis\.com|games-phoenix-assets-prd\.s3\.[a-z0-9-]+\.amazonaws\.com)$/;
const FETCH_TIMEOUT_MS = 4000;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const raw = query(req).get('u') ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    res.status(400).json({ error: 'bad url' });
    return;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.host)) {
    res.status(400).json({ error: 'host not allowed' });
    return;
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Connections Activity)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).end();
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type');
    res.setHeader('Content-Type', ct && ct.startsWith('image/') ? ct : 'image/svg+xml');
    // Immutable asset (URLs are content-hashed) — cache hard at the browser and CDN.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Defense in depth: we render these via <img> (which can't run script), but a
    // direct navigation to an SVG would be a same-origin document — neuter scripts and
    // MIME sniffing so a hypothetical hostile asset can't execute in our origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(body);
  } catch {
    res.status(502).end();
  }
}
