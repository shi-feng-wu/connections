import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isUserInstallOnly, routeInteraction, verifyDiscordSig } from "../api/interactions";

// api/interactions.ts: Discord signs every interaction (Ed25519); an unverified
// request must be refused, and the recap's Play button must map to a launch.
// Build a keypair and present the public key the way Discord does: 32 raw bytes
// as hex (the tail of the SPKI DER encoding).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubHex = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32).toString("hex");

const sigFor = (body: string, ts: string): string =>
  edSign(null, Buffer.from(ts + body), privateKey).toString("hex");

describe("verifyDiscordSig", () => {
  it("accepts a correctly signed request", () => {
    const body = JSON.stringify({ type: 1 });
    const ts = "1717200000";
    expect(verifyDiscordSig(body, sigFor(body, ts), ts, pubHex)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = "1717200000";
    const sig = sigFor(JSON.stringify({ type: 1 }), ts);
    expect(verifyDiscordSig(JSON.stringify({ type: 3 }), sig, ts, pubHex)).toBe(false);
  });

  it("rejects a swapped timestamp", () => {
    const body = JSON.stringify({ type: 1 });
    const sig = sigFor(body, "1717200000");
    expect(verifyDiscordSig(body, sig, "9999999999", pubHex)).toBe(false);
  });

  it("fails closed on missing/garbage inputs", () => {
    expect(verifyDiscordSig("{}", "", "1", pubHex)).toBe(false); // no signature
    expect(verifyDiscordSig("{}", "abcd", "1", "")).toBe(false); // no public key
    expect(verifyDiscordSig("{}", "zz", "1", pubHex)).toBe(false); // non-hex signature
  });
});

describe("routeInteraction", () => {
  it("pongs a verification PING", () => {
    expect(routeInteraction({ type: 1 })).toEqual({ type: 1 });
  });

  it("launches the Activity for the Play button", () => {
    expect(routeInteraction({ type: 3, data: { custom_id: "connections_play" } })).toEqual({ type: 12 });
  });

  it("does not launch for an unknown component", () => {
    const r = routeInteraction({ type: 3, data: { custom_id: "nope" } }) as { type: number };
    expect(r.type).not.toBe(12);
  });

  it("launches the Activity for the /connections slash command", () => {
    expect(routeInteraction({ type: 2, data: { name: "connections" } })).toEqual({ type: 12 });
  });

  it("does not launch for an unknown slash command", () => {
    const r = routeInteraction({ type: 2, data: { name: "nope" } }) as { type: number };
    expect(r.type).not.toBe(12);
  });

  it("/enable-posts offers a one-click Add-to-Server button in a bot-less server", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "enable-posts" },
      application_id: "app123",
      authorizing_integration_owners: { "1": "user123" }, // user-install only
    }) as { type: number; data: { flags?: number; components?: { components: { style?: number; url?: string }[] }[] } };
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBe(64); // ephemeral
    const btn = r.data.components?.[0].components[0];
    expect(btn?.style).toBe(5); // link button
    expect(btn?.url).toContain("client_id=app123");
    expect(btn?.url).toContain("integration_type=0");
  });

  it("/enable-posts says recaps are already on when the bot is guild-installed", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "enable-posts" },
      authorizing_integration_owners: { "0": "guild123" }, // guild install present
    }) as { type: number; data: { components?: unknown[]; content?: string } };
    expect(r.type).toBe(4);
    expect(r.data.components).toBeUndefined(); // no button
    expect(r.data.content).toContain("already");
  });
});

// The card is a bot message, so it's skipped when the launch is a user install in a server
// without the bot (only "1" present, no "0") — there it would only 403. "0" = guild install,
// "1" = user install.
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
