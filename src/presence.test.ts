import { describe, expect, it } from "vitest";
import { buildActivity, type PresenceInput, presenceSignature } from "./presence";

// A mid-game baseline: puzzle #123, nothing solved yet, all mistakes intact.
const base: PresenceInput = {
  solvedCount: 0,
  total: 4,
  mistakesLeft: 4,
  status: "playing",
  puzzleNo: 123,
  joinedAt: 1_700_000_000_000,
  durationMs: null,
};

describe("presenceSignature", () => {
  it("is stable across elapsed-clock churn (so setActivity isn't respammed)", () => {
    expect(presenceSignature(base)).toBe(
      presenceSignature({ ...base, joinedAt: 42, durationMs: 5000 }),
    );
  });

  it("changes on a solve, a mistake, or the finish", () => {
    const sig = presenceSignature(base);
    expect(presenceSignature({ ...base, solvedCount: 1 })).not.toBe(sig);
    expect(presenceSignature({ ...base, mistakesLeft: 3 })).not.toBe(sig);
    expect(presenceSignature({ ...base, status: "won" })).not.toBe(sig);
  });
});

describe("buildActivity", () => {
  it("shows puzzle number, progress, a live timer, and the icon while playing", () => {
    const a = buildActivity({ ...base, solvedCount: 2, mistakesLeft: 3 });
    expect(a.type).toBe(0);
    expect(a.details).toBe("Puzzle #123");
    expect(a.state).toBe("2/4 groups · 3 mistakes left");
    expect(a.timestamps?.start).toBe(Math.floor(base.joinedAt / 1000));
    expect(a.assets.large_image).toBeTruthy();
  });

  it("singularizes the final mistake", () => {
    expect(buildActivity({ ...base, mistakesLeft: 1 }).state).toBe(
      "0/4 groups · 1 mistake left",
    );
  });

  it("freezes the timer and shows solve time on a win", () => {
    const a = buildActivity({ ...base, solvedCount: 4, status: "won", durationMs: 272_000 });
    expect(a.state).toBe("Solved in 4:32");
    expect(a.timestamps).toBeUndefined();
  });

  it("shows partial progress and no timer on a loss", () => {
    const a = buildActivity({ ...base, solvedCount: 2, status: "lost", mistakesLeft: 0 });
    expect(a.state).toBe("2/4 solved · out of guesses");
    expect(a.timestamps).toBeUndefined();
  });

  it("falls back to 'Daily puzzle' when the number is unknown", () => {
    expect(buildActivity({ ...base, puzzleNo: undefined }).details).toBe("Daily puzzle");
  });
});
