// Fire the daily recap for a SINGLE (guild, channel) instead of every channel that ever
// played — so you can eyeball the card in a TEST server without spamming every room. It hits
// the real /api/cron-recap endpoint with the same CRON_SECRET bearer pg_cron uses, plus the
// secret-gated ?scope=&channel= override (and optional date / force re-post). Exact same code
// path as the nightly cron, just scoped to one channel.
//
// Run (args or env for the test ids):
//   node --env-file=.env scripts/test-recap.mjs <guildId> <channelId> [YYYY-MM-DD] [--force]
//   ppnpm test-recap -- <guildId> <channelId> --force
//
// Or set TEST_GUILD_ID / TEST_CHANNEL_ID in .env and run `ppnpm test-recap -- --force`.
//
//   date    optional puzzle date to recap (defaults to yesterday ET, server-side).
//   --force clears that channel's recap_posts ledger row first, so you can re-run and it
//           re-posts instead of being skipped as already-done.
//
// Needs CRON_SECRET and RECAP_URL in .env (same secret value as the Vercel env /
// Supabase Vault; RECAP_URL is your deployment's /api/cron-recap — point it at a
// preview deployment to test a branch).

const BASE = process.env.RECAP_URL;
if (!BASE) {
  console.error('Missing RECAP_URL. Set it in .env, e.g. https://your-project.vercel.app/api/cron-recap');
  process.exit(1);
}

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('Missing CRON_SECRET. Set it in .env (same value as the Vercel env var).');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const guild = positional[0] ?? process.env.TEST_GUILD_ID;
const channel = positional[1] ?? process.env.TEST_CHANNEL_ID;
const date = positional[2]; // optional; server defaults to yesterday ET

if (!guild || !channel) {
  console.error('usage: node --env-file=.env scripts/test-recap.mjs <guildId> <channelId> [YYYY-MM-DD] [--force]');
  console.error('   or set TEST_GUILD_ID / TEST_CHANNEL_ID in .env');
  process.exit(1);
}

const scope = guild.startsWith('g:') ? guild : `g:${guild}`;
const url = new URL(BASE);
url.searchParams.set('scope', scope);
url.searchParams.set('channel', channel);
if (date) url.searchParams.set('date', date);
if (force) url.searchParams.set('force', '1');

console.log(`POST ${url.origin}${url.pathname}`);
console.log(`  scope=${scope} channel=${channel}${date ? ` date=${date}` : ' date=yesterday'}${force ? ' force' : ''}`);

const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
const body = await res.text();
console.log(`\n${res.status} ${res.statusText}`);
console.log(body);

// The endpoint returns { date, posted, skipped, failed }. posted:1 → card sent. skipped:1 →
// already posted for that date (re-run with --force). failed:1 → check the bot's permission
// in that channel (403) or the logs.
process.exit(res.ok ? 0 : 1);
