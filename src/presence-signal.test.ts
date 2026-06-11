import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleRoster } from "../api/roster";
import type { CardPlayer } from "../api/_card";
import type { Puzzle } from "./game";

// Temporal behaviour of the live-roster "signal" — the /api/roster poll + heartbeat that
// REPLACED Supabase Realtime presence. The old realtime socket's failure mode was that it
// silently died when the Activity backgrounded and never recovered, so a player froze in
// everyone's roster until they restarted. These tests pin the properties that make the poll
// model immune to that, driven through the real `presence` DDL from schema.sql against real
// Postgres (PGlite), with time modelled explicitly so the TTL window is deterministic:
//   • an actively-polling player is online on every cycle (the signal updates, no flicker);
//   • a single missed 15s beat does NOT drop them (the 40s TTL spans one hiccup — consistency);
//   • a player who stops polling ages out after the TTL (the signal reflects reality);
//   • a returning player comes back online on their very next beat — no restart (the fix).

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const tableBlocks = [...schema.matchAll(/create table if not exists public\.presence[\s\S]*?\);/g)];

const SIM_DATE = "2026-06-10";
const BASE = "2026-06-10T12:00:00.000Z"; // t=0 of the simulated timeline
const BASE_MS = Date.parse(BASE);
const TTL_MS = 40_000; // ROSTER_ONLINE_TTL_MS in api/roster.ts
const at = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString();

let db: PGlite;

// A poll's heartbeat upsert, stamped at an explicit point on the timeline (last-write-wins per PK).
async function beatAt(user: string, seconds: number): Promise<void> {
  await db.query(
    `insert into public.presence (user_id, puzzle_date, last_seen)
     values ($1, $2, $3::timestamptz)
     on conflict (user_id, puzzle_date) do update set last_seen = excluded.last_seen`,
    [user, SIM_DATE, at(seconds)],
  );
}

// The online set a poll AT `seconds` would compute: heartbeats within the TTL of that instant.
// Built exactly like api/roster.ts (read last_seen → ms map, window in JS via assembleRoster's now).
async function onlineAt(seconds: number): Promise<Set<string>> {
  const rows = await db.query<{ user_id: string; last_seen: string }>(
    `select user_id, last_seen from public.presence where puzzle_date = $1`,
    [SIM_DATE],
  );
  const lastSeen = new Map<string, number>();
  for (const r of rows.rows) lastSeen.set(r.user_id, Date.parse(r.last_seen));
  const now = BASE_MS + seconds * 1000;
  const online = new Set<string>();
  for (const [id, ms] of lastSeen) if (now - ms < TTL_MS) online.add(id);
  return online;
}

beforeAll(async () => {
  db = await PGlite.create();
  expect(tableBlocks).toHaveLength(1);
  await db.exec(tableBlocks[0][0]);
});

describe("live roster signal — consistent and updating", () => {
  // One ordered timeline. Each step beats (a poll) then asserts what that instant's roster shows;
  // because only the latest beat per player is stored, every checkpoint reads true at-that-time
  // state. Cadence 15s, TTL 40s. alice/bob poll continuously; carol skips one beat; dave leaves
  // and later returns.
  it("tracks every player correctly across a sequence of 15s polls", async () => {
    // t=0 — everyone polls; everyone online.
    for (const u of ["alice", "bob", "carol", "dave"]) await beatAt(u, 0);
    expect(await onlineAt(0)).toEqual(new Set(["alice", "bob", "carol", "dave"]));

    // t=15 — alice/bob/carol poll; dave goes quiet (his last beat stays at t=0).
    for (const u of ["alice", "bob", "carol"]) await beatAt(u, 15);
    expect(await onlineAt(15)).toEqual(new Set(["alice", "bob", "carol", "dave"])); // dave 15s old → still in

    // t=30 — alice/bob poll; carol MISSES this beat (last beat t=15); dave still quiet (t=0).
    for (const u of ["alice", "bob"]) await beatAt(u, 30);
    // carol's single missed beat must NOT drop her (15s since her beat < 40s TTL) — no flicker.
    expect(await onlineAt(30)).toEqual(new Set(["alice", "bob", "carol", "dave"])); // dave 30s old → still in

    // t=45 — carol resumes; alice/bob keep polling; dave still gone (45s since t=0, past the TTL).
    for (const u of ["alice", "bob", "carol"]) await beatAt(u, 45);
    const at45 = await onlineAt(45);
    expect(at45).toEqual(new Set(["alice", "bob", "carol"])); // dave aged out past the TTL

    // t=60 — active trio still polling; dave unambiguously offline (60s since his last beat).
    for (const u of ["alice", "bob", "carol"]) await beatAt(u, 60);
    expect(await onlineAt(60)).toEqual(new Set(["alice", "bob", "carol"]));

    // t=90 — dave RETURNS and polls once. He must light back up immediately (the old realtime
    // bug left him frozen until an Activity restart; the poll recovers him on the next beat).
    // The trio's last beat was t=60 (30s ago < TTL), so they're still online too.
    await beatAt("dave", 90);
    expect(await onlineAt(90)).toEqual(new Set(["alice", "bob", "carol", "dave"]));
  });
});

// End-to-end the signal reaches the rendered roster: a DB heartbeat → assembleRoster's `online`
// flag on the player's actual roster row, tracked across time. Closes the loop from the table to
// what the Live tab paints (the green ring), exactly as the /api/roster handler wires it.
const puzzle: Puzzle = {
  id: 1,
  date: SIM_DATE,
  editor: "T",
  groups: [
    { level: 0, category: "L0", members: ["a", "b", "c", "d"] },
    { level: 1, category: "L1", members: ["e", "f", "g", "h"] },
    { level: 2, category: "L2", members: ["i", "j", "k", "l"] },
    { level: 3, category: "L3", members: ["m", "n", "o", "p"] },
  ],
  layout: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"],
};
const joined: CardPlayer[] = [{ id: "ringer", name: "Ringer", avatar: null }];
const progress = [{ user_id: "ringer", guesses: [], started_at: at(0), updated_at: at(0) }];

async function rosterRingAt(seconds: number): Promise<boolean> {
  const rows = await db.query<{ user_id: string; last_seen: string }>(
    `select user_id, last_seen from public.presence where puzzle_date = $1 and user_id = 'ringer'`,
    [SIM_DATE],
  );
  const lastSeen = new Map<string, number>();
  for (const r of rows.rows) lastSeen.set(r.user_id, Date.parse(r.last_seen));
  const out = assembleRoster(joined, [], progress, puzzle, BASE_MS + seconds * 1000, lastSeen);
  return out.find((p) => p.userId === "ringer")?.online ?? false;
}

describe("live signal → roster row (assembleRoster online flag)", () => {
  it("lights, ages out, and re-lights the green ring as the heartbeat moves", async () => {
    await beatAt("ringer", 100);
    expect(await rosterRingAt(100)).toBe(true); // fresh beat → ring on
    expect(await rosterRingAt(145)).toBe(false); // 45s later, no new beat → ring off (left)
    await beatAt("ringer", 150); // returns and polls
    expect(await rosterRingAt(150)).toBe(true); // ring back on, no restart needed
  });
});
