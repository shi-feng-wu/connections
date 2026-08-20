import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchPuzzle, nextRolloverMs, todayET } from './_puzzles.js';

// TODAY's board, readable without a Discord identity — the one public puzzle route.
//
// /api/puzzle stays Discord-only (it serves ANY date, carries the practice/playtest
// branches, and is the route scoring replays against). This one does a single thing:
// hand the landing page the board for the current puzzle day so a visitor can play it
// in the browser. No date parameter, no archive, no random — a wider surface here
// would quietly reopen the archive to anyone.
//
// Nothing is written. A web solve lives entirely in the visitor's localStorage; the
// `progress` / score tables are only ever touched by the authenticated Activity.
//
// Caching: one shared CDN copy for everyone, expiring exactly at the day rollover
// (midnight ET) so the edge can never hand out yesterday's board. nextRolloverMs is
// derived from the same etDate() the rest of the server keys days on.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const puzzle = await fetchPuzzle(todayET());
    const ttl = Math.max(60, Math.floor((nextRolloverMs() - Date.now()) / 1000));
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}`);
    res.status(200).json(puzzle);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    const message = e instanceof Error ? e.message : 'error';
    res.status(message === 'NOT_FOUND' ? 404 : 502).json({ error: message });
  }
}
