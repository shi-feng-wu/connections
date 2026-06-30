import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game } from '../src/game.js';
import type { RosterDelta } from '../src/player.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { bearerToken } from './_discord.js';
import { triggerCardRefresh } from './_internal.js';
import { cardNeedsRefresh } from './_livecard.js';
import { fetchPuzzle, isValidDate, todayET } from './_nyt.js';
import { broadcastRoom } from './_realtime.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Commit one guess to the player's authoritative daily record, then return its
// result. Commit-THEN-reveal is the whole point: the guess is recorded server-side
// before the client learns the outcome, so a player can't see a result and then
// abandon the Activity to erase it. The stored list is append-only and is exactly
// what /api/score replays, which closes the "leave to get infinite tries" hole:
//   • mistakes and solved groups persist across relaunches (resumed via /api/start)
//   • a bad guess can't be hidden — you can't learn it was bad until it's committed
//   • the clock can't be re-rolled (started_at is pinned; see /api/start)
// Gated by the same auth ticket as /api/puzzle and /api/start; the ticket's uid is
// the Discord user id — identical to the id /api/score resolves from the token — so
// the (user_id, puzzle_date) row lines up across all three endpoints.
const MAX_GUESSES = 40; // upper bound on a real game's submissions

const snapshot = (game: Game) => ({
  mistakesLeft: game.mistakesLeft,
  solvedLevels: game.solved.map((s) => s.level),
  status: game.status,
});

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
  // No identity, no per-user record. (Only reachable on local `vercel dev`, where
  // the ticket gate is skipped; the standalone client plays in-memory and never
  // calls this.)
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
  const guess = Array.isArray(body.guess) ? body.guess.map(String) : null;
  if (!guess || guess.length !== 4) {
    res.status(400).json({ error: 'bad guess' });
    return;
  }

  const db = admin();
  if (!db) {
    // Local dev without a store: let play proceed in-memory (nothing to track). A
    // misconfigured deploy fails closed, so a tracked game isn't silently untracked.
    if (isLocalDev()) {
      res.status(200).json({ ok: true, persisted: false });
      return;
    }
    res.status(503).json({ ok: false, reason: 'unavailable' });
    return;
  }

  try {
    const puzzle = await fetchPuzzle(date);

    // Load the committed record and replay it for the current state.
    const { data } = await db
      .from('progress')
      .select('guesses')
      .eq('user_id', uid)
      .eq('puzzle_date', date)
      .maybeSingle();
    const committed: string[][] =
      data && Array.isArray(data.guesses) ? (data.guesses as string[][]) : [];

    const game = Game.fromGuesses(puzzle, committed);
    if (game.status !== 'playing') {
      // Already finished today; nothing to add.
      res.status(200).json({ ok: true, done: game.status, state: snapshot(game) });
      return;
    }

    // Apply the new guess against the real board.
    game.clear();
    for (const w of guess) game.toggle(w);
    if (!game.canSubmit()) {
      // Not four distinct on-board words (stale client / tampering). Reject without
      // recording; the client should resync.
      res.status(200).json({ ok: false, reason: 'illegal', state: snapshot(game) });
      return;
    }
    const result = game.submit();

    // Append only a guess that actually counted; a duplicate/noop changes nothing,
    // so it isn't recorded — the client just gets the result back. started_at is
    // intentionally omitted from the payload: set once by /api/start (or the column
    // default on a first-guess insert) and never overwritten here.
    const counted = result.type !== 'duplicate' && result.type !== 'noop';
    if (counted && committed.length < MAX_GUESSES) {
      await db.from('progress').upsert(
        {
          user_id: uid,
          puzzle_date: date,
          guesses: [...committed, guess],
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,puzzle_date' },
      );
    }

    // Fan the new state out to everyone watching this room's roster, instantly (the SSE relay —
    // api/_realtime.ts fans it out to every subscribed client). Only a counted guess changes what
    // they'd see. Off the reveal path via waitUntil so it never delays this response; a drop is
    // harmless (their reconnect reconcile / 5-min backstop poll catches up). The guessing player sees their own result
    // from this response + local state, not from the broadcast.
    if (counted) {
      const guildId = typeof body.guildId === 'string' ? body.guildId : null;
      const channelId = typeof body.channelId === 'string' ? body.channelId : null;
      const scope = canonicalScope(guildId, channelId);
      if (scope) {
        const done = game.status === 'playing' ? null : game.status;
        const delta: RosterDelta = {
          userId: uid,
          channelId,
          // groupsSolved / deducedLevels, NOT game.solved — on a loss submit() back-fills
          // game.solved with every remaining group (the reveal), so broadcasting it raw would
          // credit a loser with all four groups (inflated score + four solved bars). These
          // deduced getters exclude the back-fill, matching what /api/roster replays, so the
          // live delta and the cold-start read agree.
          solvedCount: game.groupsSolved,
          solvedLevels: game.deducedLevels,
          mistakesLeft: game.mistakesLeft,
          done,
          finishedAt: done ? Date.now() : null,
        };
        waitUntil(broadcastRoom(scope, 'progress', delta));

        // Re-render the room's live "who's playing" card from this same event, so its guess grids
        // fill in during play instead of only at the solve. Gated cheaply here (skip when there's
        // no card or the 30s window is still open) and rate-limited authoritatively in
        // /api/refresh-card; the heavy canvas render lives there so this function stays canvas-free.
        // Off the reveal path via waitUntil — a drop just means the card waits for the next guess.
        if (channelId) {
          const finished = done !== null;
          waitUntil(
            cardNeedsRefresh(db, scope, date, channelId, finished).then((due) =>
              due ? triggerCardRefresh({ guildId, channelId, finished }) : undefined,
            ),
          );
        }
      }
    }

    res.status(200).json({ ok: true, result, state: snapshot(game) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
