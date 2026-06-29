import { beforeAll, describe, expect, it } from "vitest";

// /api/refresh-card is internal: it is fired server-to-server by /api/guess on a counted guess,
// authenticated via INTERNAL_SECRET (NOT the user's auth ticket — the client never calls it).
// Without the right bearer it must 403, so a random can't drive card edits or trust the `finished`
// flag to bypass the throttle. A body with no guild/channel short-circuits to no-guild BEFORE any
// Supabase/canvas work, so these assert the auth gate without a live DB.
const { default: handler } = await import("../api/refresh-card");

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
async function call(method: string, headers: Record<string, string>, body: unknown): Promise<Res> {
  const res = mkRes();
  await handler({ method, headers, body } as any, res as any);
  return res;
}

beforeAll(() => {
  process.env.INTERNAL_SECRET = "s3cret";
});

describe("refresh-card handler — internal auth", () => {
  it("405s on a non-POST before touching auth", async () => {
    const r = await call("GET", {}, {});
    expect(r.statusCode).toBe(405);
  });

  it("403s without the internal bearer", async () => {
    const r = await call("POST", {}, {});
    expect(r.statusCode).toBe(403);
  });

  it("403s with a wrong bearer", async () => {
    const r = await call("POST", { authorization: "Bearer nope" }, {});
    expect(r.statusCode).toBe(403);
  });

  it("accepts the internal bearer (a no-scope body short-circuits before any render)", async () => {
    const r = await call("POST", { authorization: "Bearer s3cret" }, {});
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: false, reason: "no-scope" });
  });
});
