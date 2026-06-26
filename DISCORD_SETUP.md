# Discord Activity setup (the easy-to-get-wrong bits)

Most of the Developer Portal config for a Discord **Activity** is non-obvious and
silently breaks the app in different ways. This is the exact config this project
needs. Portal: <https://discord.com/developers/applications> → **Connections**.

Production host (the deployed Vercel **production alias**, kept public; the per-deploy
`*-<team>.vercel.app` URLs are behind Vercel Authentication and won't load in Discord):

```
https://your-project.vercel.app
```

## 1. OAuth2 → Redirects

```
https://127.0.0.1
https://your-project.vercel.app/api/discord-callback
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
| `/supabase` | `<your-project>.supabase.co`          |
| `/relay`    | `<your-relay-host>` (Railway, `scripts/relay.mjs`) |
| `/`         | `your-project.vercel.app`             |

- Discord Activities sandbox **all** network requests through `*.discordsays.com`. A
  direct connection to Supabase (its realtime WebSocket + REST) is blocked
  (*"websocket is not available, the operation is insecure"*).
- The `/supabase` mapping + `patchUrlMappings()` in `src/main.tsx` route Supabase
  through the proxy. The prefix here **must match** the one in `patchUrlMappings`.
- `/relay` proxies the live-roster SSE relay (`src/roomlive.ts`, reached by relative
  `/relay/...` paths — no `patchUrlMappings` needed). Without it the live roster is dark.
- ⚠️ Ordering: Discord globs prefixes, so the catch-all `/` **must be last** or it
  swallows `/supabase` and `/relay`.

## 3. General Information → Interactions Endpoint URL

```
https://your-project.vercel.app/api/interactions
```

- Required for the typed `/connections` slash command (Discord POSTs the interaction
  here; `api/interactions.ts` replies with `LAUNCH_ACTIVITY`).
- ⚠️ This field gets **blanked out if you re-save other settings on this page with it
  empty** — which silently breaks the slash command (*"The application did not
  respond"*). If you edit anything here, keep this URL populated.

## 4. Commands (`pnpm register-commands`)

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

## 5. Installation (native two-option "Add App" screen + bot recap)

Use Discord's own install screen — the same one Wordle shows — with two choices:

| Option              | Context      | Grants                                  | Effect                                                              |
| ------------------- | ------------ | --------------------------------------- | ------------------------------------------------------------------ |
| **Add to My Apps**  | User install | `applications.commands`                 | `/connections` works **everywhere** (any server/DM). No bot, no recap. |
| **Add to Server**   | Guild install| `applications.commands` + `bot` (View Channel, Send Messages, Embed Links, Attach Files) | Adds the bot so the daily recap can post. |

`pnpm configure-install` sets this up (PATCHes `/applications/@me`): it writes the
per-context Default Install Settings above **and clears any Custom URL** so the native
Discord-provided link takes over. Then confirm in **Installation → Install Link =
`Discord Provided Link`**, with both **Installation Contexts** (User + Guild) checked.

Why a bot for the recap: Discord-provided install links are limited to the
`applications.commands` and `bot` scopes — `webhook.incoming` is not allowed in the
native install, and it needs an authorization-code exchange the one-click install never
performs. So a third-party app's only way to post unprompted is the bot (Wordle skips
this only because it's first-party). After "Add to Server":

1. The bot joins the guild with Send Messages / Attach Files.
2. Whenever someone finishes a game, `/api/score` records the channel on
   `recap_channels.channel_id` (the room's last-played channel).
3. The cron (`vercel.json`, `0 6 * * *`) posts the recap there as the bot
   (`POST /channels/:id/messages` with `DISCORD_BOT_TOKEN`) after the midnight-ET reset.

Notes / caveats:
- **No install-time channel picker.** The recap goes to the channel the activity was
  **last played in** (the `recap_channels.channel_id` breadcrumb), mirroring Wordle. A
  server that "Add to Server"s but never plays gets no recap until someone finishes a
  game there. (An admin `/set-recap-channel` command could pin a specific channel — not
  built yet.)
- The bot needs to actually see + post in that channel; if it can't (a `403`), that
  day's recap is skipped and retried the next day.
- Requires `DISCORD_BOT_TOKEN` set **server-side in Vercel** (it was script-only before).
- Commands only appear where the app is installed; global command edits can take up to
  ~1h to propagate (and the desktop client caches them — fully quit/reopen to refresh).

> Legacy: `/api/install` + `/api/discord-callback` (the old `webhook.incoming` flow) and
> the `recap_channels.webhook_*` columns are now **unused**. They can be removed; the
> `…/api/discord-callback` redirect from §1 is no longer needed for recaps.

## Environment variables

See `.env.example`. Server secrets (`DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `CRON_SECRET`) must
be real values in Vercel — **not** the placeholders. `DISCORD_BOT_TOKEN` is now needed at
runtime (the recap cron posts as the bot), not just by the setup scripts. `SESSION_SECRET`
signs the auth ticket and game-session HMACs; generate with `openssl rand -base64 32`.
