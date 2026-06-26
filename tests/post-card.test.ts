import { beforeAll, describe, expect, it, vi } from "vitest";

// /api/post-card is the render function split out of /api/interactions (so the launch-ACK function
// stays tiny). waitUntil is a no-op here: the handler still evaluates postCard(body), which early-
// returns for a body with no token, so no Supabase/canvas is touched — we only assert the auth gate.
vi.mock("@vercel/functions", () => ({ waitUntil: () => {} }));

const { default: handler, isUserInstallOnly, botCanPostInChannel } = await import("../api/post-card");

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
async function call(headers: Record<string, string>, body: unknown): Promise<Res> {
  const res = mkRes();
  await handler({ method: "POST", headers, body } as any, res as any);
  return res;
}

beforeAll(() => {
  process.env.INTERNAL_SECRET = "s3cret";
});

// /api/post-card is internal: /api/interactions verifies the Discord signature, then calls this with
// the verified interaction, authenticating via INTERNAL_SECRET (NOT the Discord signature). Without
// the right bearer it must 403 — so a random can't forge an interaction to post cards / use a token.
describe("post-card handler — internal auth", () => {
  it("403s without the internal bearer", async () => {
    const r = await call({}, { type: 2 });
    expect(r.statusCode).toBe(403);
  });

  it("403s with a wrong bearer", async () => {
    const r = await call({ authorization: "Bearer nope" }, { type: 2 });
    expect(r.statusCode).toBe(403);
  });

  it("ACKs 200 with the right bearer", async () => {
    const r = await call({ authorization: "Bearer s3cret" }, { type: 2 });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

// The card is a bot message, so it's skipped when the launch is a user install in a server
// without the bot (only "1" present, no "0") — there it would only 403. "0" = guild install,
// "1" = user install. (Moved here with postCard from api/interactions.ts.)
describe("isUserInstallOnly", () => {
  it("is true for a user-install-only launch (no guild install)", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "1": "user123" } })).toBe(true);
  });

  it("is false when the app is guild-installed (bot is present)", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "0": "guild123" } })).toBe(false);
  });

  it("is false when both install types authorized it", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "0": "guild123", "1": "user123" } })).toBe(false);
  });

  it("is false (proceeds) when the field is absent or empty", () => {
    expect(isUserInstallOnly({})).toBe(false);
    expect(isUserInstallOnly({ authorizing_integration_owners: {} })).toBe(false);
  });
});

// botCanPostInChannel reads the bot's effective channel permissions off the interaction's
// app_permissions bitfield. The card/recap are PNG attachments, so it needs View Channel +
// Send Messages + Attach Files — short any one (e.g. a private channel the bot's role isn't in)
// and the recap silently 403s. Bitfield is compared as BigInt.
describe("botCanPostInChannel", () => {
  const VIEW = 1n << 10n, SEND = 1n << 11n, ATTACH = 1n << 15n, ADMIN = 1n << 3n;

  it("is true when View Channel + Send Messages + Attach Files are all present", () => {
    expect(botCanPostInChannel(String(VIEW | SEND | ATTACH))).toBe(true);
  });

  it("is false when Attach Files is missing (the card/recap are image attachments)", () => {
    expect(botCanPostInChannel(String(VIEW | SEND))).toBe(false);
  });

  it("is false when View Channel is missing (a private channel the bot isn't allowed into)", () => {
    expect(botCanPostInChannel(String(SEND | ATTACH))).toBe(false);
  });

  it("is true for Administrator (implies every permission)", () => {
    expect(botCanPostInChannel(String(ADMIN))).toBe(true);
  });

  it("fails OPEN (true) on an absent or unparseable field, so it never wrongly nudges", () => {
    expect(botCanPostInChannel(undefined)).toBe(true);
    expect(botCanPostInChannel("")).toBe(true);
    expect(botCanPostInChannel("not-a-number")).toBe(true);
  });
});
