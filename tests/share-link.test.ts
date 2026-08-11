import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countMintedToday,
  etMidnightIso,
  loadCachedShareLink,
  MAX_SHARE_DATES_PER_DAY,
  mintQuickLink,
  parseShareCustomId,
  quickLinkUrl,
  saveShareLink,
  SHARE_LINK_REMINT_MS,
  shareCustomId,
  shareMessage,
  shareResultPhrase,
} from "../api/_share";

// The MINT half of the share loop (api/share-link.ts + api/_share.ts): turning a finished
// daily into a Discord quick link. What's pinned here is everything that decides WHETHER a
// link is minted and WHAT goes on it — the caller can only ever mint their own finished
// result, a second Share click reuses the first link, the quota can't be walked, and the
// prefilled message can't leak a word off the board.
//
// The Supabase service client is shimmed onto tiny in-memory tables that mimic the exact
// chains the code issues (the tests/piggyback-recap.test.ts pattern; PGlite per file would
// push the parallel suite over a memory cliff, and what's under test is the TS gate logic).
// Discord's quick-links POST is a stubbed global fetch — it needs a live user token, so the
// real endpoint is unreachable from a test.

// ---- in-memory tables + the Supabase-builder shim over them (only the chains we use) ----
type Row = Record<string, any>;
type Store = { share_links: Row[]; progress: Row[] };

class Q {
  private op: "select" | "insert" | "upsert" = "select";
  private eqs: [string, unknown][] = [];
  private gtes: [string, unknown][] = [];
  private values: Row | null = null;
  private counting = false;
  constructor(
    private store: Store,
    private table: keyof Store,
    private fail: string | null,
  ) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.count) this.counting = true;
    return this;
  }
  upsert(obj: Row): this {
    this.op = "upsert";
    this.values = obj;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs.push([col, val]);
    return this;
  }
  gte(col: string, val: unknown): this {
    this.gtes.push([col, val]);
    return this;
  }
  private rows(): Row[] {
    return this.store[this.table].filter(
      (r) =>
        this.eqs.every(([c, v]) => r[c] === v) &&
        this.gtes.every(([c, v]) => String(r[c]) >= String(v)),
    );
  }
  async maybeSingle(): Promise<{ data: Row | null; error: { code?: string } | null }> {
    if (this.fail) return { data: null, error: { code: this.fail } };
    return { data: this.rows()[0] ?? null, error: null };
  }
  // Thenable, so an awaited chain that doesn't end in maybeSingle() resolves like PostgREST.
  then(
    resolve: (v: { data: unknown; count?: number; error: { code?: string } | null }) => void,
  ): void {
    if (this.fail) {
      resolve({ data: null, error: { code: this.fail } });
      return;
    }
    if (this.op === "upsert") {
      const row = { ...(this.values as Row) };
      const i = this.store[this.table].findIndex(
        (r) => r.user_id === row.user_id && r.puzzle_date === row.puzzle_date,
      );
      // On conflict PostgREST sets ONLY the columns it was given (ON CONFLICT DO UPDATE SET
      // <provided>), so a column left to its default keeps its old value on the update path.
      // Merging rather than replacing is what makes that visible to the tests below.
      if (i >= 0) Object.assign(this.store[this.table][i], row);
      else this.store[this.table].push(row);
      resolve({ data: null, error: null });
      return;
    }
    const hits = this.rows();
    resolve({ data: hits, count: this.counting ? hits.length : undefined, error: null });
  }
}

function mkDb(seed: Partial<Store> = {}, fail: string | null = null): { db: SupabaseClient; store: Store } {
  const store: Store = { share_links: seed.share_links ?? [], progress: seed.progress ?? [] };
  const db = { from: (t: keyof Store) => new Q(store, t, fail) } as unknown as SupabaseClient;
  return { db, store };
}

const UID = "111222333444555666";
const DATE = "2026-08-11";

// ——— custom_id: what rides on the link and comes back at the recipient's boot ———
describe("share custom_id", () => {
  it("round-trips the sharer and the date", () => {
    const cid = shareCustomId(UID, DATE);
    expect(cid).toBe(`${UID}/20260811`);
    expect(parseShareCustomId(cid)).toEqual({ userId: UID, date: DATE });
  });

  it("stays short enough to sit in a user-visible URL", () => {
    expect(shareCustomId(UID, DATE).length).toBeLessThan(40);
  });

  it("refuses anything that isn't one of ours (a static campaign link, junk, nothing)", () => {
    for (const v of ["launch-tweet", "", "abc/20260811", `${UID}/2026-08-11`, null, 7])
      expect(parseShareCustomId(v)).toBeNull();
  });
});

