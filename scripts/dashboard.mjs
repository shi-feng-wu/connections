// Private admin dashboard for the Disconnections Activity. LOCAL ONLY.
//
// WHY THIS IS PRIVATE: the server binds to 127.0.0.1 (loopback) — it is not reachable
// from your network, let alone the internet. It reads the database with the Supabase
// SERVICE ROLE key from .env (bypasses RLS, sees every table), which never leaves your
// machine. Nothing is deployed; "only I have access" = it only exists while you run it,
// only on this box. Do NOT expose this behind a tunnel/0.0.0.0 — that would publish the
// full database to anyone.
//
// Run:
//   pnpm dashboard            # opens http://127.0.0.1:7337
//   DASHBOARD_PORT=8080 pnpm dashboard
// Needs SUPABASE_URL (or VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY in .env
// (loaded via --env-file). No build step, no tsx — plain node, like `pnpm status`.
//
// Page loads are instant: a background loop keeps a pre-rendered snapshot warm
// (see the server section) and requests serve it from memory. Charts are Recharts,
// self-hosted from scripts/.dashboard-vendor/ after a one-time unpkg fetch. For
// cheap 30s polls, run supabase/dashboard-perf.sql once in the SQL editor (adds
// two cursor indexes + the card-stats RPC; the dashboard falls back gracefully
// until then).

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in .env.');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const PORT = Number(process.env.DASHBOARD_PORT ?? 7337);
const HOST = '127.0.0.1'; // loopback only — see header. Do not change to 0.0.0.0.
const ONLINE_TTL_MS = 15_000; // matches ROSTER_ONLINE_TTL_MS in api/roster.ts (green ring)

// ── data ────────────────────────────────────────────────────────────────────

// Runs task(i) for i in [0, count) with at most `limit` in flight concurrently, storing
// each result at its own index so the returned array is in offset order regardless of
// which task finishes first. Used to parallelize the full-table page dumps below instead
// of fetching one page at a time — that serial pagination was the dominant cost of a
// cold start (48s to page through the whole scores table one request at a time).
async function mapConcurrent(count, limit, task) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      results[i] = await task(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
}

// scores is the app's core fact table and is insert-only: rows are upserted with
// ignoreDuplicates:true on the (puzzle_id, user_id) conflict key and never touched again
// afterward. That means a row fetched once is valid forever, so instead of re-running the
// full dump on every 30s auto-refresh, we keep every row seen so far in memory (sorted
// created_at DESC — downstream code depends on newest-first: rows.slice(0,25) for the
// recent feed, first-seen-wins in byUser), and after the first fetch only ask Supabase
// for rows at/after the high-water created_at we've already reached. That in-memory
// cache is also persisted to scripts/.dashboard-scores-cache.json (see below) — a
// separate file from the small guild-install cache, since this one is the full
// multi-MB scores dump and gets rewritten on every incremental merge, and there's no
// reason to churn the small file's mtime alongside a multi-MB rewrite — so a fresh
// `pnpm dashboard` process loads yesterday's dump straight off disk and only pays for
// an incremental catch-up, instead of re-paging the whole table on every restart.
const cols =
  'puzzle_id, puzzle_date, scope_id, channel_id, user_id, name, avatar, score, mistakes, solved, groups_solved, duration_ms, created_at';
let scoresCache = []; // sorted created_at DESC
let scoresCursor = null; // highest created_at fetched so far ('' once the table's been touched but is empty)
let scoresLoaded = false; // false only before the very first fetch (full dump or disk-cache load)
const scoresKeys = new Set(); // `${puzzle_id}:${user_id}` — the row's real identity, for dedupe

const SCORES_CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dashboard-scores-cache.json');

function loadScoresDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCORES_CACHE_FILE, 'utf8'));
    if (!Array.isArray(raw.rows) || typeof raw.cursor !== 'string') return; // unexpected shape — treat as corrupt
    scoresCache = raw.rows;
    for (const r of scoresCache) scoresKeys.add(r.puzzle_id + ':' + r.user_id);
    scoresCursor = raw.cursor;
    scoresLoaded = true; // the next fetchAllScores() call does an incremental catch-up, not a full dump
  } catch {
    // missing (first run) or corrupt — fetchAllScores() falls back to the full fetch, same as before this cache existed
  }
}

function saveScoresDiskCache() {
  try {
    const tmp = SCORES_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cursor: scoresCursor, rows: scoresCache }));
    fs.renameSync(tmp, SCORES_CACHE_FILE); // atomic — never a half-written multi-MB cache
  } catch {
    // best effort — the dashboard still works, it just re-dumps the full table next restart
  }
}

loadScoresDiskCache();

async function fetchAllScores() {
  const page = 1000;
  if (!scoresLoaded) {
    // Full dump, parallelized: get the exact row count first, then fetch every page
    // concurrently (limit 6) instead of one page at a time. This must be ordered
    // created_at ASCENDING: under concurrent inserts, ascending order is stable for rows
    // that already existed when we counted (new rows append past the counted range),
    // while descending order would shift every offset as new rows land at the front.
    // Pages are assembled in offset order by mapConcurrent, then reversed once into the
    // DESC order the rest of the file expects. Anything inserted mid-scan is picked up
    // by the next incremental refresh via the cursor, not by this pass.
    const { count, error: countError } = await db.from('scores').select('*', { count: 'exact', head: true });
    if (countError) throw new Error('scores count: ' + countError.message);
    const pageCount = Math.ceil((count ?? 0) / page);
    const pages = await mapConcurrent(pageCount, 6, async (i) => {
      const from = i * page;
      const { data, error } = await db
        .from('scores')
        .select(cols)
        .order('created_at', { ascending: true })
        .range(from, from + page - 1);
      if (error) throw new Error('scores: ' + error.message);
      return data ?? [];
    });
    const out = pages.flat().reverse();
    scoresCache = out;
    for (const r of out) scoresKeys.add(r.puzzle_id + ':' + r.user_id);
    scoresCursor = out.length ? out[0].created_at : '';
    scoresLoaded = true;
    saveScoresDiskCache();
    return scoresCache;
  }

  // Incremental: only rows at/after our high-water cursor. created_at is Postgres
  // transaction-START time, not commit time, so an older transaction can commit after a
  // newer one and land with a timestamp slightly BELOW the max we've already observed —
  // a strict gte(cursor) would miss that row forever. The query bound backs off 5
  // minutes from the stored cursor to cover that race, while scoresCursor itself keeps
  // tracking the true max seen; the key-Set dedupe below makes re-fetching the overlap
  // harmless.
  const queryCursor = scoresCursor ? new Date(Date.parse(scoresCursor) - 5 * 60_000).toISOString() : '';
  let from = 0;
  const fresh = [];
  for (;;) {
    let q = db.from('scores').select(cols).order('created_at', { ascending: false }).range(from, from + page - 1);
    if (queryCursor) q = q.gte('created_at', queryCursor);
    const { data, error } = await q;
    if (error) throw new Error('scores: ' + error.message);
    fresh.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  const newRows = fresh.filter((r) => !scoresKeys.has(r.puzzle_id + ':' + r.user_id));
  if (newRows.length) {
    for (const r of newRows) scoresKeys.add(r.puzzle_id + ':' + r.user_id);
    scoresCache = [...newRows, ...scoresCache]; // fresh rows are all >= cursor, so this stays DESC-sorted
    scoresCursor = newRows[0].created_at; // the true max — unaffected by the query-only overlap backoff
    saveScoresDiskCache();
  }
  return scoresCache;
}

// progress is the game-START ledger: one row per (user_id, puzzle_date), inserted the
// moment a player opens that day's board — including the ~8% of games abandoned mid-way,
// which never produce a scores row. Play-shaped metrics (games played, daily actives,
// acquisition, retention) union this table with scores in loadStats so an abandoned game
// still counts as a play; scores stays the source for anything needing an outcome
// (wins, mistakes, points) or a server (progress has no scope_id). Rows here DO get
// rewritten after insert (every guess upserts guesses/updated_at), but the columns read
// below are all fixed at insert time — started_at in particular never changes — so the
// same fetch-once-then-incremental pattern as scores applies, cursored on started_at,
// with the identical ASC-dump stability argument, 5-minute overlap backoff, and key-Set
// dedupe (see the fetchAllScores comments for the reasoning behind each).
const pcols = 'user_id, puzzle_date, started_at';
let progressCache = []; // sorted started_at DESC
let progressCursor = null; // highest started_at fetched so far ('' once the table's been touched but is empty)
let progressLoaded = false;
const progressKeys = new Set(); // `${user_id}:${puzzle_date}` — the row's real identity, for dedupe

const PROGRESS_CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dashboard-progress-cache.json');

function loadProgressDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_CACHE_FILE, 'utf8'));
    if (!Array.isArray(raw.rows) || typeof raw.cursor !== 'string') return; // unexpected shape — treat as corrupt
    progressCache = raw.rows;
    for (const r of progressCache) progressKeys.add(r.user_id + ':' + r.puzzle_date);
    progressCursor = raw.cursor;
    progressLoaded = true;
  } catch {
    // missing (first run) or corrupt — fetchAllProgress() falls back to the full dump
  }
}

