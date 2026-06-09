import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  OAUTH_SCOPES,
  resolveRedirectUri,
} from "../api/_oauth";

// api/_oauth.ts: the pure pieces of the webhook.incoming "add to server" flow.
// The redirect_uri must be identical in the authorize request and the token exchange.

describe("resolveRedirectUri", () => {
  it("derives https://<host>/api/discord-callback from the request host", () => {
    expect(resolveRedirectUri("example-app.vercel.app")).toBe(
      "https://example-app.vercel.app/api/discord-callback",
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
