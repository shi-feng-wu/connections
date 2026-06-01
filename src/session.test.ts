import { beforeAll, describe, expect, it } from "vitest";

// api/_session.ts: HMAC binds a score to a puzzle date + server-measured start
// time, blocking scores for unstarted puzzles and forged fast solves. SECRET is
// read at module load, so set it before the dynamic import.
let session: typeof import("../api/_session");

beforeAll(async () => {
  process.env.SESSION_SECRET = "unit-test-secret-abc123";
  session = await import("../api/_session");
});

describe("session signing", () => {
  it("round-trips a signed session", () => {
    const s = { date: "2026-06-01", iat: 1717200000000 };
    expect(session.verifySession(session.signSession(s))).toEqual(s);
  });

  it("rejects a payload swapped under an old signature", () => {
    const sig = session.signSession({ date: "2026-06-01", iat: 5 }).split(".")[1];
    const forgedBody = Buffer.from(
      JSON.stringify({ date: "2026-12-25", iat: 5 }),
    ).toString("base64url");
    expect(session.verifySession(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const tok = session.signSession({ date: "2026-06-01", iat: 5 });
    const flipped = tok.slice(0, -1) + (tok.at(-1) === "A" ? "B" : "A");
    expect(session.verifySession(flipped)).toBeNull();
  });

  it("rejects malformed or non-string tokens", () => {
    expect(session.verifySession("no-dot-here")).toBeNull();
    expect(session.verifySession("")).toBeNull();
    expect(session.verifySession(42)).toBeNull();
    expect(session.verifySession(null)).toBeNull();
  });
});
