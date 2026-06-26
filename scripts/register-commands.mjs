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
// In a server without the bot, /enable-posts replies (privately) with a one-click "Add to
// Server" button — the only way the daily recap + live card can post there. GUILD context only
// (no DM): recaps are a server-channel thing, so the command is meaningless in a DM and shouldn't
// show up there. integration_types stays [0,1] so it's still available in bot-less (user-install)
// servers. The response is built in api/interactions.ts (routeInteraction).
const ENABLE_POSTS = 'enable-posts';
const ENABLE_POSTS_DESCRIPTION = 'Add the bot to this server to unlock the daily recap and live card';
const ENABLE_POSTS_CONTEXTS = [0]; // GUILD only — hidden in DMs
const enable = commands.find((c) => c.type === CHAT_INPUT && c.name === ENABLE_POSTS);
if (enable) {
  // Already registered — but it may predate the GUILD-only change (it used to allow DM contexts).
  // PATCH the contexts if they differ so re-running this script hides it from DMs.
  const current = JSON.stringify((enable.contexts ?? []).slice().sort());
  const want = JSON.stringify(ENABLE_POSTS_CONTEXTS.slice().sort());
  if (current === want) {
    console.log(`Chat command /${ENABLE_POSTS} already registered, GUILD-only (id ${enable.id}).`);
  } else {
    const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${enable.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ contexts: ENABLE_POSTS_CONTEXTS }),
    });
    if (!patchRes.ok) {
      console.error(`Failed to update /${ENABLE_POSTS} contexts: ${patchRes.status} ${await patchRes.text()}`);
      process.exit(1);
    }
    console.log(`Updated /${ENABLE_POSTS} contexts ${enable.contexts ?? '[]'} -> ${JSON.stringify(ENABLE_POSTS_CONTEXTS)} (GUILD only, id ${enable.id}).`);
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
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${ENABLE_POSTS}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}), GUILD only.`);
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

// --- 6) unsubscribe chat-input command --------------------------------------------
// /unsubscribe silences the daily recap in the channel it's run in (a recap_optouts row that
// recap_channels() subtracts; re-armed on the next Activity launch there — see api/interactions
// + postCard). Unlike the others this is GUILD-INSTALL ONLY (integration_types [0]) and GUILD
// context ([0]): the recap only posts where the bot is in the server, so the command stays hidden
// from user-install/DM surfaces where there's nothing to turn off. default_member_permissions
// "16" (Manage Channels, the 1<<4 bit) gates it to members who can configure the channel, so a
// random member can't silence recaps others want. The response is built in api/interactions.ts.
const UNSUBSCRIBE = 'unsubscribe';
const UNSUBSCRIBE_DESCRIPTION = 'Stop the daily recap from posting in this channel';
const MANAGE_CHANNELS = '16'; // Discord permission bit (1 << 4)
const unsubscribe = commands.find((c) => c.type === CHAT_INPUT && c.name === UNSUBSCRIBE);
if (unsubscribe) {
  console.log(`Chat command /${UNSUBSCRIBE} already registered (id ${unsubscribe.id}).`);
} else {
  const createRes = await fetch(`${API}/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: UNSUBSCRIBE,
      description: UNSUBSCRIBE_DESCRIPTION,
      type: CHAT_INPUT,
      contexts: [0], // GUILD only — recaps are a server-channel thing
      integration_types: [0], // GUILD_INSTALL only — hidden where the bot isn't in the server
      default_member_permissions: MANAGE_CHANNELS,
    }),
  });
  if (!createRes.ok) {
    console.error(`Failed to register /${UNSUBSCRIBE}: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const cmd = await createRes.json();
  console.log(`Registered chat command /${cmd.name} (id ${cmd.id}).`);
}
