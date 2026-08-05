import type { SupabaseClient } from '@supabase/supabase-js';
import { admin } from './_admin.js';

// Shared daily-puzzle helper. Leading underscore keeps Vercel from treating this
// file as a route. Serves ORIGINAL Disconnections puzzles from the `daily_puzzles`
// table — content is written and ingested ahead of time (scripts/ingest-puzzles.mjs),
// so there is no origin fetch: a date either has a row or it doesn't exist.
// Replaces the retired NYT proxy (_nyt.ts) with the same exported surface, so every
// call site (daily, practice, scoring replay, recaps, cards) switched in one move.

export type Group = { level: number; category: string; members: string[] };
export type Puzzle = {
  id: number;
  date: string;
  editor: string;
  groups: Group[];
  layout: string[];
  // Word → image URL. Retained for type-compatibility with the client renderer;
  // original puzzles are text-only, so this is never populated.
  images?: Record<string, string>;
};

// The first date with original content — the switch day. Set PUZZLES_EPOCH in the
// environment at flip time; the fallback only matters for local dev before then.
// Practice/archive bounds and random-date picks all derive from this: the NYT-era
// archive (2023-06-12 onward) is not served, full stop.
export const FIRST_DATE = process.env.PUZZLES_EPOCH ?? '2026-09-01';

const DAY = 86_400_000;
const cache = new Map<string, Puzzle>();

// Read-through cache, cheapest layer first:
//   L1  in-memory Map (per warm instance) — a published puzzle is immutable, no TTL
//   L2  Supabase `daily_puzzles` — the source of truth, written by the ingest script
// No third layer. A miss on both is NOT_FOUND (date beyond today, or a schedule
// gap — the latter is a paging alert, not a fallback case).
//
// TRANSITION BRIDGE: dates BEFORE the epoch read the legacy `puzzles` cache
// instead (cache-only — the NYT origin fetch no longer exists anywhere). This is
// what makes flip day deployable at any hour: the in-flight day keeps serving,
// scoring, and recapping the puzzle it started with, and the first original
// serves at the next ET rollover. User-supplied dates never reach this branch
// (isValidDate floors them at the epoch); only the server's own today/yesterday
// computations do, so the bridge dies naturally — after the transition night's
// recap it is unreachable, and the legacy table is truncated a day later.
// `db` defaults to the service-role admin() client, evaluated only after an L1 miss
// so warm hits stay free; pass an override for tests, or null to skip L2.
export async function fetchPuzzle(dateStr: string, dbOverride?: SupabaseClient | null): Promise<Puzzle> {
  const cached = cache.get(dateStr);
  if (cached) return cached;

  const db = dbOverride !== undefined ? dbOverride : admin();
  if (db) {
    const table = dateStr < FIRST_DATE ? 'puzzles' : 'daily_puzzles';
    const { data: row } = await db
      .from(table)
      .select('data')
      .eq('puzzle_date', dateStr)
      .maybeSingle();
    const stored = (row as { data?: Puzzle } | null)?.data;
    if (stored) {
      cache.set(dateStr, stored);
      return stored;
    }
  }
  throw new Error('NOT_FOUND');
}

const atNoonUTC = (d: string): number => Date.parse(`${d}T12:00:00Z`);
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function todayET(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// The ET calendar day before today. Anchoring at noon UTC keeps a 1h DST shift
// from ever crossing a day boundary, so subtracting one day is exact year-round
// (same trick randomDate relies on). The cron uses this for "yesterday's puzzle".
export function yesterdayET(): string {
  return ymd(atNoonUTC(todayET()) - DAY);
}

export function randomDate(): string {
  const days = Math.floor((atNoonUTC(todayET()) - atNoonUTC(FIRST_DATE)) / DAY);
  return ymd(atNoonUTC(FIRST_DATE) + Math.floor(Math.random() * (days + 1)) * DAY);
}

export function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= FIRST_DATE && d <= todayET();
}
