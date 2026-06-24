import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { renderRecap } from './_card.js';
import { fetchChannelName, fetchGuildName } from './_discord.js';
import { sendCard } from './_livecard.js';
import { fetchPuzzle, todayET, yesterdayET } from './_nyt.js';
import { type DayRow, recapPayload, recapText, type SeasonRow, toRecapData } from './_recap.js';
import { Game, type Puzzle } from '../src/game.js';
import { rankMap, rankDelta } from '../src/rank-delta.js';

// Daily recap cron. Posts yesterday's results + season standings, with a Play button, to
// every CHANNEL that has ever had play (recap_channels) AND sits in a guild the bot is actually
// in (fetchBotGuildIds) — one card per (guild, channel), every day. recap_channels alone also
// lists user-install servers (live card via interaction webhook, no bot), where a direct recap
// POST 403s, so the bot-guild filter drops them. On a day no one solved — no plays, no finishes,
// or all losses alike — it still posts a "nobody got it… new day" card; mirrors the Wordle bot.
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
// Attach Files permission in that channel. maxDuration is bumped to 300s in vercel.json so the
// midnight run clears every channel in one invocation (a 60s cap was killing it mid-run once the
// channel count outgrew what 60s could post, spilling the remainder to the 05:00 twin at 1am ET).
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
// How many channels to post concurrently. High enough to clear the full channel set (now many
// hundreds) well inside the 300s budget below — at ~1.2s per channel this drains ~600 channels
// in ~60s — low enough to stay under Discord's ~50 req/s global limit (≈3 calls/channel × 10
// channels/s ≈ 30 req/s here) and keep memory modest (one in-flight canvas render per slot).
// See the note above postOne. The real ceiling is maxDuration in vercel.json, raised to 300s so
// the midnight run finishes every channel rather than spilling the overflow to the 05:00 twin.
const CONCURRENCY = 12;

type ScopeRow = { scope_id: string | null; channel_id: string | null };
type Outcome = 'posted' | 'skipped' | 'failed';

// The guilds the bot is actually a member of. The recap posts as the bot (a direct channel
// message), so it can only reach guilds where the bot is installed. recap_channels is sourced
// from live_cards, which ALSO exist in user-install servers (there the live card posts via an
// interaction webhook — no bot needed), so without this the cron 403s on ~every bot-less channel
// nightly. Paginated (200/page) in case the bot grows past one page. Returns null on failure so
// the caller fails OPEN (attempt all) rather than suppressing every recap on a Discord blip.
async function fetchBotGuildIds(botToken: string): Promise<Set<string> | null> {
  try {
    const ids = new Set<string>();
    let after = '';
    for (;;) {
      const url = `https://discord.com/api/v10/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`;
      const r = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
      if (!r.ok) return null;
      const page = (await r.json()) as { id: string }[];
      if (!Array.isArray(page) || page.length === 0) break;
      for (const g of page) ids.add(g.id);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
    return ids;
  } catch {
    return null;
  }
}

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
  // Keep only channels in guilds the bot actually belongs to — the rest are user-install servers
  // (live card via interaction webhook, no bot) where a direct recap POST just 403s. Fail open if
  // the guild list can't be fetched (attempt all; the ledger still de-dupes). The single-channel
  // test override bypasses this so a specific channel can always be fired.
  let scoped = allPairs;
  if (!onlyScope) {
    const botGuilds = await fetchBotGuildIds(botToken);
    if (botGuilds) {
      const before = scoped.length;
      scoped = scoped.filter((p) => botGuilds.has(p.scope.slice(2)));
      console.log(`[recap] bot in ${botGuilds.size} guilds; targeting ${scoped.length} of ${before} channels`);
    } else {
      console.warn('[recap] could not fetch bot guild list; attempting all channels');
    }
  }
  // Single-channel test override, else every bot-present channel that has ever played.
  const pairs = onlyScope && onlyChannel ? [{ scope: onlyScope, channel: onlyChannel }] : scoped;

  if (pairs.length === 0) {
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0 });
    return;
  }

  // Yesterday's puzzle: its number for the title, and the full puzzle to replay each finisher's
  // guesses into a solve order for the mini-board (best-effort; NYT fetch may fail → title falls
  // back to the date, mini-boards fall back to the count). Cached, so this is one fetch.
  let puzzleNo: number | undefined;
  let puzzle: Puzzle | null = null;
  try {
    puzzle = await fetchPuzzle(date);
    puzzleNo = puzzle.id;
  } catch {
    /* title falls back to the date alone; mini-boards to the count */
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
      const [{ data: results }, { data: season }, { data: prevSeason }, { data: stats }, guildName, channelName] = await Promise.all([
        db.rpc('day_results', { p_scope: scope, p_date: date, p_channel: channel }),
        // Standings AS OF the recapped day (p_until: date) — so today's early plays can't skew
        // them and a backfilled/test recap for an old date shows that day's board, not today's.
        db.rpc('room_board', { p_scope: scope, p_since: since, p_limit: SEASON_LIMIT, p_channel: channel, p_until: date }),
        // The same board one day earlier, unlimited, so the rank-change arrows can find where a
        // current top-5 player ranked before yesterday's puzzle (delta = movement it caused).
        db.rpc('room_board', { p_scope: scope, p_since: since, p_limit: 1000, p_channel: channel, p_until: dayBefore }),
        db.rpc('room_recap_stats', { p_scope: scope, p_since: since, p_date: date, p_channel: channel }),
        // Room identity for the card eyebrow; best-effort (null → static "DAILY RECAP").
        fetchGuildName(guildId, botToken),
        fetchChannelName(channel, botToken),
      ]);
      const stat = ((stats ?? []) as { streak: number; win_pct: number; max_streak: number }[])[0];
      const dayRows = (results ?? []) as DayRow[];
      const solvedYesterday = dayRows.some((r) => r.solved);

      // Season-standings rank movement caused by yesterday's puzzle: diff the current board's
      // order (rank = row index) against the same board "as of the day before". Reuses the
      // leaderboard's pure delta math so the arrows mean the same thing on both. A player not
      // on the board the day before (brand-new) gets null → no arrow (see rankDelta).
      const prevRanks = rankMap((prevSeason ?? []) as SeasonRow[]);
      const seasonRows = ((season ?? []) as SeasonRow[]).map((r, i) => ({
        ...r,
        delta: rankDelta(prevRanks, r.user_id, i + 1),
      }));

      // Mini-board solve ORDER: the recap reads counts from scores, so mirror the live card /
      // roster and replay each finisher's committed guesses against yesterday's puzzle. One
      // daily progress row per user (any scope), so query by (user_id, date). A finisher whose
      // progress is gone just falls back to the count (easiest-first) — see drawMiniBars.
      if (puzzle && dayRows.length) {
        const { data: prog } = await db
          .from('progress')
          .select('user_id, guesses')
          .in('user_id', dayRows.map((r) => r.user_id))
          .eq('puzzle_date', date);
        const levelsById = new Map<string, number[]>();
        for (const row of (prog ?? []) as { user_id: string; guesses: unknown }[]) {
          const guesses = Array.isArray(row.guesses) ? (row.guesses as string[][]) : [];
          levelsById.set(row.user_id, Game.fromGuesses(puzzle, guesses).deducedLevels);
        }
        for (const r of dayRows) r.solvedLevels = levelsById.get(r.user_id);
      }

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
          season: seasonRows,
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
