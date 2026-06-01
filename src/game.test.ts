import { describe, it, expect } from "vitest";
import { Game, LEVELS, MAX_MISTAKES, SCORING, shuffle, type Puzzle } from "./game";

// Fixed 16-word puzzle; word names encode their group, e.g. "A2" is in level 2.
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
const newGame = (): Game => new Game(puzzle);

// Submit an explicit four-word guess, ignoring the current selection.
function guess(g: Game, words: string[]) {
  g.clear();
  for (const w of words) g.toggle(w);
  return g.submit();
}

// Four distinct wrong guesses (one word per group); exhausts mistakes, completes nothing.
const FOUR_WRONG = [
  ["A0", "A1", "A2", "A3"],
  ["B0", "B1", "B2", "B3"],
  ["C0", "C1", "C2", "C3"],
  ["D0", "D1", "D2", "D3"],
];

describe("Game · construction", () => {
  it("copies the layout onto the board without aliasing it", () => {
    const g = newGame();
    expect(g.board).toEqual(puzzle.layout);
    expect(g.board).not.toBe(puzzle.layout);
    expect(g.status).toBe("playing");
    expect(g.mistakesLeft).toBe(MAX_MISTAKES);
    expect(g.solved).toEqual([]);
    expect(g.selected.size).toBe(0);
    expect(g.score).toBe(0);
  });

  it("maps every word to its level and unknown words to undefined", () => {
    const g = newGame();
    expect(g.levelOf("A0")).toBe(0);
    expect(g.levelOf("D3")).toBe(3);
    expect(g.levelOf("nope")).toBeUndefined();
  });
});

describe("Game · selection", () => {
  it("toggles valid words, ignores unknown words, and caps at four", () => {
    const g = newGame();
    g.toggle("A0");
    g.toggle("B0");
    expect(g.selected.size).toBe(2);
    g.toggle("A0"); // toggle off
    expect(g.selected.has("A0")).toBe(false);
    expect(g.selected.size).toBe(1);

    g.toggle("ghost"); // not on board
    expect(g.selected.size).toBe(1);

    g.clear();
    for (const w of ["A0", "B0", "C0", "D0", "A1"]) g.toggle(w);
    expect(g.selected.size).toBe(4); // the fifth is rejected
    expect(g.selected.has("A1")).toBe(false);
    expect(g.canSubmit()).toBe(true);
  });

  it("clear() empties the selection", () => {
    const g = newGame();
    g.toggle("A0");
    g.clear();
    expect(g.selected.size).toBe(0);
    expect(g.canSubmit()).toBe(false);
  });
});

describe("Game · submit outcomes", () => {
  it("is a noop with fewer than four selected", () => {
    const g = newGame();
    g.toggle("A0");
    expect(g.submit()).toEqual({ type: "noop" });
    expect(g.history).toEqual([]);
  });

  it("resolves a correct group: removes the words, records history, keeps playing", () => {
    const g = newGame();
    expect(guess(g, group(0))).toEqual({ type: "correct", level: 0 });
    expect(g.solved.map((s) => s.level)).toEqual([0]);
    expect(g.board).toHaveLength(12);
    expect(g.board.some((w) => group(0).includes(w))).toBe(false);
    expect(g.selected.size).toBe(0);
    expect(g.history).toEqual([[0, 0, 0, 0]]);
    expect(g.guesses).toEqual([group(0)]);
    expect(g.groupsSolved).toBe(1);
    expect(g.status).toBe("playing");
  });

  it("flags a one-away guess (3 of one group + 1 other) and spends a mistake", () => {
    const g = newGame();
    expect(guess(g, ["A0", "B0", "C0", "A1"])).toEqual({ type: "oneaway" });
    expect(g.mistakesLeft).toBe(MAX_MISTAKES - 1);
    expect(g.status).toBe("playing");
    // wrong guesses keep the selection (NYT behaviour)
    expect(g.selected.size).toBe(4);
  });

  it("flags a spread guess as incorrect and spends a mistake", () => {
    const g = newGame();
    expect(guess(g, ["A0", "A1", "A2", "A3"])).toEqual({ type: "incorrect" });
    expect(g.mistakesLeft).toBe(MAX_MISTAKES - 1);
  });

  it("rejects a repeated guess as a duplicate without spending another mistake", () => {
    const g = newGame();
    guess(g, ["A0", "A1", "A2", "A3"]);
    expect(g.mistakesLeft).toBe(MAX_MISTAKES - 1);
    // same four words, re-ordered
    expect(guess(g, ["A3", "A2", "A1", "A0"])).toEqual({ type: "duplicate" });
    expect(g.mistakesLeft).toBe(MAX_MISTAKES - 1);
    expect(g.history).toHaveLength(1);
  });

  it("wins when the fourth group is completed", () => {
    const g = newGame();
    expect(guess(g, group(0))).toEqual({ type: "correct", level: 0 });
    expect(guess(g, group(1))).toEqual({ type: "correct", level: 1 });
    expect(guess(g, group(2))).toEqual({ type: "correct", level: 2 });
    expect(guess(g, group(3))).toEqual({ type: "win" });
    expect(g.status).toBe("won");
    expect(g.solved).toHaveLength(4);
    expect(typeof g.durationMs).toBe("number");
    expect(g.progress()).toEqual({ mistakesLeft: 4, solvedCount: 4, done: "won" });
  });

  it("loses on the fourth mistake and back-fills every group, sorted by level", () => {
    const g = newGame();
    const results = FOUR_WRONG.map((w) => guess(g, w));
    expect(results.at(-1)).toEqual({ type: "lose" });
    expect(g.status).toBe("lost");
    expect(g.mistakesLeft).toBe(0);
    expect(g.board).toEqual([]);
    expect(g.solved.map((s) => s.level)).toEqual([0, 1, 2, 3]);
    expect(typeof g.durationMs).toBe("number");
    expect(g.groupsSolved).toBe(0);
  });

  it("counts only deduced groups in groupsSolved after a partial loss", () => {
    const g = newGame();
    guess(g, group(0)); // one real solve
    for (const w of FOUR_WRONG) if (g.status === "playing") guess(g, w);
    expect(g.status).toBe("lost");
    expect(g.solved).toHaveLength(4); // 1 real + 3 back-filled
    expect(g.groupsSolved).toBe(1); // only one deduced
  });

  it("ignores input once the game is over", () => {
    const g = newGame();
    for (const lvl of [0, 1, 2, 3]) guess(g, group(lvl));
    expect(g.status).toBe("won");
    g.toggle("A0");
    expect(g.selected.size).toBe(0);
    expect(g.submit()).toEqual({ type: "noop" });
  });
});

