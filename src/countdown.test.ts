import { describe, expect, it } from "vitest";
import { fmtCountdown, msUntilNextEtMidnight } from "./countdown";

// msUntilNextEtMidnight takes an explicit `now`, so each case is a fixed UTC instant whose
// ET wall-clock we know — no clock mocking needed. The instants below are chosen so the ET
// offset is unambiguous: January is EST (UTC-5), July is EDT (UTC-4).

const HOUR = 3_600_000;
const MIN = 60_000;

describe("msUntilNextEtMidnight", () => {
  it("EST: at midnight ET the next reset is a full day away", () => {
    // 05:00 UTC Jan 15 = 00:00 EST Jan 15
    expect(msUntilNextEtMidnight(new Date("2024-01-15T05:00:00Z"))).toBe(24 * HOUR);
  });

  it("EST: counts down from a mid-day ET time", () => {
    // 10:30 UTC Jan 15 = 05:30 EST → 18h30m left
    expect(msUntilNextEtMidnight(new Date("2024-01-15T10:30:00Z"))).toBe(18 * HOUR + 30 * MIN);
  });

  it("EDT: midnight ET in summer is 04:00 UTC, also a full day", () => {
    // 04:00 UTC Jul 15 = 00:00 EDT Jul 15
    expect(msUntilNextEtMidnight(new Date("2024-07-15T04:00:00Z"))).toBe(24 * HOUR);
  });

  it("clamps to 0 rather than going negative", () => {
    // Exactly at an ET midnight returns a full day, never <= 0; the sub-second math
    // (getMilliseconds) can't push it under zero.
    expect(msUntilNextEtMidnight(new Date("2024-01-15T05:00:00.500Z"))).toBeGreaterThan(0);
  });
});

describe("fmtCountdown", () => {
  it("shows Xh Ym above an hour", () => {
    expect(fmtCountdown(18 * HOUR + 30 * MIN)).toBe("18h 30m");
    expect(fmtCountdown(1 * HOUR)).toBe("1h 0m");
  });

  it("drops to Ym within the hour", () => {
    expect(fmtCountdown(30 * MIN)).toBe("30m");
    expect(fmtCountdown(59 * MIN + 59_000)).toBe("59m");
  });

  it("drops to Ss in the last minute", () => {
    expect(fmtCountdown(30_000)).toBe("30s");
    expect(fmtCountdown(0)).toBe("0s");
  });
});
