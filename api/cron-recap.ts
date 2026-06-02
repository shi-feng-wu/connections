import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { fetchPuzzle, yesterdayET } from './_nyt.js';
import { buildRecap, type DayRow, type SeasonRow } from './_recap.js';

// Daily recap cron. Fires after the midnight-ET Connections reset (see the
// vercel.json schedule) and posts yesterday's results + season standings, with a
// Play button, to each room's recap channel. Mirrors the Wordle activity's daily
// summary.
//
// Posting goes through the per-room incoming webhook an admin set up via the
// webhook.incoming OAuth flow (/api/install -> /api/discord-callback), so there is
// no bot in the guild: we just POST to the stored webhook URL. A room with no
// webhook_url (never ran setup) gets nothing.
//
// Only rooms that (a) have a recap webhook and (b) had at least one finisher
// yesterday get a post, so dead servers stay quiet. A per-(scope, date) ledger row
// is claimed before posting, so a retried or doubled cron run can't repost.
//
// Recaps are guild-only: incoming webhooks live on guild channels, so c: scopes are
// skipped. Vercel injects `Authorization: Bearer $CRON_SECRET` on cron calls; we
// fail closed without it so the route can't be triggered by anyone else.

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

  const date = yesterdayET();
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)

  // Rooms that had a finisher yesterday (only g: scopes — webhooks live on guild
  // channels, so c: scopes can't have one).
  const { data: scoredRows } = await db.from('scores').select('scope_id').eq('puzzle_date', date);
  const playedScopes = [
    ...new Set(((scoredRows ?? []) as ScopeRow[]).map((r) => r.scope_id).filter((s): s is string => !!s)),
  ].filter((s) => s.startsWith('g:'));

  if (playedScopes.length === 0) {
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0 });
    return;
  }

  // Their recap webhooks (rooms that ran the install flow). A row without a
  // webhook_url predates webhook setup and has nowhere to post.
  const { data: chanRows } = await db
    .from('recap_channels')
    .select('scope_id, webhook_url')
    .in('scope_id', playedScopes);
  const webhookByScope = new Map<string, string>(
    ((chanRows ?? []) as { scope_id: string; webhook_url: string | null }[])
      .filter((r) => !!r.webhook_url)
      .map((r) => [r.scope_id, r.webhook_url as string]),
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
    const webhookUrl = webhookByScope.get(scope);
    if (!webhookUrl) {
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

      // Execute the incoming webhook. No auth header — the token is in the URL.
      // with_components=true ensures the Play button renders on the message.
      const r = await fetch(`${webhookUrl}?with_components=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (r.ok) {
        posted++;
      } else if (r.status === 404 || r.status === 401) {
        // Webhook deleted (404) or its token revoked (401): it can never post again.
        // Forget it so future days skip cleanly; keep the claim so today doesn't
        // retry. The room must re-run setup to re-enable recaps.
        failed++;
        await db
          .from('recap_channels')
          .update({ webhook_url: null, webhook_id: null })
          .eq('scope_id', scope);
      } else if (r.status === 429 || r.status >= 500) {
        // Transient (rate limit / Discord outage): release the slot so the next
        // daily run retries.
        failed++;
        await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
      } else {
        // Other 4xx (e.g. a malformed payload): keep the slot so we don't loop on it.
        failed++;
      }
    } catch {
      failed++;
      await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date });
    }
  }

  res.status(200).json({ date, posted, skipped, failed });
}
