import type { VercelRequest, VercelResponse } from '@vercel/node';
import { COPY } from '../src/discord-copy.js';
import { fill } from '../src/copy-util.js';
import { admin } from './_admin.js';
import { fetchDiscordUser } from './_discord.js';
import { isValidDate, todayET } from './_puzzles.js';
import {
  countMintedToday,
  etMidnightIso,
  fetchStreak,
  loadCachedShareLink,
  MAX_SHARE_DATES_PER_DAY,
  messageFor,
  mintQuickLink,
  mistakesOf,
  quickLinkUrl,
  type Replay,
  replayFinished,
  saveShareLink,
  shareCustomId,
} from './_share.js';
import { renderShareCard } from './_sharecard.js';

// Mint the caller's daily result as a Discord QUICK LINK: a 30-day link that renders in chat
// as a rich embed (our 43:24 card image, a title, a description, and a "Play" button that
// opens the Activity). This is the one free compounding acquisition surface Discord gives an
// Activity, and it carries attribution for free — Discord stamps referrer_id and our custom_id
// onto the URL, and the recipient's client hands them back at boot (see /api/referral).
//
// THE GRID IS NEVER TAKEN FROM THE REQUEST. Identity comes from the Discord token (/users/@me,
// the api/score.ts idiom) and the result is replayed from that user's own append-only
// `progress` record, so a caller can only ever mint a card of a game they actually played,
// with the result they actually got. The same token authorizes the mint, so the sharer on the
// link and the owner of the replayed result are the same account by construction.
//
// The client follows up with discordSdk.commands.shareLink({message, link_id}), which opens
// Discord's native share modal. The constructed URL comes back too, for the clipboard fallback
// on hosts that can't open that modal.
//
// Gate order matters: CACHE BEFORE QUOTA, so a player who has hit the daily mint cap can still
// re-share a date they already minted.

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
    const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
    if (!appId) {
      res.status(503).json({ ok: false, reason: 'unavailable' });
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

    // 1. Already minted this date? Hand the same link back.
    const customId = shareCustomId(user.id, date);
    const cached = await loadCachedShareLink(db, user.id, date);
    if (cached) {
      // The card already exists; this replay only supplies the prefilled line, so a failure
      // drops the prefill (an empty share box) rather than the share.
      const replay = await replayFinished(db, user.id, date).catch(
        () => ({ ok: false, reason: 'no-progress' }) as Replay,
      );
      res.status(200).json({
        ok: true,
        link_id: cached.link_id,
        url: cached.url,
        message: replay.ok ? messageFor(replay.puzzle, replay.game) : '',
        cached: true,
      });
      return;
    }

    // 2. Quota, on NEW dates only.
    if ((await countMintedToday(db, user.id, etMidnightIso())) >= MAX_SHARE_DATES_PER_DAY) {
      res.status(429).json({ ok: false, reason: 'rate-limited' });
      return;
    }

    // 3. The caller's own finished game, replayed from the append-only record.
    const replay = await replayFinished(db, user.id, date);
    if (!replay.ok) {
      res.status(200).json({ ok: false, reason: replay.reason });
      return;
    }
    const { puzzle, game } = replay;

    const png = await renderShareCard({
      puzzleNo: puzzle.id,
      puzzleDate: date,
      grid: game.history,
      solved: game.status === 'won',
      mistakes: mistakesOf(game),
      streak: await fetchStreak(db, user.id),
    });

    const minted = await mintQuickLink(appId, accessToken, {
      title: fill(COPY['share-card.title'], { name: user.name, puzzle: puzzle.id }),
      description: COPY['share-card.description'],
      customId,
      png,
    });
    if (!minted.ok) {
      // Greppable: the whole loop dies here if Discord's contract moves. The body is Discord's
      // own error JSON — the only diagnosis available without a live token.
      console.error('[share-link] quick-link mint failed', minted.status, minted.body);
      res.status(502).json({ ok: false, reason: 'mint-failed' });
      return;
    }

    const url = quickLinkUrl(appId, user.id, customId, minted.linkId);
    // Cache write is best-effort and deliberately AFTER the mint: a share that can't be
    // remembered is still a share.
    await saveShareLink(db, { user_id: user.id, puzzle_date: date, link_id: minted.linkId, url });
    res.status(200).json({
      ok: true,
      link_id: minted.linkId,
      url,
      message: messageFor(puzzle, game),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
