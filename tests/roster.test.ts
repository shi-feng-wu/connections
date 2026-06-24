import { describe, it, expect } from "vitest";
import { colorFor, initials, rankOf, sortRoster } from "../src/roster";
import { finishedScore } from "../src/game";
import type { PlayerState } from "../src/player";

const NOW = 1_000_000;

function player(o: Partial<PlayerState> & { userId: string }): PlayerState {
  const base: PlayerState = {
    userId: o.userId,
    name: o.userId,
    mistakesLeft: 4,
    solvedCount: 0,
    solvedLevels: [],
    picking: false,
    done: null,
    startedAt: NOW,
    finishedAt: null,
  };
  return { ...base, ...o };
}

describe("initials", () => {
  it("takes the first letter of up to two name parts, uppercased", () => {
    expect(initials("Jun Park")).toBe("JP");
    expect(initials("mara okafor")).toBe("MO");
    expect(initials("Madonna")).toBe("M");
    expect(initials("Ada B. Carter")).toBe("AB"); // capped at two
  });
  it("falls back to ? for an empty name", () => {
    expect(initials("")).toBe("?");
  });
});

describe("colorFor", () => {
  it("is deterministic and returns a hex color", () => {
    const c = colorFor("user-123");
    expect(c).toBe(colorFor("user-123"));
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("sortRoster", () => {
  // Everyone ranks by points: final score for finished runs, banked partial credit
  // (20·groups²) for live ones — so live rows only climb past finished rows, and
  // only when a solve lands.
  const now = NOW + 200_000;
  // solve at 60s → 40s into the decay past the grace: 400 + round(100·(600−40)/600) = 493
  const winA = player({ userId: "winA", done: "won", solvedCount: 4, solvedLevels: [0, 1, 2, 3], mistakesLeft: 4, finishedAt: NOW + 60_000 });
  // 400 + round(100·(600−70)/600) − 2·30 = 428, despite finishing 4 groups like winA
  const winB = player({ userId: "winB", done: "won", solvedCount: 4, solvedLevels: [0, 1, 2, 3], mistakesLeft: 2, finishedAt: NOW + 90_000 });
  // loss credit only: 20·2² = 80
  const lossC = player({ userId: "lossC", done: "lost", solvedCount: 2, solvedLevels: [0, 1], mistakesLeft: 0, finishedAt: NOW + 30_000 });
  // banked 20·3² = 180: above lossC's 80, but no live run outranks a win (≥250)
  const liveMid = player({ userId: "liveMid", solvedCount: 3, solvedLevels: [0, 1, 2], mistakesLeft: 2, startedAt: NOW });
  // banked 20 — below lossC's 80
  const liveGrind = player({ userId: "liveGrind", solvedCount: 1, solvedLevels: [0], mistakesLeft: 1, startedAt: NOW });
  // banked 0 — fresh runs start at the bottom and climb as solves land
  const liveAce = player({ userId: "liveAce", solvedCount: 0, startedAt: now - 30_000 });
  const input = [liveGrind, winB, liveAce, lossC, winA, liveMid];

  it("ranks everyone by points: finished scores vs live banked credit", () => {
    expect(sortRoster(input, now).map((p) => p.userId)).toEqual([
      "winA",
      "winB",
      "liveMid",
      "lossC",
      "liveGrind",
      "liveAce",
    ]);
  });

  it("a live run outranks a finished one at equal points (still climbing)", () => {
    const liveTwo = player({ userId: "liveTwo", solvedCount: 2, solvedLevels: [0, 1], startedAt: NOW });
    expect(sortRoster([lossC, liveTwo], now).map((p) => p.userId)).toEqual([
      "liveTwo",
      "lossC",
    ]);
  });

  it("breaks score ties among finished wins by speed, then mistakes", () => {
    // The 20s speed grace flattens every fast clean solve to an identical 500, so
    // the score alone can't separate them — the elapsed tier keeps the quicker run
    // on top.
    const fast = player({ userId: "fast", done: "won", solvedCount: 4, solvedLevels: [0, 1, 2, 3], mistakesLeft: 4, finishedAt: NOW + 12_000 });
    const quick = player({ userId: "quick", done: "won", solvedCount: 4, solvedLevels: [0, 1, 2, 3], mistakesLeft: 4, finishedAt: NOW + 18_000 });
    // both finish inside the grace → both exactly 500
    expect(finishedScore("won", 4, 4, 12_000)).toBe(500);
    expect(finishedScore("won", 4, 4, 18_000)).toBe(500);
    // tied on score, so the faster (12s) run ranks first
    expect(sortRoster([quick, fast], now).map((p) => p.userId)).toEqual(["fast", "quick"]);
  });

  it("live runs with equal banked points race on elapsed, then mistakes", () => {
    const slow = player({ userId: "slow", solvedCount: 1, solvedLevels: [0], startedAt: NOW });
    const quick = player({ userId: "quick", solvedCount: 1, solvedLevels: [0], startedAt: now - 10_000 });
    expect(sortRoster([slow, quick], now).map((p) => p.userId)).toEqual([
      "quick",
      "slow",
    ]);
  });

  it("does not mutate its input", () => {
    const before = input.map((p) => p.userId);
    sortRoster(input, now);
    expect(input.map((p) => p.userId)).toEqual(before);
  });

  it("rankOf returns a 1-based rank, or null when absent", () => {
    expect(rankOf(input, "winA", now)).toBe(1);
    expect(rankOf(input, "liveMid", now)).toBe(3);
    expect(rankOf(input, "liveAce", now)).toBe(6);
    expect(rankOf(input, "ghost", now)).toBeNull();
  });
});
