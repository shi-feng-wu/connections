import { describe, expect, it } from "vitest";
import {
  fmtClock,
  fmtDateFull,
  gridMetrics,
  outcomeLabel,
  renderShareCard,
  SHARE_CARD_H,
  SHARE_CARD_W,
  type ShareCardData,
} from "../api/_sharecard";

// api/_sharecard.ts: the spoiler-free result card a player posts as a Discord quick link. It
// is the end screen restaged, so three things must not regress: (a) it emits a real PNG at
// Discord's 43:24 hero ratio for every shape of finished game, including the degraded ones
// where a stat is missing; (b) it is driven ONLY by the grid, counts, times and the date —
// never by the puzzle's words or categories, which is what makes it safe to post in a channel
// where people haven't played yet; (c) its numerals read the way the app's do (m:ss clock,
// PERFECT/SOLVED/FAILED).

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
  score: 412,
  durationMs: 134_000,
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
      { ...WIN, solved: false, mistakes: 4, streak: 1, score: 80 },
      { ...WIN, grid: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]], mistakes: 0, streak: 12 },
      { ...WIN, streak: null },
    ];
    for (const s of shapes) expect(png(await renderShareCard(s))).toBe(true);
  });

  it("renders every degraded stat combination (a missing stat is dropped, never faked)", async () => {
    // An unscored game, an older row with no duration, and a scored row for a player with no
    // streak — each must still produce a card rather than a hole or a throw.
    const shapes: ShareCardData[] = [
      { ...WIN, score: null, durationMs: null, streak: null },
      { ...WIN, score: null },
      { ...WIN, durationMs: null },
      { ...WIN, score: 0, durationMs: 0 },
      { ...WIN, solved: false, mistakes: 4, score: null, durationMs: null, streak: null },
    ];
    for (const s of shapes) expect(png(await renderShareCard(s))).toBe(true);
  });

  it("survives the degenerate inputs a replay can hand it", async () => {
    // No puzzle number and no date (the dateline just drops), an empty grid, a grid longer
    // than any real game, and a four-digit score with a long month — none may throw mid-share.
    expect(png(await renderShareCard({ grid: [], solved: false, mistakes: 4 }))).toBe(true);
    const long = Array.from({ length: 12 }, () => [0, 1, 2, 3]);
    expect(png(await renderShareCard({ ...WIN, grid: long }))).toBe(true);
    expect(
      png(
        await renderShareCard({
          ...WIN,
          puzzleDate: "2026-09-30",
          score: 9999,
          durationMs: 3_601_000,
          streak: 128,
        }),
      ),
    ).toBe(true);
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

  it("changes with the score and the time, so those stats really are on the card", async () => {
    const base = await renderShareCard(WIN);
    expect((await renderShareCard({ ...WIN, score: 999 })).equals(base)).toBe(false);
    expect((await renderShareCard({ ...WIN, durationMs: 61_000 })).equals(base)).toBe(false);
    expect((await renderShareCard({ ...WIN, streak: 9 })).equals(base)).toBe(false);
    // …and dropping one visibly changes the card rather than silently rendering a zero.
    expect((await renderShareCard({ ...WIN, score: null })).equals(base)).toBe(false);
    expect((await renderShareCard({ ...WIN, durationMs: null })).equals(base)).toBe(false);
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

// The card states its stats the way the end screen does: a status word, a m:ss clock, and
// numerals. No prose sentences — those are what the redesign replaced with icons.
describe("end-screen vocabulary", () => {
  it("uses the end footer's status words, with PERFECT reserved for a clean win", () => {
    expect(outcomeLabel(true, 0)).toBe("PERFECT");
    expect(outcomeLabel(true, 1)).toBe("SOLVED");
    expect(outcomeLabel(true, 3)).toBe("SOLVED");
    // A loss always spends every mistake, so it can never read PERFECT.
    expect(outcomeLabel(false, 4)).toBe("FAILED");
    expect(outcomeLabel(false, 0)).toBe("FAILED");
  });

  it("formats the clock as the end footer does (m:ss, sub-second rounds up to 0:01)", () => {
    expect(fmtClock(134_000)).toBe("2:14");
    expect(fmtClock(88_000)).toBe("1:28");
    expect(fmtClock(3_601_000)).toBe("60:01");
    expect(fmtClock(200)).toBe("0:01");
  });

  it("drops the clock rather than showing a placeholder when the duration is unknown", () => {
    expect(fmtClock(null)).toBe("");
    expect(fmtClock(undefined)).toBe("");
    expect(fmtClock(Number.NaN)).toBe("");
  });

  it("formats the dateline, and drops it when the date is unusable", () => {
    expect(fmtDateFull("2026-08-11")).toBe("August 11, 2026");
    expect(fmtDateFull(undefined)).toBe("");
    expect(fmtDateFull("nonsense")).toBe("");
  });
});
