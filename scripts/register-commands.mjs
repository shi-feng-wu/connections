// One-off: rename the Activity's auto-created "Launch" Entry Point command to
// "connections", so users launch the game with /connections (mirrors /wordle).
//
// Discord creates a PRIMARY_ENTRY_POINT command (type 4) automatically when an app
// enables Activities. We PATCH it by id rather than bulk-overwriting the command
// list: a PUT that omits or re-specifies the Entry Point command can drop or
// duplicate it. The handler (DISCORD_LAUNCH_ACTIVITY) is left untouched, so Discord
// keeps performing the launch itself.
//
// Run once after setting up the bot:
//   npm run register-commands
// Needs VITE_DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const APP_ID = process.env.VITE_DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NAME = 'connections';
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

if (entry.name === NAME) {
  console.log(`Entry Point command is already named "${NAME}" (id ${entry.id}). Nothing to do.`);
  process.exit(0);
}

const patchRes = await fetch(`${API}/applications/${APP_ID}/commands/${entry.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ name: NAME }),
});
if (!patchRes.ok) {
  console.error(`Failed to rename command: ${patchRes.status} ${await patchRes.text()}`);
  process.exit(1);
}
console.log(`Renamed Entry Point command "${entry.name}" -> "${NAME}" (id ${entry.id}). /${NAME} now launches the Activity.`);
