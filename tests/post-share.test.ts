import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api/post-share.ts is the /share RENDER, split out of /api/interactions the same way the "who's
// playing" card is (api/post-card.ts) — the latency-critical interactions function must never carry
// @napi-rs/canvas. /api/interactions defers the /share reply and calls this with the invoker's id
// and the interaction token; this function replays the game, draws the portrait card, and edits the
// deferred message into the picture.
//
// What's pinned here: the INTERNAL_SECRET gate (a forged call must not be able to spend someone's
// interaction token), the replay gate (the result comes from the player's OWN progress record, never
// from the request), the happy-path edit contract (a multipart PATCH to the @original webhook URL
// carrying real PNG bytes), and — the promise that /share never gets WORSE than it was — the
// degradation to the pre-image Components V2 emoji card when the picture can't be produced.
//
// Harness follows tests/share-moment.test.ts: Supabase is shimmed onto in-memory tables, the render
// is REAL (so the PNG assertion checks actual bytes) but interposable so a failure can be forced,
// and Discord is a stubbed global fetch.

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

function mkDb(seed: Partial<Store> = {}): { db: SupabaseClient; store: Store } {
  const store: Store = { progress: seed.progress ?? [], scores: seed.scores ?? [] };
  const db = {
    from: (t: keyof Store) => new Q(store, t),
    // fetchStreak's user_streak RPC. "No such function" keeps the streak off the card
    // deliberately, rather than by an accidental TypeError the best-effort catch would swallow.
    rpc: async () => ({ data: null, error: { code: "42883" } }),
  } as unknown as SupabaseClient;
  return { db, store };
}

const UID = "111222333444555666";
const DATE = "2026-08-11";
const TOKEN = "interaction_tok_abc";
const ORIGINAL_URL = `https://discord.com/api/v10/webhooks/app1/${TOKEN}/messages/@original`;

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
let route: { db: SupabaseClient; store: Store; renderThrows: boolean } = {
  ...mkDb(),
  renderThrows: false,
};
// The background work handed to waitUntil. The handler ACKs its internal caller before rendering,
// so the test has to drain these before asserting on what Discord received.
const pending: Promise<unknown>[] = [];

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  },
}));
vi.mock("../api/_admin.js", () => ({ admin: () => route.db }));
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => PUZZLE,
  todayET: () => DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));
// The real renderer, interposed: the happy path draws an actual PNG (which is what makes the byte
// assertions meaningful), and a test can force the "canvas blew up" branch without stubbing the
// drawing out of every other case.
vi.mock("../api/_sharecard.js", async () => {
  const actual = await vi.importActual<typeof import("../api/_sharecard")>("../api/_sharecard.js");
  return {
    ...actual,
    renderShareCard: async (...args: Parameters<typeof actual.renderShareCard>) => {
      if (route.renderThrows) throw new Error("canvas exploded");
      return actual.renderShareCard(...args);
    },
  };
});

const { default: handler } = await import("../api/post-share");

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
  // Drain the background render before asserting on the Discord edit.
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

