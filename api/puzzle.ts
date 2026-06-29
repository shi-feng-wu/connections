import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bearerToken } from './_discord.js';
import { fetchPuzzle, todayET, randomDate, isValidDate, FIRST_DATE } from './_nyt.js';
import { query } from './_query.js';
import { isLocalDev, verifyAuth } from './_session.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    // Discord-only: a puzzle is served only to a verified Discord identity, so a
    // direct browser visit gets nothing playable. The auth ticket (signed by
    // /api/token after one Discord check) is verified by HMAC here — no per-request
    // round-trip. Skipped on local `vercel dev` so the standalone fallback works.
    if (!isLocalDev() && !verifyAuth(bearerToken(req.headers.authorization))) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const q = query(req);
    const dateParam = q.get('date') ?? undefined;
    if (dateParam && !isValidDate(dateParam)) {
      res.status(400).json({ error: `Date must be between ${FIRST_DATE} and ${todayET()}.` });
      return;
    }
    const date = dateParam ?? (q.get('random') ? randomDate() : todayET());
    const puzzle = await fetchPuzzle(date);
    // Per-user (auth-gated) response: browser may cache, shared CDN must not, or it
    // could serve a puzzle to an unauthenticated request. fetchPuzzle's in-memory
    // cache still spares NYT the repeat fetches the edge cache used to absorb.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).json(puzzle);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'error';
    res.status(message === 'NOT_FOUND' ? 404 : 502).json({ error: message });
  }
}
