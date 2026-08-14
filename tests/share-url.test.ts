import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The authed half of the permanent-card pair (api/share-url.ts): "what is MY forever link?".
// The end screen's "Copy link" row calls this and puts the answer on the clipboard as text.
//
// What's pinned here is the gate order it shares with its siblings (share-image /
// share-moment) — a caller can only ever get a link to their OWN finished game, and the id
// baked into the url comes from the Discord token, never from the request — plus the shape of
// the url itself, since it's the one string in this feature that gets pasted somewhere
// permanent: it must point at our own origin and carry a token /api/share-png accepts.
//
// Same harness as tests/share-image.test.ts, minus the canvas: this route renders nothing.

// ---- in-memory tables + the Supabase-builder shim over them (only the chains we use) ----
type Row = Record<string, any>;
type Store = { progress: Row[]; scores: Row[] };

class Q {
  private eqs: [string, unknown][] = [];
  constructor(
    private store: Store,
    private table: keyof Store,
  ) {}
  select(_cols?: string): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs.push([col, val]);
    return this;
  }
  private rows(): Row[] {
    return this.store[this.table].filter((r) => this.eqs.every(([c, v]) => r[c] === v));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null };
  }
}

function mkDb(seed: Partial<Store> = {}): { db: SupabaseClient; store: Store } {
  const store: Store = { progress: seed.progress ?? [], scores: seed.scores ?? [] };
  const db = { from: (t: keyof Store) => new Q(store, t) } as unknown as SupabaseClient;
  return { db, store };
}

const UID = "111222333444555666";
const DATE = "2026-08-11";
const SECRET = "s3cret";

const PUZZLE = {
  id: 1170,
  date: DATE,
  editor: "Test",
  groups: [
    { level: 0, category: "L0", members: ["A0", "B0", "C0", "D0"] },
    { level: 1, category: "L1", members: ["A1", "B1", "C1", "D1"] },
    { level: 2, category: "L2", members: ["A2", "B2", "C2", "D2"] },
    { level: 3, category: "L3", members: ["A3", "B3", "C3", "D3"] },
  ],
  layout: ["A0", "B0", "C0", "D0", "A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "B3", "C3", "D3"],
};
const WON = [
  ["A0", "B0", "C0", "D0"],
  ["A1", "B1", "C1", "D1"],
  ["A2", "B2", "C2", "D2"],
  ["A3", "B3", "C3", "D3"],
];

// Reassigned per test (see beforeEach); the mock factories below close over it.
let route: { db: SupabaseClient; store: Store; user: { id: string; name: string } | null } = {
  ...mkDb(),
  user: { id: UID, name: "Alice" },
};

vi.mock("../api/_admin.js", () => ({ admin: () => route.db }));
vi.mock("../api/_discord.js", () => ({ fetchDiscordUser: async () => route.user }));
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => PUZZLE,
  todayET: () => DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is fine).
const { default: handler } = await import("../api/share-url");
const { parseSharePngToken } = await import("../api/_share");

type Res = { statusCode: number; body: any; headers: Record<string, string> };
async function call(body: unknown, method = "POST"): Promise<Res> {
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  await handler({ method, headers: {}, body } as any, res);
  return res;
}

describe("POST /api/share-url", () => {
  beforeEach(() => {
    const { db, store } = mkDb();
    route = { db, store, user: { id: UID, name: "Alice" } };
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
    vi.restoreAllMocks();
  });

  it("rejects anything but POST", async () => {
    const r = await call({}, "GET");
    expect(r.statusCode).toBe(405);
    expect(r.body).toEqual({ error: "Method not allowed" });
  });

  it("rejects a malformed date before touching anything", async () => {
    const r = await call({ date: "yesterday", accessToken: "t" });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: "bad date" });
  });

  it("rejects a caller Discord doesn't recognise", async () => {
    route.user = null;
    expect((await call({ date: DATE, accessToken: "bad" })).statusCode).toBe(401);
    // A missing token never reaches Discord, and still fails closed.
    expect((await call({ date: DATE })).statusCode).toBe(401);
  });

  it("refuses rather than handing out a link it couldn't sign", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    delete process.env.INTERNAL_SECRET;
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ ok: false, reason: "unavailable" });
  });

  it("answers with the permanent /i/ url for a finished game", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const r = await call({ date: DATE, accessToken: "t" });

    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    // Our own origin, our own path shape — this string outlives the share, so it can't drift.
    expect(r.body.url).toMatch(/^https:\/\/disconnections\.app\/i\/[^/]+\.png$/);
    // ...and the token in it is one /api/share-png will accept, for this player and this date.
    const token = r.body.url.slice("https://disconnections.app/i/".length, -".png".length);
    expect(parseSharePngToken(token)).toEqual({ userId: UID, date: DATE });
    // A link is not a result: nothing about the request is cacheable.
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a game the caller never played", async () => {
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: "no-progress" });
  });

  it("refuses a game still in progress: the url would 404", async () => {
    route.store.progress.push({
      user_id: UID,
      puzzle_date: DATE,
      guesses: [["A0", "B0", "C0", "D0"]],
      hints: [],
    });
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: "not-finished" });
  });

  it("never links someone else's result: the id comes from the token, not the request", async () => {
    route.store.progress.push({ user_id: "999", puzzle_date: DATE, guesses: WON, hints: [] });
    expect((await call({ date: DATE, accessToken: "t", userId: "999" })).body).toEqual({
      ok: false,
      reason: "no-progress",
    });
  });
});
