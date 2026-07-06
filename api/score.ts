import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { fetchDiscordUser, fetchUserGuildIds } from './_discord.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { MAX_GUESSES, scoreRow, upsertScore } from './_scoring.js';
import { verifySession } from './_session.js';

// The only path a score reaches the leaderboard. The client is trusted only for
// the requested room (authorized, not just accepted) — not for the outcome. Identity
// comes from the Discord token via /users/@me (not the body); the guess list comes
// from the server's own append-only record (api/guess), NOT the request body, so
// leaving and retrying is pointless — only what was actually committed during play
// is scored. Duration comes from the pinned session start, score from the shared
// Game logic. A guild board is written only after confirming the user belongs to
// that guild (guild ids are public); the g:/c: prefix stops a guild id smuggled in
// via the channel slot. Writes use the service role, so the anon key can't touch
// the table.

// This is now the FALLBACK scoring path: the authoritative write happens server-side the
// moment the finishing guess commits (/api/guess + the /api/join room stamp — see
// api/_scoring.ts). This route stays for sessions that never got a stamp (a session opened
// before stamping existed, a failed stamp write) and for older cached client bundles; its
// upsert is first-finish-wins, so double-writing with the finish-time path is harmless.

// A full day. The daily-reset check (session.date !== todayET, below) is the real
// per-day boundary — anyone who hasn't finished by reset just stays incomplete — so
// this is only a hard ceiling that stops an ancient session from scoring.
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;

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

    // 4. Replay this player's committed guesses — the append-only record written by
    //    /api/guess as they actually played — for the outcome. The request body is
    //    NOT trusted for the guess list; that's what makes leaving-and-retrying
    //    pointless. No record means nothing legitimately started/finished to score.
    const puzzle = await fetchPuzzle(session.date);
    const { data: progress } = await db
      .from('progress')
      .select('guesses, hints')
      .eq('user_id', user.id)
      .eq('puzzle_date', session.date)
      .maybeSingle();
    const committed: unknown = progress?.guesses;
    if (!Array.isArray(committed)) {
      res.status(200).json({ ok: false, reason: 'no-progress' });
      return;
    }
    // Hints come from the same append-only record (api/hint), NOT the request body,
    // so the −hintPenalty per hint can't be dodged by posting a clean body.
    const game = Game.fromGuesses(puzzle, committed.slice(0, MAX_GUESSES), undefined, progress?.hints);
    // Only a finished game scores. A still-playing record means the client posted
    // early; bail rather than writing (and locking, via ignoreDuplicates) a 0.
    if (game.status === 'playing') {
      // Greppable: guesses commit in the background, so a finish can race its own final
      // guess write and land here (the missing-score/broken-streak class). The client now
      // flushes its commit chain first AND retries this verdict, so a burst of these that
      // never converts into a scores row is the signal that protection has regressed.
      console.warn('[score] not-finished replay', { user: user.id, date: session.date });
      res.status(200).json({ ok: false, reason: 'not-finished' });
      return;
    }
    // 5. Authorize the room. Guild ids aren't secret, so write a guild board only after
    //    confirming this user belongs to that guild — this matters because the server-view
    //    board derives its roster from scores.scope_id, so an unauthorized g: write would
    //    plant the player on a server they're not in. A DM/group channel id is known only to
    //    its participants, so it needs no check; the g:/c: prefix keeps the namespaces apart.
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const userGuilds = await fetchUserGuildIds(body.accessToken);
    if (guildId && (!userGuilds || !userGuilds.includes(guildId))) {
      res.status(403).json({ ok: false, reason: 'not-a-member' });
      return;
    }
    const scopeId = canonicalScope(guildId, channelId);
    // No room at all (no guild, no channel) → nothing this score could land on: every
    // board and roster derives from scope_id. Don't write an unreachable row.
    if (!scopeId) {
      res.status(200).json({ ok: false, reason: 'no-room' });
      return;
    }

    // 6. Same row construction as the finish-time path (api/_scoring.ts): first finish
    //    wins, a reload of today's puzzle can't overwrite it. Duration = now - the pinned
    //    session start (a relaunch can't shrink it); scoreRow clamps it.
    const inserted = await upsertScore(
      db,
      scoreRow(
        puzzle,
        game,
        { userId: user.id, name: user.name, avatar: user.avatar ?? null },
        { scopeId, channelId },
        age,
      ),
    );
    // Greppable: the fallback actually wrote the row — finish-time scoring missed this
    // finish. Expected while pre-stamp sessions drain after deploy; a steady rate beyond
    // that means the /api/join stamp or the /api/guess write path has regressed.
    if (inserted) console.log('[score] fallback write', { user: user.id, date: session.date });

    res.status(200).json({ ok: true, score: game.score, solved: game.status === 'won' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
