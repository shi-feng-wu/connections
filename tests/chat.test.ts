import { describe, expect, it } from "vitest";
import { devUnread, playerUnread, type ThreadRow } from "../api/chat";
import { isCategory } from "../api/_feedback";

// The unread predicates drive both badges: the dot on a player's Feedback entry (a reply is
// waiting) and the "new" mark in the dev's inbox (a player wrote and we haven't read it). They're
// pure functions over the denormalized thread summary, so the badge can be decided in one row read.

const T0 = "2026-06-20T10:00:00.000Z";
const T1 = "2026-06-20T11:00:00.000Z"; // strictly later than T0

const thread = (over: Partial<ThreadRow>): ThreadRow => ({
  id: 1,
  user_id: "u1",
  name: "Player",
  avatar: null,
  category: "Bug",
  subject: "it broke",
  puzzle_id: 314,
  last_message_at: T0,
  last_sender: "user",
  last_text: "it broke",
  user_last_read_at: T0,
  dev_last_read_at: null,
  msg_count: 1,
  ...over,
});

describe("playerUnread", () => {
  it("is false when the latest message is the player's own", () => {
    expect(playerUnread(thread({ last_sender: "user" }))).toBe(false);
  });

  it("is true when our reply lands after the player last read", () => {
    expect(
      playerUnread(thread({ last_sender: "dev", last_message_at: T1, user_last_read_at: T0 })),
    ).toBe(true);
  });

  it("is false once the player has read up to the reply", () => {
    expect(
      playerUnread(thread({ last_sender: "dev", last_message_at: T1, user_last_read_at: T1 })),
    ).toBe(false);
  });
});

describe("devUnread", () => {
  it("is true for a never-read player message", () => {
    expect(devUnread(thread({ last_sender: "user", dev_last_read_at: null }))).toBe(true);
  });

  it("is true when a new player message lands after we last read", () => {
    expect(
      devUnread(thread({ last_sender: "user", last_message_at: T1, dev_last_read_at: T0 })),
    ).toBe(true);
  });

  it("is false right after we've read it", () => {
    expect(
      devUnread(thread({ last_sender: "user", last_message_at: T1, dev_last_read_at: T1 })),
    ).toBe(false);
  });

  it("is false when the latest message is our own reply", () => {
    expect(devUnread(thread({ last_sender: "dev", dev_last_read_at: null }))).toBe(false);
  });
});

describe("isCategory", () => {
  it("accepts the three real tags and rejects anything else", () => {
    expect(isCategory("Bug")).toBe(true);
    expect(isCategory("Idea")).toBe(true);
    expect(isCategory("Other")).toBe(true);
    expect(isCategory("Spam")).toBe(false);
    expect(isCategory(null)).toBe(false);
    expect(isCategory(42)).toBe(false);
  });
});
