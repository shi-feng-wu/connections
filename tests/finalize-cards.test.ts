import { beforeAll, describe, expect, it } from "vitest";

// /api/finalize-cards is the cron that flips a DM card's "who's playing" caption to past tense just
// before its interaction-token window closes. It's CRON_SECRET-authed (Vercel Cron sends
// Authorization: Bearer $CRON_SECRET, same as api/cron-recap). Without the right bearer it must 403.
// With it, admin() is null in the test env (no SUPABASE_* set) so the handler short-circuits to
// "unavailable" before any DB/Discord work — enough to prove the gate without a live DB.
const { default: handler } = await import("../api/finalize-cards");

type Res = { statusCode: number; body: unknown; headers: Record<string, string> };
function mkRes(): Res & {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => any;
  json: (b: unknown) => any;
} {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}
async function call(headers: Record<string, string>): Promise<Res> {
  const res = mkRes();
  await handler({ method: "GET", headers } as any, res as any);
  return res;
}

beforeAll(() => {
  process.env.CRON_SECRET = "cr0n";
});

describe("finalize-cards cron — auth", () => {
  it("403s without the cron bearer", async () => {
    expect((await call({})).statusCode).toBe(403);
  });

  it("403s with a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer nope" })).statusCode).toBe(403);
  });

  it("passes auth with the cron bearer (no DB configured → unavailable, not 403)", async () => {
    const r = await call({ authorization: "Bearer cr0n" });
    expect(r.statusCode).not.toBe(403);
    expect(r.body).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
