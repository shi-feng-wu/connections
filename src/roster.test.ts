import { describe, it, expect } from "vitest";
import { colorFor, initials, rankOf, sortRoster } from "./roster";
import type { PlayerState } from "./player";

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
  // Furthest ahead first: most groups solved, then fastest, then fewest mistakes.
  const hi = player({ userId: "hi", solvedCount: 4, finishedAt: NOW + 90_000, mistakesLeft: 2 });
  const hiFast = player({ userId: "hiFast", solvedCount: 4, finishedAt: NOW + 60_000, mistakesLeft: 1 });
  const hiFastClean = player({ userId: "hiFastClean", solvedCount: 4, finishedAt: NOW + 60_000, mistakesLeft: 4 });
  const mid = player({ userId: "mid", solvedCount: 2, finishedAt: NOW + 30_000 });
  const low = player({ userId: "low", solvedCount: 0, finishedAt: null }); // still playing
  const now = NOW + 200_000;
  const input = [low, hi, mid, hiFast, hiFastClean];

  it("orders by solved, then elapsed, then mistakes left", () => {
    expect(sortRoster(input, now).map((p) => p.userId)).toEqual([
      "hiFastClean",
      "hiFast",
      "hi",
      "mid",
      "low",
    ]);
  });

  it("does not mutate its input", () => {
    const before = input.map((p) => p.userId);
    sortRoster(input, now);
    expect(input.map((p) => p.userId)).toEqual(before);
  });

  it("rankOf returns a 1-based rank, or null when absent", () => {
    expect(rankOf(input, "hiFastClean", now)).toBe(1);
    expect(rankOf(input, "hi", now)).toBe(3);
    expect(rankOf(input, "low", now)).toBe(5);
    expect(rankOf(input, "ghost", now)).toBeNull();
  });
});