function saveProgressDiskCache() {
  try {
    const tmp = PROGRESS_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cursor: progressCursor, rows: progressCache }));
    fs.renameSync(tmp, PROGRESS_CACHE_FILE); // atomic — never a half-written multi-MB cache
  } catch {
    // best effort — worst case is a full re-dump next restart
  }
}

loadProgressDiskCache();

async function fetchAllProgress() {
  const page = 1000;
  if (!progressLoaded) {
    const { count, error: countError } = await db.from('progress').select('*', { count: 'exact', head: true });
    if (countError) throw new Error('progress count: ' + countError.message);
    const pageCount = Math.ceil((count ?? 0) / page);
    const pages = await mapConcurrent(pageCount, 6, async (i) => {
      const from = i * page;
      const { data, error } = await db
        .from('progress')
        .select(pcols)
        .order('started_at', { ascending: true })
        .range(from, from + page - 1);
      if (error) throw new Error('progress: ' + error.message);
      return data ?? [];
    });
    const out = pages.flat().reverse();
    progressCache = out;
    for (const r of out) progressKeys.add(r.user_id + ':' + r.puzzle_date);
    progressCursor = out.length ? out[0].started_at : '';
    progressLoaded = true;
    saveProgressDiskCache();
    return progressCache;
  }

  const queryCursor = progressCursor ? new Date(Date.parse(progressCursor) - 5 * 60_000).toISOString() : '';
  let from = 0;
  const fresh = [];
  for (;;) {
    let q = db.from('progress').select(pcols).order('started_at', { ascending: false }).range(from, from + page - 1);
    if (queryCursor) q = q.gte('started_at', queryCursor);
    const { data, error } = await q;
    if (error) throw new Error('progress: ' + error.message);
    fresh.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  const newRows = fresh.filter((r) => !progressKeys.has(r.user_id + ':' + r.puzzle_date));
  if (newRows.length) {
    for (const r of newRows) progressKeys.add(r.user_id + ':' + r.puzzle_date);
    progressCache = [...newRows, ...progressCache]; // fresh rows are all >= cursor, so this stays DESC-sorted
    progressCursor = newRows[0].started_at;
    saveProgressDiskCache();
  }
  return progressCache;
}

// Card KPIs: posted-card count + distinct g: servers ever reached by a card.
// Preferred path is one RPC (dashboard_card_stats — see supabase/dashboard-perf.sql)
// that counts in Postgres in a single scan. Until that function is installed the
// fallback pages the whole live_cards table like the pre-RPC dashboard did (130k+
// rows over ~134 requests) — it works, it's just the expensive way. Either way the
// result is cached for 5 minutes; the snapshot loop keeps it off the request path.
const CARDS_TTL_MS = 5 * 60_000;
let cardsCache = { at: 0, data: null };
let cardRpcMissing = false; // probed once per process; true = fall back to the dump
async function fetchCardStats() {
  if (cardsCache.data && Date.now() - cardsCache.at < CARDS_TTL_MS) return cardsCache.data;
  if (!cardRpcMissing) {
    const { data, error } = await db.rpc('dashboard_card_stats').single();
    if (!error) {
      cardsCache = {
        at: Date.now(),
        data: { cardsPosted: Number(data.cards_posted), cardServers: Number(data.card_servers) },
      };
      return cardsCache.data;
    }
    cardRpcMissing = true;
    console.warn('dashboard_card_stats RPC unavailable (run supabase/dashboard-perf.sql) — using the slow live_cards dump');
  }
  const page = 1000;
  const { count, error: countError } = await db
    .from('live_cards')
    .select('*', { count: 'exact', head: true })
    .not('message_id', 'is', null);
  if (countError) throw new Error('live_cards count: ' + countError.message);
  const pageCount = Math.ceil((count ?? 0) / page);
  const pages = await mapConcurrent(pageCount, 6, async (i) => {
    const from = i * page;
    const { data, error } = await db
      .from('live_cards')
      .select('scope_id, message_id')
      .not('message_id', 'is', null)
      .order('scope_id')
      .range(from, from + page - 1);
    if (error) throw new Error('live_cards: ' + error.message);
    return data ?? [];
  });
  // scope_id ordering isn't insert-stable — a row inserted mid-scan can shift another
  // row into an offset we already fetched, so pages can overlap. Dedupe by message_id
  // (unique per posted card); worst case a just-inserted card is missed until the next
  // 5-minute TTL refresh, which is fine for two aggregate counts.
  const seen = new Set();
  const servers = new Set();
  for (const r of pages.flat()) {
    if (seen.has(r.message_id)) continue;
    seen.add(r.message_id);
    if (String(r.scope_id).startsWith('g:')) servers.add(r.scope_id);
  }
  cardsCache = { at: Date.now(), data: { cardsPosted: seen.size, cardServers: servers.size } };
  return cardsCache.data;
}

// True bot installs, straight from Discord (same source as the email they send).
// live_cards can't tell you this: cards also exist in user-install servers (posted via
// the interaction webhook, no bot in the guild) and rows outlive servers that removed
// the bot. Guild listing mirrors fetchBotGuildIds in api/cron-recap.ts. Returns null
// when the token is missing or has never once succeeded, so the KPI shows "—"; once we
// have a good result, a later Discord error re-serves that stale-but-real result instead
// (see fetchBotInstalls's catch) so a transient outage doesn't blank the dashboard.
//
// The timeline comes from the bot's own member joined_at in each guild
// (GET /guilds/{id}/members/{botUserId} — the OAuth2-flavored /users/@me/guilds/{id}/member
// 403s for bot tokens). Discord keeps no log of past installs, so this is "current
// guilds by the day the bot joined"; servers that removed the bot drop out of the
// whole curve. joined_at never changes for a guild, so it's cached per guild id AND
// written to disk (scripts/.dashboard-cache.json, see loadDiskCache/saveDiskCache below)
// — at 1000+ guilds a from-scratch scan is slow and 429-prone, so paying for it once and
// persisting it means every dashboard restart after the first is instant. To keep that
// first-ever run from blocking the page load, fetchBotInstalls never awaits the per-guild
// lookup: it returns immediately with whatever joined_at values are already known and
// kicks off backfillJoinedAt in the background (guarded by backfillInFlight so overlapping
// 30s-refresh calls don't pile up), persisting to disk when it finishes a batch.
let botUserId = null; // the bot's own user id, fetched once (persisted to disk)
const joinedAtByGuild = new Map(); // guild id -> 'YYYY-MM-DD' (absent = not fetched yet or last attempt failed) (persisted to disk)
const guildNameById = new Map(); // guild id -> server name (from /users/@me/guilds; absent for servers the bot has left) (persisted to disk)
let lastGoodInstalls = null; // last successful install stats — persisted to disk so a cold boot renders installs immediately instead of blocking on ~14 pages of Discord guild pagination (a fresh scan replaces it on the next refresh)

// ── disk cache ──────────────────────────────────────────────────────────────
// Resolved relative to this file (not cwd) so `pnpm dashboard` works from anywhere.
const CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dashboard-cache.json');

function loadDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw.botUserId) botUserId = raw.botUserId;
    if (raw.joinedAtByGuild) for (const [id, date] of Object.entries(raw.joinedAtByGuild)) joinedAtByGuild.set(id, date);
    if (raw.guildNameById) for (const [id, name] of Object.entries(raw.guildNameById)) guildNameById.set(id, name);
    if (raw.lastGoodInstalls) lastGoodInstalls = raw.lastGoodInstalls;
  } catch {
    // missing (first run) or corrupt — start with an empty scan, same as before this cache existed
  }
}

