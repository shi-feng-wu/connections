import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { fetchPuzzle, isValidDate, todayET, FIRST_DATE } from "../api/_puzzles";

// fetchPuzzle is a two-layer read-through (L1 in-memory Map → L2 Supabase
// `daily_puzzles`) with NO origin: a date either has an ingested row or it is
// NOT_FOUND. Every case uses a distinct date so the module-level L1 Map can't
// bleed between tests. `null` as the db arg skips L2 (L1 only).

// A minimal ingested puzzle, as scripts/ingest-puzzles.mjs writes it.
function storedPuzzle(id: number, date: string) {
  const groups = [0, 1, 2, 3].map((level) => ({
    level,
    category: `Cat ${level}`,
    members: [0, 1, 2, 3].map((j) => `w${level}${j}`),
  }));
  return { id, date, editor: "Disconnections", groups, layout: groups.flatMap((g) => g.members) };
}

// In-memory stand-in for the `daily_puzzles` table, exposing the one chain
// fetchPuzzle uses: select(...).eq(col, val).maybeSingle().
function fakeDb(store: Map<string, unknown>, log?: string[]) {
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => {
            log?.push(val);
            return {
              data: store.has(val) ? { data: store.get(val) } : null,
              error: null,
            };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("fetchPuzzle two-layer read-through", () => {
  it("L2: returns the stored puzzle for an ingested date", async () => {
    const store = new Map<string, unknown>([["2099-02-01", storedPuzzle(1, "2099-02-01")]]);
    const p = await fetchPuzzle("2099-02-01", fakeDb(store));
    expect(p.id).toBe(1);
    expect(p.editor).toBe("Disconnections");
    expect(p.layout).toHaveLength(16);
  });

  it("L1: a second call for the same date never re-reads L2", async () => {
    const log: string[] = [];
    const store = new Map<string, unknown>([["2099-02-02", storedPuzzle(2, "2099-02-02")]]);
    const db = fakeDb(store, log);
    const a = await fetchPuzzle("2099-02-02", db);
    const b = await fetchPuzzle("2099-02-02", db);
    expect(a).toEqual(b);
    expect(log).toHaveLength(1);
  });

  it("miss: a date with no row is NOT_FOUND, and nothing is cached for it", async () => {
    const store = new Map<string, unknown>();
    await expect(fetchPuzzle("2099-02-03", fakeDb(store))).rejects.toThrow("NOT_FOUND");
    // Row appears later (ingest ran between requests) → served, not pinned-missing.
    store.set("2099-02-03", storedPuzzle(3, "2099-02-03"));
    const p = await fetchPuzzle("2099-02-03", fakeDb(store));
    expect(p.id).toBe(3);
  });

  it("null db skips L2 entirely and misses are NOT_FOUND", async () => {
    await expect(fetchPuzzle("2099-02-04", null)).rejects.toThrow("NOT_FOUND");
  });

  it("pre-epoch dates read the legacy `puzzles` table (flip-day bridge)", async () => {
    const tables: string[] = [];
    const legacy = new Map<string, unknown>([["2020-01-01", storedPuzzle(9, "2020-01-01")]]);
    const db = {
      from: (t: string) => {
        tables.push(t);
        return {
          select: () => ({
            eq: (_c: string, val: string) => ({
              maybeSingle: async () => ({
                data: legacy.has(val) ? { data: legacy.get(val) } : null,
                error: null,
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;
    const p = await fetchPuzzle("2020-01-01", db); // far before any possible epoch
    expect(p.id).toBe(9);
    expect(tables).toEqual(["puzzles"]);
  });
});

describe("date bounds", () => {
  it("rejects dates before the content epoch — the NYT-era archive is not served", () => {
    expect(isValidDate("2023-06-12")).toBe(false); // NYT Connections #1
    expect(isValidDate("2025-01-01")).toBe(false);
    expect(FIRST_DATE > "2025-12-31").toBe(true);
  });

  it("accepts only well-formed dates between the epoch and today (ET)", () => {
    expect(isValidDate("not-a-date")).toBe(false);
    expect(isValidDate("2199-01-01")).toBe(false); // future
    expect(isValidDate(todayET())).toBe(FIRST_DATE <= todayET());
  });
});
