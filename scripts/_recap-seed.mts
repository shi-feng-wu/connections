// TEMP — seed fake recap data so /api/cron-recap has something to post, then clean up.
//
//   Seed:   node --env-file=.env --import tsx scripts/_recap-seed.mts
//   Clean:  node --env-file=.env --import tsx scripts/_recap-seed.mts --clean
//
// Target room: pass --scope g:<guild> --channel <channelId>, or omit both to
// auto-pick the most recently used row in recap_channels (where the bot already
// posts). The channel must be one the app's bot can post in, or the cron's Discord
// POST will fail (failed++), even though the DB seeding succeeded.
import { admin } from '../api/_admin.js';

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CLEAN = argv.includes('--clean');

const PUZZLE_DATE = '2026-06-02'; // yesterday ET relative to 2026-06-03
const PREV_DATE = '2026-06-01'; // a prior day so room streak/season totals aren't trivial
const FAKE_IDS = ['fake_alice', 'fake_bob', 'fake_carol', 'fake_dave'];

const db = admin();
if (!db) {
  console.error('admin() is null — run with --env-file=.env so SUPABASE_* are set.');
  process.exit(1);
}

// ---- resolve target scope + channel ----
let scope = arg('--scope');
let channel = arg('--channel');
if (!scope || !channel) {
  const { data, error } = await db
    .from('recap_channels')
    .select('scope_id, channel_id, updated_at')
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) {
    console.error('recap_channels read failed:', error.message);
    process.exit(1);
  }
  const guildRows = (data ?? []).filter((r) => String(r.scope_id).startsWith('g:') && r.channel_id);
  if (guildRows.length === 0) {
    console.error(
      'No g: recap_channels row found. Play a game in your test server first, or pass --scope g:<guild> --channel <id>.',
    );
    process.exit(1);
  }
  scope ??= guildRows[0].scope_id as string;
  channel ??= guildRows[0].channel_id as string;
  console.log(`Auto-picked target from recap_channels (most recent): ${scope} -> channel ${channel}`);
  if (guildRows.length > 1) {
    console.log(`(${guildRows.length} guild rooms exist; pass --scope/--channel to choose another.)`);
  }
}

if (CLEAN) {
  const a = await db.from('scores').delete().eq('scope_id', scope).in('user_id', FAKE_IDS);
  const b = await db.from('recap_posts').delete().eq('scope_id', scope).in('puzzle_date', [PUZZLE_DATE]);
  console.log('Cleaned fake scores:', a.error?.message ?? 'ok', '| recap_posts:', b.error?.message ?? 'ok');
  console.log('(recap_channels row left intact — it predates this script.)');
  process.exit(0);
}

// ---- fake rows ----
type Row = {
  puzzle_id: number;
  puzzle_date: string;
  scope_id: string;
  user_id: string;
  name: string;
  avatar: null;
  score: number;
  mistakes: number;
  solved: boolean;
  groups_solved: number;
  duration_ms: number | null;
};
const rows: Row[] = [
  // PUZZLE_DATE — what "yesterday's results" shows (3 solves + 1 loss).
  { puzzle_id: 1091, puzzle_date: PUZZLE_DATE, scope_id: scope, user_id: 'fake_alice', name: 'Alice', avatar: null, score: 95, mistakes: 0, solved: true, groups_solved: 4, duration_ms: 41_000 },
  { puzzle_id: 1091, puzzle_date: PUZZLE_DATE, scope_id: scope, user_id: 'fake_bob', name: 'Bob', avatar: null, score: 80, mistakes: 1, solved: true, groups_solved: 4, duration_ms: 88_000 },
  { puzzle_id: 1091, puzzle_date: PUZZLE_DATE, scope_id: scope, user_id: 'fake_carol', name: 'Carol', avatar: null, score: 72, mistakes: 2, solved: true, groups_solved: 4, duration_ms: 153_000 },
  { puzzle_id: 1091, puzzle_date: PUZZLE_DATE, scope_id: scope, user_id: 'fake_dave', name: 'Dave', avatar: null, score: 30, mistakes: 4, solved: false, groups_solved: 2, duration_ms: null },
  // PREV_DATE — builds a 2-day room streak + fuller June season standings.
  { puzzle_id: 1090, puzzle_date: PREV_DATE, scope_id: scope, user_id: 'fake_alice', name: 'Alice', avatar: null, score: 90, mistakes: 0, solved: true, groups_solved: 4, duration_ms: 60_000 },
  { puzzle_id: 1090, puzzle_date: PREV_DATE, scope_id: scope, user_id: 'fake_bob', name: 'Bob', avatar: null, score: 70, mistakes: 2, solved: true, groups_solved: 4, duration_ms: 110_000 },
];

// Idempotent: clear any prior fake rows for this scope, then insert fresh.
await db.from('scores').delete().eq('scope_id', scope).in('user_id', FAKE_IDS);
const ins = await db.from('scores').insert(rows);
if (ins.error) {
  console.error('insert scores failed:', ins.error.message);
  process.exit(1);
}

// Make sure the room has a channel to post to (upsert the detected/explicit target).
const up = await db.from('recap_channels').upsert({ scope_id: scope, channel_id: channel }, { onConflict: 'scope_id' });
if (up.error) console.error('recap_channels upsert warning:', up.error.message);

// Clear the idempotency ledger for this (scope, date) so the cron will post.
await db.from('recap_posts').delete().eq('scope_id', scope).in('puzzle_date', [PUZZLE_DATE]);

console.log(`Seeded ${rows.length} fake scores for ${scope} (${PUZZLE_DATE} + ${PREV_DATE}).`);
console.log(`Recap will post to channel ${channel}.`);
console.log('Now hit /api/cron-recap. Expect {"date":"2026-06-02","posted":1,...}.');
