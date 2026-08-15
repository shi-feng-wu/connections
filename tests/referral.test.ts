import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReferral } from "../api/referral";

// The INBOUND half of the share loop (api/referral.ts): who brought whom. When a player opens
// the Activity from a shared quick link, Discord hands their client the sharer's id and the
// custom_id we stamped at mint time; the client posts both here once at boot.
//
// The two rules this must never lose are FIRST-WRITER-WINS (a player is attributed exactly
// once, ever — a later link they open is a no-op) and NO SELF-REFERRALS. v1 grants nothing off
// these rows, but they're the only measurement of whether the loop works, so a double-count or
// a self-count would quietly corrupt the one number the feature is judged on.

const REFERRED = "111222333444555666";
const SHARER = "999888777666555444";
const CID = `${SHARER}/20260811`;

// ---- in-memory referrals table + the Supabase-builder shim (only the insert chain used) ----
type Row = Record<string, any>;

function mkDb(seed: Row[] = [], fail: string | null = null): { db: SupabaseClient; rows: Row[] } {
  const rows = seed;
  const db = {
    from: () => ({
      insert: (obj: Row) => {
        if (fail) return Promise.resolve({ error: { code: fail } });
        // The primary key IS the first-writer-wins rule; raise 23505 the way Postgres does.
        if (rows.some((r) => r.referred_user_id === obj.referred_user_id)) {
          return Promise.resolve({ error: { code: "23505" } });
        }
        rows.push({ ...obj });
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as SupabaseClient;
  return { db, rows };
}

// ——— the attribution rules, as a pure function ———
describe("resolveReferral", () => {
  it("credits Discord's referrer_id", () => {
    const r = resolveReferral(REFERRED, { referrerId: SHARER, customId: CID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.referrer_user_id).toBe(SHARER);
      expect(r.row.custom_id).toBe(CID);
      expect(r.row.referred_user_id).toBe(REFERRED);
    }
  });

  it("falls back to the sharer encoded in our own custom_id", () => {
    const r = resolveReferral(REFERRED, { customId: CID });
    expect(r.ok && r.row.referrer_user_id).toBe(SHARER);
  });

  it("drops a self-referral, by referrer_id or by custom_id", () => {
    expect(resolveReferral(SHARER, { referrerId: SHARER })).toEqual({ ok: false, reason: "self" });
    expect(resolveReferral(SHARER, { customId: CID })).toEqual({ ok: false, reason: "self" });
  });

  it("records a campaign link with no sharer behind it", () => {
    // A STATIC dev-portal link carries a custom_id but no referrer — still worth counting.
    const r = resolveReferral(REFERRED, { customId: "launch-tweet" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.referrer_user_id).toBeNull();
      expect(r.row.custom_id).toBe("launch-tweet");
    }
  });

  it("has nothing to record on a normal launch", () => {
    expect(resolveReferral(REFERRED, {})).toEqual({ ok: false, reason: "none" });
    expect(resolveReferral(REFERRED, { referrerId: null, customId: null })).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("reads a stringified missing param as absence, not as a campaign arrival", () => {
    // Discord puts the literal text "undefined" in the iframe URL when there is no launch param.
    // Recording it wrote a null-referrer squatter row for every ordinary boot, and the primary
    // key on referred_user_id then locked that player out of their real attribution forever.
    for (const junk of ["undefined", "null", "NaN", "none", "  ", "UNDEFINED"]) {
      expect(resolveReferral(REFERRED, { customId: junk })).toEqual({ ok: false, reason: "none" });
    }
    // A referrer_id that survives still counts — the placeholder only clears the free text.
    const r = resolveReferral(REFERRED, { referrerId: SHARER, customId: "undefined" });
    expect(r.ok && r.row.custom_id).toBe(null);
    expect(r.ok && r.row.referrer_user_id).toBe(SHARER);
  });

  it("refuses a referrer that isn't a Discord snowflake", () => {
    // A forged id must not land in the table as if it were a person; the custom_id still does.
    const r = resolveReferral(REFERRED, { referrerId: "<script>", customId: "promo" });
    expect(r.ok && r.row.referrer_user_id).toBeNull();
  });

  it("caps the free text that rides in from the URL", () => {
    const r = resolveReferral(REFERRED, { customId: "x".repeat(5000), linkId: "y".repeat(5000) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.custom_id!.length).toBe(200);
      expect(r.row.link_id!.length).toBe(100);
    }
  });

  it("carries the link id when the client can see one", () => {
    // The Embedded App SDK (2.5.0) exposes referrerId/customId at boot but not the link id, so
    // this stays null in practice — the column is here for when it doesn't.
    expect(resolveReferral(REFERRED, { referrerId: SHARER }).ok).toBe(true);
    const r = resolveReferral(REFERRED, { referrerId: SHARER, linkId: "lnk_1" });
    expect(r.ok && r.row.link_id).toBe("lnk_1");
  });
});

// ——— the route: the auth gate and the first-writer-wins write ———
let db: SupabaseClient;
let rows: Row[];
let uid: string | null = REFERRED;

vi.mock("../api/_admin.js", () => ({ admin: () => db }));
vi.mock("../api/_session.js", () => ({
  verifyAuth: (t: unknown) => (t && uid ? { uid, iat: Date.now() } : null),
}));
vi.mock("../api/_discord.js", () => ({
  bearerToken: (h: unknown) => (typeof h === "string" ? h.replace(/^Bearer /i, "") : null),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is fine).
const { default: handler } = await import("../api/referral");

type Res = { statusCode: number; body: any };
async function call(body: unknown, headers: Record<string, string> = { authorization: "Bearer t" }, method = "POST"): Promise<Res> {
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
  await handler({ method, headers, body } as any, res);
  return res;
}

describe("POST /api/referral", () => {
  beforeEach(() => {
    const made = mkDb();
    db = made.db;
    rows = made.rows;
    uid = REFERRED;
  });

  it("rejects anything but POST", async () => {
    expect((await call({}, {}, "GET")).statusCode).toBe(405);
  });

  it("rejects a caller with no signed ticket", async () => {
    expect((await call({ referrerId: SHARER }, {})).statusCode).toBe(401);
  });

  it("attributes the arriving player to the sharer", async () => {
    const r = await call({ referrerId: SHARER, customId: CID });
    expect(r.body).toEqual({ ok: true, first: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referred_user_id: REFERRED, referrer_user_id: SHARER });
  });

  it("attributes a player ONCE, ever: a later link from anyone else is a no-op", async () => {
    await call({ referrerId: SHARER });
    const second = await call({ referrerId: "555444333222111000" });
    expect(second.body).toEqual({ ok: true, first: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].referrer_user_id).toBe(SHARER); // the FIRST writer keeps the credit
  });

  it("never lets a player refer themselves", async () => {
    uid = SHARER;
    const r = await call({ referrerId: SHARER, customId: CID });
    expect(r.body).toEqual({ ok: false, reason: "self" });
    expect(rows).toHaveLength(0);
  });

  it("writes nothing on a normal launch", async () => {
    const r = await call({});
    expect(r.body).toEqual({ ok: false, reason: "none" });
    expect(rows).toHaveLength(0);
  });

  it("drops the attribution (never errors at the player) when the table isn't there yet", async () => {
    db = mkDb([], "42P01").db;
    const r = await call({ referrerId: SHARER });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: "unavailable" });
  });
});
