import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { fetchPuzzle, yesterdayET } from './_nyt.js';
import { buildRecap, type DayRow, type SeasonRow } from './_recap.js';

// Daily recap cron. Fires after the midnight-ET Connections reset (see the
// vercel.json schedule) and posts yesterday's results + season standings, with a
// Play button, to the channel each room last played in. Mirrors the Wordle
// activity's daily summary.
//
// Only rooms that (a) recorded a recap channel and (b) had at least one finisher
// yesterday get a post, so dead servers stay quiet. A per-(scope, date) ledger
// row is claimed before posting, so a retried or doubled cron run can't repost.
//
// Recaps are guild-only in practice: a bot can't post to a group DM, so c: scopes
// are skipped. Vercel injects `Authorization: Bearer $CRON_SECRET` on cron calls;
// we fail closed without it so the route can't be triggered by anyone else.

const DISCORD_API = 'https://discord.com/api/v10';
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

  const token = process.env.DISCORD_BOT_TOKEN ?? '';
  if (!token) {
    res.status(503).json({ error: 'bot not configured' });
    return;
  }
  const db = admin();
  if (!db) {
    res.status(503).json({ error: 'leaderboard unavailable' });
    return;
  }

  const date = yesterdayET();
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)

  // Rooms that had a finisher yesterday (skip c: scopes a bot can't post to).
  const { data: scoredRows } = await db.from('scores').select('scope_id').eq('puzzle_date', date);
  const playedScopes = [
    ...new Set(((scoredRows ?? []) as ScopeRow[]).map((r) => r.scope_id).filter((s): s is string => !!s)),
  ].filter((s) => s.startsWith('g:'));

  if (playedScopes.length === 0) {
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0 });
    return;
  }

  // Their recap channels.
  const { data: chanRows } = await db
    .from('recap_channels')
    .select('scope_id, channel_id')
    .in('scope_id', playedScopes);
  const channelByScope = new Map<string, string>(
    ((chanRows ?? []) as { scope_id: string; channel_id: string }[]).map((r) => [r.scope_id, r.channel_id]),
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
      const [{ data: results }, { data: season }] = await Promise.all([
        db.rpc('day_results', { p_scope: scope, p_date: date }),
        db.rpc('room_board', { p_scope: scope, p_since: since, p_limit: SEASON_LIMIT }),
      ]);
      const message = buildRecap({
        puzzleDate: date,
        puzzleNo,
        results: (results ?? []) as DayRow[],
        season: (season ?? []) as SeasonRow[],
      });

      const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (r.ok) {
        posted++;
      } else {
        failed++;
        // Transient (rate limit / Discord error): release the slot so the next
        // daily run retries. A 403 (missing perms) is permanent — keep the slot
        // so we never hammer a channel we can't post to.
        if (r.status === 429 || r.status >= 500) {
          await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
        }
      }
    } catch {
      failed++;
      await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
    }
  }

  res.status(200).json({ date, posted, skipped, failed });
}
