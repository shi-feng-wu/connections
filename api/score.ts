import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game, MAX_MISTAKES } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { fetchDiscordUser, fetchUserGuildIds } from './_discord.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { verifySession } from './_session.js';

// The only path a score reaches the leaderboard. The client is trusted for nothing
// but the raw guess list and the requested room; the room is authorized, not just
// accepted. Identity comes from the Discord token via /users/@me (not the body),
// outcome from replaying the guesses against the real solution, duration from the
// signed session's start time, score from the shared Game logic. A guild board is
// written only after confirming the user belongs to that guild (guild ids are
// public); the g:/c: prefix stops a guild id smuggled in via the channel slot.
// Writes use the service role, so the anon key can't touch the table.

const SESSION_MAX_AGE = 18 * 60 * 60 * 1000; // daily session shouldn't outlive its day
const DURATION_CAP = 6 * 60 * 60 * 1000;
const MAX_GUESSES = 40; // upper bound on a real game's submissions

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.body ?? {};

    // 1. Valid, unexpired session bound to a puzzle date.
    const session = verifySession(body.session);
    if (!session) {
      res.status(400).json({ error: 'bad session' });
      return;
    }
    const age = Date.now() - session.iat;
    if (age < 0 || age > SESSION_MAX_AGE) {
      res.status(400).json({ error: 'session expired' });
      return;
    }
    // 2. Only the official daily counts toward the season; enforced server-side.
    if (session.date !== todayET()) {
      res.status(200).json({ ok: false, reason: 'not-daily' });
      return;
    }
    // 3. Authoritative identity.
    const user = await fetchDiscordUser(body.accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const db = admin();
    if (!db) {
      res.status(503).json({ error: 'leaderboard unavailable' });
      return;
    }

    // 4. Replay the guesses against the real solution for the outcome; a client
    //    can't claim a solve it didn't produce.
    const puzzle = await fetchPuzzle(session.date);
    const game = new Game(puzzle);
    const guesses: unknown = body.guesses;
    if (Array.isArray(guesses)) {
      for (const guess of guesses.slice(0, MAX_GUESSES)) {
        if (game.status !== 'playing') break;
        if (!Array.isArray(guess) || guess.length !== 4) continue;
        game.clear();
        for (const w of guess) game.toggle(String(w));
        game.submit();
      }
    }
    // 5. Server-measured duration drives the speed component of the score.
    game.durationMs = Math.min(DURATION_CAP, Math.max(1000, age));

    // 6. Authorize the room. Guild ids aren't secret, so write a guild board only
    //    after confirming this user belongs to that guild. A DM/group channel id is
    //    known only to its participants, so it needs no check; the g:/c: prefix
    //    keeps the two namespaces apart.
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    if (guildId) {
      const guilds = await fetchUserGuildIds(body.accessToken);
      if (!guilds || !guilds.includes(guildId)) {
        res.status(403).json({ ok: false, reason: 'not-a-member' });
        return;
      }
    }
    const scopeId = canonicalScope(guildId, channelId);

    // Remember the channel this room last played in, so the daily recap cron knows
    // where to post (mirrors the Wordle activity's daily summary). channelId is the
    // post target even for a g: scope, where it isn't recoverable from scopeId.
    // Strictly best-effort: a hiccup here must never fail a legitimate score.
    if (scopeId && channelId) {
      try {
        await db.from('recap_channels').upsert(
          { scope_id: scopeId, channel_id: channelId, guild_id: guildId, updated_at: new Date().toISOString() },
          { onConflict: 'scope_id' },
        );
      } catch {
        /* recap channel is a convenience; never block scoring on it */
      }
    }

    await db.from('scores').upsert(
      {
        puzzle_id: puzzle.id,
        puzzle_date: puzzle.date,
        scope_id: scopeId,
        user_id: user.id,
        name: user.name,
        avatar: user.avatar ?? null,
        score: game.score,
        mistakes: MAX_MISTAKES - game.mistakesLeft,
        // groups deduced (0-4); drives the weekly strip's per-day segments,
        // a loss keeps however many the player cracked
        groups_solved: game.groupsSolved,
        solved: game.status === 'won',
        duration_ms: game.durationMs,
      },
      // first finish wins; a reload of today's puzzle can't overwrite it
      { onConflict: 'puzzle_id,user_id', ignoreDuplicates: true },
    );
    res.status(200).json({ ok: true, score: game.score, solved: game.status === 'won' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
