// One-off: rename the Activity's auto-created "Launch" Entry Point command to
// "connections" and give it a real description, so users launch the game with
// /connections (mirrors /wordle) and the command picker shows what it does instead
// of Discord's generic "Launch an activity".
//
// Discord creates a PRIMARY_ENTRY_POINT command (type 4) automatically when an app
// enables Activities. We PATCH it by id rather than bulk-overwriting the command
// list: a PUT that omits or re-specifies the Entry Point command can drop or
// duplicate it. The handler (DISCORD_LAUNCH_ACTIVITY) is left untouched, so Discord
// keeps performing the launch itself.
//
// The auto-created command also ships localized as "launch" (translated into every
// locale). Discord shows each user the name for THEIR locale, so the base `name`
// alone isn't enough — e.g. an en-US user still sees /launch. We null out
// name_localizations/description_localizations so /connections (+ our description)
// applies everywhere.
//
// Run once after setting up the bot:
//   npm run register-commands
// Needs VITE_DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const APP_ID = process.env.VITE_DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NAME = 'connections';
// Shown in the command picker / app launcher. Max 100 chars (Discord limit).
const DESCRIPTION = 'Launch the daily 16-word Connections puzzle and play live with the channel';
const PRIMARY_ENTRY_POINT = 4;
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

// `name_localized`/`description_localized` reflect the requester-locale override (if
// any). The command is fully set only when the base matches AND no localized value
// differs from it — otherwise some locale still shows /launch.
const nameOk = entry.name === NAME && (entry.name_localized ?? NAME) === NAME;
const descOk =
  entry.description === DESCRIPTION && (entry.description_localized ?? DESCRIPTION) === DESCRIPTION;
if (nameOk && descOk) {
  console.log(`Entry Point command already set: /${NAME} — "${DESCRIPTION}" (id ${entry.id}). Nothing to do.`);
  process.exit(0);
}

const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${entry.id}`, {
  method: 'PATCH',
  headers: auth,
  // null localizations clear Discord's auto-translated "launch" so the base name
  // (connections) and description apply in every locale.
  body: JSON.stringify({
    name: NAME,
    description: DESCRIPTION,
    name_localizations: null,
    description_localizations: null,
  }),
});
if (!patchRes.ok) {
  console.error(`Failed to update command: ${patchRes.status} ${await patchRes.text()}`);
  process.exit(1);
}
console.log(
  `Updated Entry Point command (id ${entry.id}): name "${entry.name}" -> "${NAME}", ` +
    `description "${entry.description}" -> "${DESCRIPTION}", localizations cleared. ` +
    `/${NAME} launches the Activity in every locale.`,
);
