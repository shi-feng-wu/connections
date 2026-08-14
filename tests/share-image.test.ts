import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The COPY-IMAGE half of the share loop (api/share-image.ts): the same card /api/share-link
// mints, handed back as raw PNG bytes for the clipboard instead of posted to Discord. What's
// pinned here is the gate order and the one property that makes the card unfakeable — the
// result is replayed from the caller's OWN progress record, never read off the request — plus
// the response shape the clipboard depends on (an image/png body, not JSON, not a data URI).
//
// Same harness as tests/share-link.test.ts: the Supabase service client is shimmed onto tiny
// in-memory tables that mimic the exact chains the code issues, and Discord identity is a
// mock (the real /users/@me needs a live user token). The render is REAL — @napi-rs/canvas
// draws an actual PNG — which is what lets the happy path assert on the bytes.

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
  const db = {
    from: (t: keyof Store) => new Q(store, t),
    // fetchStreak's user_streak RPC. Answering "no such function" keeps the streak line off
    // the card deliberately, rather than by an accidental TypeError the best-effort catch
    // would swallow just as quietly.
    rpc: async () => ({ data: null, error: { code: "42883" } }),
  } as unknown as SupabaseClient;
  return { db, store };
}

const UID = "111222333444555666";
const DATE = "2026-08-11";

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

// Reassigned per test (see beforeEach); the mock factories below close over it, so the route
// sees a fresh store and whatever identity the case needs.
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
const { default: handler } = await import("../api/share-image");

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
    // The binary path: Vercel's helper writes a Buffer body through send().
    send(b: unknown) {
      this.body = b;
      return this;
    },
  };
  await handler({ method, headers: {}, body } as any, res);
  return res;
}

describe("POST /api/share-image", () => {
  beforeEach(() => {
    const { db, store } = mkDb();
    route = { db, store, user: { id: UID, name: "Alice" } };
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects anything but POST", async () => {
    const r = await call({}, "GET");
    expect(r.statusCode).toBe(405);
    expect(r.body).toEqual({ error: "Method not allowed" });
  });

  it("rejects a caller Discord doesn't recognise", async () => {
    route.user = null;
    expect((await call({ date: DATE, accessToken: "bad" })).statusCode).toBe(401);
    // A missing token never reaches Discord, and still fails closed.
    expect((await call({ date: DATE })).statusCode).toBe(401);
  });

  it("rejects a malformed date before touching anything", async () => {
    const r = await call({ date: "yesterday", accessToken: "t" });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: "bad date" });
  });

  it("returns the card as image/png bytes for a finished game", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
    const r = await call({ date: DATE, accessToken: "t" });

    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    // The clipboard gets bytes, not a data URI and not JSON.
    expect(Buffer.isBuffer(r.body)).toBe(true);
    expect(r.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // \x89PNG
    expect(r.body.length).toBeGreaterThan(1000);
    // Nothing cacheable: the card is a per-player result.
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("refuses to render a game the caller never played", async () => {
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: "no-progress" });
  });

  it("refuses to render a game still in progress", async () => {
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

  it("never renders someone else's result: the record is looked up by the token's own id", async () => {
    route.store.progress.push({ user_id: "999", puzzle_date: DATE, guesses: WON, hints: [] });
    expect((await call({ date: DATE, accessToken: "t", userId: "999" })).body).toEqual({
      ok: false,
      reason: "no-progress",
    });
  });

  it("draws from the caller's OWN record, never from a grid in the request", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const honest = await call({ date: DATE, accessToken: "t" });
    const forged = await call({
      date: DATE,
      accessToken: "t",
      grid: [[0, 1, 2, 3]],
      solved: false,
      score: 99_999,
    });
    // Byte-identical: every field the request tried to supply was ignored.
    expect(Buffer.compare(forged.body, honest.body)).toBe(0);
  });
});
