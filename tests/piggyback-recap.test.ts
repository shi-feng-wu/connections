import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { claimRecapSlot, recapText, STALE_CLAIM_MS } from "../api/_recap";
import { postsOptedOut, roomEstablished } from "../api/post-card";
import { piggybackRecapText } from "../src/discord-messages";

// The bot-less "piggyback recap": in a server without the bot, the day's FIRST launcher carries
// yesterday's recap into the channel as a second interaction followup, right behind the who's
// playing card (api/post-card.ts piggybackRecap). The nightly cron can never reach these rooms —
// recap_channels() excludes token-backed cards — so this is their only delivery.
//
// This covers the three gates that decide whether it fires, plus the aside that only it carries.
// The gates are DB reads/writes, so the Supabase service client is shimmed onto tiny in-memory
// tables that mimic the exact chains the code issues (the pattern tests/chat-api.test.ts uses;
// PGlite per file would push the parallel suite over a memory cliff, and what's under test here is
// the TS gate logic, not SQL). The render + Discord POST are NOT exercised: they need canvas and a
// live token, and everything decidable without them is a pure gate above.

// ---- in-memory tables + the Supabase-builder shim over them (only the chains we use) ----
type Row = Record<string, any>;

type Store = {
  post_optouts: Row[];
  live_cards: Row[];
  recap_posts: Row[];
};

// The primary keys the shim enforces, so an insert can raise a real 23505 the way Postgres does.
const PK: Record<string, string[]> = {
  post_optouts: ["scope_id", "channel_id"],
  live_cards: ["scope_id", "puzzle_date", "channel_id"],
  recap_posts: ["scope_id", "puzzle_date", "channel_id"],
};

class Q {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private eqs: [string, unknown][] = [];
  private lts: [string, unknown][] = [];
  private values: Row | null = null;
  private returning = false;
  constructor(
    private store: Store,
    private table: keyof Store,
  ) {}
  select(): this {
    if (this.op === "select") return this;
    this.returning = true;
    return this;
  }
  insert(obj: Row): this {
    this.op = "insert";
    this.values = obj;
    return this;
  }
  update(obj: Row): this {
    this.op = "update";
    this.values = obj;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs.push([col, val]);
    return this;
  }
  lt(col: string, val: unknown): this {
    this.lts.push([col, val]);
    return this;
  }
  // `.match(key)` is shorthand for one eq per column (what the ledger helpers use).
  match(obj: Row): this {
    for (const [k, v] of Object.entries(obj)) this.eqs.push([k, v]);
    return this;
  }
  limit(): this {
    return this;
  }
  async maybeSingle(): Promise<{ data: Row | null }> {
    return { data: this.rows()[0] ?? null };
  }
  private rows(): Row[] {
    return this.store[this.table].filter(
      (r) =>
        this.eqs.every(([c, v]) => r[c] === v) &&
        this.lts.every(([c, v]) => r[c] < (v as string)),
    );
  }
  // Thenable, so an awaited chain that doesn't end in maybeSingle() resolves like PostgREST.
  then(
    resolve: (v: { data: unknown; error: { code?: string } | null }) => void,
  ): void {
    if (this.op === "insert") {
      const row = { ...(this.values as Row) };
      const cols = PK[this.table];
      const clash = this.store[this.table].some((r) => cols.every((c) => r[c] === row[c]));
      if (clash) {
        resolve({ data: null, error: { code: "23505" } }); // unique violation, as Postgres raises it
        return;
      }
      this.store[this.table].push(row);
      resolve({ data: this.returning ? [row] : null, error: null });
      return;
    }
    const hits = this.rows();
    if (this.op === "update") for (const r of hits) Object.assign(r, this.values);
    if (this.op === "delete")
      this.store[this.table] = this.store[this.table].filter((r) => !hits.includes(r));
    resolve({ data: this.returning ? hits : null, error: null });
  }
}

function mkDb(seed: Partial<Store> = {}): { db: SupabaseClient; store: Store } {
  const store: Store = {
    post_optouts: seed.post_optouts ?? [],
    live_cards: seed.live_cards ?? [],
    recap_posts: seed.recap_posts ?? [],
  };
  const db = { from: (t: keyof Store) => new Q(store, t) } as unknown as SupabaseClient;
  return { db, store };
}

