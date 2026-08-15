import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { fetchDiscordUser } from './_discord.js';
import { isValidDate, todayET } from './_puzzles.js';
import { replayFinished, sharePngUrl } from './_share.js';

// "What is MY permanent link?" — the authed half of the permanent-card pair. Answers with
// https://disconnections.app/i/<token>.png, which /api/share-png re-renders forever (see
// _share.ts for why the token needs no table behind it).
//
// This is the end screen's "Copy link" row. It exists because the clipboard is not one thing:
// Discord's desktop shell denies IMAGE clipboard writes (so "Copy image" is dark there) but not
// text ones, and a url is text — so this row is the desktop app's way to get a picture of the
// result into any chat, and everyone else's way to share one that outlives Discord's signed
// links.
//
// NOTHING IS RENDERED HERE. A token is an HMAC over two short strings, so this route is a DB
// read and some string work — cheap enough that the end screen can call it on a tap without a
// pending state. The picture is paid for by whoever opens the url, at most once per edge.
//
// Same gate order as its siblings (share-image / share-moment), and the same refusal shape, so
// the client branches on one contract for every share path. The grid is never taken from the
// request: identity comes from the Discord token and the result is replayed from that user's
// own append-only record, so nobody can mint a link to a game they didn't play.

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
    // No signing key means the url we'd hand out couldn't be verified by /api/share-png — a
    // dead link is worse than an honest refusal, and the client drops the row's confirmation
    // rather than showing one.
    if (!db || !process.env.INTERNAL_SECRET) {
      res.status(503).json({ ok: false, reason: 'unavailable' });
      return;
    }

    // The caller's own finished game. We only need to know THAT it's finished — the card itself
    // is drawn later, by /api/share-png, from this same record — but handing out a url for a
    // game in progress would mint a link that 404s.
    const replay = await replayFinished(db, user.id, date);
    if (!replay.ok) {
      res.status(200).json({ ok: false, reason: replay.reason });
      return;
    }

    res.status(200).json({ ok: true, url: sharePngUrl(user.id, date) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
