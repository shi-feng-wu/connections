// Render sample "who's playing" cards to PNGs for visual review.
//   npx tsx scripts/card-preview.mts
import { writeFileSync } from 'node:fs';
import { renderRoster, type CardPlayer } from '../api/_card.ts';

// A real-ish Discord avatar (small, public) so the avatar path is exercised too.
const AV = 'https://cdn.discordapp.com/embed/avatars/0.png';

// Some sample Connections grids (each row = four group-levels 0..3).
const won: number[][] = [
  [0, 1, 0, 0], // miss
  [2, 2, 2, 2], // blue
  [0, 0, 0, 0], // yellow
  [1, 1, 1, 1], // green
  [3, 3, 3, 3], // purple
];
const lost: number[][] = [
  [0, 1, 0, 2],
  [1, 1, 3, 1],
  [0, 0, 0, 0],
  [2, 3, 2, 2],
];
const mid: number[][] = [
  [0, 0, 0, 0],
  [3, 1, 2, 3],
];
const fresh: number[][] = [];

function mk(n: number, grids: number[][][]): CardPlayer[] {
  const names = ['borgar', 'loljessecs', 'mizutsune', 'Aria', 'kenji_99', 'tomoko', 'Val', 'qqq', 'sleepyhead', 'noodle', 'Rin', 'xX_dark_Xx'];
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i),
    name: names[i % names.length],
    avatar: i % 3 === 0 ? AV : null, // mix avatar + placeholder paths
    grid: grids[i % grids.length],
  }));
}

const cases: Array<[string, CardPlayer[]]> = [
  ['solo', mk(1, [mid])],
  ['two', mk(2, [won, mid])],
  ['six', mk(6, [won, lost, mid, fresh, won, lost])],
];

for (const [name, players] of cases) {
  const buf = await renderRoster(players, { puzzleNo: 1170 });
  const out = `/tmp/card-${name}.png`;
  writeFileSync(out, buf);
  console.log(out, buf.length, 'bytes');
}
