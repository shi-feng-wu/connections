import { describe, expect, it } from "vitest";
import { activeToken, INTERACTION_TOKEN_TTL_MS } from "../api/_livecard";

// api/_livecard.ts: the room card is hosted on a Discord interaction response and
// edited via its token. activeToken decides whether that token can still edit the
// message — launches inside the window edit the same card; once it has lapsed the next
// launch must establish a fresh one.
describe("activeToken", () => {
  const now = 1_700_000_000_000;
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("returns the token while inside the 15-minute window", () => {
    const card = { interaction_token: "tok", token_at: at(INTERACTION_TOKEN_TTL_MS - 1000) };
    expect(activeToken(card, now)).toBe("tok");
  });

  it("returns null once the window has elapsed", () => {
    const card = { interaction_token: "tok", token_at: at(INTERACTION_TOKEN_TTL_MS) };
    expect(activeToken(card, now)).toBeNull();
  });

  it("returns null with no token, no timestamp, or a bad row", () => {
    expect(activeToken({ interaction_token: null, token_at: at(0) }, now)).toBeNull();
    expect(activeToken({ interaction_token: "tok", token_at: null }, now)).toBeNull();
    expect(activeToken({ interaction_token: "tok", token_at: "not-a-date" }, now)).toBeNull();
    expect(activeToken(null, now)).toBeNull();
    expect(activeToken(undefined, now)).toBeNull();
  });
});
