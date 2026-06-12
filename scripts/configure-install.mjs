// Configure the app's install link so Discord shows its native two-option "Add App"
// screen (like Wordle): "Add to My Apps" (user install) and "Add to Server" (guild
// install). We PATCH /applications/@me with per-context Default Install Settings and
// clear any custom_install_url so the Discord-provided link takes over.
//
//   - User install (1):  scope applications.commands  → /connections works everywhere,
//                        no bot, no webhook, no recap.
//   - Guild install (0): scopes applications.commands + bot, with the bot permissions
//                        the recap needs → "Add to Server" drops the bot in so the daily
//                        cron can post (api/cron-recap posts as the bot to the room's
//                        last-played channel).
//
// Discord-provided links are limited to the applications.commands and bot scopes, so the
// recap can't ride the native install as a webhook — the bot is how a third-party app
// posts unprompted. Run once (re-run to change scopes/permissions):
//   pnpm configure-install
// Needs DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API = 'https://discord.com/api/v10';

// Bot permissions requested for the guild install: View Channel | Send Messages |
// Embed Links | Attach Files | Read Message History. Read Message History is required to
// post a *reply* (the "who's playing" card replies to the /connections launch message);
// the rest are the minimum to post the card / recap PNG to a channel.
const VIEW_CHANNEL = 1 << 10;
const SEND_MESSAGES = 1 << 11;
const EMBED_LINKS = 1 << 14;
const ATTACH_FILES = 1 << 15;
const READ_MESSAGE_HISTORY = 1 << 16;
const GUILD_BOT_PERMISSIONS = String(
  VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | READ_MESSAGE_HISTORY,
);

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN. Set it in .env.');
  process.exit(1);
}

const auth = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

const body = {
  // Both keys present => both installation contexts are supported (the two-option screen).
  integration_types_config: {
    0: { oauth2_install_params: { scopes: ['applications.commands', 'bot'], permissions: GUILD_BOT_PERMISSIONS } },
    1: { oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' } },
  },
  // Empty string clears a previously-set Custom URL so the Discord-provided link (the
  // native two-option screen) is used again.
  custom_install_url: '',
};

const res = await fetch(`${API}/applications/@me`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`Failed to update application: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const app = await res.json();
console.log(
  `Configured install for "${app.name}" (id ${app.id}):\n` +
    `  • User install  → scopes [applications.commands]\n` +
    `  • Guild install → scopes [applications.commands, bot], permissions ${GUILD_BOT_PERMISSIONS} ` +
    `(View Channel | Send Messages | Embed Links | Attach Files | Read Message History)\n` +
    `  • custom_install_url cleared → native "Add App" two-option screen.\n` +
    'Confirm in Developer Portal ▸ Installation that Install Link = "Discord Provided Link" and both contexts are checked.',
);
