// One-off: rename the Activity's auto-created "Launch" Entry Point command to
// "connections" and give it a real description, so users launch the game with
// /connections (mirrors /wordle) and the command picker shows what it does instead
// of Discord's generic "Launch an activity".
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
// name_localizations/description_localizations so /connections (+ our description)
// applies everywhere.
//
// Then we also register a CHAT_INPUT (type 1) command. The Entry Point command lives
// in the App Launcher and doesn't reliably appear in the typed "/" menu; a normal
// slash command does. It carries no handler — Discord delivers the invocation to the
// Interactions Endpoint URL, and api/interactions.ts replies with LAUNCH_ACTIVITY to
// open the game. REQUIRES the app's Interactions Endpoint URL to be set to
// <host>/api/interactions (Developer Portal ▸ General Information, or PATCH /applications/@me).
//
// Run once after setting up the bot:
//   pnpm register-commands
// Needs VITE_DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const APP_ID = process.env.VITE_DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NAME = 'connections';
// Shown in the command picker / app launcher. Max 100 chars (Discord limit).
const DESCRIPTION = 'Launch the daily 16-word Connections puzzle and play live with the channel';
const PRIMARY_ENTRY_POINT = 4;
// Entry Point command handlers: 1 = APP_HANDLER (our Interactions Endpoint launches
// it), 2 = DISCORD_LAUNCH_ACTIVITY (Discord launches + auto-posts the invite card).
const APP_HANDLER = 1;
const CHAT_INPUT = 1;
// The typed "/" command. Keep in sync with LAUNCH_COMMANDS in api/interactions.ts.
const CHAT_NAME = 'connections';
const CHAT_DESCRIPTION = 'Launch the daily 16-word Connections puzzle';
// Match the Entry Point command so the slash command appears in the same places.
const CONTEXTS = [0, 1, 2];
const INTEGRATION_TYPES = [0, 1];
// Discord permission bit (1 << 4) — gates the moderator-only commands (/enable-posts, /disable-posts)
// to members who can configure the channel.
const MANAGE_CHANNELS = '16';
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
    // (connections) and description apply in every locale. handler: APP_HANDLER routes
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

// --- 2) Chat-input command (typed "/" menu) ---------------------------------------
const chat = commands.find((c) => c.type === CHAT_INPUT && c.name === CHAT_NAME);
if (chat) {
  console.log(`Chat command /${CHAT_NAME} already registered (id ${chat.id}).`);
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: CHAT_NAME,
      description: CHAT_DESCRIPTION,
      type: CHAT_INPUT,
      contexts: CONTEXTS,
      integration_types: INTEGRATION_TYPES,
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${CHAT_NAME}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(
    `Registered chat command /${cmd.name} (id ${cmd.id}). Typing /${cmd.name} launches the Activity ` +
      `(via the Interactions Endpoint — make sure it's set to <host>/api/interactions).`,
  );
}

// --- 3) enable-posts chat-input command -------------------------------------------
// In a server without the bot, /enable-posts replies (privately) with a one-click "Add to Server"
// button. Where the bot IS installed, it clears any /disable-posts opt-out for the channel — turning
// the live card + daily recap back on. GUILD context only (no DM): the bot only posts in server
// channels. integration_types stays [0,1] so it's still available in bot-less (user-install) servers
// for the add-bot pitch. Deliberately NOT default_member_permissions-gated: the command is left open
// so anyone can reach the add-bot pitch (which does nothing privileged — the OAuth add needs Manage
// Server anyway). The moderation part — clearing a /disable-posts opt-out — is gated IN CODE
// (Manage Channels) in api/interactions.ts (enablePostsResponse), so re-enabling still mirrors the
// permission /disable-posts requires, without hiding the add-bot pitch from non-admins.
const ENABLE_POSTS = 'enable-posts';
const ENABLE_POSTS_DESCRIPTION = 'Add the bot, or turn the daily recap and live card back on in this channel';
const ENABLE_POSTS_CONTEXTS = [0]; // GUILD only — hidden in DMs
const enable = commands.find((c) => c.type === CHAT_INPUT && c.name === ENABLE_POSTS);
if (enable) {
  // Reconcile what may have drifted: contexts (it used to allow DMs), the description, and that it's
  // NOT permission-gated (null — open to everyone; the re-enable branch is gated in code). PATCH if
  // any differ so a re-run is a no-op once matched.
  const contextsOk =
    JSON.stringify((enable.contexts ?? []).slice().sort()) ===
    JSON.stringify(ENABLE_POSTS_CONTEXTS.slice().sort());
  const permsOk = (enable.default_member_permissions ?? null) === null;
  const descOk = enable.description === ENABLE_POSTS_DESCRIPTION;
  if (contextsOk && permsOk && descOk) {
    console.log(`Chat command /${ENABLE_POSTS} already registered, GUILD-only + open (id ${enable.id}).`);
  } else {
    const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${enable.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({
        description: ENABLE_POSTS_DESCRIPTION,
        contexts: ENABLE_POSTS_CONTEXTS,
        default_member_permissions: null, // open — clears any prior gate; re-enable is gated in code
      }),
    });
    if (!patchRes.ok) {
      console.error(`Failed to update /${ENABLE_POSTS}: ${patchRes.status} ${await patchRes.text()}`);
      process.exit(1);
    }
    console.log(`Updated /${ENABLE_POSTS} (id ${enable.id}): GUILD-only, open (re-enable gated in code), description synced.`);
  }
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: ENABLE_POSTS,
      description: ENABLE_POSTS_DESCRIPTION,
      type: CHAT_INPUT,
      contexts: ENABLE_POSTS_CONTEXTS,
      integration_types: INTEGRATION_TYPES,
      // No default_member_permissions: open to everyone. Re-enabling is gated in code (Manage
      // Channels) so the add-bot pitch stays reachable by non-admins.
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${ENABLE_POSTS}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}), GUILD only, open.`);
}

// --- 4) share chat-input command --------------------------------------------------
// /share posts the player's result grid for today's puzzle (one row of category-colour
// squares per guess, Wordle-style) to the channel. The response is built in
// api/interactions.ts (shareResponse); this only registers the name. Same contexts +
// integration types as the launch command so it's available in user-install servers too —
// the share posts as an interaction response, which needs no bot in the guild.
const SHARE = 'share';
const SHARE_DESCRIPTION = "Share your Connections result grid for today's puzzle";
const share = commands.find((c) => c.type === CHAT_INPUT && c.name === SHARE);
if (share) {
  console.log(`Chat command /${SHARE} already registered (id ${share.id}).`);
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: SHARE,
      description: SHARE_DESCRIPTION,
      type: CHAT_INPUT,
      contexts: CONTEXTS,
      integration_types: INTEGRATION_TYPES,
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${SHARE}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}).`);
}

