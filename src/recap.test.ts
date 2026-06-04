import { describe, expect, it } from "vitest";
import { recapPayload, recapText } from "../api/_recap";

// api/_recap.ts: recapText is the one-line text body posted above the recap PNG — a bold
// streak clause with the room's current solve streak (and a 🔥), then the results intro.
// The longest streak and the per-player results live in the PNG, so the text carries
// neither them nor @mentions.
describe("recapText", () => {
  it("bolds the streak clause with a 🔥 before the results intro", () => {
    expect(recapText({ streak: 369 })).toBe(
      "**Your group is on a 369 day streak! 🔥** Here are yesterday's results:",
    );
    expect(recapText({ streak: 1 })).toBe(
      "**Your group is on a 1 day streak! 🔥** Here are yesterday's results:",
    );
  });

  it("is just the results intro when there's no active streak", () => {
    expect(recapText({ streak: 0 })).toBe("Here are yesterday's results:");
    expect(recapText({ streak: null })).toBe("Here are yesterday's results:");
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
