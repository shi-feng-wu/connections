import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game, MAX_MISTAKES, type Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { query } from './_query.js';

// Persistent "who's played this room today" roster for the live panel. Returns every player
// we can identify who has played today — replayed server-side from their committed guesses
// (the same record /api/score trusts): finishers and abandoners alike, frozen at their last
// committed state.
//
// This is the COLD-START / safety-net read, not a poll. The client runs it on load, on
// reconnect/foreground, and a 5-min backstop; Realtime broadcasts (api/_realtime.ts) carry the
// live progress in between, and Discord's own participant list drives the green "online" ring —
// so this handler computes no live presence (the `online` field it still returns is ignored by
// the client). Side-effect-free and per-room, so the response stays CDN-cacheable; identity is
// verified at the edge (middleware.ts) via the x-ct ticket before the cache.
//
// The player SET is the union of two identity sources, because that's everywhere a
// player's name/avatar is recorded:
//   • live_cards.players — append-only via /api/join (on open, before play) + launches.
//   • scores             — written on every finish by /api/score, scoped the same way.
// Sourcing from live_cards alone dropped anyone whose /api/join never landed (a network
// blip, a membership check, or the finished-gate that permanently blocks re-adds): they
// played, even finished, yet never appeared. Unioning scores recovers every finisher.
//
// Works for any room scope: a guild (g:) or a DM/group (c:). live_cards.players exists only
// for g: scopes (the bot posts those), so a DM's identity comes from scores alone — which is
// fine, since assembleRoster unions both sources. Read-gated by the signed auth ticket (same
// as /api/start); the data is the public "who's playing" card content.

type ScoreRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  solved: boolean;
  mistakes: number;
  // Optional: absent on pre-migration rows / older fixtures → treated as 0.
  hints_used?: number;
  groups_solved: number;
  duration_ms: number | null;
};
type ProgressRow = {
  user_id: string;
  guesses: unknown;
  hints?: unknown; // optional; absent → no hints (see fromGuesses)
  started_at: string | null;
  updated_at: string | null;
};

// The roster row the client consumes — structurally a PlayerState (src/realtime.ts),
// declared locally so this serverless route never imports client-only code.
type RosterPlayer = {
  userId: string;
  name: string;
  avatar?: string;
  mistakesLeft: number;
  solvedCount: number;
  solvedLevels: number[];
  hintsUsed: number;
  picking: false;
  done: 'won' | 'lost' | null;
  startedAt: number;
  finishedAt: number | null;
  // True when this player's heartbeat (last_seen) is within the TTL — drives the green ring.
  online: boolean;
};

// A player is "online" (green ring) when their /api/roster heartbeat is within this window.
// Clients poll ~30s, so a reliably-polling player stays inside the TTL (30s < 40s) while a
// backgrounded client (which simply stops polling) ages out of it on its own. A single
// dropped beat can blink the ring for one cycle; the next poll's heartbeat revives it.
const ROSTER_ONLINE_TTL_MS = 40_000;

// A finished roster row built from a scores row, for a player whose progress row is
// missing/unparseable (or who finished without one). A scores row exists only for a
// finished game, so this is always done.
function synthFromScore(p: CardPlayer, s: ScoreRow, now: number, online: boolean): RosterPlayer {
  const dur = typeof s.duration_ms === 'number' && s.duration_ms > 0 ? s.duration_ms : 0;
  const count = Math.max(0, Math.min(4, s.groups_solved ?? 0));
  return {
    userId: p.id,
    name: p.name,
    avatar: p.avatar ?? undefined,
    mistakesLeft: Math.max(0, MAX_MISTAKES - (s.mistakes ?? 0)),
    solvedCount: count,
    // scores stores only the count, not which levels; approximate with the easiest
    // `count`. Exact for a winner (all four); a partial loss may paint the wrong
    // category colours on the mini-board (cosmetic, rare fallback only).
    solvedLevels: Array.from({ length: count }, (_, i) => i),
    hintsUsed: Math.max(0, s.hints_used ?? 0),
    picking: false,
    done: s.solved ? 'won' : 'lost',
    // Frozen timer: roster.tsx elapsed = (finishedAt ?? now) - (startedAt || now) = dur.
    // startedAt must be non-zero (the `|| now` guard), so anchor both at `now`.
    startedAt: now,
    finishedAt: now + dur,
    online,
  };
}

