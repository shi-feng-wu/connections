import { describe, expect, it } from "vitest";
import {
  fmtDateFull,
  gridMetrics,
  outcomeLine,
  renderShareCard,
  SHARE_CARD_H,
  SHARE_CARD_W,
  type ShareCardData,
} from "../api/_sharecard";

// api/_sharecard.ts: the spoiler-free result card a player posts as a Discord quick link.
// The two things that must never regress are (a) it emits a real PNG at Discord's 43:24
// hero ratio for every shape of finished game, and (b) it is driven ONLY by the guess grid,
// counts, and the date — never by the puzzle's words or categories, which is what makes it
// safe to post in a channel where people haven't played yet.

const png = (b: Buffer): boolean =>
  b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG";

const WIN: ShareCardData = {
  puzzleNo: 1170,
  puzzleDate: "2026-08-11",
  grid: [
    [2, 1, 2, 2],
    [2, 2, 2, 2],
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [3, 3, 3, 3],
  ],
  solved: true,
  mistakes: 1,
  streak: 5,
};

describe("share card render", () => {
  it("is exactly Discord's 43:24 quick-link ratio", () => {
    expect(SHARE_CARD_W / SHARE_CARD_H).toBeCloseTo(43 / 24, 10);
  });

  it("renders a real PNG for a win with a streak", async () => {
    const buf = await renderShareCard(WIN);
    expect(png(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("renders a loss, a perfect solve, and a no-streak card", async () => {
    const shapes: ShareCardData[] = [
      { ...WIN, solved: false, mistakes: 4, streak: 1 },
      { ...WIN, grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]], mistakes: 0, streak: 12 },
      { ...WIN, streak: null },
    ];
    for (const s of shapes) expect(png(await renderShareCard(s))).toBe(true);
  });

  it("survives the degenerate inputs a replay can hand it", async () => {
    // No puzzle number and no date (the subline and the eyebrow suffix just drop), an empty
    // grid, and a grid longer than any real game — none of which may throw mid-share.
    expect(png(await renderShareCard({ grid: [], solved: false, mistakes: 4 }))).toBe(true);
    const long = Array.from({ length: 12 }, () => [0, 1, 2, 3]);
    expect(png(await renderShareCard({ ...WIN, grid: long }))).toBe(true);
  });

  it("is deterministic: the same result renders byte-identical PNGs", async () => {
    const a = await renderShareCard(WIN);
    const b = await renderShareCard({ ...WIN, grid: WIN.grid.map((r) => [...r]) });
    expect(a.equals(b)).toBe(true);
  });

  it("changes with the grid, so the card really is the player's own result", async () => {
    const other = await renderShareCard({
      ...WIN,
      grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]],
      mistakes: 0,
    });
    expect(other.equals(await renderShareCard(WIN))).toBe(false);
  });
});

describe("share card layout", () => {
  it("keeps the grid inside the frame however long the game ran", () => {
    for (let rows = 1; rows <= 8; rows++) {
      const { size, x, y } = gridMetrics(rows);
      const h = rows * size + (rows - 1) * 18;
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y + h).toBeLessThanOrEqual(SHARE_CARD_H);
      expect(x + 4 * size + 3 * 18).toBeLessThanOrEqual(SHARE_CARD_W);
      // The grid is the hero, so tiles must never collapse to specks on a long game.
      expect(size).toBeGreaterThan(40);
    }
  });

  it("centres the grid vertically", () => {
    for (const rows of [4, 5, 7]) {
      const { size, y } = gridMetrics(rows);
      const h = rows * size + (rows - 1) * 18;
      expect(Math.abs(y - (SHARE_CARD_H - h - y))).toBeLessThanOrEqual(1);
    }
  });
});

describe("card copy", () => {
  it("names the outcome and a count, and nothing else", () => {
    expect(outcomeLine(true, 0)).toBe("Perfect solve");
    expect(outcomeLine(true, 1)).toBe("Solved with 1 mistake");
    expect(outcomeLine(true, 3)).toBe("Solved with 3 mistakes");
    expect(outcomeLine(false, 4)).toBe("Out of guesses");
  });

  it("formats the subline date, and drops it when the date is unusable", () => {
    expect(fmtDateFull("2026-08-11")).toBe("August 11, 2026");
    expect(fmtDateFull(undefined)).toBe("");
    expect(fmtDateFull("nonsense")).toBe("");
  });
});
