// TEMP read-only inspector for recap testing. Run:
//   node --env-file=.env --import tsx scripts/_recap-inspect.mts
import { admin } from '../api/_admin.js';

const db = admin();
if (!db) {
  console.error('admin() null — missing SUPABASE_URL / SERVICE_ROLE_KEY');
  process.exit(1);
}

const { data: chans, error: ce } = await db
  .from('recap_channels')
  .select('scope_id, channel_id, guild_id, updated_at')
  .order('updated_at', { ascending: false });
console.log('=== recap_channels ===', ce?.message ?? '');
console.log(JSON.stringify(chans, null, 2));

const { data: scopes } = await db
  .from('scores')
  .select('scope_id, puzzle_date')
  .order('puzzle_date', { ascending: false })
  .limit(50);
const byScope = new Map<string, { dates: Set<string>; n: number }>();
for (const r of (scopes ?? []) as { scope_id: string | null; puzzle_date: string | null }[]) {
  if (!r.scope_id) continue;
  const e = byScope.get(r.scope_id) ?? { dates: new Set<string>(), n: 0 };
  e.n++;
  if (r.puzzle_date) e.dates.add(r.puzzle_date);
  byScope.set(r.scope_id, e);
}
console.log('\n=== recent scope_ids in scores (last 50 rows) ===');
for (const [scope, e] of byScope) {
  console.log(`${scope}  rows=${e.n}  dates=${[...e.dates].sort().reverse().slice(0, 5).join(',')}`);
}

const { data: posts } = await db
  .from('recap_posts')
  .select('scope_id, puzzle_date, posted_at')
  .eq('puzzle_date', '2026-06-02');
console.log('\n=== recap_posts for 2026-06-02 ===');
console.log(JSON.stringify(posts, null, 2));