// Pure roster assembly, separated from DB I/O so it's unit-testable. The identity set is
// joined ∪ finishers; each player's live state is replayed from their progress row, with
// a scores-derived fallback for finishers whose progress is gone. A player who joined but
// never started (no progress, no score) is dropped — they're in the room but haven't
// played. Without the puzzle we can't replay, so we return only the self-contained
// finishers (frozen) rather than emptying the roster on a transient puzzle-fetch blip.
export function assembleRoster(
  joined: CardPlayer[],
  scoreRows: ScoreRow[],
  progressRows: ProgressRow[],
  puzzle: Puzzle | null,
  now: number,
  lastSeen?: Map<string, number>,
  onlineTtlMs = ROSTER_ONLINE_TTL_MS,
): RosterPlayer[] {
  // Green-ring test: heartbeat within the TTL. No map (older callers / tests) → all offline.
  const isOnline = (id: string): boolean =>
    !!lastSeen && now - (lastSeen.get(id) ?? 0) < onlineTtlMs;
  const ids = new Map<string, CardPlayer>();
  for (const p of joined) ids.set(p.id, p); // live_cards wins on collision (join-time identity)
  for (const s of scoreRows) if (!ids.has(s.user_id)) ids.set(s.user_id, { id: s.user_id, name: s.name, avatar: s.avatar });

  const scoreById = new Map<string, ScoreRow>();
  for (const s of scoreRows) scoreById.set(s.user_id, s);
  const progById = new Map<string, ProgressRow>();
  for (const r of progressRows) progById.set(r.user_id, r);

  if (!puzzle) {
    return [...ids.values()].flatMap((p) => {
      const s = scoreById.get(p.id);
      return s ? [synthFromScore(p, s, now, isOnline(p.id))] : [];
    });
  }

  return [...ids.values()].flatMap((p) => {
    const row = progById.get(p.id);
    const startedAt = row?.started_at ? Date.parse(row.started_at) : NaN;
    if (!Number.isNaN(startedAt)) {
      const guesses = row && Array.isArray(row.guesses) ? (row.guesses as string[][]) : [];
      const game = Game.fromGuesses(puzzle, guesses, startedAt, row?.hints);
      const done = game.status === 'playing' ? null : game.status;
      const finishedAt = done && row?.updated_at ? Date.parse(row.updated_at) : NaN;
      const solvedLevels = game.deducedLevels;
      return [
        {
          userId: p.id,
          name: p.name,
          avatar: p.avatar ?? undefined,
          mistakesLeft: game.mistakesLeft,
          solvedCount: solvedLevels.length,
          solvedLevels,
          hintsUsed: game.hintsUsed,
          picking: false as const,
          done,
          startedAt,
          finishedAt: Number.isNaN(finishedAt) ? null : finishedAt,
          online: isOnline(p.id),
        },
      ];
    }
    // No usable progress: show them if they finished (scores), else drop (joined, not played).
    const s = scoreById.get(p.id);
    return s ? [synthFromScore(p, s, now, isOnline(p.id))] : [];
  });
}

// What one roster_bundle RPC returns (supabase/schema.sql): every read a poll needs, in a
// single round-trip — members is already one-row-per-user (latest identity, deduped by
// `distinct on` server-side), the rest mirror the old per-table queries.
type RosterBundle = {
  members: CardPlayer[];
  card_players: CardPlayer[];
  scores: ScoreRow[];
  progress: ProgressRow[];
  seen: { user_id: string; last_seen: string }[];
};

// One bundle per (scope view, day), shared across a warm instance for a short TTL. Fluid
// compute serves many concurrent requests from one instance with shared module state (the
// same trick as the puzzle cache in _nyt.ts), so room-mates whose polls land inside the
// window share one DB trip. The read is now write-free (p_uid is null below — no per-poll
// last_seen heartbeat; the online ring is driven by Discord's ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE,
// not by a presence row). 10s keeps worst-case roster staleness under one 15s poll interval.
const BUNDLE_TTL_MS = 10_000;
const bundleCache = new Map<string, { at: number; bundle: RosterBundle }>();

export function cachedBundle(key: string, now: number): RosterBundle | null {
  const hit = bundleCache.get(key);
  if (hit && now - hit.at < BUNDLE_TTL_MS) return hit.bundle;
  if (hit) bundleCache.delete(key);
  return null;
}

