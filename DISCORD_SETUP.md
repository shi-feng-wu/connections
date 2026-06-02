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
https://connections-olive.vercel.app/api/discord-callback
```

- `https://127.0.0.1` is a **placeholder**, not a real URL. The embedded SDK uses
  Discord's **RPC** OAuth2 flow, which won't accept a normal web redirect
  (`…vercel.app` → *"Redirect URI cannot be used in the RPC OAuth2 Authorization
  flow"*), yet the flow still requires *a* registered redirect to default to (none →
  *"Missing redirect_uri"*). `https://127.0.0.1` is the value Discord's own Activity
  tutorial mandates. It must stay **first** so the SDK's `authorize()` (which sends no
  `redirect_uri` and `prompt: "none"`) defaults to it.
- `…/api/discord-callback` is the **real** redirect for the daily-recap install flow
  (§5). It must byte-match what `/api/install` sends; that endpoint derives it from
  the request host, so register the **production alias** host here. (If you host
  elsewhere, set `OAUTH_REDIRECT_URI` and register that exact value instead.)
- ⚠️ Do **not** put the app's bare `…vercel.app` root URL here. That's a different
  setting (URL Mappings, below).

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
| `PRIMARY_ENTRY_POINT` | App Launcher / voice rocket-ship | Routed to `api/interactions.ts` (handler `APP_HANDLER`), which replies `LAUNCH_ACTIVITY` |
| `CHAT_INPUT`          | typed `/` menu                   | `api/interactions.ts` replies `LAUNCH_ACTIVITY`   |

`scripts/register-commands.mjs` (run once after setup):
- renames the auto-created Entry Point command to `connections` and **clears its
  localizations** (otherwise it shows as `/launch` in every locale),
- sets the Entry Point command's `handler` to `APP_HANDLER` so the launch is routed to
  `/api/interactions` instead of Discord launching it natively — the native
  (`DISCORD_LAUNCH_ACTIVITY`) path auto-posts a "Game Invitation / Game ended" invite
  card to the channel on every launch; this avoids that. **Requires the Interactions
  Endpoint URL from §3.**, and
- registers the `CHAT_INPUT` `/connections` command.

## 5. Installation (bundled: app + recap webhook in one "Add App")

Point the install link at our own OAuth flow so a single "Add App" both installs the
commands **and** sets up the daily recap webhook — the way Discord's own daily-summary
activities do it.

**Installation → Install Link → `Custom URL`:**

```
https://connections-olive.vercel.app/api/install
```

What happens when someone adds the app to a server:

1. `/api/install` redirects to Discord's consent screen requesting
   `applications.commands webhook.incoming`, `integration_type=0` (guild install), so
   the admin sees the **server + channel picker**.
2. They pick a channel and approve. Discord installs the commands **and** mints an
   incoming webhook in that channel, then redirects to `/api/discord-callback`, which
   stores the webhook URL in `public.recap_channels` (keyed by `g:<guild>`).
3. From then on the cron (`vercel.json`, `0 6 * * *`) POSTs the recap straight to that
   webhook after the midnight-ET reset. **No bot, no `Send Messages` permission** — the
   app is never a guild member.

Notes / caveats:
- **Per server.** A webhook is bound to one channel in one guild, so each server
  installs (and picks a channel) once; there is no global install.
- **The Activity must stay launchable.** Installing via this custom URL still installs
  `applications.commands`, so the `/connections` command and App-Launcher rocket keep
  working — verify on the first real install.
- Re-adding the app just **repoints** the recap to the newly chosen channel.
- If an admin deletes the webhook, the next cron run gets a `404`/`401`, clears the
  stored URL, and the room silently stops getting recaps until it's re-added.
- Requires the `…/api/discord-callback` redirect from §1 to be registered, and
  `DISCORD_CLIENT_SECRET` + the Supabase service role set server-side.
- Commands only appear where the app is installed; global command edits can take up to
  ~1h to propagate (and the desktop client caches them — fully quit/reopen to refresh).

> Prefer not to bundle? Leave the Install Link as the Discord-provided
> `applications.commands` link, and have admins visit
> `https://connections-olive.vercel.app/api/install` separately to enable recaps. Same
> endpoint, just a second step.

## Environment variables

See `.env.example`. Server secrets (`DISCORD_CLIENT_SECRET`, `SESSION_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `CRON_SECRET`) must be real random
values in Vercel — **not** the placeholders. `SESSION_SECRET` in particular signs the
auth ticket and game-session HMACs; generate with `openssl rand -base64 32`.
