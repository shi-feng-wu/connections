// Ingest certified editorial boards into the `daily_puzzles` table, one per
// calendar day, and record the assignments in the editorial publish ledger
// (activating its self-repeat window).
//
//   node --env-file=.env scripts/ingest-puzzles.mjs --start 2026-09-01 [--dry]
//
// Sources, in ship order: the certified batch files listed in BATCHES below,
// main-track boards only (slot !== 'gauntlet' — gauntlet is premium stock and
// ships through a separate, later pipeline). Boards get consecutive dates from
// --start and puzzle numbers continuing the running daily count (see below; or after the highest
// number already in the table). Idempotent: a date that already has a row is
// left untouched and its board is NOT double-assigned; re-running with the same
// --start extends the schedule.
//
// The boards live in the gitignored editorial/ dir and go straight from disk to
// the database — they never touch the repo.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.cwd();
const EDITORIAL = join(ROOT, 'editorial');
const BATCHES = ['batch-013.json', 'batch-015.json', 'batch-016.json', 'batch-017.json', 'batch-018.json', 'batch-019.json'];
const LEDGER = join(EDITORIAL, 'data', 'publish-ledger.json');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? true);
};
const START = flag('--start');
const DRY = args.includes('--dry');
if (!START || !/^\d{4}-\d{2}-\d{2}$/.test(String(START))) {
  console.error('Usage: node --env-file=.env scripts/ingest-puzzles.mjs --start YYYY-MM-DD [--dry]');
  process.exit(1);
}

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const db = createClient(url, key);

// Deterministic per-board deal (same PRNG as the playtest harness) so the grid
// a player saw is reproducible from the board id alone.
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toPuzzle(board, seq, date) {
  const groups = [...board.groups]
    .sort((a, b) => a.level - b.level)
    // Members alphabetized within each group: NYT convention (798/800 recent NYT
    // groups list members A-Z at reveal) and the top provenance tell in the
    // 2026-08-08 blind eye test. Authored order stays in the editorial files.
    .map((g) => ({ level: g.level, category: g.name, members: [...g.words].sort((a, b) => a.localeCompare(b)) }));
  const layout = groups.flatMap((g) => g.members);
  // Seed from the board id digits, not the date, so rescheduling never re-deals.
  const rand = mulberry32(Number(String(board.id).replace(/\D/g, '')) || seq);
  for (let k = layout.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [layout[k], layout[j]] = [layout[j], layout[k]];
  }
  return { id: seq, date, editor: 'Disconnections', groups, layout };
}

const DAY = 86_400_000;
const atNoonUTC = (d) => Date.parse(`${d}T12:00:00Z`);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Load every certified main-track board.
const boards = [];
for (const f of BATCHES) {
  const p = join(EDITORIAL, 'candidates', f);
  if (!existsSync(p)) {
    console.error(`Missing ${p} — editorial dir incomplete; aborting before any write.`);
    process.exit(1);
  }
  for (const b of JSON.parse(readFileSync(p, 'utf8'))) {
    // 'gauntlet' is premium stock; 'held' is certified inventory deferred past a
    // self-repeat window (e.g. an identical title already scheduled this run).
    if (!['gauntlet', 'held'].includes(b.slot ?? 'main')) boards.push(b);
  }
}

// Ship order: quality-first (editorial/data/ship-order.json — judge-panel ranking
// with variety smoothing) so launch week leads with the strongest boards. Boards
// missing from the file append afterward in file order; an id in the file that
// matches no board is a staleness error, not a skip.
const ORDER_FILE = join(EDITORIAL, 'data', 'ship-order.json');
if (existsSync(ORDER_FILE)) {
  const { order } = JSON.parse(readFileSync(ORDER_FILE, 'utf8'));
  const byId = new Map(boards.map((b) => [b.id, b]));
  const unknown = order.filter((id) => !byId.has(id));
  if (unknown.length) {
    console.error(`ship-order.json names unknown/non-main boards: ${unknown.join(', ')} — regenerate it.`);
    process.exit(1);
  }
  const ordered = order.map((id) => byId.get(id));
  const rest = boards.filter((b) => !order.includes(b.id));
  if (rest.length) console.log(`${rest.length} board(s) not in ship-order.json — appended after the ranked ${ordered.length}.`);
  boards.length = 0;
  boards.push(...ordered, ...rest);
  console.log(`Ship order applied: ${ordered.length} ranked boards (quality-first launch).`);
}

// Existing schedule: skip already-assigned boards and already-filled dates.
const { data: existing, error: readErr } = await db
  .from('daily_puzzles')
  .select('puzzle_date, puzzle_id, data');
if (readErr) {
  console.error(`Cannot read daily_puzzles (${readErr.message}). Apply supabase/daily-puzzles.sql first.`);
  process.exit(1);
}
const filledDates = new Set((existing ?? []).map((r) => r.puzzle_date));
const shippedBoardIds = new Set((existing ?? []).map((r) => r.data?.source_id).filter(Boolean));

// Numbering CONTINUES the activity's running daily count rather than restarting
// at 1 (owner decision 2026-08-05): the header's "No." keeps incrementing with
// no visible discontinuity. On a fresh table, seed from the last daily served
// before --start (still in the legacy `puzzles` cache at ingest time — it is
// truncated only after the flip verifies), or from an explicit --first-no.
let seq;
if ((existing ?? []).length > 0) {
  seq = Math.max(...existing.map((r) => r.puzzle_id)) + 1;
} else if (flag('--first-no')) {
  seq = Number(flag('--first-no'));
} else {
  const { data: lastServed } = await db
    .from('puzzles')
    .select('puzzle_date, puzzle_id')
    .lt('puzzle_date', String(START))
    .order('puzzle_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lastServed) {
    console.error('Cannot derive the continuing puzzle number (legacy `puzzles` table empty?). Pass --first-no <n>.');
    process.exit(1);
  }
  seq = lastServed.puzzle_id + 1;
  console.log(`Continuing numbering: last served daily was No. ${lastServed.puzzle_id} (${lastServed.puzzle_date}); first original is No. ${seq}.`);
}
if (!Number.isInteger(seq) || seq < 1) {
  console.error(`Bad first number (${seq}).`);
  process.exit(1);
}

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
let date = String(START);
const plan = [];
for (const b of boards) {
  if (shippedBoardIds.has(b.id)) continue;
  while (filledDates.has(date)) date = ymd(atNoonUTC(date) + DAY);
  const puzzle = toPuzzle(b, seq, date);
  puzzle.source_id = b.id; // internal provenance; the client never surfaces it
  plan.push({ date, seq, board: b.id, puzzle });
  ledger[b.id] = date;
  seq += 1;
  date = ymd(atNoonUTC(date) + DAY);
}

console.log(`${boards.length} certified main boards; ${plan.length} to ingest, starting ${START}.`);
for (const p of plan.slice(0, 5)) console.log(`  ${p.date}  No. ${p.seq}  ${p.board}`);
if (plan.length > 5) console.log(`  … ${plan.length - 5} more, ending ${plan[plan.length - 1].date} (${plan[plan.length - 1].board})`);
if (DRY) {
  console.log('Dry run — nothing written.');
  process.exit(0);
}

for (const p of plan) {
  const { error } = await db.from('daily_puzzles').insert({
    puzzle_date: p.date,
    puzzle_id: p.seq,
    data: p.puzzle,
  });
  if (error) {
    console.error(`Insert failed at ${p.date} (${p.board}): ${error.message}`);
    process.exit(1);
  }
}
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
console.log(`Ingested ${plan.length} puzzles. Publish ledger updated (${Object.keys(ledger).length} entries).`);
