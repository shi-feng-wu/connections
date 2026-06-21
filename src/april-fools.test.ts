import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchPuzzle } from "../api/_nyt";
import { Game } from "./game";

// Can the app handle NYT's "weird" April Fools puzzles? These feed the REAL raw
// NYT responses (captured verbatim from the v2 endpoint) through the actual parser
// (api/_nyt.fetchPuzzle, with fetch stubbed + L2 skipped) and then through the
// Game model, the same path production uses. Each year breaks the usual "16 short
// text words" assumption in a different way:
//   2024-04-01 (#307): every card is an emoji in the normal `content` field.
//   2025-04-01 (#672): cards have NO `content` — they're image_url + image_alt_text.

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

// Drive a Game to a clean win by submitting each group in turn. Throws/returns
// non-win if the parsed board can't actually be played (e.g. undefined cards that
// collapse to a single board entry). Returns the final result type.
function playToWin(puzzle: { groups: { members: string[] }[] }, date: string) {
  const game = new Game(puzzle as any);
  let last = "";
  for (const g of puzzle.groups) {
    game.clear();
    for (const w of g.members) game.toggle(w);
    last = game.submit().type;
  }
  return { game, last, dateLabel: date };
}

// === 2024 April Fools (#307): all-emoji board ===
const RAW_2024 = {
  status: "OK",
  id: 307,
  print_date: "2024-04-01",
  editor: "Wyna Liu",
  categories: [
    { title: "FOOD SLANG FOR MONEY", cards: [
      { content: "🥓", position: 12 }, { content: "🍞", position: 0 },
      { content: "🥬", position: 6 }, { content: "🧀", position: 9 } ] },
    { title: "WORDS THAT RHYME", cards: [
      { content: "🧠", position: 1 }, { content: "✈️", position: 13 },
      { content: "🌧️", position: 10 }, { content: "🚂", position: 7 } ] },
    { title: "HORROR MOVIES", cards: [
      { content: "👽", position: 8 }, { content: "🧛", position: 15 },
      { content: "🪚", position: 3 }, { content: "😱", position: 4 } ] },
    { title: "LETTER HOMOPHONES", cards: [
      { content: "🐝", position: 14 }, { content: "🐑", position: 5 },
      { content: "👁️", position: 11 }, { content: "🫖", position: 2 } ] },
  ],
};

// === 2025 April Fools (#672): image cards, no text `content` ===
const RAW_2025 = {
  status: "OK",
  id: 672,
  print_date: "2025-04-01",
  editor: "Wyna Liu",
  categories: [
    { title: "CURRENCY SYMBOLS", cards: [
      { position: 9, image_url: "https://x/9.svg", image_alt_text: "$" },
      { position: 7, image_url: "https://x/7.svg", image_alt_text: "€" },
      { position: 12, image_url: "https://x/12.svg", image_alt_text: "£" },
      { position: 15, image_url: "https://x/15.svg", image_alt_text: "¥" } ] },
    { title: "AND/TOGETHER WITH", cards: [
      { position: 1, image_url: "https://x/1.svg", image_alt_text: "&" },
      { position: 11, image_url: "https://x/11.svg", image_alt_text: "+" },
      { position: 4, image_url: "https://x/4.svg", image_alt_text: "N" },
      { position: 2, image_url: "https://x/2.svg", image_alt_text: "X" } ] },
    { title: "EMOTICON MOUTHS", cards: [
      { position: 10, image_url: "https://x/10.svg", image_alt_text: "(" },
      { position: 3, image_url: "https://x/3.svg", image_alt_text: ")" },
      { position: 5, image_url: "https://x/5.svg", image_alt_text: "O" },
      { position: 6, image_url: "https://x/6.svg", image_alt_text: "P" } ] },
    { title: '"RIGHT"', cards: [
      { position: 14, image_url: "https://x/14.svg", image_alt_text: "R" },
      { position: 8, image_url: "https://x/8.svg", image_alt_text: "→" },
      { position: 0, image_url: "https://x/0.svg", image_alt_text: "⊾" },
      { position: 13, image_url: "https://x/13.svg", image_alt_text: "✔" } ] },
  ],
};

