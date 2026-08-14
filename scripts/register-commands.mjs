// One-off: rename the Activity's auto-created "Launch" Entry Point command to
// "disconnections" and give it a real description, so users launch the game with
// /disconnections (mirrors /wordle) and the command picker shows what it does instead
// of Discord's generic "Launch an activity". /connections is kept registered too, as
// an indefinite alias (same behavior, description "Launch Disconnections") so existing
// muscle memory and cached client command lists still work post-rebrand.
//
// Discord creates a PRIMARY_ENTRY_POINT command (type 4) automatically when an app
// enables Activities. We PATCH it by id rather than bulk-overwriting the command
// list: a PUT that omits or re-specifies the Entry Point command can drop or
// duplicate it. We also flip the handler to APP_HANDLER so Discord routes the launch
// to our Interactions Endpoint (api/interactions.ts replies LAUNCH_ACTIVITY) instead
// of launching it itself and auto-posting an invite card to the channel on every
// launch. REQUIRES the Interactions Endpoint URL to be set (see DISCORD_SETUP.md §3).
//
// The auto-created command also ships localized as "launch" (translated into every
// locale). Discord shows each user the name for THEIR locale, so the base `name`
// alone isn't enough — e.g. an en-US user still sees /launch. We null out
// name_localizations/description_localizations so /disconnections (+ our description)
// applies everywhere.
//
// Then we reconcile the CHAT_INPUT (type 1) commands against scripts/command-defs.mjs:
// /disconnections and its /connections alias, /share, /donate, /invite-bot, /help, and the
// moderator pair /mute + /unmute (renamed from /disable-posts + /enable-posts). The Entry Point
// command lives in the App Launcher and doesn't reliably appear in the typed "/" menu; a normal
// slash command does. They carry no handler — Discord delivers the invocation to the
// Interactions Endpoint URL, and api/interactions.ts replies with LAUNCH_ACTIVITY to
// open the game. REQUIRES the app's Interactions Endpoint URL to be set to
// <host>/api/interactions (Developer Portal ▸ General Information, or PATCH /applications/@me).
//
// Re-run whenever scripts/command-defs.mjs changes (it's idempotent — an in-sync command makes no
// API call at all):
//   pnpm register-commands
// Needs VITE_DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env (loaded via --env-file).

import { CHAT_COMMANDS } from './command-defs.mjs';

const APP_ID = process.env.VITE_DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NAME = 'disconnections';
// Shown in the command picker / app launcher. Max 100 chars (Discord limit).
const DESCRIPTION = 'Launch the daily 16-word Disconnections puzzle and play live with the channel';
const PRIMARY_ENTRY_POINT = 4;
// Entry Point command handlers: 1 = APP_HANDLER (our Interactions Endpoint launches
// it), 2 = DISCORD_LAUNCH_ACTIVITY (Discord launches + auto-posts the invite card).
const APP_HANDLER = 1;
const CHAT_INPUT = 1;
const API = 'https://discord.com/api/v10';

if (!APP_ID || !TOKEN) {
  console.error('Missing VITE_DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN. Set them in .env.');
  process.exit(1);
}

const auth = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

