import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// Runs the leaderboard functions from supabase/schema.sql against real Postgres
// (PGlite = Postgres in WASM). Extracts the three `create function` blocks
// (skipping Supabase-only grants/policies) against a minimal `scores` table.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlocks = [
  ...schema.matchAll(
    /create or replace function public\.(?:current_streak|user_streak|room_board|room_self|day_results|room_recap_stats)[\s\S]*?\$\$;/g,
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
  // g3: a room whose 06-02 was a no-solve day (breaks the room streak) — exercises the
  // room-level recap stats (every g1 day has a solver, so g1 alone can't test a break).
  ["g3", "frank", "Frank", 500, 1, true, "2026-06-01"],
  ["g3", "frank", "Frank", 100, 4, false, "2026-06-02"],
  ["g3", "frank", "Frank", 500, 1, true, "2026-06-03"],
  ["g3", "frank", "Frank", 500, 1, true, "2026-06-04"],
  ["g3", "frank", "Frank", 500, 1, true, "2026-06-05"],
];

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table public.scores (
      id bigint generated always as identity primary key,
      scope_id text, channel_id text, user_id text not null, name text not null, avatar text,
      score int not null default 0, mistakes int not null default 0,
      solved boolean not null default false, groups_solved smallint not null default 0,
      duration_ms int, puzzle_date date, created_at timestamptz not null default now()
    );
  `);
  expect(fnBlocks).toHaveLength(6); // current_streak, user_streak, room_board, room_self, day_results, room_recap_stats
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

type DayRow = { user_id: string; score: number; mistakes: number; solved: boolean };
const dayResults = async (scope: string, date: string): Promise<DayRow[]> =>
  (await db.query<DayRow>(`select * from public.day_results($1, $2::date)`, [scope, date])).rows.map((r) => ({
    ...r,
    score: Number(r.score),
    mistakes: Number(r.mistakes),
  }));

describe("day_results", () => {
  it("returns one room's finishers for a single day, scoped and ranked", async () => {
    // 2026-06-05 in g1: alice 1000/win, bob 900/win, dave 0/loss. carol didn't play
    // that day; eve is in g2. Order: solved first, then by score.
    const rows = await dayResults("g1", "2026-06-05");
    expect(rows.map((r) => r.user_id)).toEqual(["alice", "bob", "dave"]);
    expect(rows[0]).toMatchObject({ user_id: "alice", score: 1000, mistakes: 0, solved: true });
    expect(rows[2]).toMatchObject({ user_id: "dave", score: 0, solved: false });
  });

  it("is empty for a day nobody played", async () => {
    expect(await dayResults("g1", "2025-01-01")).toEqual([]);
  });
});

const recapStats = async (
  scope: string,
  since: string | null,
  date: string | null,
): Promise<{ streak: number; win_pct: number; max_streak: number }> => {
  const r = (
    await db.query<{ streak: number; win_pct: number; max_streak: number }>(
      `select * from public.room_recap_stats($1, $2::date, $3::date)`,
      [scope, since, date],
    )
  ).rows[0];
  return { streak: Number(r.streak), win_pct: Number(r.win_pct), max_streak: Number(r.max_streak) };
};

describe("room_recap_stats", () => {
  it("counts the room streak (any solver = a room solve-day) and all-time win rate", async () => {
    // g3: 06-01 solved, 06-02 a no-solve day, 06-03..05 solved. As of 06-05 the streak
    // runs back to the 06-02 break (3 days); 4 of 5 played days had a solver (80%). The
    // longest island is that same 03–05 run (3), beating the lone 06-01 day.
    expect(await recapStats("g3", null, "2026-06-05")).toEqual({ streak: 3, win_pct: 80, max_streak: 3 });
  });

  it("windows the win rate by p_since but lets both streaks cross it", async () => {
    // since the 3rd: days 03–05 all solved → 100%, current + longest streak still 3
    // (max_streak ignores p_since, spanning all history up to p_date).
    expect(await recapStats("g3", "2026-06-03", "2026-06-05")).toEqual({ streak: 3, win_pct: 100, max_streak: 3 });
  });

  it("is a 0 streak when the room's most recent played day had no solver", async () => {
    // as of the 06-02 no-solve day: current streak broken (0), 1 of 2 days solved (50%),
    // longest-ever is the single 06-01 solve (1).
    expect(await recapStats("g3", null, "2026-06-02")).toEqual({ streak: 0, win_pct: 50, max_streak: 1 });
  });

  it("treats a day with any solver as solved (g1: every day has one) and is scope-isolated", async () => {
    // g1 06-04 has a loss (bob) but alice/carol solved, and 06-05 has a loss (dave) but
    // alice/bob solved — so all five days are room solve-days: streak 5, longest 5, 100%.
    expect(await recapStats("g1", null, "2026-06-05")).toEqual({ streak: 5, win_pct: 100, max_streak: 5 });
  });

  it("is a 0 streak / 0 rate / 0 longest for a room with no rows", async () => {
    expect(await recapStats("g404", null, "2026-06-05")).toEqual({ streak: 0, win_pct: 0, max_streak: 0 });
  });
});

// The p_channel param (null = whole server, a channel id = that channel only). Same scope
// "gc", two channels: chA (anna) and chB (bret). Server view sees both; channel views isolate.
describe("p_channel scoping", () => {
  beforeAll(async () => {
    const rows: [string, string, string, string, number, boolean, string][] = [
      // scope, channel, user, name, score, solved, date
      ["gc", "chA", "anna", "Anna", 500, true, "2026-06-01"],
      ["gc", "chA", "anna", "Anna", 500, true, "2026-06-02"],
      ["gc", "chB", "bret", "Bret", 800, true, "2026-06-01"],
    ];
    for (const [scope, channel, user, name, score, solved, date] of rows) {
      await db.query(
        `insert into public.scores (scope_id, channel_id, user_id, name, score, solved, puzzle_date)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [scope, channel, user, name, score, solved, date],
      );
    }
  });

  const boardCh = async (channel: string | null) =>
    (
      await db.query<{ user_id: string }>(`select user_id from public.room_board('gc', null, 50, $1)`, [channel])
    ).rows.map((r) => r.user_id);

  it("server view (p_channel null) sees every channel, ranked", async () => {
    // anna totals 1000 (500+500) across two chA days; bret 800 in chB → anna ranks first.
    expect(await boardCh(null)).toEqual(["anna", "bret"]);
  });

  it("channel view isolates to one channel", async () => {
    expect(await boardCh("chA")).toEqual(["anna"]);
    expect(await boardCh("chB")).toEqual(["bret"]);
  });

  it("current_streak is channel-scoped", async () => {
    const s = async (channel: string | null) =>
      Number((await db.query<{ s: number }>(`select public.current_streak('gc','anna',$1) as s`, [channel])).rows[0].s);
    expect(await s(null)).toBe(2); // both anna days (chA)
    expect(await s("chA")).toBe(2);
    expect(await s("chB")).toBe(0); // anna never played chB
  });

  it("day_results and room_self honor the channel", async () => {
    const day = await db.query<{ user_id: string }>(
      `select user_id from public.day_results('gc','2026-06-01'::date,$1)`,
      ["chB"],
    );
    expect(day.rows.map((r) => r.user_id)).toEqual(["bret"]);
    const selfRaw = (
      await db.query<{ r: unknown }>(`select public.room_self('gc', null, 'anna', $1) as r`, ["chA"])
    ).rows[0].r;
    const self = typeof selfRaw === "string" ? JSON.parse(selfRaw) : selfRaw;
    expect(self).toMatchObject({ rank: 1, total_players: 1, total: 1000, plays: 2 });
  });
});

