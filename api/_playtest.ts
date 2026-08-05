import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Puzzle } from './_puzzles.js';

// Local-dev-only playtest source (see /api/puzzle's `pg` branch). Reads the
// certified batch straight from the gitignored editorial working dir (drafts under review), so the
// boards never enter the public repo or a deployment: the file is absent from
// any build AND the serving branch requires isLocalDev().

type PgGroup = { name: string; level: number; words: string[] };
type PgBoard = { id: string; slot?: string; groups: PgGroup[] };
export type PgMeta = { id: string; index: number; total: number; slot: 'main' | 'gauntlet' };

const BATCH = join(process.cwd(), 'editorial', 'candidates', 'batch-018.json');

let ordered: PgBoard[] | null = null;
function boards(): PgBoard[] {
  if (!ordered) {
    const all = JSON.parse(readFileSync(BATCH, 'utf8')) as PgBoard[];
    // Playtest order: main-track boards first, gauntlet last (each in file order).
    ordered = [
      ...all.filter((b) => b.slot !== 'gauntlet'),
      ...all.filter((b) => b.slot === 'gauntlet'),
    ];
  }
  return ordered;
}

// Deterministic per-board deal so a reported issue reproduces exactly.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pgPuzzle(index: number): Puzzle & { pg: PgMeta } {
  const list = boards();
  const i = Math.min(Math.max(0, index), list.length - 1);
  const b = list[i];
  const groups = [...b.groups]
    .sort((x, y) => x.level - y.level)
    .map((g) => ({ level: g.level, category: g.name, members: [...g.words] }));
  const layout = groups.flatMap((g) => g.members);
  const rand = mulberry32(i + 1);
  for (let k = layout.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [layout[k], layout[j]] = [layout[j], layout[k]];
  }
  // Synthetic identity, far clear of any real NYT date/number.
  const date = new Date(Date.UTC(2099, 0, 1 + i)).toISOString().slice(0, 10);
  return {
    id: 990001 + i,
    date,
    editor: 'Disconnections',
    groups,
    layout,
    pg: { id: b.id, index: i, total: list.length, slot: b.slot === 'gauntlet' ? 'gauntlet' : 'main' },
  };
}
