import { describe, it, expect } from "vitest";
import type { BoardRow } from "./leaderboard";
import { rankMap, rankDelta } from "./standings-snapshot";

const row = (user_id: string): BoardRow => ({
  user_id,
  name: user_id,
  avatar: null,
  total: 0,
  plays: 0,
  wins: 0,
  win_pct: 0,
  avg_mistakes: 0,
  streak: 0,
});

describe("rankMap", () => {
  it("assigns 1-based ranks in board order", () => {
    expect(rankMap([row("a"), row("b"), row("c")])).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("is empty for an empty board", () => {
    expect(rankMap([])).toEqual({});
  });
});

describe("rankDelta", () => {
  const prev = { a: 1, b: 3, c: 5 };

  it("is positive when a player climbed (smaller rank now)", () => {
    expect(rankDelta(prev, "c", 2)).toBe(3); // 5 -> 2
  });

  it("is negative when a player slipped", () => {
    expect(rankDelta(prev, "a", 2)).toBe(-1); // 1 -> 2
  });

  it("is 0 when the rank is unchanged", () => {
    expect(rankDelta(prev, "b", 3)).toBe(0);
  });

  it("is null for a player absent from the prior snapshot (new)", () => {
    expect(rankDelta(prev, "z", 4)).toBeNull();
  });

  it("is null when there is no prior snapshot at all", () => {
    expect(rankDelta(null, "a", 1)).toBeNull();
    expect(rankDelta(undefined, "a", 1)).toBeNull();
  });
});
