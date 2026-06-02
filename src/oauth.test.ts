import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  OAUTH_SCOPES,
  resolveRedirectUri,
  webhookToRecapRow,
} from "../api/_oauth";

// api/_oauth.ts: the pure pieces of the webhook.incoming "add to server" flow.
// The redirect_uri must be identical in the authorize request and the token
// exchange, and the granted webhook must map cleanly to a recap_channels row.

describe("resolveRedirectUri", () => {
  it("derives https://<host>/api/discord-callback from the request host", () => {
    expect(resolveRedirectUri("connections-olive.vercel.app")).toBe(
      "https://connections-olive.vercel.app/api/discord-callback",
    );
  });

  it("prefers an explicit override (custom domain)", () => {
    expect(resolveRedirectUri("whatever.vercel.app", "https://play.example.com/api/discord-callback")).toBe(
      "https://play.example.com/api/discord-callback",
    );
  });
});

describe("buildAuthorizeUrl", () => {
  const url = buildAuthorizeUrl("123", "https://h/api/discord-callback", "state-tok");
  const parsed = new URL(url);

  it("targets Discord's authorize endpoint with the guild-install code flow", () => {
    expect(parsed.origin + parsed.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("integration_type")).toBe("0"); // guild install
  });

  it("requests webhook.incoming and carries the client id, redirect, and state", () => {
    expect(parsed.searchParams.get("scope")).toBe(OAUTH_SCOPES);
    expect(OAUTH_SCOPES).toContain("webhook.incoming");
    expect(parsed.searchParams.get("client_id")).toBe("123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://h/api/discord-callback");
    expect(parsed.searchParams.get("state")).toBe("state-tok");
  });
});

describe("webhookToRecapRow", () => {
  const webhook = {
    id: "347114750880120863",
    token: "kKDdjXa1g9tKNs0",
    url: "https://discord.com/api/webhooks/347114750880120863/kKDdjXa1g9tKNs0",
    channel_id: "345626669224982402",
    guild_id: "290926792226357250",
    name: "testwebhook",
  };

  it("maps a granted guild webhook to a g:<guild> recap row", () => {
    expect(webhookToRecapRow(webhook, "2026-06-02T00:00:00.000Z")).toEqual({
      scope_id: "g:290926792226357250",
      channel_id: "345626669224982402",
      guild_id: "290926792226357250",
      webhook_id: "347114750880120863",
      webhook_url: "https://discord.com/api/webhooks/347114750880120863/kKDdjXa1g9tKNs0",
      updated_at: "2026-06-02T00:00:00.000Z",
    });
  });

  it("rejects a webhook with no guild (can't form a g: scope)", () => {
    expect(webhookToRecapRow({ ...webhook, guild_id: null }, "t")).toBeNull();
  });

  it("rejects a missing or incomplete webhook", () => {
    expect(webhookToRecapRow(null, "t")).toBeNull();
    expect(webhookToRecapRow(undefined, "t")).toBeNull();
    expect(webhookToRecapRow({ ...webhook, url: "" }, "t")).toBeNull();
  });
});
