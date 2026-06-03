import { describe, expect, it } from "vitest";
import { renderRoster } from "../api/_card";
import { gridFinished } from "../api/_livecard";

// api/_livecard.ts: turns stored rosters into render-ready grids and gates the live
// edit throttle. gridFinished decides whether a player's grid skips the throttle so
// their final board always lands; renderRoster must draw a real PNG with grids.

describe("gridFinished", () => {
  const solve = (l: number) => [l, l, l, l];
  const miss = [0, 1, 2, 3];

  it("is false for no grid / an empty grid (not started)", () => {
    expect(gridFinished(undefined)).toBe(false);
    expect(gridFinished([])).toBe(false);
  });

  it("is false mid-game (some solves, under four misses)", () => {
    expect(gridFinished([solve(0), miss, solve(1)])).toBe(false);
  });

  it("is true on a win (four groups solved)", () => {
    expect(gridFinished([solve(0), solve(1), solve(2), solve(3)])).toBe(true);
  });

  it("is true on a win even with misses mixed in", () => {
    expect(gridFinished([miss, solve(0), solve(1), miss, solve(2), solve(3)])).toBe(true);
  });

  it("is true on a loss (four misses)", () => {
    expect(gridFinished([miss, miss, miss, miss])).toBe(true);
    expect(gridFinished([solve(0), miss, miss, miss, miss])).toBe(true);
  });
});

describe("renderRoster with grids", () => {
  const png = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG";

  it("renders coloured grids alongside blank ones", async () => {
    const buf = await renderRoster(
      [
        { id: "1", name: "Won", grid: [[0, 1, 0, 0], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1], [3, 3, 3, 3]] },
        { id: "2", name: "Mid", grid: [[0, 0, 0, 0], [3, 1, 2, 3]] },
        { id: "3", name: "Fresh", grid: [] },
        { id: "4", name: "NoGrid" },
      ],
      { puzzleNo: 1170 },
    );
    expect(png(buf)).toBe(true);
  });

  it("ignores out-of-range cell levels (renders blank, no throw)", async () => {
    const buf = await renderRoster([{ id: "1", name: "Odd", grid: [[9, -1, 0, 1]] }]);
    expect(png(buf)).toBe(true);
  });
});
