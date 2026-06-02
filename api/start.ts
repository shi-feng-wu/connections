import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { bearerToken } from './_discord.js';
import { isValidDate } from './_nyt.js';
import { isLocalDev, signSession, verifyAuth } from './_session.js';

// Opens (or resumes) a player's day. Two jobs:
//   1. Issue a signed session so /api/score can bind the eventual score to this
//      puzzle and measure solve time. iat = the pinned started_at, so a relaunch
//      returns the SAME start and can't fake a faster solve.
//   2. Hand back the committed guess list, so the client rehydrates the exact board
//      it left — mistakes spent, groups solved — instead of resetting to a fresh
//      one and handing out infinite tries.
// started_at is stamped once by the progress row's column default on first insert;
// ignoreDuplicates means every later call leaves it untouched. Client calls this
// right after loading a puzzle.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Discord-only, matching /api/puzzle: no signed session without a valid auth
  // ticket, so a direct visitor can't even start (and thus can't be scored).
  const auth = verifyAuth(bearerToken(req.headers.authorization));
  if (!isLocalDev() && !auth) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const date = typeof req.body?.date === 'string' ? req.body.date : '';
  if (!isValidDate(date)) {
    res.status(400).json({ error: 'bad date' });
    return;
  }

  // Resume (or open) this player's record. Best-effort: a store hiccup falls back
  // to a fresh in-memory start (the old behaviour), so a transient failure can
  // never lock anyone out of playing — it just won't resume that one time.
  let startedAt = Date.now();
  let updatedAt = startedAt;
  let guesses: string[][] = [];
  const db = auth ? admin() : null;
  if (db && auth) {
    try {
      // Insert-if-absent: pins started_at via the column default; a reopen no-ops.
      await db.from('progress').upsert(
        { user_id: auth.uid, puzzle_date: date },
        { onConflict: 'user_id,puzzle_date', ignoreDuplicates: true },
      );
      const { data } = await db
        .from('progress')
        .select('guesses, started_at, updated_at')
        .eq('user_id', auth.uid)
        .eq('puzzle_date', date)
        .maybeSingle();
      if (data) {
        if (Array.isArray(data.guesses)) guesses = data.guesses as string[][];
        const s = Date.parse(data.started_at as string);
        if (!Number.isNaN(s)) startedAt = s;
        const u = Date.parse(data.updated_at as string);
        if (!Number.isNaN(u)) updatedAt = u;
      }
    } catch {
      /* fall back to a fresh start; the day just won't resume this once */
    }
  }

  res.status(200).json({
    session: signSession({ date, iat: startedAt }),
    startedAt,
    updatedAt,
    guesses,
  });
}
