import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { renderRecap } from './_card.js';
import { fetchChannelName, fetchGuildName } from './_discord.js';
import { sendCard } from './_livecard.js';
import { fetchPuzzle, todayET, yesterdayET } from './_nyt.js';
import { type DayRow, recapPayload, recapText, type SeasonRow, toRecapData } from './_recap.js';

// Daily recap cron. Posts yesterday's results + season standings, with a Play button, to
// every CHANNEL that has ever had play (recap_channels) — one card per (guild, channel),
// every day. On a day no one solved — no plays, no finishes, or all losses alike — it still
// posts a "nobody got it… new day" card; mirrors the Wordle activity's daily per-channel beat.
//
// Triggered by Supabase pg_cron (supabase/recap-cron.sql), which POSTs this endpoint on
// the exact minute — Vercel Hobby crons only fire "within the hour", so the schedule lives
// in Supabase instead. pg_cron runs in UTC and doesn't follow DST, but midnight ET is 04:00
// UTC in summer (EDT) / 05:00 UTC in winter (EST), so two jobs fire at 04:00 and 05:00 UTC —
// one always lands at/after the true reset year-round. The off-season run is a no-op: the
// recap_posts ledger claim below blocks a double-post and the puzzle warm is cache-backed.
//
// Posting goes through the app's bot user (added when an admin chooses "Add to Server"),
// which POSTs the recap to each channel from recap_channels (every (guild, channel) with any
// historical score). Channels are posted in parallel with a small concurrency cap (CONCURRENCY
// below) — one canvas render + Discord upload per channel, across hundreds of channels, would
// blow the function budget run serially. Needs DISCORD_BOT_TOKEN and the bot's Send Messages /
// Attach Files permission in that channel. maxDuration is bumped in vercel.json for headroom.
//
// A channel the bot was removed from (or a deleted channel) just 403s/404s at post time and
// is skipped for that day. A per-(scope, date, channel) ledger row is claimed before posting,
// so a retried or doubled cron run can't repost — and any partial run (kill, 429) is safe:
// whatever stays unclaimed is picked up by the 05:00 twin run or tomorrow.
//
// Recaps are guild-only (c: scopes are skipped). The pg_cron job sends `Authorization:
// Bearer $CRON_SECRET` (the secret lives in Supabase Vault); we fail closed without it so
// the route can't be triggered by anyone else.

const SEASON_LIMIT = 5;
// How many channels to post concurrently. High enough to clear hundreds inside the function
// budget (~tens of seconds), low enough to stay under Discord's ~50 req/s global limit and
// keep memory modest (one in-flight canvas render per slot). See the note above postOne.
const CONCURRENCY = 8;