const SCOPE = "g:111";
const CHANNEL = "chA";
const TODAY = "2026-08-11";
const YESTERDAY = "2026-08-10";
const KEY = { scope_id: SCOPE, puzzle_date: YESTERDAY, channel_id: CHANNEL };

// ——— gate (a): a muted channel gets nothing, on either post path ———
// This is the gate that had a live hole: post-card's only opt-out check sat AFTER the bot-less
// early return, so /mute never silenced a bot-less room's token card. Both paths now call this.
describe("post_optouts gate", () => {
  it("suppresses posts in a channel a moderator muted", async () => {
    const { db } = mkDb({ post_optouts: [{ scope_id: SCOPE, channel_id: CHANNEL }] });
    expect(await postsOptedOut(db, SCOPE, CHANNEL)).toBe(true);
  });

  it("leaves other channels in the same server alone", async () => {
    const { db } = mkDb({ post_optouts: [{ scope_id: SCOPE, channel_id: "chB" }] });
    expect(await postsOptedOut(db, SCOPE, CHANNEL)).toBe(false);
  });

  it("is off by default (no row = posts on)", async () => {
    const { db } = mkDb();
    expect(await postsOptedOut(db, SCOPE, CHANNEL)).toBe(false);
  });
});

// ——— gate (b): never open with a recap on a room's first-ever launch ———
describe("established-room gate", () => {
  it("blocks a channel's first-ever launch (nothing before today)", async () => {
    const { db } = mkDb();
    expect(await roomEstablished(db, SCOPE, CHANNEL, TODAY)).toBe(false);
  });

  it("still blocks when the only card is today's, which the live card just wrote", async () => {
    // postDmCard has already upserted today's row by the time the piggyback runs, so the predicate
    // has to compare against TODAY (not yesterday) to stay order-independent.
    const { db } = mkDb({
      live_cards: [{ scope_id: SCOPE, puzzle_date: TODAY, channel_id: CHANNEL, message_id: "m1" }],
    });
    expect(await roomEstablished(db, SCOPE, CHANNEL, TODAY)).toBe(false);
  });

  it("allows the second day (a card posted here before today)", async () => {
    const { db } = mkDb({
      live_cards: [
        { scope_id: SCOPE, puzzle_date: YESTERDAY, channel_id: CHANNEL, message_id: "m0" },
        { scope_id: SCOPE, puzzle_date: TODAY, channel_id: CHANNEL, message_id: "m1" },
      ],
    });
    expect(await roomEstablished(db, SCOPE, CHANNEL, TODAY)).toBe(true);
  });

  it("is per-channel: history in a sibling channel doesn't establish this one", async () => {
    const { db } = mkDb({
      live_cards: [{ scope_id: SCOPE, puzzle_date: YESTERDAY, channel_id: "chB", message_id: "m0" }],
    });
    expect(await roomEstablished(db, SCOPE, CHANNEL, TODAY)).toBe(false);
  });
});

