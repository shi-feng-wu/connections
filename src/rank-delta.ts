// Pure rank-movement math, shared by the in-app leaderboard (src/standings-snapshot.ts,
// which diffs a per-device daily baseline) and the server-rendered daily recap card
// (api/cron-recap.ts, which diffs through-yesterday vs through-the-day-before). Kept
// React-free so the serverless recap cron can import it without pulling in React.

export type RankSnapshot = Record<string, number>;

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
// slipped. null when there's no prior snapshot or the player wasn't in it (brand-new), so
// the UI shows no arrow. 0 (unchanged) also reads as "no arrow" at the render site.
export function rankDelta(
  prev: RankSnapshot | null | undefined,
  userId: string,
  rank: number,
): number | null {
  const was = prev?.[userId];
  return was != null ? was - rank : null;
}