const listRes = await fetch(`${API}/applications/${APP_ID}/commands`, { headers: auth });
if (!listRes.ok) {
  console.error(`Failed to list commands: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const commands = await listRes.json();
const entry = commands.find((c) => c.type === PRIMARY_ENTRY_POINT);

if (!entry) {
  console.error(
    'No Entry Point command found. Enable Activities for the app in the Developer Portal ' +
      '(this auto-creates a "Launch" command), then re-run.',
  );
  process.exit(1);
}

// --- 1) Entry Point command (App Launcher) ----------------------------------------
// `name_localized`/`description_localized` reflect the requester-locale override (if
// any). The command is fully set only when the base matches AND no localized value
// differs from it — otherwise some locale still shows /launch.
const nameOk = entry.name === NAME && (entry.name_localized ?? NAME) === NAME;
const descOk =
  entry.description === DESCRIPTION && (entry.description_localized ?? DESCRIPTION) === DESCRIPTION;
const handlerOk = entry.handler === APP_HANDLER;
if (nameOk && descOk && handlerOk) {
  console.log(`Entry Point command already set: /${NAME} — "${DESCRIPTION}", APP_HANDLER (id ${entry.id}).`);
} else {
  const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${entry.id}`, {
    method: 'PATCH',
    headers: auth,
    // null localizations clear Discord's auto-translated "launch" so the base name
    // (disconnections) and description apply in every locale. handler: APP_HANDLER routes
    // the launch through our Interactions Endpoint so Discord stops launching the
    // Activity itself and auto-posting its invite card on every launch.
    body: JSON.stringify({
      name: NAME,
      description: DESCRIPTION,
      name_localizations: null,
      description_localizations: null,
      handler: APP_HANDLER,
    }),
  });
  if (!patchRes.ok) {
    console.error(`Failed to update Entry Point command: ${patchRes.status} ${await patchRes.text()}`);
    process.exit(1);
  }
  console.log(
    `Updated Entry Point command (id ${entry.id}): name "${entry.name}" -> "${NAME}", ` +
      `description "${entry.description}" -> "${DESCRIPTION}", handler -> APP_HANDLER, localizations cleared.`,
  );
}

// --- 2) Chat-input commands (typed "/" menu) --------------------------------------
// Every chat-input command's DEFINITION lives in scripts/command-defs.mjs (pure data, also read by
// tests/interactions.test.ts so the /help list and the moderator gates can't drift from what's
// really registered). This loop reconciles Discord's list against it:
//   • missing       -> POST (create)
//   • drifted       -> PATCH by id (description / contexts / integration_types / permissions)
//   • renamed       -> the same PATCH, matched through `previousNames`, so the command keeps its id
//                      and any per-guild permission overrides (Discord has no rename API; PATCHing
//                      `name` in place IS the rename — /unsubscribe -> /disable-posts -> /mute).
//   • already right -> no call at all, so a re-run is a no-op.
// The Entry Point command handled above is NOT part of this loop and must never be touched by it.
const sameList = (a, b) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

for (const def of CHAT_COMMANDS) {
  const existing = commands.find(
    (c) =>
      c.type === CHAT_INPUT &&
      (c.name === def.name || (def.previousNames ?? []).includes(c.name)),
  );
  const perms = def.default_member_permissions ?? null;
  const body = {
    name: def.name,
    description: def.description,
    contexts: def.contexts,
    integration_types: def.integration_types,
    default_member_permissions: perms,
  };

  if (!existing) {
    const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...body, type: CHAT_INPUT }),
    });
    if (!createRes.ok) {
      console.error(`Failed to register /${def.name}: ${createRes.status} ${await createRes.text()}`);
      process.exit(1);
    }
    const cmd = await createRes.json();
    console.log(`Registered chat command /${cmd.name} (id ${cmd.id}).`);
    continue;
  }

  const inSync =
    existing.name === def.name &&
    existing.description === def.description &&
    sameList(existing.contexts, def.contexts) &&
    sameList(existing.integration_types, def.integration_types) &&
    (existing.default_member_permissions ?? null) === perms;
  if (inSync) {
    console.log(`Chat command /${def.name} already registered and in sync (id ${existing.id}).`);
    continue;
  }

  // PATCH by id (never POST): renames keep the command id, so per-guild overrides survive. `type`
  // is immutable, so it's not in the body.
  const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${existing.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify(body),
  });
  if (!patchRes.ok) {
    console.error(`Failed to update /${existing.name}: ${patchRes.status} ${await patchRes.text()}`);
    process.exit(1);
  }
  const renamed = existing.name !== def.name ? `name "${existing.name}" -> "${def.name}", ` : '';
  console.log(
    `Updated chat command /${def.name} (id ${existing.id}): ${renamed}description/contexts/` +
      `integration types/permissions synced${perms ? ' (Manage Channels gated)' : ''}.`,
  );
}
