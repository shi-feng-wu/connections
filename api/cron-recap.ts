import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Game, type Puzzle } from "../src/game.js";
import { rankDelta, rankMap } from "../src/rank-delta.js";
import { admin } from "./_admin.js";
import { renderRecap } from "./_card.js";
import { fetchChannelName, fetchGuildName } from "./_discord.js";
import { sendCard } from "./_livecard.js";
import { fetchPuzzle, todayET, yesterdayET } from "./_nyt.js";
import { query } from "./_query.js";
import {
  type DayRow,
  recapPayload,
  recapText,
  type SeasonRow,
  toRecapData,
} from "./_recap.js";

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
// A channel the bot can't post in is now excluded up front (recap_channels filters on live_cards.
// bot_can_post, the launch-time app_permissions verdict), so the old silent nightly 403 — a command
// launch posts the live card via the interaction webhook, needing no bot channel perms, which made a
// channel a recap target the bot couldn't actually post its own message in — is designed out. Any
// that still 4xx (perms revoked between launch and midnight, deleted channel) are RECORDED on the
// ledger row (status/http_status/discord_code), not silently kept as a phantom "posted". The row is
// a state machine: 'claimed' (in flight) → 'posted' (message_id stored, never repost) or 'failed' (a
// permanent 4xx, don't loop); a transient 429/5xx deletes the row so a later run retries. A run
// killed mid-flight leaves rows stuck 'claimed'; a later run / the 05:00 twin re-attempts any still
// 'claimed' past STALE_CLAIM_MS (an atomic CAS), so kill-orphans are recovered instead of lost.
//
// Recaps are guild-only (c: scopes are skipped). The pg_cron job sends `Authorization:
// Bearer $CRON_SECRET` (the secret lives in Supabase Vault); we fail closed without it so
// the route can't be triggered by anyone else.

const SEASON_LIMIT = 5;
// Channels rendered+posted per INVOCATION. This is the OOM guard: the run used to render every
// channel in one invocation and the sandbox was OOM-killed at ~1000 @napi-rs/canvas renders — so it
// never reached the tail of recap_channels() (the older 18-digit guilds), which silently got no recap
// for weeks. Now the cron is a QUEUE DRAINER: each per-minute tick (see supabase/recap-cron.sql)
// processes one bounded batch of the still-pending channels (recap_pending) and returns; successive
// ticks drain the rest. 150 renders/tick stays well under the OOM ceiling; at ~150/8 concurrent this
// is a ~25s tick, and ~1500 channels drain in ~10 ticks. A crashed tick just leaves its remainder for
// the next tick — no channel is lost and nothing is starved (recap_pending serves neediest-first).
const BATCH_LIMIT = 150;
// How many channels to render+post concurrently within a tick. Modest to cap peak memory (one live
// canvas render per slot) and stay well under Discord's global rate limit; the batch cap above, not
// this, is what bounds total per-invocation memory.
const CONCURRENCY = 8;
// A recap_posts row still in status 'claimed' this long after its last attempt was orphaned by a
// killed run (a hard 300s kill runs no cleanup), so a later run / the 05:00 twin re-attempts it. Must
// be well above a healthy run's duration (~90s) so a live in-flight claim is never stolen mid-post.
const STALE_CLAIM_MS = 15 * 60 * 1000;

type ScopeRow = { scope_id: string | null; channel_id: string | null };
type Outcome = "posted" | "skipped" | "failed";

