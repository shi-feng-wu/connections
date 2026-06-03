import { describe, expect, it } from "vitest";
import { type DayRow, recapPayload, recapText } from "../api/_recap";

// api/_recap.ts: recapText builds the Wordle-style message body posted above the recap
// PNG — a group-streak headline plus yesterday's finishers grouped by result (solvers by
// mistakes, best first with a crown; non-solvers under "X"), each player @mentioned.
const row = (over: Partial<DayRow> & { user_id: string }): DayRow => ({
  name: over.user_id,
  avatar: null,
  score: 0,
  mistakes: 0,
  solved: true,
  duration_ms: null,
  ...over,
});

describe("recapText", () => {
  it("headlines the streak and groups finishers best-first with a crown", () => {
    const text = recapText({
      streak: 369,
      results: [
        row({ user_id: "alice", mistakes: 0, solved: true }),
        row({ user_id: "bob", mistakes: 1, solved: true }),
        row({ user_id: "carol", mistakes: 1, solved: true }),
        row({ user_id: "dave", mistakes: 4, solved: false }),
      ],
    });
    expect(text).toBe(
      "Your group is on a 369 day streak! 🔥🔥🔥 Here are yesterday's results:\n" +
        "👑 Perfect: <@alice>\n" +
        "1 mistake: <@bob> <@carol>\n" +
        "X: <@dave>",
    );
  });

  it("drops the streak headline when the room streak is broken (0)", () => {
    const text = recapText({
      streak: 0,
      results: [row({ user_id: "a", mistakes: 2 })],
    });
    expect(text).toBe("Here are yesterday's results:\n👑 2 mistakes: <@a>");
  });

  it("scales the flames with the streak length and needs no finishers", () => {
    expect(recapText({ streak: 1, results: [] })).toBe(
      "Your group is on a 1 day streak! 🔥 Here are yesterday's results:",
    );
    expect(recapText({ streak: 30, results: [] })).toBe(
      "Your group is on a 30 day streak! 🔥🔥 Here are yesterday's results:",
    );
  });

  it("calls out the all-time longest streak when a past run beat the current one", () => {
    expect(recapText({ streak: 2, longest: 5, results: [row({ user_id: "a", mistakes: 0 })] })).toBe(
      "Your group is on a 2 day streak! 🔥 Longest streak: 5 days. Here are yesterday's results:\n" +
        "👑 Perfect: <@a>",
    );
  });

  it("flags a 🏆 record when the current streak ties the longest ever", () => {
    expect(recapText({ streak: 5, longest: 5, results: [] })).toBe(
      "Your group is on a 5 day streak! 🔥 🏆 Here are yesterday's results:",
    );
  });

  it("still shows the longest streak when the current run is broken", () => {
    expect(recapText({ streak: 0, longest: 4, results: [] })).toBe(
      "Longest streak: 4 days. Here are yesterday's results:",
    );
  });
});

describe("recapPayload", () => {
  it("adds a content body only when text is supplied", () => {
    expect(recapPayload()).not.toHaveProperty("content");
    expect(recapPayload("hello")).toMatchObject({ content: "hello" });
  });
});
