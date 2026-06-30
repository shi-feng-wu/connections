import { describe, expect, it } from "vitest";
import { recapPayload, recapText, toRecapData, type SeasonRow } from "../api/_recap";

// api/_recap.ts: recapText is the one-line text body posted above the recap PNG — a bold
// streak clause with the room's current solve streak (and a 🔥), then the results intro.
// The longest streak and the per-player results live in the PNG, so the text carries
// neither them nor @mentions.
describe("recapText", () => {
  // Case 1 — someone solved: streak headline with one 🔥 per digit of the streak count.
  it("streak maintained: one fire per digit of the streak count", () => {
    expect(recapText({ streak: 5, solved: true })).toBe(
      "**Your group is on a 5 day streak! 🔥** Here are yesterday's results:",
    );
    expect(recapText({ streak: 12, solved: true })).toBe(
      "**Your group is on a 12 day streak! 🔥🔥** Here are yesterday's results:",
    );
    expect(recapText({ streak: 369, solved: true })).toBe(
      "**Your group is on a 369 day streak! 🔥🔥🔥** Here are yesterday's results:",
    );
  });

  it("is just the results intro when a solve hasn't built a streak yet", () => {
    expect(recapText({ streak: 0, solved: true })).toBe("Here are yesterday's results:");
    expect(recapText({ streak: null, solved: true })).toBe("Here are yesterday's results:");
  });

  // Cases 2 & 4 — finishers but nobody solved: "stumped everyone", named prefix if a streak ended.
  it("everyone failed: stumped-everyone line, names the broken streak only when one ended", () => {
    expect(
      recapText({ streak: 0, solved: false, played: true, brokenStreak: 12, puzzleNo: 642 }),
    ).toBe(
      "**12-day streak broken!** Yesterday's Connections #642 stumped everyone… but today is a new day 🌞",
    );
    expect(
      recapText({ streak: 0, solved: false, played: true, brokenStreak: 0, puzzleNo: 642 }),
    ).toBe("Yesterday's Connections #642 stumped everyone… but today is a new day 🌞");
  });

  // Cases 3 & 5 — no finishers at all: "nobody played", named prefix if a streak ended.
  it("nobody played: nobody-played line, names the broken streak only when one ended", () => {
    expect(
      recapText({ streak: 0, solved: false, played: false, brokenStreak: 3, puzzleNo: 642 }),
    ).toBe(
      "**3-day streak broken!** Nobody played yesterday's Connections #642… but today is a new day 🌞",
    );
    expect(
      recapText({ streak: 0, solved: false, played: false, brokenStreak: 0, puzzleNo: 642 }),
    ).toBe("Nobody played yesterday's Connections #642… but today is a new day 🌞");
  });

  it("falls back to a generic puzzle name when the number is unknown", () => {
    expect(recapText({ streak: 0, solved: false, played: false })).toBe(
      "Nobody played yesterday's Connections… but today is a new day 🌞",
    );
  });
});

// toRecapData maps the RPC result sets into the render model. The season-standings
// rank-change delta (computed by the recap cron, not an RPC column) must survive the map,
// defaulting to null when absent so the card draws no arrow.
describe("toRecapData standings delta", () => {
  const season: SeasonRow[] = [
    { user_id: "a", name: "A", avatar: null, total: 100, wins: 5, plays: 6, delta: 2 },
    { user_id: "b", name: "B", avatar: null, total: 90, wins: 4, plays: 6, delta: -1 },
    { user_id: "d", name: "D", avatar: null, total: 85, wins: 3, plays: 6, delta: "new" },
    { user_id: "c", name: "C", avatar: null, total: 80, wins: 3, plays: 6 }, // no delta
  ];

  it("passes each row's delta through (incl. \"new\"), null when absent", () => {
    const data = toRecapData({ puzzleDate: "2026-05-30", results: [], season });
    expect(data.standings.map((s) => s.delta)).toEqual([2, -1, "new", null]);
  });
});

describe("recapPayload", () => {
  it("adds a content body only when text is supplied", () => {
    expect(recapPayload()).not.toHaveProperty("content");
    expect(recapPayload("hello")).toMatchObject({ content: "hello" });
  });

  // The recap is the one bot message allowed to notify, so unlike the live card it
  // carries no SUPPRESS_NOTIFICATIONS flag.
  it("does not suppress notifications", () => {
    expect(recapPayload()).not.toHaveProperty("flags");
    expect(recapPayload("hi")).not.toHaveProperty("flags");
  });
});
