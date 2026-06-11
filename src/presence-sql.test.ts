import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// Runs the live-roster heartbeat against real Postgres (PGlite = Postgres in WASM): the actual
// `create table public.presence` DDL straight out of supabase/schema.sql, plus the upsert and the
// windowed "online" read that api/roster.ts performs every poll. Guards the migration SQL (a typo
// would fail to load here) and the two semantics the green ring relies on — last-write-wins per
// (user, day), and the TTL window — independent of the TS assembleRoster (covered separately).

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
// Pull the presence table block verbatim from the schema. The only `);` in it closes the table
// (default now() / the PK paren are never immediately followed by a semicolon), so non-greedy is safe.
const tableBlocks = [
  ...schema.matchAll(/create table if not exists public\.presence[\s\S]*?\);/g),
];

const TTL = "40 seconds"; // mirrors ROSTER_ONLINE_TTL_MS in api/roster.ts (40_000)
const DATE = "2026-06-07";

// The upsert api/roster.ts issues each poll: supabase .upsert() on the PK = INSERT ... ON CONFLICT.
async function beat(db: PGlite, user: string, secondsAgo: number, date = DATE): Promise<void> {
  await db.query(
    `insert into public.presence (user_id, puzzle_date, last_seen)
     values ($1, $2, now() - ($3 || ' seconds')::interval)
     on conflict (user_id, puzzle_date) do update set last_seen = excluded.last_seen`,
    [user, date, String(secondsAgo)],
  );
}

// The "who's online" read: ids whose heartbeat for the day is within the TTL.
async function online(db: PGlite, date = DATE): Promise<string[]> {
  const r = await db.query<{ user_id: string }>(
    `select user_id from public.presence
     where puzzle_date = $1 and last_seen > now() - $2::interval order by user_id`,
    [date, TTL],
  );
  return r.rows.map((x) => x.user_id);
}

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  expect(tableBlocks).toHaveLength(1); // schema.sql defines public.presence exactly once
  await db.exec(tableBlocks[0][0]);
});

describe("presence heartbeat (schema.sql)", () => {
  it("marks a fresh heartbeat online and a stale one offline", async () => {
    await beat(db, "fresh", 3); // 3s ago → within the 40s TTL
    await beat(db, "stale", 60); // 60s ago → aged out
    expect(await online(db)).toEqual(["fresh"]);
  });

  it("upsert is last-write-wins per (user, day): no duplicate row, latest beat revives online", async () => {
    await beat(db, "u", 60); // stale first
    expect(await online(db)).not.toContain("u");
    await beat(db, "u", 1); // re-poll → updates the same row
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from public.presence where user_id = 'u' and puzzle_date = $1`,
      [DATE],
    );
    expect(rows.rows[0].n).toBe(1); // updated in place, not duplicated (PK held)
    expect(await online(db)).toContain("u");
  });

  it("keys by (user, day): the same user on a different day is a separate row", async () => {
    await beat(db, "twoday", 1, "2026-06-07");
    await beat(db, "twoday", 1, "2026-06-08");
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from public.presence where user_id = 'twoday'`,
    );
    expect(rows.rows[0].n).toBe(2);
    // The window is scoped to the day, so a beat on another day doesn't leak into today's roster.
    expect(await online(db, "2026-06-07")).toContain("twoday");
    expect(await online(db, "2026-06-08")).toContain("twoday");
  });
});