// ——— gate (c): the recap_posts ledger, shared with the cron ———
describe("recap ledger claim", () => {
  it("gives the slot to the first caller, stamped as a launch row", async () => {
    const { db, store } = mkDb();
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("claimed");
    expect(store.recap_posts).toHaveLength(1);
    expect(store.recap_posts[0].status).toBe("claimed");
    // via='launch' is what keeps this row out of recap_pending()'s dormancy window — a piggyback
    // says nothing about whether the BOT can post here (see the dormancy block in schema.sql).
    expect(store.recap_posts[0].via).toBe("launch");
  });

  it("skips a second launch the same day (idempotent per scope/date/channel)", async () => {
    const { db } = mkDb();
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("claimed");
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("taken");
  });

  it("skips when the cron already posted this date", async () => {
    const { db } = mkDb({ recap_posts: [{ ...KEY, status: "posted", message_id: "m9" }] });
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("taken");
  });

  it("skips a date already recorded as permanently failed", async () => {
    const { db } = mkDb({ recap_posts: [{ ...KEY, status: "failed", http_status: 403 }] });
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("taken");
  });

  it("claims freely once a transient failure released the row", async () => {
    const { db, store } = mkDb();
    await claimRecapSlot(db, KEY, "launch");
    store.recap_posts = []; // what releaseRecapSlot does
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("claimed");
  });

  it("takes over a claim orphaned by a crashed run, and re-stamps it", async () => {
    const now = Date.parse("2026-08-11T12:00:00Z");
    const stale = new Date(now - STALE_CLAIM_MS - 1000).toISOString();
    const { db, store } = mkDb({
      recap_posts: [{ ...KEY, status: "claimed", attempted_at: stale, via: "cron" }],
    });
    expect(await claimRecapSlot(db, KEY, "launch", now)).toBe("recovered");
    expect(store.recap_posts[0].attempted_at).toBe(new Date(now).toISOString());
    // The recovering path owns the attempt, so via follows it: a launch that rescues a killed
    // cron's claim must not file its delivery as cron evidence for dormancy.
    expect(store.recap_posts[0].via).toBe("launch");
  });

  it("hands a stale launch claim back to the cron as a cron row", async () => {
    const now = Date.parse("2026-08-11T12:00:00Z");
    const stale = new Date(now - STALE_CLAIM_MS - 1000).toISOString();
    const { db, store } = mkDb({
      recap_posts: [{ ...KEY, status: "claimed", attempted_at: stale, via: "launch" }],
    });
    expect(await claimRecapSlot(db, KEY, "cron", now)).toBe("recovered");
    expect(store.recap_posts[0].via).toBe("cron"); // the cron's attempt IS bot evidence
  });

  it("leaves a claim alone right up to the staleness boundary", async () => {
    const now = Date.parse("2026-08-11T12:00:00Z");
    // Exactly STALE_CLAIM_MS old: the CAS is a strict `<`, so this is still in flight.
    const edge = new Date(now - STALE_CLAIM_MS).toISOString();
    const { db, store } = mkDb({
      recap_posts: [{ ...KEY, status: "claimed", attempted_at: edge }],
    });
    expect(await claimRecapSlot(db, KEY, "launch", now)).toBe("taken");
    expect(store.recap_posts[0].attempted_at).toBe(edge); // untouched
  });

  it("never steals a fresh in-flight claim from a concurrent launch", async () => {
    const now = Date.parse("2026-08-11T12:00:00Z");
    const fresh = new Date(now - 5000).toISOString();
    const { db } = mkDb({ recap_posts: [{ ...KEY, status: "claimed", attempted_at: fresh }] });
    expect(await claimRecapSlot(db, KEY, "launch", now)).toBe("taken");
  });

  it("reports an error (and posts nothing) when the claim write itself fails", async () => {
    const db = {
      from: () => ({
        insert: () => Promise.resolve({ error: { code: "42P01" } }), // table missing
      }),
    } as unknown as SupabaseClient;
    expect(await claimRecapSlot(db, KEY, "launch")).toBe("error");
  });
});

// ——— the aside: only ever on a piggybacked recap ———
describe("piggyback invite aside", () => {
  const body = recapText({ streak: 3, solved: true, puzzleNo: 42 });

  it("appends one small line with the masked invite link", () => {
    const text = piggybackRecapText(body, "app123");
    expect(text.startsWith(body)).toBe(true); // the recap line still leads
    const aside = text.slice(body.length);
    expect(aside.split("\n").filter((l) => l.trim())).toHaveLength(1); // one line, no more
    expect(aside).toContain("-# "); // Discord's small grey subtext
    expect(aside).toContain("[invite the bot](https://discord.com/oauth2/authorize?client_id=app123");
    expect(aside).toContain("integration_type=0"); // the guild-install ("Add to Server") flow
  });

  it("never touches the cron's recap text (that server already has the bot)", () => {
    // The cron posts recapText's output verbatim — see api/cron-recap.ts postOne.
    expect(body).not.toContain("btw");
    expect(body).not.toContain("oauth2/authorize");
    expect(body).not.toContain("-# ");
  });
});