// ——— the prefilled message: the one piece of the loop a human reads before the image loads ———
describe("share message", () => {
  const words = ["yellow", "green", "blue", "purple", "group", "category", "answer", "word"];

  it("names the puzzle and the outcome, Wordle-style", () => {
    expect(shareMessage(1170, true, 1)).toBe("Disconnections #1170: solved with 1 mistake");
    expect(shareMessage(1170, true, 2)).toBe("Disconnections #1170: solved with 2 mistakes");
    expect(shareMessage(1170, true, 0)).toBe("Disconnections #1170: solved with no mistakes");
    expect(shareMessage(1170, false, 4)).toBe("Disconnections #1170: ran out of guesses");
  });

  it("leaves no dangling # when the puzzle number is unknown", () => {
    expect(shareMessage(null, true, 1)).toBe("Disconnections: solved with 1 mistake");
    expect(shareMessage(undefined, false, 4)).not.toContain("#");
  });

  it("carries no board words, no group names, and no spoilers", () => {
    for (const solved of [true, false]) {
      for (let m = 0; m <= 4; m++) {
        const msg = shareMessage(1170, solved, m).toLowerCase();
        for (const w of words) expect(msg, `leaked "${w}"`).not.toContain(w);
        // The grid emoji are the other way a share can spoil a category; the message is text only.
        expect(msg).not.toMatch(/[🟨🟩🟦🟪]/u);
      }
    }
  });

  it("keeps the house voice: no em dashes", () => {
    expect(shareMessage(1170, true, 1)).not.toContain("—");
    expect(shareResultPhrase(false, 4)).not.toContain("—");
  });
});

// ——— the URL we hand the clipboard when the native share modal isn't available ———
describe("quick link url", () => {
  it("carries the sharer, the custom id, and the link id", () => {
    const u = new URL(quickLinkUrl("app1", UID, shareCustomId(UID, DATE), "lnk_9"));
    expect(u.origin + u.pathname).toBe("https://discord.com/activities/app1");
    expect(u.searchParams.get("referrer_id")).toBe(UID);
    expect(u.searchParams.get("custom_id")).toBe(`${UID}/20260811`);
    expect(u.searchParams.get("link_id")).toBe("lnk_9");
  });
});

// ——— the cache: one link per (player, date), reused on every later Share click ———
describe("minted-link cache", () => {
  const fresh = (over: Row = {}): Row => ({
    user_id: UID,
    puzzle_date: DATE,
    link_id: "lnk_1",
    url: "https://discord.com/activities/app1?link_id=lnk_1",
    created_at: new Date().toISOString(),
    ...over,
  });

  it("returns the existing link for a date already minted", async () => {
    const { db } = mkDb({ share_links: [fresh()] });
    expect(await loadCachedShareLink(db, UID, DATE)).toEqual({
      link_id: "lnk_1",
      url: "https://discord.com/activities/app1?link_id=lnk_1",
    });
  });

  it("is per (player, date): another day, or another player, is a miss", async () => {
    const { db } = mkDb({ share_links: [fresh()] });
    expect(await loadCachedShareLink(db, UID, "2026-08-10")).toBeNull();
    expect(await loadCachedShareLink(db, "999", DATE)).toBeNull();
  });

  it("re-mints a link about to hit Discord's 30-day TTL", async () => {
    const now = Date.now();
    const old = new Date(now - SHARE_LINK_REMINT_MS - 1000).toISOString();
    const { db } = mkDb({ share_links: [fresh({ created_at: old })] });
    expect(await loadCachedShareLink(db, UID, DATE, now)).toBeNull();
  });

  it("keeps serving a link right up to the re-mint boundary", async () => {
    const now = Date.now();
    const edge = new Date(now - SHARE_LINK_REMINT_MS).toISOString();
    const { db } = mkDb({ share_links: [fresh({ created_at: edge })] });
    expect(await loadCachedShareLink(db, UID, DATE, now)).not.toBeNull();
  });

  it("degrades to uncached minting when the table isn't there yet", async () => {
    const { db } = mkDb({}, "42P01");
    expect(await loadCachedShareLink(db, UID, DATE)).toBeNull();
    expect(await countMintedToday(db, UID, etMidnightIso())).toBe(0);
    await expect(saveShareLink(db, { user_id: UID, puzzle_date: DATE, link_id: "l", url: "u" })).resolves.toBeUndefined();
  });

  it("writes a row the next Share click can find", async () => {
    const { db, store } = mkDb();
    await saveShareLink(db, { user_id: UID, puzzle_date: DATE, link_id: "lnk_2", url: "u2" });
    expect(store.share_links).toHaveLength(1);
    expect(store.share_links[0].created_at).toBeTruthy();
    // A concurrent mint that already wrote the row must not duplicate it.
    await saveShareLink(db, { user_id: UID, puzzle_date: DATE, link_id: "lnk_3", url: "u3" });
    expect(store.share_links).toHaveLength(1);
  });

  it("re-stamps created_at on a re-mint, so a replaced link doesn't read as stale forever", async () => {
    // An upsert only sets the columns it's given, so leaving created_at to the column default
    // would keep the ORIGINAL timestamp on the conflict path: the fresh link would still look
    // 30 days old, and every later Share click would mint again.
    const t0 = new Date("2026-07-01T00:00:00.000Z");
    const t1 = new Date("2026-08-11T00:00:00.000Z");
    const { db, store } = mkDb();
    await saveShareLink(db, { user_id: UID, puzzle_date: DATE, link_id: "old", url: "u" }, t0);
    await saveShareLink(db, { user_id: UID, puzzle_date: DATE, link_id: "new", url: "u2" }, t1);
    expect(store.share_links[0].created_at).toBe(t1.toISOString());
    // …and the freshly stamped row is served, not re-minted.
    expect(await loadCachedShareLink(db, UID, DATE, t1.getTime())).toEqual({
      link_id: "new",
      url: "u2",
    });
  });
});