// Server view of a real guild scope (g:<id>) is play-gated: it lists ONLY players who have
// finished a puzzle in that server (membership derived from scores.scope_id), but ranks
// them by their GLOBAL total — so a listed player's score follows them across every server,
// while no one is pre-populated onto a server they never played in. Channel views and
// non-g: scopes stay scope-bound (covered above).
describe("membership (g: server view)", () => {
  beforeAll(async () => {
    // zoe played in BOTH servers (g:111 twice, g:222 once); max only in g:111. Three
    // straight solves for zoe across the two servers (06-03 in 222, 06-04/05 in 111).
    const rows: [string, string, string, number, boolean, string][] = [
      ["g:111", "zoe", "Zoe", 1000, true, "2026-06-04"],
      ["g:111", "zoe", "Zoe", 900, true, "2026-06-05"],
      ["g:222", "zoe", "Zoe", 500, true, "2026-06-03"],
      ["g:111", "max", "Max", 700, true, "2026-06-05"],
    ];
    for (const [scope, user, name, score, solved, date] of rows) {
      await db.query(
        `insert into public.scores (scope_id, user_id, name, score, solved, puzzle_date)
         values ($1,$2,$3,$4,$5,$6)`,
        [scope, user, name, score, solved, date],
      );
    }
  });

  const members = async (scope: string): Promise<string[]> =>
    (await db.query<{ user_id: string }>(`select user_id from public.room_board($1, null, 50)`, [scope])).rows.map(
      (r) => r.user_id,
    );

  it("lists only players who have actually finished a puzzle in that server", async () => {
    // server 222: only zoe ever played there → only zoe. max has a score (in g:111) but
    // never played in 222, so he is NOT pre-populated onto its board.
    expect(await members("g:222")).toEqual(["zoe"]);
    // a server nobody has played in has an empty board.
    expect(await members("g:999")).toEqual([]);
  });

  it("ranks everyone who played there by their GLOBAL cross-server total", async () => {
    // both played in 111; zoe's total spans both servers (1000+900+500=2400) > max (700).
    expect(await members("g:111")).toEqual(["zoe", "max"]);
  });

  it("a listed player's total still counts scores earned in other servers", async () => {
    // zoe makes 222's board off a single 222 play, but her shown total is her global 2400.
    const raw = (await db.query<{ r: unknown }>(`select public.room_self('g:222', null, 'zoe') as r`)).rows[0].r;
    const self = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(self).toMatchObject({ rank: 1, total_players: 1, total: 2400, plays: 3, streak: 3 });
  });

  it("uses the player's personal (scope-agnostic) streak on the server board", async () => {
    const { rows } = await db.query<{ user_id: string; streak: number }>(
      `select user_id, streak from public.room_board('g:222', null, 50)`,
    );
    expect(Number(rows.find((r) => r.user_id === "zoe")!.streak)).toBe(3); // 06-03 + 06-04 + 06-05
  });

  it("user_streak counts a player's solves across all rooms", async () => {
    const s = Number((await db.query<{ s: number }>(`select public.user_streak('zoe') as s`)).rows[0].s);
    expect(s).toBe(3);
  });
});