// --- 5) donate chat-input command -------------------------------------------------
// /donate replies (privately) with a Ko-fi link button — the same "Help cover the server
// costs" link in the app footer. The response is built in api/interactions.ts
// (routeInteraction); this only registers the name. Same contexts + integration types as the
// launch command so it's available everywhere, including user-install (bot-less) servers — it
// posts as an interaction response and needs no bot in the guild.
const DONATE = 'donate';
const DONATE_DESCRIPTION = 'Support Connections — donate to help cover the server costs';
const donate = commands.find((c) => c.type === CHAT_INPUT && c.name === DONATE);
if (donate) {
  console.log(`Chat command /${DONATE} already registered (id ${donate.id}).`);
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: DONATE,
      description: DONATE_DESCRIPTION,
      type: CHAT_INPUT,
      contexts: CONTEXTS,
      integration_types: INTEGRATION_TYPES,
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${DONATE}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}).`);
}

// --- 6) disable-posts chat-input command ------------------------------------------
// /disable-posts turns the bot's posts off in the channel it's run in — BOTH the live "who's
// playing" card AND the nightly recap (a post_optouts row that post-card checks and recap_channels()
// subtracts). Sticky: only /enable-posts here turns it back on. GUILD-INSTALL ONLY (integration_types
// [0]) + GUILD context ([0]) — the bot only posts where it's in the server — and Manage Channels
// gated so a random member can't silence a channel others want. RENAMED from /unsubscribe: Discord
// has no rename API, so if the old command is still around we PATCH its name in place by id (same
// command id, new name — preserves any per-guild permission overrides). api/interactions.ts also
// still accepts the old "unsubscribe" name for clients on a cached command list mid-rollout.
const DISABLE_POSTS = 'disable-posts';
const DISABLE_POSTS_DESCRIPTION = "Turn the bot's posts (live card + daily recap) off in this channel";
const DISABLE_POSTS_BODY = {
  description: DISABLE_POSTS_DESCRIPTION,
  contexts: [0], // GUILD only — the bot only posts in server channels
  integration_types: [0], // GUILD_INSTALL only — hidden where the bot isn't in the server
  default_member_permissions: MANAGE_CHANNELS,
};
const disablePosts = commands.find((c) => c.type === CHAT_INPUT && c.name === DISABLE_POSTS);
const legacyUnsub = commands.find((c) => c.type === CHAT_INPUT && c.name === 'unsubscribe');
if (disablePosts) {
  console.log(`Chat command /${DISABLE_POSTS} already registered (id ${disablePosts.id}).`);
} else if (legacyUnsub) {
  // Rename the existing /unsubscribe command to /disable-posts in place (PATCH by id).
  const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${legacyUnsub.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ name: DISABLE_POSTS, ...DISABLE_POSTS_BODY }),
  });
  if (!patchRes.ok) {
    console.error(`Failed to rename /unsubscribe -> /${DISABLE_POSTS}: ${patchRes.status} ${await patchRes.text()}`);
    process.exit(1);
  }
  console.log(`Renamed /unsubscribe -> /${DISABLE_POSTS} in place (id ${legacyUnsub.id}).`);
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: DISABLE_POSTS, type: CHAT_INPUT, ...DISABLE_POSTS_BODY }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${DISABLE_POSTS}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}), GUILD only, Manage Channels gated.`);
}