// ——— the quota: one row per distinct date, so a row count IS the distinct-date count ———
describe("mint quota", () => {
  const at = (iso: string, date: string): Row => ({
    user_id: UID,
    puzzle_date: date,
    link_id: "l",
    url: "u",
    created_at: iso,
  });

  it("counts this player's dates minted since the window opened", async () => {
    const since = "2026-08-11T04:00:00.000Z";
    const { db } = mkDb({
      share_links: [
        at("2026-08-11T05:00:00.000Z", "2026-08-11"),
        at("2026-08-11T06:00:00.000Z", "2026-08-10"),
        at("2026-08-10T05:00:00.000Z", "2026-08-09"), // yesterday's mint: outside the window
        { ...at("2026-08-11T07:00:00.000Z", "2026-08-08"), user_id: "other" },
      ],
    });
    expect(await countMintedToday(db, UID, since)).toBe(2);
  });

  it("caps a walk through the archive at five dates a day", () => {
    expect(MAX_SHARE_DATES_PER_DAY).toBe(5);
  });

  it("resets on the same midnight-ET boundary the puzzle does", () => {
    // Noon ET on a summer day (EDT, UTC-4) -> that day's 04:00Z.
    expect(etMidnightIso(new Date("2026-08-11T16:00:00Z"))).toBe("2026-08-11T04:00:00.000Z");
    // Just after midnight ET is already the new window, not the previous day's.
    expect(etMidnightIso(new Date("2026-08-11T04:30:00Z"))).toBe("2026-08-11T04:00:00.000Z");
    // A winter date (EST, UTC-5) -> 05:00Z, without a tz table.
    expect(etMidnightIso(new Date("2026-01-15T18:00:00Z"))).toBe("2026-01-15T05:00:00.000Z");
  });
});

// ——— the Discord POST: the contract we can't reach without a live user token ———
describe("quick-links POST", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  afterEach(() => vi.restoreAllMocks());

  it("posts the card as a base64 data URI on the player's own bearer token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ link_id: "lnk_7" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await mintQuickLink("app1", "tok_abc", {
      title: "Alice played Disconnections #1170",
      description: "Four groups hiding in sixteen words.",
      customId: shareCustomId(UID, DATE),
      png,
    });
    expect(out).toEqual({ ok: true, linkId: "lnk_7" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/applications/app1/quick-links");
    const headers = (init as RequestInit).headers as Record<string, string>;
    // The docs specify a USER access token here, not the bot token: the link is minted as
    // the player, which is what lets Discord stamp referrer_id onto it.
    expect(headers.Authorization).toBe("Bearer tok_abc");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.custom_id).toBe(`${UID}/20260811`);
    expect(sent.title).toContain("#1170");
    expect(sent.image).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("hands Discord's own error text back so a broken contract is diagnosable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"message":"Missing Access","code":50001}', { status: 403 }),
      ),
    );
    const out = await mintQuickLink("app1", "tok", { title: "t", description: "d", customId: "c", png });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(403);
      expect(out.body).toContain("50001");
    }
  });

  it("treats a 2xx with no link_id as a failure rather than minting a broken share", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 })));
    const out = await mintQuickLink("app1", "tok", { title: "t", description: "d", customId: "c", png });
    expect(out.ok).toBe(false);
  });
});