describe("api/post-share", () => {
  beforeEach(() => {
    const { db, store } = mkDb();
    route = { db, store, renderThrows: false };
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

    it("ACKs its caller immediately, before the render", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      const r = await call(AUTH, job());
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(r.headers["cache-control"]).toBe("no-store");
    });
  });

  // The picture is the point of this route: a multipart PATCH of the deferred interaction response.
  it("edits the deferred message into the portrait card", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
    await call(AUTH, job());

    expect(calls()).toHaveLength(1);
    const [url, init] = lastEdit();
    expect(url).toBe(ORIGINAL_URL);
    expect(init.method).toBe("PATCH");
    // No Content-Type of ours — fetch writes the multipart boundary itself.
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined();

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload).toEqual({ attachments: [{ id: 0, filename: `disconnections-${DATE}.png` }] });

    const file = form.get("files[0]") as File;
    expect(file.name).toBe(`disconnections-${DATE}.png`);
    expect(file.type).toBe("image/png");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // \x89PNG
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("falls back to the app id in the environment when the job doesn't carry one", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    await call(AUTH, { token: TOKEN, userId: UID, date: DATE });
    expect(lastEdit()[0]).toBe(ORIGINAL_URL);
  });

  // The result is replayed from the player's own append-only record — the same one /api/score
  // scores from — so an internal call can't invent one, and can't dress up someone else's.
  describe("replay gate", () => {
    it("never posts a picture for a game the player didn't finish", async () => {
      route.store.progress.push({
        user_id: UID,
        puzzle_date: DATE,
        guesses: [["A0", "B0", "C0", "D0"]],
        hints: [],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job());
      // One edit, and it is NOT an image: the deferred message is resolved with the apology copy
      // rather than left hanging as a dead "thinking…".
      expect(calls()).toHaveLength(1);
      const [url, init] = lastEdit();
      expect(url).toBe(ORIGINAL_URL);
      expect(init.body).not.toBeInstanceOf(FormData);
      expect(JSON.parse(init.body as string).content).toBeTruthy();
      expect(String(warn.mock.calls[0])).toContain("[post-share]");
    });

    it("never posts a picture for a game that was never played", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await call(AUTH, job());
      expect((lastEdit()[1].body as unknown) instanceof FormData).toBe(false);
    });

    it("draws only what the named player's own record says, never a grid off the request", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      const bytes = async (i: number): Promise<Buffer> => {
        const form = (calls()[i][1].body as FormData).get("files[0]") as File;
        return Buffer.from(await form.arrayBuffer());
      };
      await call(AUTH, job());
      await call(AUTH, job({ grid: [[0, 1, 2, 3]], solved: false, score: 99_999, mistakes: 4 }));
      // Byte-identical: every field the request tried to supply was ignored.
      expect(Buffer.compare(await bytes(1), await bytes(0))).toBe(0);
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
  // emoji squares, and that card is what a failed render degrades to.
  describe("fallback to the emoji card", () => {
    const assertEmojiCard = (init: RequestInit): void => {
      expect(init.method).toBe("PATCH");
      expect(init.body).not.toBeInstanceOf(FormData);
      const payload = JSON.parse(init.body as string);
      expect(payload.flags).toBe(1 << 15); // IS_COMPONENTS_V2
      expect(payload.components[0].type).toBe(17); // CONTAINER
      // The grid of colour squares the card has always carried.
      const text = JSON.stringify(payload.components[0].components);
      expect(text).toMatch(/🟨|🟩|🟦|🟪/);
      expect(text).toContain("Disconnections #1170");
    };

    it("posts the emoji card when the render throws", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      route.store.scores.push({ user_id: UID, puzzle_date: DATE, score: 412, duration_ms: 134_000 });
      route.renderThrows = true;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await call(AUTH, job());

      expect(calls()).toHaveLength(1);
      const [url, init] = lastEdit();
      expect(url).toBe(ORIGINAL_URL);
      assertEmojiCard(init);
      // The stat line keeps the time + points the inline card used to show.
      const payload = JSON.parse(init.body as string);
      const stats = JSON.stringify(payload.components[0].components);
      expect(stats).toContain("2:14"); // 134s
      expect(stats).toContain("412 pts");
      expect(String(err.mock.calls[0])).toContain("[post-share]");
    });

    it("posts the emoji card when Discord refuses the attachment", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{"message":"Invalid Form Body","code":50035}', { status: 400 }))
        .mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await call(AUTH, job());

      expect(calls()).toHaveLength(2);
      expect(calls()[0][1].body).toBeInstanceOf(FormData); // the picture was attempted first
      assertEmojiCard(calls()[1][1]);
      // Discord's own text is the only diagnosis available without live credentials.
      expect(err.mock.calls.flat().join(" ")).toContain("50035");
    });

    it("gives up quietly, and greppably, when even the fallback edit fails", async () => {
      route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
      route.renderThrows = true;
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
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("[post-share]");
      expect(logged).toContain("10015");
    });
  });
});
