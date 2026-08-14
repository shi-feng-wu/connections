// Shapes the daily recap the bot posts on the Disconnections reset and turns the two
// RPC result sets (yesterday's finishers + the month's season standings) into the
// render model for the recap PNG. The drawing itself lives in src/card-draw.ts
// (shared with the browser preview); api/_card.ts wraps it into a Buffer and
// api/cron-recap.ts posts it — exactly like the "who's playing" card. Leading
// underscore keeps Vercel from treating this file as a route.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RecapData } from '../src/card-draw.js';
import type { Delta } from '../src/rank-delta.js';
import { COPY } from '../src/discord-copy.js';
import { fill } from '../src/copy-util.js';

// One finisher of yesterday's puzzle in this room (from the day_results RPC). The RPC
// also returns user_id + avatar (used for the row's roster avatar).
export type DayRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  score: number;
  mistakes: number;
  solved: boolean;
  groups_solved: number; // 0–4; count fallback for the per-row mini-board
  // Solved groups in solve order (a level 0–3 per bar), replayed from the finisher's guesses
  // by the recap cron (the RPC has only the count). Absent → the bars fall back to the count.
  solvedLevels?: number[];
  duration_ms: number | null;
};

// One season-standings row (from the room_board RPC; a subset of its columns). `delta` is
// the room's rank movement caused by yesterday's puzzle, computed by the recap cron (not an
// RPC column): positive = climbed, negative = slipped, "new" = brand-new entrant (amber dash),
// null/0 = no indicator.
export type SeasonRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  total: number;
  wins: number;
  plays: number;
  delta?: Delta;
};

const PLAY_CUSTOM_ID = 'connections_play';

const MON = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
// "2026-05-30" -> "May" (the standings window label).
function monthOf(date: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  return m ? MON[+m[2] - 1] : undefined;
}

// Map the two RPC result sets (plus the room's header stats) into the recap render
// model consumed by drawRecap. duration_ms -> seconds; user_id -> the avatar hash id.
export function toRecapData(opts: {
  puzzleDate: string;
  puzzleNo?: number;
  results: DayRow[];
  season: SeasonRow[];
  streak?: number | null;
  longest?: number | null;
  winRate?: number | null;
  guildName?: string | null;
  channelName?: string | null;
}): RecapData {
  return {
    puzzleNo: opts.puzzleNo,
    puzzleDate: opts.puzzleDate,
    season: monthOf(opts.puzzleDate),
    streak: opts.streak ?? null,
    longest: opts.longest ?? null,
    winRate: opts.winRate ?? null,
    guildName: opts.guildName ?? null,
    channelName: opts.channelName ?? null,
    results: opts.results.map((r) => ({
      id: r.user_id,
      name: r.name,
      avatar: r.avatar,
      solved: r.solved,
      score: r.score,
      mistakes: r.mistakes,
      // Exact solve order when the cron replayed it; else the count (a win is all four even if
      // an older row's count lagged), which the card fills easiest-first.
      solvedLevels: r.solvedLevels,
      groups: r.solved ? 4 : Math.max(0, Math.min(4, r.groups_solved ?? 0)),
      sec: r.duration_ms != null ? Math.round(r.duration_ms / 1000) : null,
    })),
    standings: opts.season.map((r) => ({
      id: r.user_id,
      name: r.name,
      avatar: r.avatar,
      total: r.total,
      wins: r.wins,
      plays: r.plays,
      delta: r.delta ?? null,
    })),
  };
}

// The text body posted above the recap PNG (the PNG carries the per-player results and the
// streak stats). One of five lines, by yesterday's outcome:
//   1. someone solved        → the streak headline, with one 🔥 per digit of the streak count.
//   2. broke streak + failed  → "**N-day streak broken!** Yesterday's … stumped everyone … 🌞"
//   3. broke streak + no play → "**N-day streak broken!** Nobody played yesterday's … 🌞"
//   4. no streak + failed     → same as 2 without the prefix.
//   5. no streak + no play    → same as 3 without the prefix.
// `played` separates "everyone failed" (finishers, none solved) from "nobody played" (none).
export function recapText(opts: {
  streak: number | null;
  // Did anyone solve yesterday? true → streak maintained; false → one of the "down" lines.
  solved?: boolean;
  // Were there any finishers? separates "everyone failed" (true) from "nobody played" (false).
  played?: boolean;
  // Length of the solve streak that ended yesterday (0/undefined if none) — named in the prefix.
  brokenStreak?: number;
  puzzleNo?: number;
}): string {
  // Wording lives in src/discord-copy.md (recap.*); this assembles the variant + the streak fires.
  const puzzle = opts.puzzleNo ? `Disconnections #${opts.puzzleNo}` : 'Disconnections';
  if (opts.solved === false) {
    const broken = opts.brokenStreak ?? 0;
    const prefix = broken >= 1 ? `${fill(COPY['recap.broken-prefix'], { broken })} ` : '';
    const body = opts.played
      ? fill(COPY['recap.stumped'], { puzzle })
      : fill(COPY['recap.no-play'], { puzzle });
    return `${prefix}${body}${COPY['recap.new-day']}`;
  }
  // Streak maintained: one 🔥 per digit of the streak count (5 → 🔥, 12 → 🔥🔥, 100 → 🔥🔥🔥).
  const streak = opts.streak ?? 0;
  const tail = COPY['recap.tail'];
  if (streak < 1) return tail;
  const fires = '🔥'.repeat(String(streak).length);
  return fill(COPY['recap.streak'], { streak, fires, tail });
}

