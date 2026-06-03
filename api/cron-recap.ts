import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { renderRecap } from './_card.js';
import { sendCard } from './_livecard.js';
import { fetchPuzzle, yesterdayET } from './_nyt.js';
import { type DayRow, recapPayload, recapText, type SeasonRow, toRecapData } from './_recap.js';

// Daily recap cron. Fires after the midnight-ET Connections reset (see the
// vercel.json schedule) and posts yesterday's results + season standings, with a
// Play button, to each room's recap channel. Mirrors the Wordle activity's daily
// summary.
//
// Posting goes through the app's bot user (added when an admin chooses "Add to
// Server"), which POSTs the recap to the room's last-played channel — the breadcrumb
// /api/score stores on recap_channels.channel_id. Needs DISCORD_BOT_TOKEN and the
// bot's Send Messages / Attach Files permission in that channel. A room with no
// recorded channel (nobody finished there yet) gets nothing.
//
// Only rooms that (a) have a recap channel and (b) had at least one finisher
// yesterday get a post, so dead servers stay quiet. A per-(scope, date) ledger row
// is claimed before posting, so a retried or doubled cron run can't repost.
//
// Recaps are guild-only (c: scopes are skipped). Vercel injects `Authorization:
// Bearer $CRON_SECRET` on cron calls; we fail closed without it so the route can't be
// triggered by anyone else.

const SEASON_LIMIT = 5;

type ScopeRow = { scope_id: string | null };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  // Cron auth: Vercel sends the bearer; reject everything else.
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = admin();
  if (!db) {
    res.status(503).json({ error: 'leaderboard unavailable' });
    return;
  }

  const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
  if (!botToken) {
    res.status(503).json({ error: 'bot token unconfigured' });
    return;
  }

  const date = yesterdayET();
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)

  // Rooms that had a finisher yesterday (only g: scopes — the recap bot posts in guild
  // channels, so c: DM/group scopes are skipped).
  const { data: scoredRows } = await db.from('scores').select('scope_id').eq('puzzle_date', date);
  const playedScopes = [
    ...new Set(((scoredRows ?? []) as ScopeRow[]).map((r) => r.scope_id).filter((s): s is string => !!s)),
  ].filter((s) => s.startsWith('g:'));

  if (playedScopes.length === 0) {
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0 });
    return;
  }

  // The channel each room last played in (the bot posts the recap there). A row with
  // no channel_id means nobody has finished a game in that room yet.
  const { data: chanRows } = await db
    .from('recap_channels')
    .select('scope_id, channel_id')
    .in('scope_id', playedScopes);
  const channelByScope = new Map<string, string>(
    ((chanRows ?? []) as { scope_id: string; channel_id: string | null }[])
      .filter((r) => !!r.channel_id)
      .map((r) => [r.scope_id, r.channel_id as string]),
  );

  // Puzzle number for the embed title (best-effort; NYT fetch may fail).
  let puzzleNo: number | undefined;
  try {
    puzzleNo = (await fetchPuzzle(date)).id;
  } catch {
    /* title falls back to the date alone */
  }

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const scope of playedScopes) {
    const channelId = channelByScope.get(scope);
    if (!channelId) {
      skipped++;
      continue;
    }

    // Claim the (scope, date) slot before posting; a unique violation means a
    // prior run already handled it.
    const claim = await db.from('recap_posts').insert({ scope_id: scope, puzzle_date: date });
    if (claim.error) {
      if (claim.error.code === '23505') skipped++;
      else failed++;
      continue;
    }

    try {
      const [{ data: results }, { data: season }, { data: stats }] = await Promise.all([
        db.rpc('day_results', { p_scope: scope, p_date: date }),
        db.rpc('room_board', { p_scope: scope, p_since: since, p_limit: SEASON_LIMIT }),
        db.rpc('room_recap_stats', { p_scope: scope, p_since: since, p_date: date }),
      ]);
      const stat = ((stats ?? []) as { streak: number; win_pct: number; max_streak: number }[])[0];
      const dayRows = (results ?? []) as DayRow[];
      // Wordle-style text body (streak headline + @mentioned finishers) above the PNG.
      const text = recapText({ streak: stat?.streak ?? null, longest: stat?.max_streak ?? null, results: dayRows });
      const png = await renderRecap(
        toRecapData({
          puzzleDate: date,
          puzzleNo,
          results: dayRows,
          season: (season ?? []) as SeasonRow[],
          streak: stat?.streak ?? null,
          winRate: stat?.win_pct ?? null,
        }),
      );

      // Post as the bot (multipart with the recap PNG) to the room's channel — the same
      // multipart path as the live "who's playing" card (api/_livecard.ts). The bot token
      // authorizes it; app-owned messages render the Play button without with_components.
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const r = await sendCard(url, recapPayload(text), png, 'POST', 'recap.png', {
        Authorization: `Bot ${botToken}`,
      });
      if (r.ok) {
        posted++;
      } else if (r.status === 429 || r.status >= 500) {
        // Transient (rate limit / Discord outage): release the slot so the next
        // daily run retries.
        failed++;
        await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
      } else {
        // Permanent for today (e.g. 403 the bot can't post there, 404 channel gone, or a
        // malformed payload): keep the claim so we don't loop. channel_id stays — it's the
        // breadcrumb /api/score maintains, and a later game may move it to a usable channel.
        failed++;
      }
    } catch {
      failed++;
      await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
    }
  }

  res.status(200).json({ date, posted, skipped, failed });
}
