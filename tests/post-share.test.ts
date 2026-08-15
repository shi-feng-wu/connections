import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api/post-share.ts is the /share ANSWER, split out of /api/interactions the same way the "who's
// playing" card is (api/post-card.ts) — the latency-critical interactions function can't be held up
// by DB work. /api/interactions defers the /share reply and calls this with the invoker's id and the
// interaction token; this function replays the game and edits the deferred message into a picture of
// it.
//
// The picture is a LINK, not an upload: a bare image embed pointing at the player's PERMANENT card
// url (https://disconnections.app/i/<token>.png — api/share-png), which Discord's proxy fetches from
// our origin once and then serves to every viewer. Nothing is rendered here, so there is no PNG in
// this file's assertions; what's pinned instead is that the url is the RIGHT one — it round-trips
// through parseSharePngToken back to exactly this (user, date).
//
// What else is pinned: the INTERNAL_SECRET gate (a forged call must not be able to spend someone's
// interaction token), the replay gate (the result comes from the player's OWN progress record, never
// from the request, and a /share for a result that doesn't exist must not emit a url that 404s into
// a broken image), the edit contract (a JSON PATCH to the @original webhook URL, no attachment), and
// — the promise that /share never gets WORSE than it was — the degradation to the pre-image
// Components V2 emoji card when the embed can't be posted.
//
// Harness follows tests/share-moment.test.ts: Supabase is shimmed onto in-memory tables and Discord
// is a stubbed global fetch.

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
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return {
      data: this.store[this.table].find((r) => this.eqs.every(([c, v]) => r[c] === v)) ?? null,
      error: null,
    };
  }
}

// `touched`/`rpcs` record which tables and RPCs a run actually read. The embed path is supposed to
// look up NOTHING beyond the replay (whoever opens the url makes /api/share-png fetch the stats
// itself), so "what did we query" is part of the contract, not just an implementation detail.
function mkDb(seed: Partial<Store> = {}): {
  db: SupabaseClient;
  store: Store;
  touched: string[];
  rpcs: string[];
} {
  const store: Store = { progress: seed.progress ?? [], scores: seed.scores ?? [] };
  const touched: string[] = [];
  const rpcs: string[] = [];
  const db = {
    from: (t: keyof Store) => {
      touched.push(t);
      return new Q(store, t);
    },
    // fetchStreak's user_streak RPC. "No such function" keeps the streak off a card deliberately,
    // rather than by an accidental TypeError the best-effort catch would swallow.
    rpc: async (name: string) => {
      rpcs.push(name);
      return { data: null, error: { code: "42883" } };
    },
  } as unknown as SupabaseClient;
  return { db, store, touched, rpcs };
}

const UID = "111222333444555666";
const DATE = "2026-08-11";
const TOKEN = "interaction_tok_abc";
const ORIGINAL_URL = `https://discord.com/api/v10/webhooks/app1/${TOKEN}/messages/@original`;
const CARD_URL_PREFIX = "https://disconnections.app/i/";

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

// Reassigned per test (see beforeEach); the hoisted mock factories close over it.
type Route = ReturnType<typeof mkDb> & { onWork?: () => void };
let route: Route = mkDb();
// The background work handed to waitUntil. The handler ACKs its internal caller before touching the
// DB, so the test has to drain these before asserting on what Discord received.
const pending: Promise<unknown>[] = [];

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  },
}));
// admin() is the first thing the background job does, which makes it the one deterministic seam for
// "the environment changed underneath the job" (see the missing-key test below).
vi.mock("../api/_admin.js", () => ({
  admin: () => {
    route.onWork?.();
    return route.db;
  },
}));
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => PUZZLE,
  todayET: () => DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));

const { default: handler } = await import("../api/post-share");
// The real verifier, unmocked: the whole point of the assertion is that the url we posted is one
// /api/share-png would actually accept.
const { parseSharePngToken } = await import("../api/_share");

type Res = { statusCode: number; body: any; headers: Record<string, string> };
async function call(
  headers: Record<string, string>,
  body: unknown,
  method = "POST",
): Promise<Res> {
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
  await handler({ method, headers, body } as any, res);
  // Drain the background work before asserting on the Discord edit.
  await Promise.all(pending.splice(0));
  return res;
}

