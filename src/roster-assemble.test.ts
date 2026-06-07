import { describe, expect, it } from "vitest";
import { assembleRoster } from "../api/roster";
import type { CardPlayer } from "../api/_card";
import type { Puzzle } from "./game";

// assembleRoster (api/roster.ts) builds the Live-tab roster. The player SET is the union
// of who joined the room card (live_cards.players) and who finished (scores), so a player
// who played but whose /api/join never landed still shows. State is replayed from each
// player's committed progress; a finisher whose progress row is gone is synthesized from
// their scores row; a player who joined but never started is dropped.

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

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const cp = (id: string, name = id): CardPlayer => ({ id, name, avatar: null });
type ScoreRow = Parameters<typeof assembleRoster>[1][number];
const score = (o: Partial<ScoreRow> & { user_id: string }): ScoreRow => ({
  user_id: o.user_id,
  name: o.name ?? o.user_id,
  avatar: o.avatar ?? null,
  solved: o.solved ?? true,
  mistakes: o.mistakes ?? 0,
  groups_solved: o.groups_solved ?? 4,
  duration_ms: o.duration_ms ?? null,
});
type ProgRow = Parameters<typeof assembleRoster>[2][number];
const prog = (user_id: string, guesses: string[][], startedAt: number, updatedAt = startedAt): ProgRow => ({
  user_id,
  guesses,
  started_at: iso(startedAt),
  updated_at: iso(updatedAt),
});

// Mirrors roster.tsx elapsedMs so we assert the displayed time, not raw epochs.
const elapsed = (p: { startedAt: number; finishedAt: number | null }): number =>
  Math.max(0, (p.finishedAt ?? NOW) - (p.startedAt || NOW));

describe("assembleRoster", () => {
  it("replays a joined player who is mid-game (still playing, live timer running)", () => {
    const start = NOW - 90_000;
    const out = assembleRoster([cp("A")], [], [prog("A", [group(0)], start)], puzzle, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      userId: "A",
      done: null,
      solvedCount: 1,
      solvedLevels: [0],
      mistakesLeft: 4,
      startedAt: start,
      finishedAt: null,
    });
  });

  it("synthesizes a finisher who is only in scores (never joined the card)", () => {
    const out = assembleRoster([], [score({ user_id: "B", solved: true, groups_solved: 4, duration_ms: 120_000 })], [], puzzle, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      userId: "B",
      done: "won",
      solvedCount: 4,
      solvedLevels: [0, 1, 2, 3],
      mistakesLeft: 4,
    });
    // Frozen timer shows the recorded solve duration.
    expect(elapsed(out[0])).toBe(120_000);
    expect(out[0].finishedAt).not.toBeNull();
  });

  it("synthesizes a loss from scores (partial groups, all mistakes spent)", () => {
    const out = assembleRoster([], [score({ user_id: "D", solved: false, groups_solved: 2, mistakes: 4, duration_ms: 60_000 })], [], puzzle, NOW);
    expect(out[0]).toMatchObject({ userId: "D", done: "lost", solvedCount: 2, solvedLevels: [0, 1], mistakesLeft: 0 });
    expect(elapsed(out[0])).toBe(60_000);
  });

  it("drops a player who joined but never started (no progress, no score)", () => {
    expect(assembleRoster([cp("C")], [], [], puzzle, NOW)).toEqual([]);
  });

  it("prefers the live progress replay over the scores synth when both exist", () => {
    const start = NOW - 200_000;
    const finishedAt = NOW - 80_000; // updated_at = real finish time
    const out = assembleRoster(
      [cp("E")],
      [score({ user_id: "E", solved: true, groups_solved: 4, duration_ms: 999_999 })],
      [prog("E", WIN, start, finishedAt)],
      puzzle,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ userId: "E", done: "won", solvedCount: 4, startedAt: start, finishedAt });
    // Replayed time wins (from progress), not the synth duration.
    expect(elapsed(out[0])).toBe(finishedAt - start);
  });

  it("unions both sources and dedupes by id", () => {
    const start = NOW - 30_000;
    const out = assembleRoster(
      [cp("A")],
      [score({ user_id: "B", duration_ms: 50_000 })],
      [prog("A", [group(0)], start)],
      puzzle,
      NOW,
    );
    expect(out.map((p) => p.userId).sort()).toEqual(["A", "B"]);
  });

  it("fails soft when the puzzle is unavailable: returns finishers, not nothing", () => {
    const start = NOW - 30_000;
    const out = assembleRoster(
      [cp("A")], // mid-game joiner — unrenderable without the puzzle
      [score({ user_id: "B", solved: true, groups_solved: 4, duration_ms: 70_000 })],
      [prog("A", [group(0)], start)],
      null,
      NOW,
    );
    expect(out.map((p) => p.userId)).toEqual(["B"]);
    expect(out[0]).toMatchObject({ done: "won", solvedCount: 4 });
    expect(elapsed(out[0])).toBe(70_000);
  });

  it("flags a player online only when their heartbeat is within the TTL", () => {
    const start = NOW - 30_000;
    const seen = new Map<string, number>([
      ["A", NOW - 5_000], // fresh beat → online
      ["B", NOW - 60_000], // stale beat → offline
    ]);
    const out = assembleRoster(
      [cp("A")],
      [score({ user_id: "B", duration_ms: 50_000 })],
      [prog("A", [group(0)], start)],
      puzzle,
      NOW,
      seen,
    );
    const byId = Object.fromEntries(out.map((p) => [p.userId, p]));
    expect(byId.A.online).toBe(true);
    expect(byId.B.online).toBe(false);
  });

  it("defaults online to false when no heartbeat map is passed", () => {
    const start = NOW - 30_000;
    const out = assembleRoster([cp("A")], [], [prog("A", [group(0)], start)], puzzle, NOW);
    expect(out[0].online).toBe(false);
  });
});
