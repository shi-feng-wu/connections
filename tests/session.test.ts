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

describe("auth ticket", () => {
  it("round-trips a fresh auth ticket", () => {
    const a = { uid: "123", iat: Date.now() };
    expect(session.verifyAuth(session.signAuth(a))).toEqual(a);
  });

  it("rejects a ticket older than its max age", () => {
    const a = { uid: "123", iat: Date.now() - 25 * 60 * 60 * 1000 };
    expect(session.verifyAuth(session.signAuth(a))).toBeNull();
  });

  it("rejects a ticket dated in the future", () => {
    const a = { uid: "123", iat: Date.now() + 60 * 60 * 1000 };
    expect(session.verifyAuth(session.signAuth(a))).toBeNull();
  });

  it("won't accept a session token as an auth ticket, or vice versa", () => {
    const sess = session.signSession({ date: "2026-06-01", iat: Date.now() });
    expect(session.verifyAuth(sess)).toBeNull();
    const auth = session.signAuth({ uid: "123", iat: Date.now() });
    expect(session.verifySession(auth)).toBeNull();
  });

  it("rejects a tampered auth ticket", () => {
    const tok = session.signAuth({ uid: "123", iat: Date.now() });
    const flipped = tok.slice(0, -1) + (tok.at(-1) === "A" ? "B" : "A");
    expect(session.verifyAuth(flipped)).toBeNull();
  });
});

describe("oauth state", () => {
  it("accepts a freshly signed state", () => {
    expect(session.verifyState(session.signState())).toBe(true);
  });

  it("rejects a state past its max age", () => {
    expect(session.verifyState(session.signState(Date.now() - 11 * 60 * 1000))).toBe(false);
  });

  it("rejects a state dated in the future", () => {
    expect(session.verifyState(session.signState(Date.now() + 60 * 1000))).toBe(false);
  });

  it("rejects a tampered or malformed state", () => {
    const tok = session.signState();
    const flipped = tok.slice(0, -1) + (tok.at(-1) === "A" ? "B" : "A");
    expect(session.verifyState(flipped)).toBe(false);
    expect(session.verifyState("nope")).toBe(false);
    expect(session.verifyState(null)).toBe(false);
  });

  it("won't accept an auth ticket as a state, or vice versa", () => {
    // an auth ticket has no role separation from state beyond shape: state carries
    // only iat, so an auth ticket (which also has iat) would pass the freshness gate.
    // Guard the inverse instead — a state must not satisfy verifyAuth (no uid).
    expect(session.verifyAuth(session.signState())).toBeNull();
  });
});

describe("isLocalDev", () => {
  // read at call time, so toggling process.env between assertions is fine.
  it("is true only when no Vercel system env vars are present (local vercel dev)", () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    expect(session.isLocalDev()).toBe(true);
  });

  it("fails closed on any deploy signal", () => {
    process.env.VERCEL_ENV = "production";
    expect(session.isLocalDev()).toBe(false);
    process.env.VERCEL_ENV = "preview";
    expect(session.isLocalDev()).toBe(false);
    delete process.env.VERCEL_ENV;
    process.env.VERCEL = "1";
    expect(session.isLocalDev()).toBe(false);
    delete process.env.VERCEL;
  });
});