// ——— the route itself: identity, own-result-only, cache-before-quota, the quota ———
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
vi.mock("../api/_discord.js", () => ({
  fetchDiscordUser: async () => route.user,
  bearerToken: (h: unknown) => (typeof h === "string" ? h.replace(/^Bearer /i, "") : null),
}));
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => PUZZLE,
  todayET: () => DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is fine).
const { default: handler } = await import("../api/share-link");

type Res = { statusCode: number; body: any };
async function call(body: unknown, method = "POST"): Promise<Res> {
  const res: any = {
    statusCode: 0,
    body: undefined,
    setHeader() {},
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

describe("POST /api/share-link", () => {
  beforeEach(() => {
    const { db, store } = mkDb();
    route = { db, store, user: { id: UID, name: "Alice" } };
    process.env.VITE_DISCORD_CLIENT_ID = "app1";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ link_id: "lnk_new" }), { status: 200 }),
      ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects anything but POST", async () => {
    expect((await call({}, "GET")).statusCode).toBe(405);
  });

  it("rejects a caller Discord doesn't recognise", async () => {
    route.user = null;
    expect((await call({ date: DATE, accessToken: "bad" })).statusCode).toBe(401);
  });

  it("rejects a malformed date before touching anything", async () => {
    expect((await call({ date: "yesterday", accessToken: "t" })).statusCode).toBe(400);
  });

  it("mints from the caller's OWN record, never from the request", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const r = await call({ date: DATE, accessToken: "t", grid: [[9, 9, 9, 9]] });
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.link_id).toBe("lnk_new");
    expect(r.body.message).toBe("Disconnections #1170: solved with no mistakes");
    expect(r.body.url).toContain(`referrer_id=${UID}`);
  });

  it("refuses to mint a game the caller never played", async () => {
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.body).toEqual({ ok: false, reason: "no-progress" });
  });

  it("refuses to mint a game still in progress", async () => {
    route.store.progress.push({
      user_id: UID,
      puzzle_date: DATE,
      guesses: [["A0", "B0", "C0", "D0"]],
      hints: [],
    });
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.body).toEqual({ ok: false, reason: "not-finished" });
  });

  it("never mints someone else's result: the record is looked up by the token's own id", async () => {
    route.store.progress.push({ user_id: "999", puzzle_date: DATE, guesses: WON, hints: [] });
    expect((await call({ date: DATE, accessToken: "t", userId: "999" })).body.reason).toBe("no-progress");
  });

  it("reuses the minted link on a second Share click, with no second Discord write", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const first = await call({ date: DATE, accessToken: "t" });
    const second = await call({ date: DATE, accessToken: "t" });
    expect(second.body.link_id).toBe(first.body.link_id);
    expect(second.body.url).toBe(first.body.url);
    expect(second.body.cached).toBe(true);
    // Exactly one quick-links POST across both clicks.
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it("refuses a sixth new date in one day", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_SHARE_DATES_PER_DAY; i++) {
      route.store.share_links.push({
        user_id: UID,
        puzzle_date: `2026-07-0${i + 1}`,
        link_id: `l${i}`,
        url: "u",
        created_at: now,
      });
    }
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(429);
    expect(r.body.reason).toBe("rate-limited");
  });

  it("still re-shares an already-minted date after the cap is hit (cache before quota)", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    const now = new Date().toISOString();
    route.store.share_links.push({
      user_id: UID,
      puzzle_date: DATE,
      link_id: "lnk_old",
      url: "https://discord.com/activities/app1?link_id=lnk_old",
      created_at: now,
    });
    for (let i = 0; i < MAX_SHARE_DATES_PER_DAY; i++) {
      route.store.share_links.push({
        user_id: UID,
        puzzle_date: `2026-07-0${i + 1}`,
        link_id: `l${i}`,
        url: "u",
        created_at: now,
      });
    }
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(200);
    expect(r.body.link_id).toBe("lnk_old");
  });

  it("reports a Discord failure rather than pretending a link exists", async () => {
    route.store.progress.push({ user_id: UID, puzzle_date: DATE, guesses: WON, hints: [] });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 500 })));
    const r = await call({ date: DATE, accessToken: "t" });
    expect(r.statusCode).toBe(502);
    expect(route.store.share_links).toHaveLength(0); // nothing cached from a failed mint
  });
});