type ScopeRow = { scope_id: string | null; channel_id: string | null };
type Outcome = 'posted' | 'skipped' | 'failed';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  // Cron auth: Vercel sends the bearer; reject everything else.
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Warm today's puzzle into the shared store before anything else, so the first player of
  // the new day never waits on NYT. Best-effort and independent of the recap: a NYT blip
  // here can't affect posting (and vice versa), and it runs even when there's nothing to
  // recap. Runs after this cron's reset, by which point today's puzzle is published.
  await fetchPuzzle(todayET()).catch(() => {});

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

  // Test override (secret-gated, same bearer): ?scope=g:..&channel=..[&date=YYYY-MM-DD][&force=1]
  // fires the recap for a SINGLE channel instead of every one — for eyeballing the card in a
  // test server without spamming every room. force=1 clears that channel's ledger row first so
  // it re-posts. With no params it's the normal cron (all channels, yesterday). See
  // scripts/test-recap.mjs.
  const q = req.query;
  const onlyScope = typeof q.scope === 'string' && q.scope ? q.scope : undefined;
  const onlyChannel = typeof q.channel === 'string' && q.channel ? q.channel : undefined;
  const force = q.force === '1';
  if (!!onlyScope !== !!onlyChannel) {
    res.status(400).json({ error: 'scope and channel must be provided together' });
    return;
  }

  const date = typeof q.date === 'string' && q.date ? q.date : yesterdayET();
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)

  // Day before yesterday, for the "was a streak broken?" check below (noon-UTC anchor so the
  // -1 day can't trip a DST boundary).
  const dayBefore = (() => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // Every (guild, channel) that has EVER had play, from recap_channels() — not just
  // yesterday's finishers — so a channel with an established habit still gets a card on a day
  // no one solved ("nobody got it… new day"). Only g: scopes (the bot posts in guild
  // channels); a channel the bot was since removed from just 403s at post time and is skipped.
  const { data: chanRows } = await db.rpc('recap_channels'); // every channel that ever played
  const allPairs = [
    ...new Map(
      ((chanRows ?? []) as ScopeRow[])
        .filter((r) => r.scope_id?.startsWith('g:') && !!r.channel_id)
        .map((r) => [
          `${r.scope_id} ${r.channel_id}`,
          { scope: r.scope_id as string, channel: r.channel_id as string },
        ]),
    ).values(),
  ];
  // Single-channel test override, else every channel that has ever played.
  const pairs = onlyScope && onlyChannel ? [{ scope: onlyScope, channel: onlyChannel }] : allPairs;

  if (pairs.length === 0) {
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0 });
    return;
  }

  // Puzzle number for the embed title (best-effort; NYT fetch may fail).
  let puzzleNo: number | undefined;
  try {
    puzzleNo = (await fetchPuzzle(date)).id;
  } catch {
    /* title falls back to the date alone */
  }

  // One channel's recap, end to end: claim the ledger slot, build the card, post it, and
  // report the outcome. Self-contained so the pool below can run many at once. A transient
  // failure (429 / 5xx / thrown) releases the ledger claim so a later run retries; a permanent
  // failure (403 can't post, 404 gone, malformed) keeps the claim so we don't loop on it.
  const postOne = async ({ scope, channel }: { scope: string; channel: string }): Promise<Outcome> => {
    // Test re-runs (force): clear any prior claim for this (scope, date, channel) so it re-posts.
    if (force) await db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date, channel_id: channel });
    // Claim the (scope, date, channel) slot before posting; a unique violation means a prior
    // run already handled this channel.
    const claim = await db.from('recap_posts').insert({ scope_id: scope, puzzle_date: date, channel_id: channel });
    if (claim.error) return claim.error.code === '23505' ? 'skipped' : 'failed';

    const release = () =>
      db.from('recap_posts').delete().match({ scope_id: scope, puzzle_date: date, channel_id: channel });

    try {
      const guildId = scope.startsWith('g:') ? scope.slice(2) : '';
      const [{ data: results }, { data: season }, { data: stats }, guildName, channelName] = await Promise.all([
        db.rpc('day_results', { p_scope: scope, p_date: date, p_channel: channel }),
        db.rpc('room_board', { p_scope: scope, p_since: since, p_limit: SEASON_LIMIT, p_channel: channel }),
        db.rpc('room_recap_stats', { p_scope: scope, p_since: since, p_date: date, p_channel: channel }),
        // Room identity for the card eyebrow; best-effort (null → static "DAILY RECAP").
        fetchGuildName(guildId, botToken),
        fetchChannelName(channel, botToken),
      ]);
      const stat = ((stats ?? []) as { streak: number; win_pct: number; max_streak: number }[])[0];
      const dayRows = (results ?? []) as DayRow[];
      const solvedYesterday = dayRows.some((r) => r.solved);

      // "Streak broken!" only when an active solve streak actually ended yesterday. The streak
      // the room carried INTO yesterday is its value as of the day before — room_recap_stats
      // measures up to the last day with data, so on an all-loss or no-play day, reading
      // yesterday can't reveal the prior run; query the day before explicitly (only when needed).
      let brokenStreak = 0;
      if (!solvedYesterday) {
        const { data: prior } = await db.rpc('room_recap_stats', {
          p_scope: scope, p_since: since, p_date: dayBefore, p_channel: channel,
        });
        brokenStreak = ((prior ?? []) as { streak: number }[])[0]?.streak ?? 0;
      }
      // No solver yesterday (no plays, no finishes, or all losses alike) → the streak is 0 as
      // of yesterday; force it so the card's stat agrees with the message. A solve keeps the
      // function's value.
      const displayStreak = solvedYesterday ? stat?.streak ?? null : 0;

      // Message body: the streak headline on a solve day, else the "nobody got it… new day"
      // beat (with "Streak broken!" when one actually ended).
      const text = recapText({
        streak: stat?.streak ?? null,
        solved: solvedYesterday,
        played: dayRows.length > 0, // finishers? "stumped everyone" vs "nobody played"
        brokenStreak,
        puzzleNo,
      });
      const png = await renderRecap(
        toRecapData({
          puzzleDate: date,
          puzzleNo,
          results: dayRows,
          season: (season ?? []) as SeasonRow[],
          streak: displayStreak,
          longest: stat?.max_streak ?? null,
          winRate: stat?.win_pct ?? null,
          guildName,
          channelName,
        }),
      );

      // Post as the bot (multipart with the recap PNG) to the room's channel — the same
      // multipart path as the live "who's playing" card (api/_livecard.ts). The bot token
      // authorizes it; app-owned messages render the Play button without with_components.
      const url = `https://discord.com/api/v10/channels/${channel}/messages`;
      const r = await sendCard(url, recapPayload(text), png, 'POST', 'recap.png', {
        Authorization: `Bot ${botToken}`,
      });
      if (r.ok) return 'posted';
      // Transient (rate limit / Discord outage): release the slot so the next daily run
      // retries. Permanent (403/404/malformed): keep the claim so we don't loop.
      if (r.status === 429 || r.status >= 500) await release();
      return 'failed';
    } catch {
      await release();
      return 'failed';
    }
  };

  // Worker pool: CONCURRENCY slots each pull the next channel off a shared cursor until the
  // list is drained. `pairs[cursor++]` is atomic (no await between read and increment), so
  // each slot gets a distinct channel.
  const outcomes: Outcome[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, async () => {
      while (cursor < pairs.length) {
        outcomes.push(await postOne(pairs[cursor++]));
      }
    }),
  );

  const posted = outcomes.filter((o) => o === 'posted').length;
  const skipped = outcomes.filter((o) => o === 'skipped').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  res.status(200).json({ date, posted, skipped, failed });
}