describe("Game · score", () => {
  const base = SCORING.completionPerGroupSq * 16 + SCORING.solveBonus;

  it("is zero while still playing", () => {
    const g = newGame();
    guess(g, group(0));
    expect(g.score).toBe(0);
  });

  it("a perfect, instant win earns base + full speed bonus", () => {
    const g = newGame();
    for (const lvl of [0, 1, 2, 3]) guess(g, group(lvl));
    g.durationMs = 0; // pin the clock; deterministic speed term
    expect(g.score).toBe(base + SCORING.speedMax);
  });

  it("subtracts a penalty per mistake on a win", () => {
    const g = newGame();
    guess(g, ["A0", "A1", "A2", "A3"]); // one mistake
    for (const lvl of [0, 1, 2, 3]) guess(g, group(lvl));
    g.durationMs = 0;
    expect(g.mistakesLeft).toBe(MAX_MISTAKES - 1);
    expect(g.score).toBe(base + SCORING.speedMax - SCORING.mistakePenalty);
  });

  it("drops the speed bonus once the solve is slower than the target", () => {
    const g = newGame();
    for (const lvl of [0, 1, 2, 3]) guess(g, group(lvl));
    g.durationMs = (SCORING.speedTargetSec + 60) * 1000; // past target
    expect(g.score).toBe(base); // perfect, no speed
  });

  it("scores a loss by convex partial credit for groups reached", () => {
    const lose = (solves: number): Game => {
      const g = newGame();
      for (let i = 0; i < solves; i++) guess(g, group(i));
      for (const w of FOUR_WRONG) if (g.status === "playing") guess(g, w);
      expect(g.status).toBe("lost");
      return g;
    };
    expect(lose(0).score).toBe(0);
    expect(lose(1).score).toBe(SCORING.completionPerGroupSq); // 1²
    expect(lose(2).score).toBe(SCORING.completionPerGroupSq * 4); // 2²
    // convexity: each extra group worth more than the last
    expect(lose(2).score - lose(1).score).toBeGreaterThan(lose(1).score - lose(0).score);
  });

  it("never goes negative, and finishing always beats any partial loss", () => {
    // worst win: 3 mistakes, slowest solve
    const g = newGame();
    for (const w of FOUR_WRONG.slice(0, 3)) guess(g, w); // 3 mistakes
    for (const lvl of [0, 1, 2, 3]) guess(g, group(lvl));
    g.durationMs = 999 * 1000;
    expect(g.status).toBe("won");
    expect(g.score).toBeGreaterThanOrEqual(0);

    // best partial loss is 3 groups
    const lost3 = (() => {
      const h = newGame();
      for (const lvl of [0, 1, 2]) guess(h, group(lvl));
      for (const w of FOUR_WRONG) if (h.status === "playing") guess(h, w);
      return h.score;
    })();
    expect(g.score).toBeGreaterThan(lost3);
  });
});

describe("Game · share grid", () => {
  it("renders each guess as a row of category-color emoji, in order", () => {
    const g = newGame();
    guess(g, ["A0", "A1", "A2", "A3"]); // spread
    guess(g, group(0)); // correct
    const rows = g.shareGrid().split("\n");
    expect(rows).toEqual([
      LEVELS[0].emoji + LEVELS[1].emoji + LEVELS[2].emoji + LEVELS[3].emoji,
      LEVELS[0].emoji.repeat(4),
    ]);
  });
});

describe("shuffle", () => {
  it("returns a permutation without mutating the input", () => {
    const src = ["a", "b", "c", "d", "e"];
    const copy = src.slice();
    const out = shuffle(src);
    expect(out).not.toBe(src);
    expect(src).toEqual(copy); // input untouched
    expect(out.slice().sort()).toEqual(src.slice().sort()); // same multiset
  });
});
