import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game } from '../src/game.js';
import { admin } from './_admin.js';
import { bearerToken } from './_discord.js';
import { fetchPuzzle, isValidDate, todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Record one revealed hint into the player's authoritative daily record. Same
// contract as /api/guess: the hint is committed server-side so the score penalty
// can't be dodged by relaunching (the "infinite tries" hole, applied to hints).
// /api/score never trusts the request body for the hint count — it replays this
// stored list — so a tampered client that skips this call just doesn't get the
// hint recorded; it can't record fewer hints than it revealed.
//
// The client reveals optimistically (it holds the whole puzzle, so it computes the
// same level/word locally — see Game.useHint) and posts the level it revealed. The
// server VALIDATES that level against its own replayed state (unsolved, not already
// hinted, and ≥2 groups still unsolved — the exact hintableLevel rules) and appends
// it, so the recorded penalty always matches what the player saw. Gated by the same
// auth ticket as /api/guess; auth.uid keys the (user_id, puzzle_date) row.

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = verifyAuth(bearerToken(req.headers.authorization));
  if (!isLocalDev() && !auth) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const uid = auth?.uid;
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const body = req.body ?? {};
  const date = typeof body.date === 'string' ? body.date : '';
  if (!isValidDate(date)) {
    res.status(400).json({ error: 'bad date' });
    return;
  }
  // Only today's official daily is tracked — it's the only thing that scores.
  if (date !== todayET()) {
    res.status(200).json({ ok: false, reason: 'not-daily' });
    return;
  }
  const level = Number(body.level);
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    res.status(400).json({ error: 'bad level' });
    return;
  }

  const db = admin();
  if (!db) {
    // Local dev without a store: play proceeds in-memory (the client computed the
    // hint itself). A misconfigured deploy fails closed so a penalty isn't lost.
    if (isLocalDev()) {
      res.status(200).json({ ok: true, persisted: false });
      return;
    }
    res.status(503).json({ ok: false, reason: 'unavailable' });
    return;
  }

  try {
    const puzzle = await fetchPuzzle(date);

    // Load the committed record and replay it for the current state (including any
    // hints already revealed, so hintedLevels reflects the real count).
    const { data } = await db
      .from('progress')
      .select('guesses, hints')
      .eq('user_id', uid)
      .eq('puzzle_date', date)
      .maybeSingle();
    const guesses: string[][] =
      data && Array.isArray(data.guesses) ? (data.guesses as string[][]) : [];
    const storedHints: unknown = data?.hints;

    const game = Game.fromGuesses(puzzle, guesses, undefined, storedHints);
    if (game.status !== 'playing') {
      res.status(200).json({ ok: false, reason: 'done' });
      return;
    }

    // Validate the requested level is a legal next hint: unsolved, not already
    // hinted, and offered only while ≥2 groups remain unsolved (once three are out
    // the last four words are forced, so a hint would reveal nothing).
    const solved = new Set(game.solved.map((s) => s.level));
    const unsolved = [0, 1, 2, 3].filter((l) => !solved.has(l));
    if (unsolved.length < 2 || solved.has(level) || game.hintedLevels.includes(level)) {
      res.status(200).json({ ok: false, reason: 'illegal' });
      return;
    }

    const hints = [...game.hintedLevels, level];
    await db.from('progress').upsert(
      {
        user_id: uid,
        puzzle_date: date,
        hints,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,puzzle_date' },
    );

    // The word is deterministic (the group's first member); returned for parity with
    // the client's local reveal, which is what the player actually sees.
    const word = puzzle.groups.find((g) => g.level === level)?.members[0] ?? null;
    res.status(200).json({ ok: true, level, word });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
