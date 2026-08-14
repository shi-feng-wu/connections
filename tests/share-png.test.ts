import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The PERMANENT half of the share loop (api/share-png.ts + the token in api/_share.ts): the
// public url https://disconnections.app/i/<token>.png, which re-renders a player's result card
// from their own record on every hit and therefore never expires.
//
// What's pinned here is the property the whole scheme rests on — the token is the ONLY
// credential, so a forged, tampered, or malformed one has to be indistinguishable from a url
// that was never minted (404, no render) — plus the two things a permanent url has to get right
// to be worth having: a real result answers with actual PNG bytes, and the response is cacheable
// forever at the edge.
//
// Same harness as tests/share-image.test.ts: the Supabase service client is shimmed onto tiny
// in-memory tables mimicking the exact chains the code issues, _puzzles is mocked (so the date
// gate doesn't move with the calendar), and the render is REAL — @napi-rs/canvas draws an actual
// PNG, which is what lets the happy path assert on the bytes.

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
    rpc: async () => ({ data: 4, error: null }),
  } as unknown as SupabaseClient;
  return { db, store };
}

const UID = "111222333444555666";
const OTHER = "999888777666555444";
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

// Reassigned per test (see beforeEach); the mock factory below closes over it.
let route: { db: SupabaseClient; store: Store } = mkDb();

vi.mock("../api/_admin.js", () => ({ admin: () => route.db }));
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => PUZZLE,
  todayET: () => DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is fine).
const { default: handler } = await import("../api/share-png");
const { sharePngToken, parseSharePngToken } = await import("../api/_share");

type Res = { statusCode: number; body: any; headers: Record<string, string> };
async function call(token: unknown, method = "GET"): Promise<Res> {
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
    send(b: unknown) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
  await handler({ method, headers: {}, query: { token } } as any, res);
  return res;
}

// ——— the token: the only credential a permanent url carries ———
describe("share-png token", () => {
  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });

  it("round-trips the player and the date", () => {
    const t = sharePngToken(UID, DATE);
    expect(t).toMatch(new RegExp(`^${UID}\\.20260811\\.[0-9a-f]{20}$`));
    expect(parseSharePngToken(t)).toEqual({ userId: UID, date: DATE });
  });

  it("is stable, so the url a player copied keeps working", () => {
    expect(sharePngToken(UID, DATE)).toBe(sharePngToken(UID, DATE));
  });

  it("stays short enough to sit in a pasteable url", () => {
    expect(sharePngToken(UID, DATE).length).toBeLessThan(60);
  });

  it("refuses a tampered id or date: you can't re-point someone else's link", () => {
    const t = sharePngToken(UID, DATE);
    const sig = t.split(".")[2];
    expect(parseSharePngToken(`${OTHER}.20260811.${sig}`)).toBeNull();
    expect(parseSharePngToken(`${UID}.20260810.${sig}`)).toBeNull();
  });

  it("refuses a forged signature, including one signed with the wrong key", () => {
    process.env.INTERNAL_SECRET = "other-key";
    const forged = sharePngToken(UID, DATE);
    process.env.INTERNAL_SECRET = SECRET;
    expect(parseSharePngToken(forged)).toBeNull();
    expect(parseSharePngToken(`${UID}.20260811.${"0".repeat(20)}`)).toBeNull();
  });

  it("refuses anything that isn't one of ours", () => {
    for (const v of [
      "",
      "junk",
      `${UID}.20260811`, // no signature
      `${UID}.2026-08-11.${"0".repeat(20)}`, // wrong date shape
      `abc.20260811.${"0".repeat(20)}`, // not a snowflake
      `${UID}.20260811.${"0".repeat(19)}`, // signature too short
      `${UID}.20260811.${"Z".repeat(20)}`, // not hex
      null,
      7,
      { userId: UID },
    ])
      expect(parseSharePngToken(v)).toBeNull();
  });

  it("verifies nothing without a signing key", () => {
    const t = sharePngToken(UID, DATE);
    delete process.env.INTERNAL_SECRET;
    expect(parseSharePngToken(t)).toBeNull();
  });
});

// ——— the route ———
describe("GET /api/share-png", () => {
  beforeEach(() => {
    const { db, store } = mkDb();
    route = { db, store };
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
    vi.restoreAllMocks();
  });

  it("rejects anything but GET/HEAD", async () => {
    const r = await call(sharePngToken(UID, DATE), "POST");
    expect(r.statusCode).toBe(405);
    expect(r.body).toEqual({ error: "Method not allowed" });
  });

  it("renders the card as image/png bytes for a finished game", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
    const r = await call(sharePngToken(UID, DATE));

    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(r.body)).toBe(true);
    expect(r.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // \x89PNG
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it("caches hard at the edge: a finished result never changes", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const r = await call(sharePngToken(UID, DATE));
    expect(r.headers["cache-control"]).toBe(
      "public, max-age=3600, s-maxage=31536000, immutable",
    );
  });

  it("answers a HEAD with the headers and no render", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const r = await call(sharePngToken(UID, DATE), "HEAD");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.body).toBeUndefined();
  });

  it("404s a bad, forged, or tampered token — never a hint that the result exists", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const good = sharePngToken(UID, DATE);
    const sig = good.split(".")[2];
    for (const t of [
      undefined,
      "",
      "junk",
      `${UID}.20260811.${"0".repeat(20)}`, // forged signature
      `${UID}.20260810.${sig}`, // date swapped under a valid signature
      `${OTHER}.20260811.${sig}`, // id swapped under a valid signature
    ]) {
      const r = await call(t);
      expect(r.statusCode).toBe(404);
      expect(r.body).toEqual({ error: "not found" });
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("404s a well-signed token for a result that doesn't exist", async () => {
    const r = await call(sharePngToken(UID, DATE));
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: "not found" });
  });

  it("404s a game that was never finished", async () => {
    route.store.progress.push({
      user_id: UID,
      puzzle_date: DATE,
      guesses: [["A0", "B0", "C0", "D0"]],
      hints: [],
    });
    expect((await call(sharePngToken(UID, DATE))).statusCode).toBe(404);
  });

  it("takes only the first value of a repeated ?token=", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const r = await call([sharePngToken(UID, DATE), "junk"]);
    expect(r.statusCode).toBe(200);
  });

  it("503s without a signing key, rather than calling every live link dead", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const token = sharePngToken(UID, DATE);
    delete process.env.INTERNAL_SECRET;
    const r = await call(token);
    expect(r.statusCode).toBe(503);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});
