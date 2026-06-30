// Pure rank-movement math, shared by the in-app leaderboard (src/standings-snapshot.ts,
// which diffs a per-device daily baseline) and the server-rendered daily recap card
// (api/cron-recap.ts, which diffs through-yesterday vs through-the-day-before). Kept
// React-free so the serverless recap cron can import it without pulling in React.

export type RankSnapshot = Record<string, number>;

// A rendered rank movement: a signed places-moved number (0 = unchanged), the "new" sentinel
// for a brand-new entrant against a real baseline, or null for "no indicator" (no baseline).
export type Delta = number | "new" | null;

// {user_id -> 1-based rank} from a board's order (richest-first). Mirrors season.tsx's
// `i + 1`. Takes just the id so both the client BoardRow and the recap SeasonRow fit.
export function rankMap(board: { user_id: string }[]): RankSnapshot {
  const out: RankSnapshot = {};
  board.forEach((r, i) => {
    out[r.user_id] = i + 1;
  });
  return out;
}

// Places moved since `prev` was taken: positive = climbed (smaller rank now), negative =
// slipped, 0 = unchanged (reads as "no arrow" at the render site). "new" when the player is
// absent from a real prior snapshot (brand-new entrant) → the UI shows a dash. null when
// there's no baseline to diff against at all — a missing snapshot OR an empty one (first-ever
// view, or a failed recap prev-board read). The empty-baseline guard is essential: without it
// every row would read as "new" and the whole board would render dashes.
export function rankDelta(
  prev: RankSnapshot | null | undefined,
  userId: string,
  rank: number,
): Delta {
  if (prev == null) return null;
  const was = prev[userId];
  if (was != null) return was - rank;
  return Object.keys(prev).length ? "new" : null;
}
