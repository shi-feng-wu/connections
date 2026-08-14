import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { fetchDiscordUser } from './_discord.js';
import { isValidDate, todayET } from './_puzzles.js';
import { fetchOwnScore, fetchStreak, mistakesOf, replayFinished } from './_share.js';
import { renderShareCard } from './_sharecard.js';

// Hand the caller their daily result card back as RAW PNG BYTES. This is /api/share-link's
// sibling for the "Copy image" path: the same card, minus Discord. The client puts the bytes
// straight on the clipboard, so the player can paste the card into a chat that isn't Discord —
// a DM on another app, a group thread, a tweet — which is exactly the traffic a quick link
// can't reach.
//
// THE GRID IS NEVER TAKEN FROM THE REQUEST. Identity comes from the Discord token (/users/@me,
// the api/score.ts idiom) and the result is replayed from that user's own append-only
// `progress` record, so a caller can only ever render a card of a game they actually played,
// with the result they actually got.
//
// No mint, no quota, no share_links cache. Those exist in share-link.ts because minting spends
// a Discord write and hands out a durable, publicly-resolvable URL. This route only renders —
// nothing leaves the request, nothing is written, and re-rendering costs the same as any other
// image response — so the abuse guard would only get in a re-copy's way.

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.body ?? {};
    const date = typeof body.date === 'string' && body.date ? body.date : todayET();
    if (!isValidDate(date)) {
      res.status(400).json({ error: 'bad date' });
      return;
    }

    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
    const user = await fetchDiscordUser(accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const db = admin();
    if (!db) {
      res.status(503).json({ ok: false, reason: 'unavailable' });
      return;
    }

    // The caller's own finished game, replayed from the append-only record. A refusal answers
    // in share-link's shape, so the client can branch on one contract for both share paths.
    const replay = await replayFinished(db, user.id, date);
    if (!replay.ok) {
      res.status(200).json({ ok: false, reason: replay.reason });
      return;
    }
    const { puzzle, game } = replay;

    // The card restages the end screen, so it needs the two numbers the end screen shows that
    // a replay alone can't produce: the scored points and the solve time. Both are read from
    // the player's own scores row, and both are best-effort — the card drops whichever is
    // missing instead of rendering a placeholder.
    const [{ score, durationMs }, streak] = await Promise.all([
      fetchOwnScore(db, user.id, date),
      fetchStreak(db, user.id),
    ]);
    const png = await renderShareCard({
      puzzleNo: puzzle.id,
      puzzleDate: date,
      grid: game.history,
      solved: game.status === 'won',
      mistakes: mistakesOf(game),
      streak,
      score,
      durationMs,
    });

    // Bytes, not a data URI: the clipboard wants an image/png Blob, and base64 would inflate
    // the response by a third for nothing. Content-Type is set BEFORE send() — Vercel's helper
    // only defaults a Buffer to application/octet-stream when the header is still unset.
    res.setHeader('Content-Type', 'image/png');
    res.status(200).send(png);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
