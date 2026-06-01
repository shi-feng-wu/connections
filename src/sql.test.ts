import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// Runs the leaderboard functions from supabase/schema.sql against real Postgres
// (PGlite = Postgres in WASM). Extracts the three `create function` blocks
// (skipping Supabase-only grants/policies) against a minimal `scores` table.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlocks = [
  ...schema.matchAll(
    /create or replace function public\.(?:current_streak|room_board|room_self)[\s\S]*?\$\$;/g,
  ),
].map((m) => m[0]);

// Seed: room "g1" (4 players, varied streaks/win-rates) + stray "g2" row for scope isolation.
const SEED = [
  // alice: five straight wins (streak 5)
  ["g1", "alice", "Alice", 1000, 0, true, "2026-06-01"],
  ["g1", "alice", "Alice", 900, 1, true, "2026-06-02"],
  ["g1", "alice", "Alice", 1000, 0, true, "2026-06-03"],
  ["g1", "alice", "Alice", 800, 2, true, "2026-06-04"],
  ["g1", "alice", "Alice", 1000, 0, true, "2026-06-05"],
  // bob: loss on the 4th breaks the run; 5th win restarts it (streak 1)
  ["g1", "bob", "Bob", 700, 1, true, "2026-06-01"],
  ["g1", "bob", "Bob", 600, 2, true, "2026-06-02"],
  ["g1", "bob", "Bob", 800, 1, true, "2026-06-03"],
  ["g1", "bob", "Bob", 100, 4, false, "2026-06-04"],
  ["g1", "bob", "Bob", 900, 0, true, "2026-06-05"],
  // carol: four straight wins, didn't play today (streak 4, counts to last win)
  ["g1", "carol", "Carol", 500, 1, true, "2026-06-01"],
  ["g1", "carol", "Carol", 500, 1, true, "2026-06-02"],
  ["g1", "carol", "Carol", 500, 1, true, "2026-06-03"],
  ["g1", "carol", "Carol", 500, 1, true, "2026-06-04"],
  // dave: only a loss (streak 0)
  ["g1", "dave", "Dave", 0, 4, false, "2026-06-05"],
  // other room: must never show up in g1's board
  ["g2", "eve", "Eve", 9999, 0, true, "2026-06-05"],
];

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table public.scores (
      id bigint generated always as identity primary key,
      scope_id text, user_id text not null, name text not null, avatar text,
      score int not null default 0, mistakes int not null default 0,
      solved boolean not null default false, groups_solved smallint not null default 0,
      puzzle_date date, created_at timestamptz not null default now()
    );
  `);
  expect(fnBlocks).toHaveLength(3); // current_streak, room_board, room_self
  for (const block of fnBlocks) await db.exec(block);
  for (const [scope, user, name, score, mistakes, solved, date] of SEED) {
    await db.query(
      `insert into public.scores (scope_id, user_id, name, score, mistakes, solved, puzzle_date)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [scope, user, name, score, mistakes, solved, date],
    );
  }
});

const streak = async (user: string): Promise<number> =>
  Number((await db.query<{ s: number }>(`select public.current_streak('g1', $1) as s`, [user])).rows[0].s);

describe("current_streak", () => {
  it("counts a clean consecutive-win run", async () => {
    expect(await streak("alice")).toBe(5);
  });
  it("a mid-run loss breaks it; a later win is a fresh run of 1", async () => {
    expect(await streak("bob")).toBe(1);
  });
  it("counts up to the last played day even if today was skipped", async () => {
    expect(await streak("carol")).toBe(4);
  });
  it("is 0 when the most recent played day was a loss", async () => {
    expect(await streak("dave")).toBe(0);
  });
  it("is 0 for someone with no rows", async () => {
    expect(await streak("ghost")).toBe(0);
  });
});

type Row = {
  user_id: string;
  total: number;
  plays: number;
  wins: number;
  win_pct: number;
  avg_mistakes: number;
  streak: number;
};
const board = async (since: string | null): Promise<Row[]> =>
  (await db.query<Row>(`select * from public.room_board('g1', $1::date, 50)`, [since])).rows.map((r) => ({
    ...r,
    total: Number(r.total),
    plays: Number(r.plays),
    wins: Number(r.wins),
    win_pct: Number(r.win_pct),
    avg_mistakes: Number(r.avg_mistakes),
    streak: Number(r.streak),
  }));

describe("room_board", () => {
  it("ranks by total score, scoped to the room, with the right stats (all-time)", async () => {
    const rows = await board(null);
    expect(rows.map((r) => r.user_id)).toEqual(["alice", "bob", "carol", "dave"]); // eve (g2) excluded
    const alice = rows[0];
    expect(alice).toMatchObject({ total: 4700, plays: 5, wins: 5, win_pct: 100, streak: 5 });
    expect(alice.avg_mistakes).toBeCloseTo(0.6, 5);
    const bob = rows[1];
    expect(bob).toMatchObject({ total: 3100, plays: 5, wins: 4, win_pct: 80, streak: 1 });
    expect(bob.avg_mistakes).toBeCloseTo(1.6, 5);
    expect(rows[3]).toMatchObject({ user_id: "dave", total: 0, wins: 0, win_pct: 0, streak: 0 });
  });

  it("windows by p_since (this season since the 4th)", async () => {
    const rows = await board("2026-06-04");
    expect(rows.map((r) => r.user_id)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(rows[0]).toMatchObject({ user_id: "alice", total: 1800, plays: 2, wins: 2, win_pct: 100 });
    // bob: win + loss in-window, 50% win rate
    expect(rows[1]).toMatchObject({ user_id: "bob", total: 1000, plays: 2, wins: 1, win_pct: 50 });
  });
});

const self = async (since: string | null, user: string) => {
  const r = (await db.query<{ r: unknown }>(`select public.room_self('g1', $1::date, $2) as r`, [since, user]))
    .rows[0].r;
  return typeof r === "string" ? JSON.parse(r) : r;
};

describe("room_self", () => {
  it("returns rank + total players + the player's stats", async () => {
    const s = await self(null, "bob");
    expect(s).toMatchObject({
      rank: 2,
      total_players: 4,
      total: 3100,
      plays: 5,
      wins: 4,
      win_pct: 80,
      streak: 1,
    });
    expect(Number(s.avg_mistakes)).toBeCloseTo(1.6, 5);
  });

  it("gives a null rank (but a real player count) for someone unscored", async () => {
    const s = await self(null, "ghost");
    expect(s.rank).toBeNull();
    expect(s.total_players).toBe(4);
    expect(s).toMatchObject({ total: 0, plays: 0, wins: 0, win_pct: 0, streak: 0 });
  });
});
