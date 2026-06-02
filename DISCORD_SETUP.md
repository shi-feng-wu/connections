# Discord Activity setup (the easy-to-get-wrong bits)

Most of the Developer Portal config for a Discord **Activity** is non-obvious and
silently breaks the app in different ways. This is the exact config this project
needs. Portal: <https://discord.com/developers/applications> → **Connections**.

Production host (the deployed Vercel **production alias**, kept public; the per-deploy
`*-<team>.vercel.app` URLs are behind Vercel Authentication and won't load in Discord):

```
https://connections-olive.vercel.app
```

## 1. OAuth2 → Redirects

```
https://127.0.0.1
```

- This is a **placeholder**, not a real URL. The embedded SDK uses Discord's **RPC**
  OAuth2 flow, which won't accept a normal web redirect (`…vercel.app` →
  *"Redirect URI cannot be used in the RPC OAuth2 Authorization flow"*), yet the flow
  still requires *a* registered redirect to default to (none → *"Missing redirect_uri"*).
  `https://127.0.0.1` is the value Discord's own Activity tutorial mandates.
- Keep it as the **only** redirect (with `prompt: "none"` + no `redirect_uri` in the
  `authorize()` call, Discord defaults to the first registered redirect).
- ⚠️ Do **not** put the app's `…vercel.app` URL here. That's a different setting (URL
  Mappings, below).

## 2. Activities → URL Mappings

| Prefix      | Target                                |
| ----------- | ------------------------------------- |
| `/`         | `connections-olive.vercel.app`        |
| `/supabase` | `<your-project>.supabase.co`          |

- Discord Activities sandbox **all** network requests through `*.discordsays.com`. A
  direct connection to Supabase (its realtime WebSocket + REST) is blocked
  (*"websocket is not available, the operation is insecure"*).
- The `/supabase` mapping + `patchUrlMappings()` in `src/main.tsx` route Supabase
  through the proxy. The prefix here **must match** the one in `patchUrlMappings`.

## 3. General Information → Interactions Endpoint URL

```
https://connections-olive.vercel.app/api/interactions
```

- Required for the typed `/connections` slash command (Discord POSTs the interaction
  here; `api/interactions.ts` replies with `LAUNCH_ACTIVITY`).
- ⚠️ This field gets **blanked out if you re-save other settings on this page with it
  empty** — which silently breaks the slash command (*"The application did not
  respond"*). If you edit anything here, keep this URL populated.

## 4. Commands (`npm run register-commands`)

Two commands, two surfaces — both named `connections`:

| Type                  | Surface                          | How it launches                                   |
| --------------------- | -------------------------------- | ------------------------------------------------- |
| `PRIMARY_ENTRY_POINT` | App Launcher / voice rocket-ship | Discord launches it natively (`DISCORD_LAUNCH_ACTIVITY`) |
| `CHAT_INPUT`          | typed `/` menu                   | `api/interactions.ts` replies `LAUNCH_ACTIVITY`   |

`scripts/register-commands.mjs` (run once after setup):
- renames the auto-created Entry Point command to `connections` and **clears its
  localizations** (otherwise it shows as `/launch` in every locale), and
- registers the `CHAT_INPUT` `/connections` command.

## 5. Installation

Add the app to a server with the **Discord-provided install link** (Installation →
Install Link), scope `applications.commands`. Commands only appear where the app is
installed; global command edits can take up to ~1h to propagate (and the desktop
client caches them — fully quit/reopen to refresh).

## Environment variables

See `.env.example`. Server secrets (`DISCORD_CLIENT_SECRET`, `SESSION_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `CRON_SECRET`) must be real random
values in Vercel — **not** the placeholders. `SESSION_SECRET` in particular signs the
auth ticket and game-session HMACs; generate with `openssl rand -base64 32`.
