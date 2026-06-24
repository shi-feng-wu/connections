import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPuzzle } from "../api/_nyt";

// fetchPuzzle is a three-layer read-through (L1 in-memory Map → L2 Supabase `puzzles`
// → NYT origin). These exercise each layer with a stubbed `fetch` (origin) and a fake
// `db` (L2); every case uses a distinct date so the module-level L1 Map can't bleed
// between tests. `null` as the db arg skips L2 (L1 + origin only).

// A minimal valid NYT raw response: 4 categories × 4 cards = the 16-card board.
function rawPuzzle(id: number, date: string) {
  const categories = [0, 1, 2, 3].map((level) => ({
    title: `Cat ${level}`,
    cards: [0, 1, 2, 3].map((j) => ({ content: `w${level}${j}`, position: level * 4 + j })),
  }));
  return { status: "OK", id, print_date: date, editor: "E", categories };
}

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

// In-memory stand-in for the `puzzles` table, exposing just the two chains fetchPuzzle
// uses: select(...).eq(col, val).maybeSingle() and upsert({ puzzle_date, data }).
function fakeDb(store: Map<string, unknown>) {
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => ({
            data: store.has(val) ? { data: store.get(val) } : null,
            error: null,
          }),
        }),
      }),
      upsert: async (row: { puzzle_date: string; data: unknown }) => {
        store.set(row.puzzle_date, row.data);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPuzzle read-through cache", () => {
  it("L1: a second call for the same date never re-fetches", async () => {
    const fetchMock = vi.fn(async () => okResponse(rawPuzzle(1, "2024-01-01")));
    vi.stubGlobal("fetch", fetchMock);
    const a = await fetchPuzzle("2024-01-01", null); // null db → L1 + origin only
    const b = await fetchPuzzle("2024-01-01", null);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("miss: fetches NYT once and persists the puzzle to L2", async () => {
    const store = new Map<string, unknown>();
    const fetchMock = vi.fn(async () => okResponse(rawPuzzle(2, "2024-02-01")));
    vi.stubGlobal("fetch", fetchMock);
    const p = await fetchPuzzle("2024-02-01", fakeDb(store));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p.id).toBe(2);
    expect(store.get("2024-02-01")).toEqual(p); // written through to L2
  });

  it("L2 hit: a stored row serves without touching NYT", async () => {
    const store = new Map<string, unknown>();
    const seeded = { id: 9, date: "2024-03-01", editor: "E", groups: [], layout: [] };
    store.set("2024-03-01", seeded);
    const fetchMock = vi.fn(async () => {
      throw new Error("origin should not be hit on an L2 hit");
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = await fetchPuzzle("2024-03-01", fakeDb(store));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p).toEqual(seeded);
  });

  it("404: throws and caches nothing (no negative caching)", async () => {
    const store = new Map<string, unknown>();
    const db = fakeDb(store);
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPuzzle("2024-04-01", db)).rejects.toThrow("NOT_FOUND");
    expect(store.has("2024-04-01")).toBe(false); // nothing persisted to L2
    // and not pinned in L1 either: a retry still reaches origin
    await expect(fetchPuzzle("2024-04-01", db)).rejects.toThrow("NOT_FOUND");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
