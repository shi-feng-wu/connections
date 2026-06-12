// Set the bot's "About Me" — the short line shown on its profile — to "/connections",
// nudging people toward the launch command.
//
// This is the STATIC descriptor, not a live status: the bot's About Me is just the
// application's `description`, which we PATCH once via REST (same endpoint as
// configure-install). No Gateway connection, no always-on process — set it and it
// sticks. That's the difference from a custom status (the line directly under the name
// in the member list), which Discord only lets you set over a persistent Gateway
// connection (see scripts/presence.mjs).
//
// Run once (re-run to change the text):
//   pnpm about-me
// Needs DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API = 'https://discord.com/api/v10';

// Hardcoded. Discord caps the application description at 400 chars; this is well under.
const ABOUT_ME = '/connections';

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN. Set it in .env.');
  process.exit(1);
}

const auth = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

const res = await fetch(`${API}/applications/@me`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ description: ABOUT_ME }),
});
if (!res.ok) {
  console.error(`Failed to update application: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const app = await res.json();
console.log(`Set About Me for "${app.name}" (id ${app.id}) to: ${app.description}`);