function saveDiskCache() {
  try {
    const tmp = CACHE_FILE + '.tmp';
    const payload = JSON.stringify({
      botUserId,
      joinedAtByGuild: Object.fromEntries(joinedAtByGuild),
      guildNameById: Object.fromEntries(guildNameById),
      lastGoodInstalls,
    });
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, CACHE_FILE); // rename is atomic on the same filesystem — never a half-written cache
  } catch {
    // best effort — the dashboard still works, it just re-scans more next restart
  }
}

loadDiskCache();

// Guild listing (id/name/approx member count) changes slowly — cache its outcome for 5min
// so the 30s auto-refresh doesn't re-paginate ~1000+ guilds every request (this pagination
// was 429-ing the nightly recap cron at this guild count).
const GUILD_LIST_TTL_MS = 5 * 60_000;
let guildListCache = null; // { at, ids: Set, memberByGuild: Map }
async function fetchGuildList() {
  if (guildListCache && Date.now() - guildListCache.at < GUILD_LIST_TTL_MS) return guildListCache;
  const token = process.env.DISCORD_BOT_TOKEN ?? '';
  const headers = { Authorization: `Bot ${token}` };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const ids = new Set();
  const memberByGuild = new Map(); // guild id -> approximate_member_count (from with_counts=true)
  let sawNewName = false;
  let after = '';
  for (;;) {
    // with_counts=true adds approximate_member_count per guild → total member reach below
    const url = `https://discord.com/api/v10/users/@me/guilds?limit=200&with_counts=true${after ? `&after=${after}` : ''}`;
    let r;
    for (let attempt = 0; attempt < 6; attempt++) {
      r = await fetch(url, { headers });
      if (r.status !== 429) break;
      const body = await r.json().catch(() => ({ retry_after: 2 }));
      await sleep((body.retry_after ?? 2) * 1000 + 300); // respect Discord's global rate limit
    }
    if (!r.ok) throw new Error('guild list: ' + r.status);
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const g of page) {
      ids.add(g.id);
      if (g.name && guildNameById.get(g.id) !== g.name) {
        guildNameById.set(g.id, g.name);
        sawNewName = true;
      }
      if (typeof g.approximate_member_count === 'number') memberByGuild.set(g.id, g.approximate_member_count);
    }
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  guildListCache = { at: Date.now(), ids, memberByGuild };
  if (sawNewName) saveDiskCache();
  return guildListCache;
}

let backfillInFlight = false; // guards against overlapping 30s-refresh calls double-scanning

// Fire-and-forget: looks up joined_at for every guild id we haven't dated yet, in the
// same batch-of-10 pattern as before. Never awaited by fetchBotInstalls — the first-ever
// run (or any run after new guilds appear) keeps making progress across auto-refreshes
// until every known guild is dated, then costs nothing until a new guild shows up.
async function backfillJoinedAt(ids) {
  if (backfillInFlight || !botUserId) return;
  const missing = ids.filter((id) => !joinedAtByGuild.has(id));
  if (!missing.length) return;
  backfillInFlight = true;
  const token = process.env.DISCORD_BOT_TOKEN ?? '';
  const headers = { Authorization: `Bot ${token}` };
  let added = 0;
  try {
    for (let i = 0; i < missing.length; i += 10) {
      await Promise.all(
        missing.slice(i, i + 10).map(async (id) => {
          const r = await fetch(`https://discord.com/api/v10/guilds/${id}/members/${botUserId}`, { headers });
          if (!r.ok) return; // left absent → retried on the next refresh
          const m = await r.json();
          if (m?.joined_at) {
            joinedAtByGuild.set(id, m.joined_at.slice(0, 10));
            added++;
          }
        }),
      );
    }
  } catch {
    // best effort — whatever's left over gets picked up by the next kickoff
  } finally {
    backfillInFlight = false;
    if (added > 0) saveDiskCache();
  }
}

async function fetchBotInstalls() {
  const token = process.env.DISCORD_BOT_TOKEN ?? '';
  if (!token) return null;
  try {
    const { ids, memberByGuild } = await fetchGuildList();
    if (!botUserId) {
      const headers = { Authorization: `Bot ${token}` };
      const r = await fetch('https://discord.com/api/v10/users/@me', { headers });
      if (r.ok) {
        botUserId = (await r.json()).id;
        saveDiskCache();
      }
    }
    backfillJoinedAt([...ids]); // not awaited — see backfillJoinedAt comment
    const memberReach = [...memberByGuild.values()].reduce((a, b) => a + b, 0);
    const largest = memberByGuild.size ? Math.max(...memberByGuild.values()) : 0;
    const joins = [...ids].map((id) => joinedAtByGuild.get(id)).filter(Boolean);
    lastGoodInstalls = { count: ids.size, joins, memberReach, largest };
    saveDiskCache(); // installs survive restarts — see lastGoodInstalls
    return lastGoodInstalls;
  } catch {
    return lastGoodInstalls;
  }
}

function isoMinusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadStats() {
  const [rows, starts] = await Promise.all([fetchAllScores(), fetchAllProgress()]);

  const dateSet = new Set();
  for (const r of rows) if (r.puzzle_date) dateSet.add(r.puzzle_date);
  for (const p of starts) dateSet.add(p.puzzle_date);
  const allDates = [...dateSet].sort();
  const latestDate = allDates.length ? allDates[allDates.length - 1] : null;

  const [{ data: presence }, cardStats, { count: puzzlesCached }, { count: recapPosts }, installs] = await Promise.all([
    latestDate
      ? db.from('presence').select('user_id, last_seen').eq('puzzle_date', latestDate)
      : Promise.resolve({ data: [] }),
    fetchCardStats(),
    db.from('puzzles').select('*', { count: 'exact', head: true }),
    db.from('recap_posts').select('*', { count: 'exact', head: true }),
    fetchBotInstalls(),
  ]);

  const now = Date.now();
  const players = new Set();
  const scopes = new Set();
  let solved = 0;
  let perfect = 0;
  let mistakesSum = 0;
  let scoreSum = 0;
  const solveDurations = []; // ms, solved games only — for fastest/median

  const byDate = new Map(); // date -> { players:Set, wins, scopes:Set }
  const byScope = new Map(); // scope -> { games, players:Set, wins, first, last }
  const byUser = new Map(); // user -> aggregate (rows are created_at desc → first seen = newest)
  const firstSeenUser = new Map(); // user -> earliest puzzle_date
  const firstSeenScope = new Map(); // scope -> earliest puzzle_date
  const userDayNums = new Map(); // user -> Set of epoch-day numbers they played (for retention)
  const playKeys = new Set(); // `${user_id}:${puzzle_date}` across starts AND finishes — a "play" is either

  for (const r of rows) {
    players.add(r.user_id);
    if (r.puzzle_date) playKeys.add(r.user_id + ':' + r.puzzle_date);
    if (r.scope_id) scopes.add(r.scope_id);
    if (r.solved) {
      solved++;
      if ((r.mistakes ?? 0) === 0) perfect++;
      if (r.duration_ms && r.duration_ms > 3000) solveDurations.push(r.duration_ms);
    }
    mistakesSum += r.mistakes ?? 0;
    scoreSum += r.score ?? 0;

    if (r.puzzle_date) {
      const d = byDate.get(r.puzzle_date) ?? { players: new Set(), wins: 0, scopes: new Set() };
      d.players.add(r.user_id);
      if (r.solved) d.wins++;
      if (r.scope_id) d.scopes.add(r.scope_id);
      byDate.set(r.puzzle_date, d);

      const fu = firstSeenUser.get(r.user_id);
      if (!fu || r.puzzle_date < fu) firstSeenUser.set(r.user_id, r.puzzle_date);
      let uset = userDayNums.get(r.user_id);
      if (!uset) userDayNums.set(r.user_id, (uset = new Set()));
      uset.add(Math.round(Date.parse(r.puzzle_date + 'T00:00:00Z') / 86400000));
      if (r.scope_id) {
        const fs = firstSeenScope.get(r.scope_id);
        if (!fs || r.puzzle_date < fs) firstSeenScope.set(r.scope_id, r.puzzle_date);
      }
    }

    if (r.scope_id) {
      const s = byScope.get(r.scope_id) ?? { games: 0, players: new Set(), wins: 0, last: '' };
      s.games++;
      s.players.add(r.user_id);
      if (r.solved) s.wins++;
      if ((r.puzzle_date ?? '') > s.last) s.last = r.puzzle_date ?? '';
      byScope.set(r.scope_id, s);
    }

    const u = byUser.get(r.user_id);
    if (!u) {
      byUser.set(r.user_id, {
        name: r.name, avatar: r.avatar, total: r.score ?? 0, plays: 1,
        wins: r.solved ? 1 : 0, mistakes: r.mistakes ?? 0,
      });
    } else {
      u.total += r.score ?? 0;
      u.plays++;
      if (r.solved) u.wins++;
      u.mistakes += r.mistakes ?? 0;
    }
  }

  // Fold game STARTS into the play-shaped aggregates. scores only records finished games,
  // so without this pass every abandoned game (~8% of starts) vanishes from actives,
  // acquisition, retention, and the games-played total. Outcome stats (wins, mistakes,
  // points) stay finished-only above — an abandoned game has no score row to read them
  // from — and server-level metrics stay scores-only because progress has no scope_id.
  for (const p of starts) {
    players.add(p.user_id);
    playKeys.add(p.user_id + ':' + p.puzzle_date);
    const d = byDate.get(p.puzzle_date) ?? { players: new Set(), wins: 0, scopes: new Set() };
    d.players.add(p.user_id);
    byDate.set(p.puzzle_date, d);
    const fu = firstSeenUser.get(p.user_id);
    if (!fu || p.puzzle_date < fu) firstSeenUser.set(p.user_id, p.puzzle_date);
    let uset = userDayNums.get(p.user_id);
    if (!uset) userDayNums.set(p.user_id, (uset = new Set()));
    uset.add(Math.round(Date.parse(p.puzzle_date + 'T00:00:00Z') / 86400000));
  }
  // A player's play count = distinct puzzle-days across starts and finishes, so serial
  // abandoners aren't undercounted in the leaderboard either. (Users with zero finishes
  // never enter byUser — scores is where names/avatars live — which is fine: with no
  // finished games they have no score or wins to rank by.)
  for (const [uid, u] of byUser) u.plays = userDayNums.get(uid)?.size ?? u.plays;
  const totalPlays = playKeys.size;
  const abandonedPlays = totalPlays - rows.length; // plays that never produced a score row

  // solve-time stats (solved games only; the >3s guard drops resumed/instant-finish noise)
  solveDurations.sort((a, b) => a - b);
  const fastestMs = solveDurations[0] ?? 0;
  const medianMs = solveDurations.length ? solveDurations[Math.floor(solveDurations.length / 2)] : 0;

  // new players / new servers per day, from first-appearance maps
  const newUsersByDate = new Map();
  for (const d of firstSeenUser.values()) newUsersByDate.set(d, (newUsersByDate.get(d) ?? 0) + 1);
  const newScopesByDate = new Map();
  for (const d of firstSeenScope.values()) newScopesByDate.set(d, (newScopesByDate.get(d) ?? 0) + 1);

  // full daily series with running (cumulative) reach
  let cumPlayers = 0;
  let cumServers = 0;
  const series = allDates.map((date) => {
    const e = byDate.get(date);
    const newp = newUsersByDate.get(date) ?? 0;
    const news = newScopesByDate.get(date) ?? 0;
    cumPlayers += newp;
    cumServers += news;
    return {
      date,
      players: e.players.size,
      activeServers: e.scopes.size,
      newPlayers: newp,
      newServers: news,
      cumPlayers,
      cumServers,
      solveRate: e.players.size ? e.wins / e.players.size : 0,
    };
  });

  // popularity KPIs
  const weekAgo = latestDate ? isoMinusDays(latestDate, 7) : null;
  let newPlayers7 = 0;
  if (weekAgo) for (const d of firstSeenUser.values()) if (d > weekAgo) newPlayers7++;
  const wau = new Set(); // weekly active users — anyone who started a game, finished or not
  if (weekAgo) {
    for (const r of rows) if (r.puzzle_date && r.puzzle_date > weekAgo) wau.add(r.user_id);
    for (const p of starts) if (p.puzzle_date > weekAgo) wau.add(p.user_id);
  }
  let peak = { date: null, players: 0 };
  for (const d of series) if (d.players > peak.players) peak = { date: d.date, players: d.players };

  // ── retention ──────────────────────────────────────────────────────────────
  // Classic day-N retention for a daily game: of players who first played on day D,
  // how many also played on day D+N. Only offsets that have elapsed (D+N ≤ latest)
  // count, so a fresh cohort never reads as "0% retained" for days that haven't happened.
  const dn = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
  const latestDayNum = latestDate ? dn(latestDate) : 0;
  const datedPlayers = userDayNums.size;

  const cohorts = new Map(); // first-play day -> { dayNum, date, members:[user] }
  for (const [u, firstIso] of firstSeenUser) {
    const c = dn(firstIso);
    const e = cohorts.get(c) ?? { dayNum: c, date: firstIso, members: [] };
    e.members.push(u);
    cohorts.set(c, e);
  }

  const earliestCohort = cohorts.size ? Math.min(...cohorts.keys()) : latestDayNum;
  const maxOffset = Math.min(30, latestDayNum - earliestCohort);
  const elig = new Array(maxOffset + 1).fill(0);
  const retd = new Array(maxOffset + 1).fill(0);
  for (const [u, firstIso] of firstSeenUser) {
    const f = dn(firstIso);
    const set = userDayNums.get(u);
    const top = Math.min(maxOffset, latestDayNum - f);
    for (let N = 0; N <= top; N++) {
      elig[N]++;
      if (set.has(f + N)) retd[N]++;
    }
  }
  const curveAll = elig.map((e, N) => ({ n: N, eligible: e, pct: e ? retd[N] / e : 0 }));
  const minElig = Math.max(8, Math.round(datedPlayers * 0.02)); // trim the noisy small-sample tail
  let lastN = 1;
  for (let N = 0; N < curveAll.length; N++) if (curveAll[N].eligible >= minElig) lastN = N;
  const curve = curveAll.slice(0, Math.max(2, lastN + 1));
  const atN = (N) => (curveAll[N] && curveAll[N].eligible >= 8 ? curveAll[N].pct : null);

  let multiDay = 0;
  let activeDaysSum = 0;
  for (const set of userDayNums.values()) {
    activeDaysSum += set.size;
    if (set.size >= 2) multiDay++;
  }

  const gridMaxOffset = Math.min(maxOffset, 14);
  const cohortList = [...cohorts.values()].sort((a, b) => a.dayNum - b.dayNum);
  // Hide tiny cohorts (n<5) — their 100%/0% cells are noise, not signal. The aggregate
  // curve and D1/D3 above still count every player, so headline numbers are unaffected.
  const meaningful = cohortList.filter((c) => c.members.length >= 5);
  const gridSource = meaningful.length ? meaningful : cohortList;
  const grid = (gridSource.length > 12 ? gridSource.slice(-12) : gridSource).map((c) => {
    const obs = latestDayNum - c.dayNum;
    const cells = [];
    for (let N = 0; N <= gridMaxOffset; N++) {
      if (N > obs) { cells.push(null); continue; } // hasn't elapsed yet
      let r = 0;
      for (const u of c.members) if (userDayNums.get(u).has(c.dayNum + N)) r++;
      cells.push({ pct: c.members.length ? r / c.members.length : 0, retained: r });
    }
    return { date: c.date, size: c.members.length, cells };
  });

  const retention = {
    curve, d1: atN(1), d3: atN(3), d7: atN(7),
    returningPct: datedPlayers ? multiDay / datedPlayers : 0,
    multiDay, avgDays: datedPlayers ? activeDaysSum / datedPlayers : 0,
    grid, gridMaxOffset,
  };

  // Bot install timeline: current guilds bucketed by the day the bot joined, with a
  // running total. Continuous from the first install through today so removal-free
  // stretches show as flat line, not missing days.
  const installSeries = [];
  if (installs && installs.joins.length) {
    const byDay = new Map();
    for (const d of installs.joins) byDay.set(d, (byDay.get(d) ?? 0) + 1);
    const today = new Date(now).toISOString().slice(0, 10);
    let cum = 0;
    for (let d = [...byDay.keys()].sort()[0]; d <= today; d = isoMinusDays(d, -1)) {
      const add = byDay.get(d) ?? 0;
      cum += add;
      installSeries.push({ date: d, newInstalls: add, cumInstalls: cum });
    }
  }

  const rooms = [...byScope.entries()]
    .map(([scope, e]) => ({
      scope, kind: scope.startsWith('g:') ? 'server' : scope.startsWith('c:') ? 'dm' : 'other',
      games: e.games, players: e.players.size,
      solveRate: e.games ? e.wins / e.games : 0, last: e.last,
    }))
    .sort((a, b) => b.players - a.players || b.games - a.games)
    .slice(0, 12);

  const topPlayers = [...byUser.values()]
    .map((e) => ({
      name: e.name, avatar: e.avatar, total: e.total, plays: e.plays, wins: e.wins,
      winPct: e.plays ? Math.round((100 * e.wins) / e.plays) : 0,
    }))
    .sort((a, b) => b.plays - a.plays || b.total - a.total)
    .slice(0, 15);

  const recent = rows.slice(0, 25).map((r) => ({
    name: r.name, avatar: r.avatar, scope: r.scope_id, score: r.score, mistakes: r.mistakes,
    solved: r.solved, groups: r.groups_solved, puzzle: r.puzzle_id, at: r.created_at, durationMs: r.duration_ms,
  }));

  const latestRows = latestDate ? rows.filter((r) => r.puzzle_date === latestDate) : [];
  const onlineNow = (presence ?? []).filter((p) => now - Date.parse(p.last_seen) < ONLINE_TTL_MS).length;
  const active5m = (presence ?? []).filter((p) => now - Date.parse(p.last_seen) < 5 * 60_000).length;

  return {
    generatedAt: now,
    totals: {
      games: totalPlays,
      finished: rows.length,
      abandoned: abandonedPlays,
      players: players.size,
      servers: [...scopes].filter((s) => s.startsWith('g:')).length,
      rooms: scopes.size,
      botInstalls: installs?.count ?? null,
      installsDated: installs?.joins.length ?? null, // < botInstalls while the disk-cache backfill is still running
      memberReach: installs?.memberReach ?? null,
      largestServer: installs?.largest ?? null,
      // Servers that ever had a live card posted — reach, not installs (includes
      // user-install servers and ones that later removed the bot).
      cardServers: cardStats.cardServers,
      newPlayers7,
      wau: wau.size,
      peak,
      solveRate: totalPlays ? solved / totalPlays : 0, // abandoned games count as unsolved
      avgMistakes: rows.length ? mistakesSum / rows.length : 0,
      avgScore: rows.length ? scoreSum / rows.length : 0,
      puzzlesCached: puzzlesCached ?? 0,
      totalPoints: scoreSum,
      perfectGames: perfect,
      perfectPct: rows.length ? perfect / rows.length : 0,
      cardsPosted: cardStats.cardsPosted,
      recapPosts: recapPosts ?? 0,
      fastestMs,
      medianMs,
    },
    latest: {
      date: latestDate,
      puzzle: latestRows[0]?.puzzle_id ?? null, // null until the day's first finisher lands
      players: latestDate ? byDate.get(latestDate).players.size : 0,
      onlineNow,
      active5m,
    },
    series,
    installSeries,
    retention,
    rooms,
    topPlayers,
    recent,
  };
}

