// Render sample "who's playing" cards (and the daily recap) to PNGs for visual review.
//   npx tsx scripts/card-preview.mts
import { writeFileSync } from 'node:fs';
import { renderRecap, renderRoster, type CardPlayer, type RecapData } from '../api/_card.ts';

const AV = 'https://cdn.discordapp.com/embed/avatars/0.png';

// Matches the design mock: a one-miss win, a perfect win (room leader → Trophy), a
// player mid-game, one who hasn't guessed, and a loss. grid = one row per guess (four
// group-levels 0..3); sec = elapsed/finish time.
const ROOM: CardPlayer[] = [
  { id: 'p-jun', name: 'Jun Park', avatar: AV, sec: 134, grid: [[2, 1, 2, 2], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1], [3, 3, 3, 3]] },
  { id: 'p-aria', name: 'Aria Voss', avatar: null, sec: 171, grid: [[3, 3, 3, 3], [0, 1, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]] },
  { id: 'p-theo', name: 'Theo Lindqvist', avatar: null, sec: 95, grid: [[0, 0, 0, 0], [3, 1, 2, 3]] },
  { id: 'p-mei', name: 'Mei Tanaka', avatar: AV, sec: 14, grid: [] },
  { id: 'p-noa', name: 'Noa Friedman', avatar: null, sec: 108, grid: [[1, 1, 1, 1], [3, 3, 3, 3], [0, 0, 0, 0], [2, 2, 2, 2]] },
  { id: 'p-omar', name: 'Omar Haddad', avatar: null, sec: 224, grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 3, 2, 2], [3, 2, 3, 3], [2, 3, 3, 2], [3, 2, 2, 3]] },
];
const SOLO: CardPlayer[] = [ROOM[2]];

const opts = { puzzleNo: 1170, puzzleDate: '2026-05-31' };
for (const [name, players] of [['room', ROOM], ['solo', SOLO]] as const) {
  const buf = await renderRoster(players, opts);
  const out = `/tmp/card-${name}.png`;
  writeFileSync(out, buf);
  console.log(out, buf.length, 'bytes');
}

// Daily recap: yesterday's results + season standings (mirrors the design mock).
const RECAP: RecapData = {
  puzzleNo: 1169,
  puzzleDate: '2026-05-30',
  season: 'May',
  streak: 12,
  longest: 21,
  winRate: 84,
  results: [
    { id: 'p-noa', name: 'Noa Friedman', solved: true, score: 96, mistakes: 0, sec: 102 },
    { id: 'p-theo', name: 'Theo Lindqvist', solved: true, score: 91, mistakes: 0, sec: 88 },
    { id: 'p-jun', name: 'Jun Park', solved: true, score: 84, mistakes: 1, sec: 141 },
    { id: 'p-priya', name: 'Priya Nair', solved: true, score: 77, mistakes: 1, sec: 169 },
    { id: 'p-aria', name: 'Aria Voss', solved: true, score: 68, mistakes: 2, sec: 203 },
    { id: 'p-yuki', name: 'Yuki Sato', solved: true, score: 61, mistakes: 3, sec: 247 },
    { id: 'p-omar', name: 'Omar Haddad', solved: false, score: 12, mistakes: 4, sec: null },
  ],
  standings: [
    { id: 'p-noa', name: 'Noa Friedman', total: 487, wins: 6, plays: 7 },
    { id: 'p-jun', name: 'Jun Park', total: 441, wins: 4, plays: 7 },
    { id: 'p-aria', name: 'Aria Voss', total: 408, wins: 3, plays: 7 },
    { id: 'p-theo', name: 'Theo Lindqvist', total: 372, wins: 3, plays: 6 },
    { id: 'p-priya', name: 'Priya Nair', total: 339, wins: 2, plays: 6 },
  ],
};
{
  const buf = await renderRecap(RECAP);
  const out = `/tmp/card-recap.png`;
  writeFileSync(out, buf);
  console.log(out, buf.length, 'bytes');
}
