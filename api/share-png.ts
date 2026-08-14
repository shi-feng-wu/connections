import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import {
  fetchOwnScore,
  fetchStreak,
  mistakesOf,
  parseSharePngToken,
  replayFinished,
} from './_share.js';
import { renderShareCard } from './_sharecard.js';

// THE PERMANENT SHARE CARD. Serves https://disconnections.app/i/<token>.png (see the rewrite in
// vercel.json) — a player's daily result card, re-rendered from their own record on every hit.
//
// Why we host it instead of pointing at Discord. Both of the other picture routes hand back a
// Discord url: /api/share-link's quick-link image and /api/share-moment's attachment. Those are
// SIGNED CDN links with an expiry on them, which is fine inside the chat they were posted to and
// useless everywhere a link is supposed to last — a forum post, a wiki, a group someone scrolls
// back through in a month. Nothing here expires, because nothing here is stored: the token names
// a (player, date) and the card is drawn fresh from the append-only `progress` record each time.
// A finished result is immutable, so the url and the picture it draws are stable forever.
//
// PUBLIC, BUT NOT ENUMERABLE. There is no auth on this route — a shared link has to open for
// people who have never launched the Activity. What stands in for auth is the token's HMAC (see
// _share.ts): you cannot mint a link to a result by knowing a Discord id and a date, and you
// cannot walk the archive by editing the date out of a link you were given.
//
// SPOILER-FREE BY CONSTRUCTION, like every other card: the render only ever gets the guess
// GRID (colours), the outcome, and the stats. No word, category, or group reaches the canvas,
// so a card posted mid-day spoils nothing for whoever sees it.

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // HEAD is allowed alongside GET: link unfurlers probe before they fetch, and a 405 there
  // would make a perfectly good url look broken in the preview.
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    // Credentials are checked BEFORE the token is parsed, even though a bad token is the
    // commoner failure: parseSharePngToken can't verify a signature without the signing key, so
    // on a deploy missing INTERNAL_SECRET it refuses EVERY token — and answering 404 there would
    // report a configuration outage as "this result doesn't exist", which is a lie that ages
    // into a permanently dead link.
    if (!process.env.INTERNAL_SECRET) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'unavailable' });
      return;
    }
    const db = admin();
    if (!db) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    // The rewrite passes the path segment through as ?token=. A repeated query param arrives as
    // an array; take the first rather than stringifying the lot into a guaranteed miss.
    const raw = req.query?.token;
    const parsed = parseSharePngToken(Array.isArray(raw) ? raw[0] : raw);
    if (!parsed) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ error: 'not found' });
      return;
    }

    // A permanent url for a result that doesn't exist is a 404, not a refusal: unlike the authed
    // share routes there's no client here to branch on {ok:false} — there's a browser, an <img>
    // tag, or an unfurler, and all three want the status code. Covers a deleted record and a
    // token minted for a game that was never finished.
    const replay = await replayFinished(db, parsed.userId, parsed.date);
    if (!replay.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { puzzle, game } = replay;

    // Cached hard at the edge. The RESULT is immutable, so the card is too — with one honest
    // exception: the streak line is whatever the player's streak was the first time an edge
    // rendered this url, and it keeps saying that afterwards. That's an accepted approximation.
    // The card is a snapshot of a finished game, the streak is decoration on it, and a shared
    // picture that quietly rewrote itself as the sharer kept playing would be the stranger
    // behaviour. max-age is an hour so a browser that already has it doesn't refetch on a
    // scroll-back, while s-maxage lets the CDN hold it for a year.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=31536000, immutable');
    // A HEAD has proved everything it can (the token verifies, the result exists) and gets the
    // headers without the canvas: unfurlers probe far more often than they fetch, and this is
    // the one route strangers can hit.
    if (head) {
      res.status(200).end();
      return;
    }

    // Same two numbers the end screen shows and a replay can't produce, read from the player's
    // own scores row. Best-effort — the card drops whichever is missing rather than inventing a
    // placeholder.
    const [{ score, durationMs }, streak] = await Promise.all([
      fetchOwnScore(db, parsed.userId, parsed.date),
      fetchStreak(db, parsed.userId),
    ]);
    const png = await renderShareCard({
      puzzleNo: puzzle.id,
      puzzleDate: parsed.date,
      grid: game.history,
      solved: game.status === 'won',
      mistakes: mistakesOf(game),
      streak,
      score,
      durationMs,
    });

    // Content-Type is set BEFORE send() — Vercel's helper only defaults a Buffer to
    // application/octet-stream when the header is still unset.
    res.status(200).send(png);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
