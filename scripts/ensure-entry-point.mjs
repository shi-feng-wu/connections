// Ensure the Activity's Entry Point command exists (recreate it if missing).
//
// Discord auto-creates a PRIMARY_ENTRY_POINT command (type 4) when an app enables
// Activities — that command IS the button that launches the game from the App
// Launcher. If it gets deleted (e.g. a bulk `PUT .../commands` that overwrites the
// whole list), the Activity silently stops appearing in the launcher.
//
// register-commands.mjs *renames* that command (launch -> connections) but bails if
// it's missing. This script *creates* it if absent, named "connections" to match,
// with the DISCORD_LAUNCH_ACTIVITY handler so Discord performs the launch itself.
// Idempotent, and uses POST so it never touches your other commands.
//
// Run:
//   npm run discord:entry-point
// Needs VITE_DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env (loaded via --env-file),
// or pass them as args: node scripts/ensure-entry-point.mjs <client_id> <bot_token>

const API = "https://discord.com/api/v10";
const PRIMARY_ENTRY_POINT = 4;
const DISCORD_LAUNCH_ACTIVITY = 2; // handler: Discord opens the activity (no app response needed)
const NAME = "connections"; // matches register-commands.mjs

const APP_ID =
  process.argv[2] ||
  process.env.VITE_DISCORD_CLIENT_ID ||
  process.env.DISCORD_CLIENT_ID;
const TOKEN =
  process.argv[3] || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;

if (!APP_ID || !TOKEN) {
  console.error(
    "Missing VITE_DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN (set them in .env), " +
      "or pass: node scripts/ensure-entry-point.mjs <client_id> <bot_token>",
  );
  process.exit(1);
}

const auth = { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" };

async function api(path, init) {
  const res = await fetch(API + path, { ...init, headers: auth });
  const text = await res.text();
  if (!res.ok) {
    let hint = "";
    if (res.status === 401) hint = " — bad bot token (Developer Portal ▸ Bot ▸ Reset Token).";
    if (res.status === 403) hint = " — token doesn't match this application id.";
    console.error(`✗ ${init?.method ?? "GET"} ${path} → ${res.status}: ${text}${hint}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

const commands = await api(`/applications/${APP_ID}/commands`);
const entry = commands.find((c) => c.type === PRIMARY_ENTRY_POINT);

if (entry) {
  console.log(
    `✓ Entry Point command already exists: "${entry.name}" (id ${entry.id}). Nothing to do.` +
      (entry.name !== NAME ? `\n  (run "npm run register-commands" to rename it to /${NAME}.)` : ""),
  );
  process.exit(0);
}

console.log("No Entry Point command found — creating it…");
const created = await api(`/applications/${APP_ID}/commands`, {
  method: "POST",
  body: JSON.stringify({
    name: NAME,
    description: "Launch the activity",
    type: PRIMARY_ENTRY_POINT,
    handler: DISCORD_LAUNCH_ACTIVITY,
  }),
});
console.log(`✓ Created Entry Point command "${created.name}" (id ${created.id}). /${NAME} now launches the Activity.`);
console.log(
  "Next: confirm Activities is enabled with a URL mapping (Developer Portal ▸ Activities),\n" +
    "the app is installed to a < 25-member server you own, then reload Discord (Cmd/Ctrl+R)\n" +
    "and open the App Launcher in a voice channel.",
);