// What a correctly-parsed board must satisfy regardless of card medium: 16 cards,
// all defined & non-empty, all distinct (so they're independently selectable), and
// a fully-dense 16-slot layout. These are the invariants the Game model relies on.
function expectPlayableBoard(puzzle: { groups: { members: string[] }[]; layout: string[] }) {
  const all = puzzle.groups.flatMap((g) => g.members);
  expect(all).toHaveLength(16);
  expect(all.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
  expect(new Set(all).size).toBe(16); // 16 independently selectable cards
  expect(puzzle.layout).toHaveLength(16);
  expect(puzzle.layout.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
}

describe("April Fools puzzles", () => {
  it("2024 (#307): all-emoji board parses and is fully playable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(RAW_2024)));
    const puzzle = await fetchPuzzle("2024-04-01", null);

    expectPlayableBoard(puzzle);
    expect(puzzle.groups[0].members).toContain("🥓");
    expect(puzzle.layout[0]).toBe("🍞"); // position 0

    const { last, game } = playToWin(puzzle, "2024-04-01");
    expect(last).toBe("win");
    expect(game.status).toBe("won");
  });

  it("2025 (#672): image-only board parses into a playable board with image URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(RAW_2025)));
    const puzzle = await fetchPuzzle("2025-04-01", null);

    // The cards carry their glyph in image_alt_text, not content. The parser uses
    // that as the card identity, so the board still has 16 distinct, non-empty cards.
    expectPlayableBoard(puzzle);
    expect(puzzle.groups[0].members).toEqual(["$", "€", "£", "¥"]);
    expect(puzzle.layout[9]).toBe("$"); // position 9

    // ...and carries an image URL per card so the UI can render the real SVG glyph.
    const all = puzzle.groups.flatMap((g) => g.members);
    expect(Object.keys(puzzle.images ?? {}).sort()).toEqual([...all].sort());
    expect(puzzle.images?.["$"]).toBe("https://x/9.svg");

    const { last, game } = playToWin(puzzle, "2025-04-01");
    expect(last).toBe("win");
    expect(game.status).toBe("won");
  });

  it("text puzzles carry no images map (no churn for the normal case)", async () => {
    const RAW_TEXT = {
      status: "OK",
      id: 1,
      print_date: "2024-06-01",
      editor: "E",
      categories: [0, 1, 2, 3].map((lvl) => ({
        title: `Cat ${lvl}`,
        cards: [0, 1, 2, 3].map((j) => ({ content: `w${lvl}${j}`, position: lvl * 4 + j })),
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(RAW_TEXT)));
    const puzzle = await fetchPuzzle("2024-06-01", null);
    expectPlayableBoard(puzzle);
    expect(puzzle.images).toBeUndefined();
  });

  it("mixed board (mostly text + one image card, e.g. #1028) parses per-card", async () => {
    // NYT also ships boards with a single image card among text (2026-03-07: the
    // Connections-logo "THIS GAME"). The image map should hold only that card.
    const RAW_MIXED = {
      status: "OK",
      id: 1028,
      print_date: "2026-03-07",
      editor: "Wyna Liu",
      categories: [
        { title: "$1", cards: [
          { content: "BUCK", position: 8 }, { content: "DOLLAR", position: 15 },
          { content: "ONE", position: 0 }, { content: "SINGLE", position: 6 } ] },
        { title: "ROMEO", cards: [
          { content: "ART", position: 9 }, { content: "ROMEO", position: 7 },
          { content: "THOU", position: 1 }, { content: "WHEREFORE", position: 13 } ] },
        { title: "CASTLE", cards: [
          { content: "BOUNCY", position: 10 }, { content: "NEW", position: 4 },
          { content: "SAND", position: 2 }, { content: "WHITE", position: 12 } ] },
        { title: "CONNECT", cards: [
          { position: 3, image_url: "https://x/logo.svg", image_alt_text: "THIS GAME" },
          { content: "AIRPORT", position: 11 }, { content: "DATING APP", position: 5 },
          { content: "INTERNET CAFE", position: 14 } ] },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(RAW_MIXED)));
    const puzzle = await fetchPuzzle("2026-03-07", null);
    expectPlayableBoard(puzzle);
    expect(Object.keys(puzzle.images ?? {})).toEqual(["THIS GAME"]); // only the image card
    expect(puzzle.layout[3]).toBe("THIS GAME");
    const { last } = playToWin(puzzle, "2026-03-07");
    expect(last).toBe("win");
  });

  it("rejects an unparseable board (blank/duplicate cards) instead of serving it", async () => {
    // A card with neither content nor image_alt_text → a blank, unselectable tile.
    // Under the old parser this was served as 200 OK; now it 404s like a missing date.
    const BROKEN = {
      status: "OK",
      id: 2,
      print_date: "2099-01-01",
      editor: "E",
      categories: [0, 1, 2, 3].map((lvl) => ({
        title: `Cat ${lvl}`,
        cards: [0, 1, 2, 3].map((j) => ({ position: lvl * 4 + j })), // no content, no alt text
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(BROKEN)));
    await expect(fetchPuzzle("2099-01-01", null)).rejects.toThrow("NOT_FOUND");
  });
});