// (Removed the fetchBotGuildIds bot-membership pre-filter. It paginated /users/@me/guilds and 429'd
// nightly on the growing guild list, so it failed open and attempted all channels anyway. With the
// queue drainer, attempting a user-install / no-bot channel just 403s once and records a terminal
// 'failed' row, which drops it from recap_pending — no worse than the old fail-open behavior, and it
// removes the 429 noise. Future optimization: skip known-bot-less channels up front to save a render.)

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  // Cron auth: Vercel sends the bearer; reject everything else.
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Warm today's puzzle into the shared store before anything else, so the first player of
  // the new day never waits on NYT. Best-effort and independent of the recap: a NYT blip
  // here can't affect posting (and vice versa), and it runs even when there's nothing to
  // recap. Runs after this cron's reset, by which point today's puzzle is published.
  await fetchPuzzle(todayET()).catch(() => {});

  const db = admin();
  if (!db) {
    res.status(503).json({ error: "leaderboard unavailable" });
    return;
  }

  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  if (!botToken) {
    res.status(503).json({ error: "bot token unconfigured" });
    return;
  }

  // Preflight the token before touching any channel. A rejected token (401/403) makes EVERY recap
  // POST fail — and a per-channel 4xx is recorded as a permanent failure (kept row), so a bad token
  // would silently "fail" the whole night while the ledger fills with failure rows. Abort loudly
  // instead. Any OTHER result (a transient 5xx, a network blip) is ignored so a Discord hiccup can't
  // suppress the run.
  const who = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${botToken}` },
  }).catch(() => null);
  if (who && (who.status === 401 || who.status === 403)) {
    console.error("[recap] FATAL: bot token rejected — aborting run", {
      status: who.status,
    });
    res.status(503).json({ error: "bot token rejected", status: who.status });
    return;
  }

  // Test override (secret-gated, same bearer): ?scope=g:..&channel=..[&date=YYYY-MM-DD][&force=1]
  // fires the recap for a SINGLE channel instead of every one — for eyeballing the card in a
  // test server without spamming every room. force=1 clears that channel's ledger row first so
  // it re-posts. With no params it's the normal cron (all channels, yesterday). See
  // scripts/test-recap.mjs.
  const q = query(req);
  const onlyScope = q.get("scope") || undefined;
  const onlyChannel = q.get("channel") || undefined;
  const force = q.get("force") === "1";
  if (!!onlyScope !== !!onlyChannel) {
    res
      .status(400)
      .json({ error: "scope and channel must be provided together" });
    return;
  }

  const date = q.get("date") || yesterdayET();
  const since = `${date.slice(0, 8)}01`; // month start of the puzzle's day (avoids a month-boundary skew)

  // Day before yesterday, for the "was a streak broken?" check below (noon-UTC anchor so the
  // -1 day can't trip a DST boundary).
  const dayBefore = (() => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // This invocation's slice of work. Single-channel test override fires exactly that one channel;
  // otherwise pull the next BATCH_LIMIT channels that still need a recap for `date` from the queue.
  // recap_pending() = recap_channels() minus any (scope, channel) already terminal ('posted'/'failed')
  // for the date, ordered neediest-first (never-served / least-recently-served lead). Because terminal
  // rows drop out of that result, successive per-minute ticks drain the whole set — and no single
  // invocation renders more than BATCH_LIMIT cards, which is the OOM guard (see BATCH_LIMIT above).
  let pairs: { scope: string; channel: string }[];
  if (onlyScope && onlyChannel) {
    pairs = [{ scope: onlyScope, channel: onlyChannel }];
  } else {
    const { data: pendRows } = await db.rpc("recap_pending", {
      p_date: date,
      p_limit: BATCH_LIMIT,
    });
    pairs = ((pendRows ?? []) as ScopeRow[])
      .filter((r) => r.scope_id?.startsWith("g:") && !!r.channel_id)
      .map((r) => ({
        scope: r.scope_id as string,
        channel: r.channel_id as string,
      }));
  }

  if (pairs.length === 0) {
    // Queue drained for this date (or nothing to do). Ticks after this are cheap no-ops.
    res.status(200).json({ date, posted: 0, skipped: 0, failed: 0, batch: 0 });
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

  // One channel's recap, end to end: claim the ledger slot, build the card, post it, and record the
  // outcome on the row. Self-contained so the pool below can run many at once. A transient failure
  // (429 / 5xx / thrown) releases the claim so a later run retries; a permanent failure (403 can't
  // post, 404 gone, malformed) keeps the row and stamps status='failed' + the Discord code, so it
  // doesn't loop AND the miss is visible instead of masquerading as a delivery.
  const postOne = async ({
    scope,
    channel,
  }: {
    scope: string;
    channel: string;
  }): Promise<Outcome> => {
    const key = { scope_id: scope, puzzle_date: date, channel_id: channel };
    const nowIso = new Date().toISOString();
    // Test re-runs (force): clear any prior row for this (scope, date, channel) so it re-posts.
    if (force) await db.from("recap_posts").delete().match(key);

    // Claim the slot. The row is the idempotency lock: 'claimed' = in flight, 'posted' = delivered
    // (never repost), 'failed' = a permanent 4xx for this date (don't loop), absent = released after a
    // transient failure (retryable). A fresh insert wins the claim.
    const claim = await db
      .from("recap_posts")
      .insert({ ...key, status: "claimed", attempted_at: nowIso });
    if (claim.error) {
      if (claim.error.code !== "23505") return "failed";
      // Row already exists. Take it over ONLY if it's a stale 'claimed' row orphaned by a killed run —
      // an atomic CAS: re-stamp attempted_at where status is still 'claimed' AND the prior attempt is
      // old. If nothing matches (it's 'posted'/'failed', or a fresh in-flight claim), leave it alone.
      const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
      const { data: taken } = await db
        .from("recap_posts")
        .update({ attempted_at: nowIso })
        .match(key)
        .eq("status", "claimed")
        .lt("attempted_at", cutoff)
        .select("scope_id");
      if (!taken || taken.length === 0) return "skipped";
      console.log("[recap] recovered stale claim", { scope, channel });
      // Recovered → fall through and (re)post it.
    }

    // Stamp the outcome on the claimed row: a delivery is proven (message_id), a failure is queryable.
    const record = (fields: Record<string, unknown>) =>
      db.from("recap_posts").update(fields).match(key);
    const release = () => db.from("recap_posts").delete().match(key);

    try {
      const guildId = scope.startsWith("g:") ? scope.slice(2) : "";
      const [
        { data: results },
        { data: season },
        { data: prevSeason, error: prevSeasonErr },
        { data: stats },
        guildName,
        channelName,
      ] = await Promise.all([
        db.rpc("day_results", {
          p_scope: scope,
          p_date: date,
          p_channel: channel,
        }),
        // Standings AS OF the recapped day (p_until: date) — so today's early plays can't skew
        // them and a backfilled/test recap for an old date shows that day's board, not today's.
        db.rpc("room_board", {
          p_scope: scope,
          p_since: since,
          p_limit: SEASON_LIMIT,
          p_channel: channel,
          p_until: date,
        }),
        // The same board one day earlier, unlimited, so the rank-change arrows can find where a
        // current top-5 player ranked before yesterday's puzzle (delta = movement it caused).
        db.rpc("room_board", {
          p_scope: scope,
          p_since: since,
          p_limit: 1000,
          p_channel: channel,
          p_until: dayBefore,
        }),
        db.rpc("room_recap_stats", {
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
          .from("progress")
          .select("user_id, guesses")
          .in(
            "user_id",
            dayRows.map((r) => r.user_id),
          )
          .eq("puzzle_date", date);
        const levelsById = new Map<string, number[]>();
        for (const row of (prog ?? []) as {
          user_id: string;
          guesses: unknown;
        }[]) {
          const guesses = Array.isArray(row.guesses)
            ? (row.guesses as string[][])
            : [];
          levelsById.set(
            row.user_id,
            Game.fromGuesses(puzzle, guesses).deducedLevels,
          );
        }
        for (const r of dayRows) r.solvedLevels = levelsById.get(r.user_id);
      }

      // "Streak broken!" only when an active solve streak actually ended yesterday. The streak
      // the room carried INTO yesterday is its value as of the day before — room_recap_stats
      // measures up to the last day with data, so on an all-loss or no-play day, reading
      // yesterday can't reveal the prior run; query the day before explicitly (only when needed).
      let brokenStreak = 0;
      if (!solvedYesterday) {
        const { data: prior } = await db.rpc("room_recap_stats", {
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

      // Post as the bot (multipart with the recap PNG) to the room's channel — the same
      // multipart path as the live "who's playing" card (api/_livecard.ts). The bot token
      // authorizes it; app-owned messages render the Play button without with_components.
      const url = `https://discord.com/api/v10/channels/${channel}/messages`;
      const r = await sendCard(
        url,
        recapPayload(text),
        png,
        "POST",
        "recap.png",
        {
          Authorization: `Bot ${botToken}`,
        },
      );
      if (r.ok) {
        // Store the message id as proof of delivery (was discarded before, so a kept claim was
        // indistinguishable from a silent failure).
        const messageId =
          ((await r.json().catch(() => ({}))) as { id?: string }).id ?? null;
        await record({
          status: "posted",
          http_status: r.status,
          message_id: messageId,
          discord_code: null,
          error: null,
        });
        return "posted";
      }
      // Parse Discord's error envelope { code, message } so the reason is queryable (e.g. 50001
      // Missing Access = the bot can't post here — the dominant silent-failure cause).
      const bodyText = await r.text().catch(() => "");
      let discordCode: number | null = null;
      try {
        discordCode = (JSON.parse(bodyText) as { code?: number }).code ?? null;
      } catch {
        /* non-JSON body */
      }
      if (r.status === 429 || r.status >= 500) {
        // Transient (rate limit / Discord outage): release the slot so the next daily run retries.
        await release();
        return "failed";
      }
      // Permanent 4xx (perms, gone, malformed): keep the row so we don't loop, but RECORD the failure
      // so it's visible in the ledger instead of masquerading as a delivery.
      await record({
        status: "failed",
        http_status: r.status,
        discord_code: discordCode,
        error: bodyText.slice(0, 500),
      });
      console.warn("[recap] post failed", {
        scope,
        channel,
        status: r.status,
        code: discordCode,
      });
      return "failed";
    } catch (e) {
      await release();
      console.warn("[recap] post threw", {
        scope,
        channel,
        err: e instanceof Error ? e.message : String(e),
      });
      return "failed";
    }
  };

  // Worker pool: CONCURRENCY slots each pull the next channel off a shared cursor until the
  // batch is drained. `pairs[cursor++]` is atomic (no await between read and increment), so
  // each slot gets a distinct channel. CRASH ISOLATION: every iteration is wrapped, so a throw
  // from anywhere in postOne — including the claim/CAS before its own inner try — degrades that
  // ONE channel to 'failed' instead of rejecting Promise.all and killing the whole batch (which
  // would strand every remaining channel). The channel's ledger row stays 'claimed' and a later
  // tick recovers it via the stale-claim CAS, so nothing is lost.
  const outcomes: Outcome[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, async () => {
      while (cursor < pairs.length) {
        const pair = pairs[cursor++];
        try {
          outcomes.push(await postOne(pair));
        } catch (e) {
          outcomes.push("failed");
          console.warn("[recap] channel isolated after throw", {
            scope: pair.scope,
            channel: pair.channel,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }),
  );

  const posted = outcomes.filter((o) => o === "posted").length;
  const skipped = outcomes.filter((o) => o === "skipped").length;
  const failed = outcomes.filter((o) => o === "failed").length;
  // batch = channels this tick attempted; the next per-minute tick drains the remainder.
  res.status(200).json({ date, posted, skipped, failed, batch: pairs.length });
}
