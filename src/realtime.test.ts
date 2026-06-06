import { describe, expect, it } from "vitest";
import { nextBackoff, reconnectPrivacy } from "./realtime";

// Pure decision helpers for the presence supervisor (realtime.ts). The socket orchestration
// (rejoin/heartbeat/visibility) isn't unit-tested — it needs a live proxied channel — but the
// two policy decisions it drives are, so the backoff schedule and the private/public choice
// can't regress silently.

describe("nextBackoff", () => {
  it("ramps 0 → 1s → 2s → 4s → 8s → 15s and holds at the cap", () => {
    expect(nextBackoff(0)).toBe(1_000);
    expect(nextBackoff(1_000)).toBe(2_000);
    expect(nextBackoff(2_000)).toBe(4_000);
    expect(nextBackoff(4_000)).toBe(8_000);
    // 8s doubles to 16s, clamped to the 15s cap; thereafter it stays pinned.
    expect(nextBackoff(8_000)).toBe(15_000);
    expect(nextBackoff(15_000)).toBe(15_000);
  });
});

describe("reconnectPrivacy", () => {
  it("reconnects private while no fallback has fired", () => {
    expect(reconnectPrivacy(true, false)).toBe(true);
  });

  it("stays public once the private→public fallback is spent (no flip-flop)", () => {
    expect(reconnectPrivacy(true, true)).toBe(false);
  });

  it("never goes private when private was never wanted (local/dev)", () => {
    expect(reconnectPrivacy(false, false)).toBe(false);
    expect(reconnectPrivacy(false, true)).toBe(false);
  });
});
