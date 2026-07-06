import { describe, expect, it } from "vitest";
import { Game, type Puzzle } from "../src/game";
import { DURATION_CAP, scoreRow } from "../api/_scoring";

// The shared scores-row construction (api/_scoring.ts) used by BOTH scoring paths — the
// finish-time write in /api/guess and the client-posted /api/score fallback. These pin the
// value semantics so the two paths can never drift: solved/mistakes/groups from the replay,
// hint penalty flowing through, and the duration clamps that feed the speed component.

// Fixed 16-word puzzle; word names encode their group (same fixture shape as game.test.ts).
const puzzle: Puzzle = {
  id: 42,
  date: "2026-06-01",
  editor: "Test",
  groups: [
    { level: 0, category: "L0", members: ["A0", "B0", "C0", "D0"] },
    { level: 1, category: "L1", members: ["A1", "B1", "C1", "D1"] },
    { level: 2, category: "L2", members: ["A2", "B2", "C2", "D2"] },
    { level: 3, category: "L3", members: ["A3", "B3", "C3", "D3"] },
  ],
  layout: [
    "A0", "B0", "C0", "D0",
    "A1", "B1", "C1", "D1",
    "A2", "B2", "C2", "D2",
    "A3", "B3", "C3", "D3",
  ],
};

const group = (lvl: number): string[] => puzzle.groups[lvl].members.slice();
const WIN = [group(0), group(1), group(2), group(3)];
// Four distinct wrong guesses drawn from the two hardest groups (see game.test.ts).
const FOUR_WRONG = [
  ["A2", "B2", "C2", "A3"],
  ["A2", "B2", "B3", "C3"],
  ["A2", "A3", "B3", "C3"],
  ["B2", "C2", "D2", "D3"],
];

const WHO = { userId: "u1", name: "Player", avatar: null };
const ROOM = { scopeId: "g:guild1", channelId: "chan1" };

describe("scoreRow", () => {
  it("values a clean win from the replay, not the caller", () => {
    const game = Game.fromGuesses(puzzle, WIN);
    const row = scoreRow(puzzle, game, WHO, ROOM, 60_000);
    expect(row).toMatchObject({
      puzzle_id: 42,
      puzzle_date: "2026-06-01",
      scope_id: "g:guild1",
      channel_id: "chan1",
      user_id: "u1",
      solved: true,
      mistakes: 0,
      groups_solved: 4,
      hints_used: 0,
      duration_ms: 60_000,
    });
    expect(row.score).toBeGreaterThan(0);
  });

  it("keeps a loss's partial credit and its real mistake count", () => {
    const game = Game.fromGuesses(puzzle, FOUR_WRONG);
    const row = scoreRow(puzzle, game, WHO, ROOM, 60_000);
    expect(row.solved).toBe(false);
    expect(row.mistakes).toBe(4);
    expect(row.groups_solved).toBe(0); // the loss reveal must not count as solving
  });

  it("applies the hint penalty from the replayed record", () => {
    const clean = scoreRow(puzzle, Game.fromGuesses(puzzle, WIN), WHO, ROOM, 60_000);
    const hinted = scoreRow(puzzle, Game.fromGuesses(puzzle, WIN, undefined, [0]), WHO, ROOM, 60_000);
    expect(hinted.hints_used).toBe(1);
    expect(hinted.score).toBeLessThan(clean.score);
  });

  it("clamps duration before the speed component reads it", () => {
    const floor = scoreRow(puzzle, Game.fromGuesses(puzzle, WIN), WHO, ROOM, 5);
    expect(floor.duration_ms).toBe(1000);
    const ceiling = scoreRow(puzzle, Game.fromGuesses(puzzle, WIN), WHO, ROOM, Number.MAX_SAFE_INTEGER);
    expect(ceiling.duration_ms).toBe(DURATION_CAP);
    // The clamp must be what the score saw: a faster (clamped-floor) game scores at least
    // as high as the capped-slow one.
    expect(floor.score).toBeGreaterThanOrEqual(ceiling.score);
  });
});
