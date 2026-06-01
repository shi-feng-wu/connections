import { describe, it, expect } from "vitest";
import { currentSeasonStart } from "./leaderboard";

describe("currentSeasonStart", () => {
  it("returns the first day of the month, in UTC", () => {
    expect(currentSeasonStart(new Date("2026-06-15T12:00:00Z"))).toBe("2026-06-01");
    expect(currentSeasonStart(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
    expect(currentSeasonStart(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
  });

  it("zero-pads single-digit months", () => {
    expect(currentSeasonStart(new Date("2026-03-09T00:00:00Z"))).toBe("2026-03-01");
  });
});
