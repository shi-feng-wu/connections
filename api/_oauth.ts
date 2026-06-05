// Shared bits of the "add to server" OAuth2 flow that sets up the daily recap.
// /api/install starts it (redirect to Discord) and /api/discord-callback finishes
// it (code -> token -> webhook). Leading underscore keeps Vercel from routing this
// file. Pure helpers so the URL/redirect logic can be unit-tested without a request.

// applications.commands re-installs the launch command; webhook.incoming is the
// piece that matters here — Discord shows a channel picker and, on approval, mints
// a channel-bound incoming webhook returned in the token exchange. One install both
// registers the command and wires the recap, the way Discord's own activities do.
export const OAUTH_SCOPES = 'applications.commands webhook.incoming';

// Discord requires the redirect_uri in the token exchange to byte-match the one in
// the authorize request AND a redirect registered in the Developer Portal. Both legs
// derive it the same way so they always agree; OAUTH_REDIRECT_URI overrides for odd
// hosts (preview deploys aren't registered, so production uses the alias host).
export function resolveRedirectUri(host: string | undefined, override?: string): string {
  if (override) return override;
  return `https://${host ?? ''}/api/discord-callback`;
}

// The Discord consent URL. response_type=code drives the authorization-code flow
// whose token exchange carries the webhook object. integration_type=0 pins a *guild*
// install so the consent shows the server + channel picker (a user install has no
// channel to hang a webhook on) — important when this is wired as the app's Install
// Link so a single "Add App" both installs and creates the recap webhook.
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    integration_type: '0', // 0 = guild install
    scope: OAUTH_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}
