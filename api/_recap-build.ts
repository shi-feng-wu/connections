import type { SupabaseClient } from '@supabase/supabase-js';
import { Game, type Puzzle } from '../src/game.js';
import { rankDelta, rankMap } from '../src/rank-delta.js';
import { renderRecap } from './_card.js';
import { fetchChannelName, fetchGuildName } from './_discord.js';
import { fetchPuzzle } from './_puzzles.js';
import { type DayRow, recapText, type SeasonRow, toRecapData } from './_recap.js';

// Builds ONE room's daily recap — the message text plus the rendered PNG — from the same RPCs the
// nightly cron has always used. Lifted verbatim out of api/cron-recap.ts's postOne so a SECOND
// caller can reuse it: api/post-card.ts piggybacks yesterday's recap onto the first launch of the
// day in a bot-less server (the bot isn't a member there, so it can never post one itself). The
// cron still owns the ledger + the bot-token POST; this is only the card assembly.
//
// WHY ITS OWN MODULE (and not api/_recap.ts, where the pure recap helpers live): _recap.ts is
// imported — statically — by api/_livecard.ts and api/interactions.ts, which puts it in the
// dependency graph of the two most latency-critical functions (the launch ACK and api/guess).
// Pulling ./_card.js (the @napi-rs/canvas native addon) in there would trace canvas into both
// deployments and blow the cold-start budget the launch ACK depends on. Only post-card and
// cron-recap import THIS file, and both already carry canvas. (The alternative — moving
// PLAY_CUSTOM_ID out of _recap.ts so it could hold canvas — is a three-file import shuffle for no
// gain.) Leading underscore keeps Vercel from treating it as a route.

// How many season-standings rows the recap card lists.
const SEASON_LIMIT = 5;

export type BuiltRecap = {
  // The message body posted above the PNG (recapText's streak headline / "nobody got it" beat).
  text: string;
  // The rendered recap card.
  png: Buffer;
};

export async function buildRecap(
  db: SupabaseClient,
  opts: {
    scope: string;
    channel: string;
    // The day being recapped (yesterday, for both callers).
    date: string;
    // Bot token for the room-identity lookups. Best-effort: in a bot-less guild these 403 and the
    // card falls back to the static "DAILY RECAP" eyebrow.
    botToken: string;
    // Yesterday's puzzle, when the caller already has it: the cron fetches it ONCE for the whole
    // batch and passes it (null included — a failed fetch must NOT be silently retried per channel,
    // which would change the cron's behaviour). Omit it entirely and we fetch it here (cached).
    puzzle?: Puzzle | null;
  },
): Promise<BuiltRecap> {
  const { scope, channel, date, botToken } = opts;
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)
  // Day before the recapped day, for the "was a streak broken?" check below (noon-UTC anchor so the
  // -1 day can't trip a DST boundary).
  const dayBefore = (() => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // The puzzle behind the recapped day: its number for the title, and the board itself to replay
  // each finisher's guesses into a solve order for the mini-board. Best-effort (NYT/store miss →
  // title falls back to the date, mini-boards fall back to the count).
  let puzzle: Puzzle | null;
  if (opts.puzzle !== undefined) {
    puzzle = opts.puzzle;
  } else {
    puzzle = await fetchPuzzle(date).catch(() => null);
  }
  const puzzleNo = puzzle?.id;

  const guildId = scope.startsWith('g:') ? scope.slice(2) : '';
  const [
    { data: results },
    { data: season },
    { data: prevSeason, error: prevSeasonErr },
    { data: stats },
    guildName,
    channelName,
  ] = await Promise.all([
    db.rpc('day_results', { p_scope: scope, p_date: date, p_channel: channel }),
    // Standings AS OF the recapped day (p_until: date) — so today's early plays can't skew
    // them and a backfilled/test recap for an old date shows that day's board, not today's.
    db.rpc('room_board', {
      p_scope: scope,
      p_since: since,
      p_limit: SEASON_LIMIT,
      p_channel: channel,
      p_until: date,
    }),
    // The same board one day earlier, unlimited, so the rank-change arrows can find where a
    // current top-5 player ranked before yesterday's puzzle (delta = movement it caused).
    db.rpc('room_board', {
      p_scope: scope,
      p_since: since,
      p_limit: 1000,
      p_channel: channel,
      p_until: dayBefore,
    }),
    db.rpc('room_recap_stats', {
      p_scope: scope,
      p_since: since,
      p_date: date,
      p_channel: channel,
    }),
    // Room identity for the card eyebrow; best-effort (null → static "DAILY RECAP").
    fetchGuildName(guildId, botToken),
    fetchChannelName(channel, botToken),
  ]);
  const stat = (
    (stats ?? []) as {
      streak: number;
      win_pct: number;
      max_streak: number;
    }[]
  )[0];
  const dayRows = (results ?? []) as DayRow[];
  const solvedYesterday = dayRows.some((r) => r.solved);

  // Season-standings rank movement caused by yesterday's puzzle: diff the current board's
  // order (rank = row index) against the same board "as of the day before". Reuses the
  // leaderboard's pure delta math so the arrows mean the same thing on both. A player not
  // on the board the day before (brand-new) gets "new" → an amber dash (see rankDelta).
  // A failed prev-board read leaves prevRanks empty → rankDelta's empty-baseline guard makes
  // every row null → the card posts with no movement indicators on any row (no dash sea),
  // silently. Log it so the cause is visible if it recurs.
  if (prevSeasonErr)
    console.warn(
      `[recap] prev-board RPC failed for ${scope}/${channel}; rank arrows suppressed: ${prevSeasonErr.message}`,
    );
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
      .in(
        'user_id',
        dayRows.map((r) => r.user_id),
      )
      .eq('puzzle_date', date);
    const levelsById = new Map<string, number[]>();
    for (const row of (prog ?? []) as {
      user_id: string;
      guesses: unknown;
    }[]) {
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
      p_scope: scope,
      p_since: since,
      p_date: dayBefore,
      p_channel: channel,
    });
    brokenStreak = ((prior ?? []) as { streak: number }[])[0]?.streak ?? 0;
  }
  // No solver yesterday (no plays, no finishes, or all losses alike) → the streak is 0 as
  // of yesterday; force it so the card's stat agrees with the message. A solve keeps the
  // function's value.
  const displayStreak = solvedYesterday ? (stat?.streak ?? null) : 0;

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
  return { text, png };
}