export function cacheBundle(key: string, bundle: RosterBundle, now: number): void {
  // Opportunistic sweep so dead scopes don't accumulate across a long-lived instance.
  if (bundleCache.size >= 256) {
    for (const [k, v] of bundleCache) if (now - v.at >= BUNDLE_TTL_MS) bundleCache.delete(k);
  }
  bundleCache.set(key, { at: now, bundle });
}

// Per-room read shared at Vercel's CDN for ~20s, so N players in a room cost ~1 origin hit
// per window, not N. Vercel-CDN-Cache-Control governs the edge cache and is NOT echoed to the
// client; the client's Cache-Control is max-age=0 so the browser always revalidates (every
// poll reaches the CDN, which answers from the shared cache) rather than serving its own stale
// copy. 20s keeps roster staleness under one poll; the 40s online-TTL's missed-beat slack
// already absorbs it.
function cacheRoster(res: VercelResponse): void {
  res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Identity was verified at the edge (middleware.ts) via the x-ct ticket, ahead of the cache,
  // so this handler is purely a per-room read — no uid, no write — which is what makes the
  // response cacheable and shareable. Scope rides in the query string so it keys the cache.
  const q = query(req);
  const guildId = q.get('g');
  const channelId = q.get('c');
  const scope = canonicalScope(guildId, channelId);
  const db = admin();
  // No scope or no store (standalone/DM with no persistent roster) → empty, and don't cache
  // it (it's per-context, not per-room, and cheap — no DB hit).
  if (!scope || !db) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ players: [] });
    return;
  }

  const date = todayET();
  // Both views are MEMBERSHIP-based (mirrors the leaderboard): the member set is everyone who
  // has ever played in this scope — narrowed to this channel for the Channel view, the whole
  // guild for Server. A member's one daily game then surfaces here wherever they launched it
  // today; members who didn't play today are dropped by assembleRoster.
  //
  // Channel narrowing only applies to a guild scope, where one guild spans many channels. A
  // c: DM/group scope IS a single channel, so narrowing is redundant and would drop legacy
  // rows written before channel_id existed — skip it (guildId is null for a DM/group).
  const wantChannel = q.get('view') !== 'server';
  const narrowTo = wantChannel && channelId && guildId ? channelId : null;

  const now = Date.now();
  // Independent of the bundle, and usually free (read-through cached in _nyt.ts).
  const puzzleP = fetchPuzzle(date).catch(() => null);

  // In-memory layer behind the CDN: absorbs the CDN's per-window revalidation and any misses
  // that land on a warm instance. No heartbeat rides along now — the read writes nothing.
  let bundle = cachedBundle(`${scope}|${narrowTo ?? ''}|${date}`, now);
  if (!bundle) {
    const { data, error } = await db.rpc('roster_bundle', {
      p_scope: scope,
      p_date: date,
      p_channel: narrowTo,
      p_uid: null,
    });
    if (error || !data) {
      // Degrade to an empty roster, never a 500 — but don't cache a transient failure.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ players: [] });
      return;
    }
    bundle = data as RosterBundle;
    cacheBundle(`${scope}|${narrowTo ?? ''}|${date}`, bundle, now);
  }

  // Identity per id: a member's most-recent score name/avatar, then today's card openers
  // override (freshest join-time identity). assembleRoster keeps only those who played today.
  const identity = new Map<string, CardPlayer>();
  for (const m of bundle.members) identity.set(m.id, m);
  for (const p of bundle.card_players) if (p && typeof p.id === 'string') identity.set(p.id, p);
  const joined = [...identity.values()];
  if (!joined.length) {
    // An empty room is still a valid shared answer for the window — cache it like any roster.
    cacheRoster(res);
    res.status(200).json({ players: [] });
    return;
  }

  // last_seen per player → the "online" set assembleRoster paints the green ring from.
  const lastSeen = new Map<string, number>();
  for (const r of bundle.seen) {
    const t = Date.parse(r.last_seen);
    if (!Number.isNaN(t)) lastSeen.set(r.user_id, t);
  }

  const players = assembleRoster(joined, bundle.scores, bundle.progress, await puzzleP, now, lastSeen);
  cacheRoster(res);
  res.status(200).json({ players });
}