const AUTH = { authorization: "Bearer s3cret" };
const job = (extra: Record<string, unknown> = {}) => ({
  appId: "app1",
  token: TOKEN,
  userId: UID,
  date: DATE,
  ...extra,
});

const calls = (): [string, RequestInit][] => (globalThis.fetch as any).mock.calls;
const lastEdit = (): [string, RequestInit] => calls()[calls().length - 1];
const payloadOf = (init: RequestInit): any => JSON.parse(init.body as string);
// The card url out of an embed edit, e.g. https://disconnections.app/i/<token>.png
const embedUrl = (init: RequestInit): string => payloadOf(init).embeds[0].image.url;

describe("api/post-share", () => {
  beforeEach(() => {
    route = mkDb();
    pending.length = 0;
    process.env.INTERNAL_SECRET = "s3cret";
    process.env.VITE_DISCORD_CLIENT_ID = "app1";
    // A fresh Response per call: a body stream can only be read once.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 })),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  // The Discord signature was verified upstream; this endpoint is proven to be ours by
  // INTERNAL_SECRET (the post-card idiom). Without it a stranger could spend an interaction token.
  describe("internal auth", () => {
    it("rejects anything but POST", async () => {
      const r = await call(AUTH, job(), "GET");
      expect(r.statusCode).toBe(405);
      expect(calls()).toHaveLength(0);
    });

    it("403s without the internal bearer", async () => {
      const r = await call({}, job());
      expect(r.statusCode).toBe(403);
      expect(calls()).toHaveLength(0);
    });

    it("403s with a wrong bearer", async () => {
      const r = await call({ authorization: "Bearer nope" }, job());
      expect(r.statusCode).toBe(403);
      expect(calls()).toHaveLength(0);
    });

    it("403s when no secret is configured at all (never fails open)", async () => {
      delete process.env.INTERNAL_SECRET;
      expect((await call({ authorization: "Bearer undefined" }, job())).statusCode).toBe(403);
      expect(calls()).toHaveLength(0);
    });

    it("ACKs its caller immediately, before the work", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      const r = await call(AUTH, job());
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(r.headers["cache-control"]).toBe("no-store");
    });
  });

  // The picture is the point of this route: a JSON PATCH of the deferred interaction response
  // carrying a bare image embed that points at the player's permanent card url.
  it("edits the deferred message into an embed of the permanent card url", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    await call(AUTH, job());

    expect(calls()).toHaveLength(1);
    const [url, init] = lastEdit();
    expect(url).toBe(ORIGINAL_URL);
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    // No bytes: this is a link, not an upload.
    expect(init.body).not.toBeInstanceOf(FormData);
    expect(typeof init.body).toBe("string");
    // Image only — no title, description, or url of our own, so Discord draws just the picture.
    expect(payloadOf(init)).toEqual({ embeds: [{ image: { url: expect.any(String) } }] });

    const link = embedUrl(init);
    expect(link.startsWith(CARD_URL_PREFIX)).toBe(true);
    expect(link.endsWith(".png")).toBe(true);
    // The url is one /api/share-png will actually serve: its token verifies, and it names exactly
    // this player and date.
    const token = link.slice(CARD_URL_PREFIX.length, -".png".length);
    expect(parseSharePngToken(token)).toEqual({ userId: UID, date: DATE });
  });

  it("looks up nothing but the replay — the url's reader fetches the stats itself", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
    await call(AUTH, job());
    expect(route.touched).toEqual(["progress"]); // no scores row, no streak
    expect(route.rpcs).toEqual([]);
  });

  it("falls back to the app id in the environment when the job doesn't carry one", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    await call(AUTH, { token: TOKEN, userId: UID, date: DATE });
    expect(lastEdit()[0]).toBe(ORIGINAL_URL);
  });

  // The result is replayed from the player's own append-only record — the same one /api/score
  // scores from — so an internal call can't invent one, and can't dress up someone else's. A url
  // for a result that doesn't exist would 404 into a broken image, so it must never be emitted.
  describe("replay gate", () => {
    it("never emits a url for a game the player didn't finish", async () => {
      route.store.progress.push({
        user_id: UID,
        puzzle_date: DATE,
        guesses: [["A0", "B0", "C0", "D0"]],
        hints: [],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job());
      // One edit, and it carries no picture: the deferred message is resolved with the apology copy
      // rather than left hanging as a dead "thinking…".
      expect(calls()).toHaveLength(1);
      const [url, init] = lastEdit();
      expect(url).toBe(ORIGINAL_URL);
      expect(payloadOf(init).embeds).toBeUndefined();
      expect(payloadOf(init).content).toBeTruthy();
      expect(String(warn.mock.calls[0])).toContain("[post-share]");
    });

    it("never emits a url for a game that was never played", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job());
      expect(payloadOf(lastEdit()[1]).embeds).toBeUndefined();
      expect(JSON.stringify(calls())).not.toContain(CARD_URL_PREFIX);
    });

    it("points only at the named player's own result, never at a grid off the request", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      await call(AUTH, job());
      await call(AUTH, job({ grid: [[0, 1, 2, 3]], solved: false, score: 99_999, mistakes: 4 }));
      // Identical: the url names (user, date) and nothing else, so every field the request tried to
      // supply was ignored.
      expect(embedUrl(calls()[1][1])).toBe(embedUrl(calls()[0][1]));
    });

    it("touches nothing when the job has no interaction token to edit", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job({ token: "" }));
      expect(calls()).toHaveLength(0);
      expect(String(warn.mock.calls[0])).toContain("[post-share]");
    });

    it("touches nothing when the job's date is malformed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job({ date: "yesterday" }));
      expect(calls()).toHaveLength(0);
    });
  });

  // /share must never get WORSE than it was: before the picture it posted a Components V2 card of
  // emoji squares, and that card is what a failed embed degrades to.
  describe("fallback to the emoji card", () => {
    const assertEmojiCard = (init: RequestInit): void => {
      expect(init.method).toBe("PATCH");
      expect(init.body).not.toBeInstanceOf(FormData);
      const payload = payloadOf(init);
      expect(payload.flags).toBe(1 << 15); // IS_COMPONENTS_V2
      expect(payload.components[0].type).toBe(17); // CONTAINER
      // The grid of colour squares the card has always carried.
      const text = JSON.stringify(payload.components[0].components);
      expect(text).toMatch(/🟨|🟩|🟦|🟪/);
      expect(text).toContain("Disconnections #1170");
    };

    it("posts the emoji card when Discord refuses the embed", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{"message":"Invalid Form Body","code":50035}', { status: 400 }))
        .mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await call(AUTH, job());

      expect(calls()).toHaveLength(2);
      expect(String(calls()[0][1].body)).toContain(CARD_URL_PREFIX); // the embed was attempted first
      assertEmojiCard(calls()[1][1]);
      // The stat line keeps the time + points the inline card used to show — fetched HERE, on the
      // fallback path only, which is why the scores row is read at all in this test.
      const stats = JSON.stringify(payloadOf(calls()[1][1]).components[0].components);
      expect(stats).toContain("2:14"); // 134s
      expect(stats).toContain("412 pts");
      expect(route.touched).toContain("scores");
      // Discord's own text is the only diagnosis available without live credentials.
      expect(err.mock.calls.flat().join(" ")).toContain("50035");
    });

    it("posts the emoji card, and no url, when there's no key to sign one with", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      // The route's own auth needed INTERNAL_SECRET to let this call in, so the only way to reach
      // the edit without one is for it to vanish mid-flight — which is exactly the deploy hazard the
      // guard exists for. Dropping it as the background job opens the DB puts it deterministically
      // before the url would be minted. An unsigned url is worse than yesterday's card: it would
      // never verify, so the embed would be a permanently broken image.
      route.onWork = () => {
        delete process.env.INTERNAL_SECRET;
      };
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await call(AUTH, job());

      expect(calls()).toHaveLength(1); // the embed was never even attempted
      const [url, init] = lastEdit();
      expect(url).toBe(ORIGINAL_URL);
      assertEmojiCard(init);
      expect(JSON.stringify(calls())).not.toContain(CARD_URL_PREFIX);
      expect(String(err.mock.calls[0])).toContain("[post-share]");
    });

    it("gives up quietly, and greppably, when even the fallback edit fails", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 })),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      // No throw escapes: the handler already ACKed, and there is nothing left to try.
      const r = await call(AUTH, job());
      expect(r.statusCode).toBe(200);
      expect(calls()).toHaveLength(2); // embed refused, then the fallback card refused
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("[post-share]");
      expect(logged).toContain("10015");
    });
  });
});