// The Discord message: the rendered recap PNG plus the Play button, with an optional
// Wordle-style text body (recapText). The image carries the visual recap (title, results,
// standings) as a bare inline attachment — no embed, so Discord draws no frame/border or
// coloured side bar; the PNG sits directly in the message. Same shape as the live card's
// cardPayload, with a recap.png attachment.
export function recapPayload(content?: string): object {
  return {
    ...(content ? { content } : {}),
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: COPY['button.play'], custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'recap.png' }],
  };
}

export { PLAY_CUSTOM_ID };

// ——— the recap_posts ledger (shared by the nightly cron and the bot-less piggyback) ———
//
// One row per (scope, puzzle_date, channel) — the idempotency lock AND the outcome record:
//   'claimed' = in flight · 'posted' = delivered (never repost) · 'failed' = a permanent 4xx for
//   this date (don't loop) · absent = released after a transient failure (retryable).
// api/cron-recap.ts claims it before the bot posts a recap; api/post-card.ts claims the SAME key
// before piggybacking yesterday's recap onto the first launch of the day in a bot-less server — so
// the two can never both post one recap, whichever gets there first. These helpers only touch
// Supabase through the type (no runtime import), which is what keeps this module free of the heavy
// deps api/interactions.ts must not carry.

// A recap_posts row still 'claimed' this long after its last attempt was orphaned by a killed run
// (a hard 300s cron kill runs no cleanup), so a later run / the 05:00 twin / a later launch
// re-attempts it. Must be well above a healthy run's duration (~90s) so a live in-flight claim is
// never stolen mid-post.
export const STALE_CLAIM_MS = 15 * 60 * 1000;

// The ledger's primary key.
export type RecapKey = { scope_id: string; puzzle_date: string; channel_id: string };

// Which path is claiming: 'cron' = the nightly bot post, 'launch' = the bot-less piggyback. Stamped
// on the row at claim time and never rewritten. It exists for recap_pending()'s DORMANCY window,
// which counts ONLY 'cron' rows: dormancy answers "can the bot still post here?", and a piggyback
// (delivered on a launcher's interaction webhook, no bot involved) is no evidence either way. Left
// in, a piggyback delivery would keep flapping an ex-bot channel out of dormancy every few nights —
// see the dormancy block in supabase/schema.sql.
export type RecapVia = 'cron' | 'launch';

// What claiming the slot did:
//   'claimed'   — fresh insert, this caller owns the post.
//   'recovered' — took over a stale claim orphaned by a killed run; also owns the post.
//   'taken'     — someone else has it ('posted'/'failed', or a fresh in-flight claim): do nothing.
//   'error'     — the claim write itself failed (schema/DB trouble): do nothing.
export type ClaimResult = 'claimed' | 'recovered' | 'taken' | 'error';

// Claim the recap slot for one (scope, date, channel). A fresh insert wins it. On a unique violation
// the row already exists, so take it over ONLY if it's a stale 'claimed' row — an atomic CAS:
// re-stamp attempted_at where the status is still 'claimed' AND the prior attempt is older than
// STALE_CLAIM_MS. If nothing matches, leave it alone.
export async function claimRecapSlot(
  db: SupabaseClient,
  key: RecapKey,
  via: RecapVia,
  now: number = Date.now(),
): Promise<ClaimResult> {
  const nowIso = new Date(now).toISOString();
  const claim = await db
    .from('recap_posts')
    .insert({ ...key, status: 'claimed', attempted_at: nowIso, via });
  if (!claim.error) return 'claimed';
  if (claim.error.code !== '23505') return 'error';
  const cutoff = new Date(now - STALE_CLAIM_MS).toISOString();
  const { data: taken } = await db
    .from('recap_posts')
    // A takeover re-stamps `via` as well: whoever recovers an orphaned claim is the path that will
    // actually deliver (or fail) this date, and via must describe that attempt. Otherwise a launch
    // rescuing a killed cron's claim would file a 'launch' delivery as cron evidence and re-open the
    // very dormancy flap the column exists to close (and vice versa).
    .update({ attempted_at: nowIso, via })
    .match(key)
    .eq('status', 'claimed')
    .lt('attempted_at', cutoff)
    .select('scope_id');
  return Array.isArray(taken) && taken.length > 0 ? 'recovered' : 'taken';
}

// Stamp the outcome on the claimed row: a delivery is proven (message_id), a failure is queryable
// (status/http_status/discord_code/error).
export function recordRecapOutcome(
  db: SupabaseClient,
  key: RecapKey,
  fields: Record<string, unknown>,
): PromiseLike<unknown> {
  return db.from('recap_posts').update(fields).match(key);
}

// Release the claim after a TRANSIENT failure, so a later run (or launch) retries this date.
export function releaseRecapSlot(db: SupabaseClient, key: RecapKey): PromiseLike<unknown> {
  return db.from('recap_posts').delete().match(key);
}
