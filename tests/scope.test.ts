import { describe, expect, it } from "vitest";
import { canonicalScope } from "../src/scope";

// Namespacing that stops cross-room leaderboard pollution. g:/c: prefixes keep a
// guild board and a channel board from ever sharing a key.
describe("canonicalScope", () => {
  it("prefixes a guild scope with g:", () => {
    expect(canonicalScope("123", "456")).toBe("g:123"); // guild wins over channel
    expect(canonicalScope("123", null)).toBe("g:123");
  });

  it("falls back to the channel (c:) only when there's no guild", () => {
    expect(canonicalScope(null, "456")).toBe("c:456");
    expect(canonicalScope(undefined, "456")).toBe("c:456");
  });

  it("is null when neither is present (standalone)", () => {
    expect(canonicalScope(null, null)).toBeNull();
    expect(canonicalScope()).toBeNull();
  });

  it("can never let a guild id collide with a channel-slotted value", () => {
    // Attack: victim guild's id in the channel slot. The c: prefix can never
    // match the g: key that guild's board is read under.
    const victimGuild = "999";
    expect(canonicalScope(null, victimGuild)).toBe(`c:${victimGuild}`);
    expect(canonicalScope(null, victimGuild)).not.toBe(canonicalScope(victimGuild, null));
  });
});
