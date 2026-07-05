// Backfill scores rows for finished games that lost the optimistic-commit race (fixed
// 2026-07-05 in App.tsx onFinish + leaderboard.ts submitScore): the finishing guess
// committed in the background, /api/score replayed the record before it landed, answered
// "not-finished", and the client dropped the score — so the player's progress shows a
// finished game but no scores row exists, and their streak broke.
//
// This replays each affected player's committed progress with the REAL Game logic (the same
// replay /api/score runs) and inserts the row /api/score would have written. Trust model is
// unchanged: everything comes from the server-side append-only record, never from a client.
// The one heuristic is room placement — the interaction's guild/channel ids are gone, so the
// row inherits scope_id/channel_id (and name/avatar) from the player's most recent scores row
// in the last 14 days; a player with no such row is skipped (no streak to restore, no known
// room). Inserts use ignoreDuplicates so an existing row always wins; every inserted row is
// logged to a JSON file for rollback.
//
//   npx tsx scripts/backfill-scores.mts                 # dry run, 2026-07-01..2026-07-04
//   npx tsx scripts/backfill-scores.mts --write         # actually insert
//   npx tsx scripts/backfill-scores.mts --from 2026-07-03 --to 2026-07-04 --write
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Game, MAX_MISTAKES } from '../src/game.js';
import { fetchPuzzle } from '../api/_nyt.js';

// Minimal .env loader (KEY=VALUE lines; the repo has no dotenv dependency) — the script
// needs SUPABASE_URL/VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, same as the API.
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)\s*=\s*("?)(.*)\2\s*$/.exec(line.trim());
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[3];
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const WRITE = args.includes('--write');
const FROM = flag('from') ?? '2026-07-01';
const TO = flag('to') ?? '2026-07-04';

const DURATION_CAP = 24 * 60 * 60 * 1000; // mirrors api/score.ts
const MAX_GUESSES = 40;
const SCOPE_LOOKBACK_DAYS = 14;

type ScoreRow = {
  puzzle_id: number;
  puzzle_date: string;
  scope_id: string;
  channel_id: string | null;
  user_id: string;
  name: string;
  avatar: string | null;
  score: number;
  mistakes: number;
  hints_used: number;
  groups_solved: number;
  solved: boolean;
  duration_ms: number;
};

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

// PostgREST caps responses at 1000 rows; page until short.
async function allRows<T>(
  make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await make(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

  const inserted: ScoreRow[] = [];
  let totalCandidates = 0;
  let totalSkippedUnfinished = 0;
  let totalSkippedNoScope = 0;

  for (const date of dates(FROM, TO)) {
    const puzzle = await fetchPuzzle(date, db);

    const progress = await allRows<{
      user_id: string;
      guesses: unknown;
      hints: unknown;
      started_at: string;
      updated_at: string;
    }>((a, b) =>
      db
        .from('progress')
        .select('user_id, guesses, hints, started_at, updated_at')
        .eq('puzzle_date', date)
        .order('user_id')
        .range(a, b),
    );
    const scored = new Set(
      (
        await allRows<{ user_id: string }>((a, b) =>
          db.from('scores').select('user_id').eq('puzzle_date', date).order('user_id').range(a, b),
        )
      ).map((r) => r.user_id),
    );

    // Replay every unscored record; only a finished game (won or lost) gets a row —
    // the same "status !== playing" bar /api/score applies.
    const finished: typeof progress = [];
    for (const p of progress) {
      if (scored.has(p.user_id) || !Array.isArray(p.guesses)) continue;
      const game = Game.fromGuesses(puzzle, p.guesses.slice(0, MAX_GUESSES), undefined, p.hints);
      if (game.status === 'playing') {
        totalSkippedUnfinished++;
        continue;
      }
      finished.push(p);
    }
    totalCandidates += finished.length;

    // Room placement: each player's most recent scores row within the lookback window.
    const lookback = new Date(`${date}T00:00:00Z`);
    lookback.setUTCDate(lookback.getUTCDate() - SCOPE_LOOKBACK_DAYS);
    const ids = finished.map((p) => p.user_id);
    const prior = new Map<string, { scope_id: string; channel_id: string | null; name: string; avatar: string | null }>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = await allRows<{
        user_id: string;
        scope_id: string;
        channel_id: string | null;
        name: string;
        avatar: string | null;
        puzzle_date: string;
      }>((a, b) =>
        db
          .from('scores')
          .select('user_id, scope_id, channel_id, name, avatar, puzzle_date')
          .in('user_id', chunk)
          .lt('puzzle_date', date)
          .gte('puzzle_date', lookback.toISOString().slice(0, 10))
          .order('puzzle_date', { ascending: false })
          .range(a, b),
      );
      for (const r of rows) if (!prior.has(r.user_id)) prior.set(r.user_id, r);
    }

    const rows: ScoreRow[] = [];
    for (const p of finished) {
      const home = prior.get(p.user_id);
      if (!home) {
        totalSkippedNoScope++;
        continue;
      }
      const game = Game.fromGuesses(puzzle, (p.guesses as unknown[]).slice(0, MAX_GUESSES), undefined, p.hints);
      // Duration from the pinned start to the finishing guess — tighter than /api/score's
      // "now - session start" (the game truly ended at updated_at), same clamps.
      game.durationMs = Math.min(
        DURATION_CAP,
        Math.max(1000, new Date(p.updated_at).getTime() - new Date(p.started_at).getTime()),
      );
      rows.push({
        puzzle_id: puzzle.id,
        puzzle_date: puzzle.date,
        scope_id: home.scope_id,
        channel_id: home.channel_id,
        user_id: p.user_id,
        name: home.name,
        avatar: home.avatar,
        score: game.score,
        mistakes: MAX_MISTAKES - game.mistakesLeft,
        hints_used: game.hintsUsed,
        groups_solved: game.groupsSolved,
        solved: game.status === 'won',
        duration_ms: game.durationMs,
      });
    }

    console.log(`${date}: progress=${progress.length} scored=${scored.size} backfill=${rows.length}`);
    for (const r of rows.slice(0, 3))
      console.log(`  e.g. ${r.user_id} ${r.solved ? 'won' : 'lost'} score=${r.score} scope=${r.scope_id}`);

    if (WRITE) {
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await db
          .from('scores')
          .upsert(rows.slice(i, i + 200), { onConflict: 'puzzle_id,user_id', ignoreDuplicates: true });
        if (error) throw new Error(`insert failed for ${date}: ${error.message}`);
      }
    }
    inserted.push(...rows);
  }

  console.log(
    `\n${WRITE ? 'INSERTED' : 'DRY RUN — would insert'} ${inserted.length} rows ` +
      `(${totalCandidates} finished-unscored; skipped ${totalSkippedUnfinished} unfinished, ` +
      `${totalSkippedNoScope} with no recent room)`,
  );
  const out = new URL(`../backfill-scores-${FROM}-to-${TO}${WRITE ? '' : '.dryrun'}.json`, import.meta.url);
  writeFileSync(out, JSON.stringify(inserted, null, 2));
  console.log(`row log: ${out.pathname}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