// ── render helpers ────────────────────────────────────────────────────────────

// Discord dark-theme surfaces (chat #313338, card #2b2d31) and inks, plus the
// chart palette: green / blurple / gold / pink, validated for CVD separation,
// lightness band, and contrast against the card surface. C.gold is a darkened
// chart-mark step of Discord's #f0b232 — the brand yellow itself is too light to
// sit on these surfaces as a fill, so it survives only as a text accent
// (C.goldText). Series colors follow the entity everywhere: green = active
// players, blurple = new players, pink = servers, gold = bot installs.
const C = {
  bg: '#313338', panel: '#2b2d31', hover: '#35373c', border: '#3f4147', grid: '#3a3c42',
  head: '#f2f3f5', text: '#dbdee1', soft: '#b5bac1', muted: '#949ba4', faint: '#80848e',
  green: '#23a55a', blurple: '#5865f2', gold: '#b8831c', goldText: '#f0b232', pink: '#eb459e', red: '#f23f43',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const pct = (x) => Math.round((x ?? 0) * 100) + '%';
const one = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const compact = (n) => {
  n = Math.round(n);
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n);
};
const big = (n) => {
  n = Math.round(n);
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
  return String(n);
};
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return MON[+m] + ' ' + +d;
}
function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function dur(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function scopeLabel(scope) {
  if (!scope) return 'unknown';
  const tail = scope.slice(-4);
  if (scope.startsWith('g:')) return guildNameById.get(scope.slice(2)) || 'Server ·' + tail;
  if (scope.startsWith('c:')) return 'DM/Group ·' + tail;
  return scope;
}
function avatarHtml(url, name, size = 22) {
  const initial = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  if (url)
    return `<img src="${esc(url)}" width="${size}" height="${size}" class="av" loading="lazy"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'av av-fb',textContent:'${initial}'}))">`;
  return `<span class="av av-fb" style="width:${size}px;height:${size}px">${initial}</span>`;
}
function kpi(label, value, sub, accent) {
  return `<div class="kpi"><div class="kpi-v"${accent ? ` style="color:${accent}"` : ''}>${value}</div>
    <div class="kpi-l">${esc(label)}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;
}
function retStat(label, value, sub, accent) {
  return `<div class="ret-stat"><div class="v"${accent ? ` style="color:${accent}"` : ''}>${value}</div>
    <div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

// ── charts ────────────────────────────────────────────────────────────────────
// Charts mount client-side with Recharts (React UMD bundles served from /vendor,
// cached on disk) so hovering gives a real crosshair + tooltip instead of the old
// SVG <title> tips. renderPage collects one config per chart into window.__CHARTS__
// and this script hydrates them. Every chart is single-series and single-axis on
// purpose — the old dual-axis plots (players left, servers right) let two arbitrary
// scales invent correlation, so paired measures render side by side instead.
const CHART_JS = `
(function () {
  var boxes = document.querySelectorAll('.chart');
  if (typeof Recharts === 'undefined' || typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
    boxes.forEach(function (el) {
      el.innerHTML = '<div class="chart-fallback">Charts need their vendor bundles; the first online boot fetches them. Retrying on next refresh.</div>';
    });
    return;
  }
  var e = React.createElement;
  var R = Recharts;
  function compact(n) {
    return n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1000 ? +(n / 1000).toFixed(1) + 'k' : String(Math.round(n));
  }
  function full(v) { return Number(v).toLocaleString('en-US'); }
  window.__CHARTS__.forEach(function (cfg) {
    var el = document.getElementById(cfg.id);
    if (!el) return;
    var fmtY = cfg.pct ? function (v) { return Math.round(v) + '%'; } : compact;
    var fmtTip = cfg.pct ? function (v) { return v + '%'; } : full;
    var marks = cfg.series.map(function (s) {
      if (s.kind === 'bar')
        return e(R.Bar, { key: s.key, dataKey: s.key, name: s.name, fill: s.color, radius: [3, 3, 0, 0], maxBarSize: 12, isAnimationActive: false });
      if (s.kind === 'line')
        return e(R.Line, { key: s.key, dataKey: s.key, name: s.name, stroke: s.color, strokeWidth: 2, dot: false, activeDot: { r: 3.5, strokeWidth: 0 }, type: 'monotone', isAnimationActive: false });
      return e(R.Area, { key: s.key, dataKey: s.key, name: s.name, stroke: s.color, strokeWidth: 2, fill: s.color, fillOpacity: 0.13, dot: false, activeDot: { r: 3.5, strokeWidth: 0 }, type: 'monotone', isAnimationActive: false });
    });
    var yProps = { tick: { fill: '#949ba4', fontSize: 11 }, tickLine: false, axisLine: false, width: 46, tickFormatter: fmtY };
    if (cfg.pct) yProps.domain = [0, 100];
    var chart = e.apply(null, [
      R.ComposedChart,
      { data: cfg.data, margin: { top: 6, right: 10, bottom: 0, left: 0 } },
      e(R.CartesianGrid, { stroke: '#3a3c42', vertical: false }),
      e(R.XAxis, { dataKey: 'x', tick: { fill: '#949ba4', fontSize: 11 }, tickLine: false, axisLine: { stroke: '#3f4147' }, minTickGap: 32 }),
      e(R.YAxis, yProps),
      e(R.Tooltip, {
        cursor: { stroke: '#4e5058' },
        isAnimationActive: false,
        contentStyle: { background: '#111214', border: '1px solid #2e2f34', borderRadius: 8, boxShadow: '0 8px 16px rgba(0,0,0,.24)', padding: '8px 12px', fontSize: 13 },
        labelStyle: { color: '#f2f3f5', fontWeight: 600, marginBottom: 4 },
        itemStyle: { color: '#dbdee1', padding: 0 },
        formatter: function (v, name) { return [fmtTip(v), name]; },
      }),
    ].concat(marks));
    ReactDOM.createRoot(el).render(e(R.ResponsiveContainer, { width: '100%', height: cfg.h }, chart));
  });
})();
`;

// ── page ──────────────────────────────────────────────────────────────────────

function renderPage(s) {
  const t = s.totals;
  const l = s.latest;
  const full = s.series;
  const recentWin = full.length > 30 ? full.slice(-30) : full;

  const charts = []; // one config per chart, consumed by CHART_JS at the bottom of the page
  const chartDiv = (id, h, data, series, opts = {}) => {
    charts.push({ id, h, data, series, ...opts });
    return `<div class="chart" id="${id}" style="height:${h}px"></div>`;
  };

  const activeChart = chartDiv('c-active', 240,
    recentWin.map((d) => ({ x: shortDate(d.date), v: d.players })),
    [{ key: 'v', name: 'Active players', color: C.green }]);
  const newPlayersChart = chartDiv('c-newp', 200,
    recentWin.map((d) => ({ x: shortDate(d.date), v: d.newPlayers })),
    [{ key: 'v', name: 'New players', color: C.blurple }]);
  const newServersChart = chartDiv('c-news', 200,
    recentWin.map((d) => ({ x: shortDate(d.date), v: d.newServers })),
    [{ key: 'v', name: 'New servers', color: C.pink }]);
  const cumPlayersChart = chartDiv('c-cump', 200,
    full.map((d) => ({ x: shortDate(d.date), v: d.cumPlayers })),
    [{ key: 'v', name: 'Players reached', color: C.green }]);
  const cumServersChart = chartDiv('c-cums', 200,
    full.map((d) => ({ x: shortDate(d.date), v: d.cumServers })),
    [{ key: 'v', name: 'Servers reached', color: C.pink }]);

  const inst = s.installSeries;
  const noInstalls = '<div class="empty">No install data yet. Set DISCORD_BOT_TOKEN in .env to enable this.</div>';
  const installTotalChart = inst.length
    ? chartDiv('c-insttot', 200,
        inst.map((d) => ({ x: shortDate(d.date), v: d.cumInstalls })),
        [{ key: 'v', name: 'Bot installs', color: C.gold }])
    : noInstalls;
  const installNewChart = inst.length
    ? chartDiv('c-instnew', 200,
        inst.map((d) => ({ x: shortDate(d.date), v: d.newInstalls })),
        [{ key: 'v', name: 'New installs', color: C.gold, kind: 'bar' }])
    : noInstalls;
  // The disk-cache backfill (see backfillJoinedAt) dates guilds in the background
  // rather than blocking page load, so right after a fresh install-scan starts the
  // curve only reflects whatever's been dated so far. Flag that instead of letting
  // a partial curve masquerade as the real history.
  const installBackfillNote =
    t.botInstalls != null && t.installsDated != null && t.installsDated < t.botInstalls
      ? `<div class="muted" style="font-size:12px;margin-top:8px">timeline backfilling · ${num(t.installsDated)} of ${num(t.botInstalls)} servers dated</div>`
      : '';

  // retention
  const R = s.retention;
  const dash = (x) => (x == null ? '<span class="muted">—</span>' : pct(x));
  const retStrip = `<div class="ret-strip">
    ${retStat('Next-day (D1)', dash(R.d1), 'play again the next day', C.green)}
    ${retStat('Day 3', dash(R.d3), 'still active at +3d')}
    ${retStat('Day 7', dash(R.d7), 'still active at +7d')}
    ${retStat('Returning players', pct(R.returningPct), `${num(R.multiDay)} played 2+ days`, C.blurple)}
    ${retStat('Avg active days', one(R.avgDays), 'per player')}
  </div>`;
  const retCurve = R.curve.length
    ? chartDiv('c-ret', 210,
        R.curve.map((c) => ({ x: 'D' + c.n, v: +(c.pct * 100).toFixed(1) })),
        [{ key: 'v', name: 'Still active', color: C.blurple }], { pct: true })
    : '<div class="empty">Not enough history yet.</div>';

  let cohortHtml = '<div class="empty">No cohorts yet.</div>';
  if (R.grid.length) {
    const head = [];
    for (let N = 0; N <= R.gridMaxOffset; N++) head.push(`<th class="r">D${N}</th>`);
    const body = R.grid
      .map((row) => {
        const cells = row.cells
          .map((cell) => {
            if (!cell) return `<td class="cell empty-cell"></td>`;
            const a = (0.07 + 0.68 * cell.pct).toFixed(3);
            const fg = cell.pct >= 0.45 ? '#0d1310' : C.muted;
            return `<td class="cell" style="background:rgba(35,165,90,${a});color:${fg}" title="${cell.retained}/${row.size} came back">${Math.round(cell.pct * 100)}</td>`;
          })
          .join('');
        return `<tr><td class="mono">${esc(shortDate(row.date))}</td><td class="r muted">${num(row.size)}</td>${cells}</tr>`;
      })
      .join('');
    cohortHtml = `<table class="cohort"><thead><tr><th>Cohort</th><th class="r">New</th>${head.join('')}</tr></thead><tbody>${body}</tbody></table>
      <div class="legend"><span>lower</span><span class="heat"></span><span>higher</span>
      <span style="margin-left:6px">· each cell = % of that day's new players active N days later</span></div>`;
  }

  const topPlayers = s.topPlayers
    .map(
      (p, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="who">${avatarHtml(p.avatar, p.name)}<span>${esc(p.name)}</span></td>
      <td class="r">${num(p.plays)}</td>
      <td class="r muted">${num(p.total)}</td>
      <td class="r muted">${p.winPct}%</td>
    </tr>`
    )
    .join('');

  const rooms = s.rooms
    .map(
      (r) => `<tr>
      <td class="who"><span class="tag ${r.kind}">${r.kind === 'server' ? 'Server' : r.kind === 'dm' ? 'DM' : '—'}</span>
        <span class="mono">${esc(scopeLabel(r.scope))}</span></td>
      <td class="r">${num(r.players)}</td>
      <td class="r">${num(r.games)}</td>
      <td class="r muted">${esc(r.last || '—')}</td>
    </tr>`
    )
    .join('');

  const recent = s.recent
    .map((r) => {
      const outcome = r.solved ? `<span class="ok">won</span>` : `<span class="bad">${r.groups ?? 0}/4</span>`;
      return `<div class="feed-row">
        ${avatarHtml(r.avatar, r.name, 20)}
        <span class="feed-name">${esc(r.name)}</span>
        <span class="feed-out">${outcome}</span>
        <span class="feed-score">${num(r.score)} pts</span>
        <span class="feed-meta">${r.mistakes}✗ · ${dur(r.durationMs)} · #${r.puzzle ?? '?'} · ${esc(scopeLabel(r.scope))}</span>
        <span class="feed-ago">${esc(ago(r.at))}</span>
      </div>`;
    })
    .join('');

  const updated = new Date(s.generatedAt).toLocaleTimeString('en-US');
  const chartData = JSON.stringify(charts).replace(/</g, '\\u003c');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Disconnections admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${C.bg};color:${C.text};font:14px/1.45 'gg sans','Noto Sans','Helvetica Neue',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased;padding:24px 28px 44px;max-width:1180px;margin:0 auto}
  .channel{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid ${C.border};margin-bottom:18px;flex-wrap:wrap}
  .hash{color:${C.faint};font-size:22px;font-weight:500}
  .chname{color:${C.head};font-size:17px;font-weight:600}
  .topic{color:${C.muted};font-size:13px;border-left:1px solid ${C.border};padding-left:12px;margin-left:4px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:120px}
  .live{display:inline-flex;align-items:center;gap:7px;color:${C.green};font-size:13px;font-weight:600;margin-left:auto}
  .pulse{width:10px;height:10px;border-radius:50%;background:${C.green};animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(35,165,90,.45)}70%{box-shadow:0 0 0 7px rgba(35,165,90,0)}100%{box-shadow:0 0 0 0 rgba(35,165,90,0)}}
  @media (prefers-reduced-motion:reduce){.pulse{animation:none}}
  :focus-visible{outline:2px solid ${C.blurple};outline-offset:2px}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:10px}
  .kpi{background:${C.panel};border-radius:8px;padding:14px 16px}
  .kpi-v{font-size:23px;font-weight:700;color:${C.head}}
  .kpi-l{font-size:13px;color:${C.soft};margin-top:2px}
  .kpi-s{font-size:12px;color:${C.faint};margin-top:3px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
  .grid2 .panel{margin-bottom:0}
  .panel{position:relative;background:${C.panel};border-radius:8px;padding:16px 18px 14px;margin-bottom:10px}
  .panel.ac{padding-left:22px}
  .panel.ac::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:8px 0 0 8px;background:var(--ac)}
  h2{font-size:15px;font-weight:600;color:${C.head};margin-bottom:12px}
  .hsub{font-weight:400;font-size:13px;color:${C.faint};margin-left:6px}
  .muted{color:${C.muted}}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .chart{width:100%}
  .chart-fallback,.empty{color:${C.faint};padding:24px;text-align:center;font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:12px;color:${C.muted};font-weight:500;padding:0 8px 8px}
  th.r,td.r{text-align:right}
  td{padding:7px 8px;border-top:1px solid #3b3d43;vertical-align:middle;font-variant-numeric:tabular-nums}
  tr:hover td{background:${C.hover}}
  .rank{color:${C.faint};width:24px}
  .who{display:flex;align-items:center;gap:8px}
  .who span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}
  .av{border-radius:50%;object-fit:cover;flex:none;background:#232428}
  .av-fb{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;
    background:#232428;color:${C.muted};font-size:11px;font-weight:700}
  .tag{font-size:11px;font-weight:600;padding:1px 7px;border-radius:4px;flex:none}
  .tag.server{background:rgba(88,101,242,.18);color:#a6aef7}
  .tag.dm{background:rgba(235,69,158,.16);color:#f191c8}
  .ret-strip{display:flex;gap:30px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid ${C.border}}
  .ret-stat .v{font-size:21px;font-weight:700;color:${C.head}}
  .ret-stat .l{font-size:13px;color:${C.soft};margin-top:2px}
  .ret-stat .s{font-size:12px;color:${C.faint};margin-top:1px}
  table.cohort{font-size:12px}
  table.cohort th,table.cohort td{padding:5px 7px}
  table.cohort .cell{text-align:center;font-weight:600;min-width:34px}
  table.cohort .empty-cell{background:transparent}
  .legend{display:flex;gap:10px;align-items:center;color:${C.muted};font-size:12px;margin-top:10px;flex-wrap:wrap}
  .heat{display:inline-block;width:80px;height:9px;border-radius:5px;vertical-align:middle;
    background:linear-gradient(90deg,rgba(35,165,90,.07),rgba(35,165,90,.75))}
  .feed-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #3b3d43;font-size:13px}
  .feed-row:first-child{border-top:0}
  .feed-name{font-weight:600;color:${C.head};max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .feed-out .ok{color:${C.green};font-weight:700}
  .feed-out .bad{color:${C.muted}}
  .feed-score{font-variant-numeric:tabular-nums}
  .feed-meta{color:${C.faint};font-size:11px;margin-left:auto;text-align:right}
  .feed-ago{color:${C.faint};font-size:11px;width:62px;text-align:right;flex:none}
  @media (max-width:880px){.kpis{grid-template-columns:repeat(3,1fr)}.grid2{grid-template-columns:1fr}}
</style></head><body>

<header class="channel">
  <span class="hash">#</span><span class="chname">disconnections-admin</span>
  <span class="topic">local only (127.0.0.1) · service-role read · refreshed ${esc(updated)}${
    l.date ? ` · puzzle #${esc(l.puzzle ?? '?')} (${esc(l.date)})` : ''
  }</span>
  <span class="live"><span class="pulse"></span>${l.onlineNow} online${
    l.active5m > l.onlineNow ? ` · ${l.active5m} active (5m)` : ''
  }</span>
</header>

<div class="kpis">
  ${kpi('Players reached', num(t.players), `+${num(t.newPlayers7)} this week`, C.green)}
  ${kpi('Active this week', num(t.wau), `${num(l.players)} on today's puzzle`, C.blurple)}
  ${kpi('Servers', num(t.servers), `${t.botInstalls == null ? '—' : num(t.botInstalls)} bot installs · ${num(t.cardServers)} reached · ${num(t.rooms)} rooms`, C.pink)}
  ${kpi('Games played', num(t.games), `${num(t.finished)} finished · ${num(t.abandoned)} abandoned`)}
  ${kpi('Peak day', num(t.peak.players), t.peak.date ? `players · ${esc(shortDate(t.peak.date))}` : '—')}
  ${kpi('Solve rate', pct(t.solveRate), `of all plays · avg ${one(t.avgMistakes)} mistakes`)}
</div>

<div class="kpis">
  ${kpi(
    'Member reach',
    t.memberReach == null ? '—' : big(t.memberReach),
    t.memberReach == null
      ? 'needs DISCORD_BOT_TOKEN'
      : `across ${num(t.botInstalls ?? 0)} bot servers · largest ${big(t.largestServer)}`,
    C.goldText
  )}
  ${kpi('Points scored', big(t.totalPoints), 'across every game', C.green)}
  ${kpi('Perfect games', num(t.perfectGames), `${pct(t.perfectPct)} of finished, flawless`, C.blurple)}
  ${kpi('Cards rendered', num(t.cardsPosted), 'server-side PNGs posted', C.pink)}
  ${kpi('Recaps posted', num(t.recapPosts), 'daily bot messages')}
  ${kpi('Solve time', dur(t.medianMs), `median · fastest ${dur(t.fastestMs)}`)}
</div>

<section class="panel ac" style="--ac:${C.green}">
  <h2>Daily active players <span class="hsub">anyone who started that day's puzzle · last ${recentWin.length} days</span></h2>
  ${activeChart}
</section>

<div class="grid2">
  <section class="panel ac" style="--ac:${C.blurple}">
    <h2>New players per day <span class="hsub">first ever game</span></h2>
    ${newPlayersChart}
  </section>
  <section class="panel ac" style="--ac:${C.pink}">
    <h2>New servers per day <span class="hsub">first game in the server</span></h2>
    ${newServersChart}
  </section>
</div>

<div class="grid2">
  <section class="panel ac" style="--ac:${C.green}">
    <h2>Players reached <span class="hsub">cumulative, all time</span></h2>
    ${cumPlayersChart}
  </section>
  <section class="panel ac" style="--ac:${C.pink}">
    <h2>Servers reached <span class="hsub">cumulative, all time</span></h2>
    ${cumServersChart}
  </section>
</div>

<div class="grid2">
  <section class="panel ac" style="--ac:${C.gold}">
    <h2>Bot installs <span class="hsub">running total by join date · removals drop out</span></h2>
    ${installTotalChart}
    ${installBackfillNote}
  </section>
  <section class="panel ac" style="--ac:${C.gold}">
    <h2>New installs per day</h2>
    ${installNewChart}
  </section>
</div>

<section class="panel ac" style="--ac:${C.blurple}">
  <h2>Retention <span class="hsub">do new players come back?</span></h2>
  ${retStrip}
  ${retCurve}
</section>

<section class="panel">
  <h2>Cohort retention <span class="hsub">% of each day's new players active N days later</span></h2>
  ${cohortHtml}
</section>

<div class="grid2">
  <section class="panel">
    <h2>Most active players</h2>
    ${
      s.topPlayers.length
        ? `<table><thead><tr><th></th><th>Player</th><th class="r">Plays</th><th class="r">Score</th><th class="r">Win%</th></tr></thead><tbody>${topPlayers}</tbody></table>`
        : '<div class="empty">No players yet.</div>'
    }
  </section>
  <section class="panel">
    <h2>Top rooms</h2>
    ${
      s.rooms.length
        ? `<table><thead><tr><th>Room</th><th class="r">Players</th><th class="r">Games</th><th class="r">Last</th></tr></thead><tbody>${rooms}</tbody></table>`
        : '<div class="empty">No rooms yet.</div>'
    }
  </section>
</div>

<section class="panel">
  <h2>Recent games</h2>
  ${recent || '<div class="empty">No games yet.</div>'}
</section>

<script>window.__CHARTS__=${chartData};</script>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script src="/vendor/prop-types.js"></script>
<script src="/vendor/recharts.js"></script>
<script>${CHART_JS}</script>
</body></html>`;
}

// ── chart vendor bundles ──────────────────────────────────────────────────────
// React + Recharts UMD builds, pulled from unpkg once and cached in
// scripts/.dashboard-vendor/ (gitignored with the other dashboard caches), then
// served from disk at /vendor/*. After the first online boot the page is fully
// self-hosted, so an offline session or an unpkg outage never breaks the charts.
// URLs are version-pinned, which is why /vendor/* can be cached as immutable.
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dashboard-vendor');
const VENDOR = {
  'react.js': 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'react-dom.js': 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'prop-types.js': 'https://unpkg.com/prop-types@15.8.1/prop-types.min.js', // Recharts' UMD expects a PropTypes global
  'recharts.js': 'https://unpkg.com/recharts@2.15.4/umd/Recharts.js',
};

async function vendorFile(name) {
  const url = VENDOR[name];
  if (!url) return null;
  const file = path.join(VENDOR_DIR, name);
  try {
    return fs.readFileSync(file);
  } catch {
    // not cached yet — fetch and store below
  }
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`vendor ${name}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  try {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
  } catch {
    // best effort — worst case the next request re-fetches
  }
  return buf;
}

// ── server ───────────────────────────────────────────────────────────────────
// Requests never trigger data work. A background loop refreshes loadStats() every
// 30s and keeps a fully rendered page in memory; '/' answers from that string, so
// the only request that ever waits is the very first one after a cold boot. A
// failed refresh keeps serving the previous snapshot (stale beats blank for a
// local admin page) and logs to the console.

let snapshot = null; // { html, at } — the pre-rendered page served to every request
let refreshing = null; // in-flight refresh promise; doubles as the first-paint gate

function refreshSnapshot() {
  if (!refreshing) {
    refreshing = loadStats()
      .then((stats) => {
        snapshot = { html: renderPage(stats), at: Date.now() };
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const server = createServer(async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (req.url?.startsWith('/vendor/')) {
    try {
      const buf = await vendorFile(req.url.slice('/vendor/'.length));
      if (!buf) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('vendor fetch failed: ' + (e?.message ?? String(e)));
    }
    return;
  }
  try {
    if (!snapshot) await refreshSnapshot();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(snapshot.html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Dashboard error: ' + (e?.message ?? String(e)) + '\n\nCheck SUPABASE_* keys in .env.');
    console.error(e);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Disconnections admin dashboard → ${url}`);
  console.log('  (local only — bound to 127.0.0.1; Ctrl-C to stop)\n');
  if (process.platform === 'darwin' && process.env.DASHBOARD_NO_OPEN !== '1') exec(`open ${url}`);
});

// Warm everything at boot instead of on first request: the snapshot starts
// building immediately and re-refreshes every 30s, and the chart bundles land in
// the disk cache if they aren't there yet.
refreshSnapshot().catch((e) => console.error('initial refresh: ' + (e?.message ?? e)));
setInterval(() => refreshSnapshot().catch((e) => console.error('refresh: ' + (e?.message ?? e))), 30_000);
for (const name of Object.keys(VENDOR)) vendorFile(name).catch(() => {});
