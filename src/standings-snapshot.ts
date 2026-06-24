import { useEffect, useRef, useState } from "react";
import type { BoardRow } from "./leaderboard";
import { type RankSnapshot, rankMap, rankDelta } from "./rank-delta";

// "Position change since today's puzzle dropped" for the standings tabs. The board itself
// carries no rank — it arrives ordered richest-first and rank is just the row index
// (see season.tsx). So to show movement we keep a per-device baseline of {user_id -> rank}
// captured at the start of the current ET puzzle-day, and diff the current ranks against
// it. The baseline is frozen for the whole day and recaptured at the next midnight-ET
// rollover (when the new Connections is released), so arrows accumulate across the day and
// reset daily. Per-device by design (localStorage): the agreed zero-backend implementation,
// so arrows can differ across devices and reset if storage is cleared. The pure diff math
// (rankMap/rankDelta) lives in ./rank-delta so the server recap can reuse it.

const PREFIX = "connections:standingsRank:";

// Re-exported so existing consumers (season.tsx, the test) keep importing from here.
export { rankMap, rankDelta };

// A day's baseline ranking: the standings as of the start of ET day `date`.
export type Baseline = { date: string; ranks: RankSnapshot };

// Today's baseline given what's stored. Same ET day → reuse the stored baseline (so it
// stays frozen and arrows accumulate); a new day, a first-ever view, or a legacy/garbled
// value → today's current ranks become the baseline and must be persisted (arrows reset to
// none until scores shift). Pure, so the daily-reset logic is unit-testable.
export function resolveBaseline(
  stored: Baseline | null,
  today: string,
  current: RankSnapshot,
): { baseline: RankSnapshot; persist: Baseline | null } {
  if (stored && stored.date === today) {
    return { baseline: stored.ranks, persist: null };
  }
  return { baseline: current, persist: { date: today, ranks: current } };
}

function readBaseline(key: string): Baseline | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Baseline> | null;
    // A legacy bare-map value (no `date`) reads as no baseline → treated as a fresh day.
    return v && typeof v === "object" && typeof v.date === "string" && v.ranks
      ? { date: v.date, ranks: v.ranks }
      : null;
  } catch {
    return null; // storage blocked / bad JSON — just show no arrows
  }
}

function writeBaseline(key: string, base: Baseline): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(base));
  } catch {
    /* storage blocked — fine, next open simply finds nothing to diff against */
  }
}

// Returns the baseline ranks for the current ET day `today` (the standings at the day's
// start), recapturing them at each midnight-ET rollover. Keyed on `[key, today]`: a `today`
// change at the rollover re-fires the effect and resets the baseline, while mid-day board
// churn (someone finishes and the order shifts) does NOT — the baseline stays frozen so
// arrows accumulate across the day. A null `key` or `today` (live tab, no room, standalone)
// is a no-op returning null, so the hook stays unconditional.
export function useRankSnapshot(
  key: string | null,
  board: BoardRow[],
  today: string | null,
): RankSnapshot | null {
  const [prev, setPrev] = useState<RankSnapshot | null>(null);
  // Latest board without making it an effect dep — we snapshot at the day boundary, not on churn.
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => {
    if (!key || !today) {
      setPrev(null);
      return;
    }
    const { baseline, persist } = resolveBaseline(
      readBaseline(key),
      today,
      rankMap(boardRef.current),
    );
    setPrev(baseline);
    if (persist) writeBaseline(key, persist);
  }, [key, today]);

  return prev;
}
