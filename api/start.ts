import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isValidDate } from './_nyt.js';
import { signSession } from './_session.js';

// Issues a signed session so the server can measure solve time and bind the
// eventual score to this puzzle. Uncached; each player's start time is their own.
// Client calls this right after loading a puzzle.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const date = typeof req.body?.date === 'string' ? req.body.date : '';
  if (!isValidDate(date)) {
    res.status(400).json({ error: 'bad date' });
    return;
  }
  res.status(200).json({ session: signSession({ date, iat: Date.now() }) });
}
