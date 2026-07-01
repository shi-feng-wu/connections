import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// Runs roster_bundle (supabase/schema.sql) against real Postgres (PGlite = Postgres in
// WASM): the single round-trip /api/roster makes per poll. Guards the SQL itself (a typo
// fails to load here) and the semantics the handler relies on: member identity is deduped
// to each user's MOST RECENT score row (the old per-poll fetch of every historical row,
// fixed), the id set is members ∪ card openers, today's scores follow a member in from ANY
// scope, channel narrowing, and the caller's heartbeat landing in the same trip.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlocks = [...schema.matchAll(/create or replace function public\.roster_bundle[\s\S]*?\$\$;/g)].map(
  (m) => m[0],
);
// The real DDL for the tables the function reads, verbatim from the schema. The closing
// `);` is anchored to a line start: live_cards has a column comment containing a mid-line
// `);` ("edited in place); null until…"), so the bare non-greedy match presence-sql.test.ts
// uses would truncate that block.
const tableBlocks = [
  ...schema.matchAll(/create table if not exists public\.(?:live_cards|progress|presence)[\s\S]*?\n\);/g),
].map((m) => m[0]);

const DATE = "2026-06-07";
const bundle = async (
  scope: string,
  channel: string | null = null,
  uid: string | null = null,
): Promise<{
  members: { id: string; name: string; avatar: string | null }[];
  card_players: { id: string; name: string }[];
  scores: { user_id: string }[];
  progress: { user_id: string; guesses: unknown }[];
  seen: { user_id: string; last_seen: string }[];
}> => {
  const r = (
    await db.query<{ b: unknown }>(`select public.roster_bundle($1, $2::date, $3, $4) as b`, [
      scope,
      DATE,
      channel,
      uid,
    ])
  ).rows[0].b;
  return typeof r === "string" ? JSON.parse(r) : (r as never);
};

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  // Minimal scores table (the schema's base create predates scope_id/channel_id/groups_solved,
  // which arrive via alters) — hand-built like sql.test.ts, with created_at controllable.
  await db.exec(`
    create table public.scores (
      id bigint generated always as identity primary key,
      scope_id text, channel_id text, user_id text not null, name text not null, avatar text,
      score int not null default 0, mistakes int not null default 0,
      hints_used smallint not null default 0,
      solved boolean not null default false, groups_solved smallint not null default 0,
      duration_ms int, puzzle_date date, created_at timestamptz not null default now()
    );
  `);
  expect(tableBlocks).toHaveLength(3); // live_cards, progress, presence
  for (const block of tableBlocks) await db.exec(block);
  // The schema's do-block widens the live_cards PK to include channel_id (per-channel cards);
  // replay that outcome so two channels can hold cards on the same day, as in prod.
  await db.exec(`
    alter table public.live_cards drop constraint live_cards_pkey;
    alter table public.live_cards add constraint live_cards_pkey primary key (scope_id, puzzle_date, channel_id);
  `);
  expect(fnBlocks).toHaveLength(1);
  await db.exec(fnBlocks[0]);

  const score = (
    scope: string,
    channel: string,
    user: string,
    name: string,
    date: string,
    createdDaysAgo: number,
  ): Promise<unknown> =>
    db.query(
      `insert into public.scores (scope_id, channel_id, user_id, name, avatar, solved, puzzle_date, created_at)
       values ($1,$2,$3,$4,$5,true,$6, now() - ($7 || ' days')::interval)`,
      [scope, channel, user, name, `${user}.png`, date, String(createdDaysAgo)],
    );
  // alice: an old row under a stale name, plus today's — members must carry ONLY the latest.
  await score("g:1", "ch1", "alice", "Alice Old", "2026-06-01", 6);
  await score("g:1", "ch1", "alice", "Alice", DATE, 0);
  // bob: member via ch2 only (channel narrowing drops him from the ch1 view); didn't play today.
  await score("g:1", "ch2", "bob", "Bob", "2026-06-05", 2);
  // dave: member of g:1, but today's game was launched in g:2 — it must follow him in here.
  await score("g:1", "ch1", "dave", "Dave", "2026-06-03", 4);
  await score("g:2", "ch9", "dave", "Dave", DATE, 0);
  // eve: another room entirely; must never leak into g:1.
  await score("g:9", "ch9", "eve", "Eve", DATE, 0);

  // carol opened today's card in ch1 but has no score ever (first-timer, mid-game).
  await db.query(
    `insert into public.live_cards (scope_id, puzzle_date, channel_id, players) values ($1,$2,$3,$4)`,
    ["g:1", DATE, "ch1", JSON.stringify([{ id: "carol", name: "Carol", avatar: null }])],
  );
  // A different day's card in the same room: its players must not bleed into today.
  await db.query(
    `insert into public.live_cards (scope_id, puzzle_date, channel_id, players) values ($1,$2,$3,$4)`,
    ["g:1", "2026-06-06", "ch1", JSON.stringify([{ id: "yesterday", name: "Yesterday", avatar: null }])],
  );

  // carol's committed progress today; alice's stale row from another day (date-filtered out).
  await db.query(`insert into public.progress (user_id, puzzle_date, guesses) values ('carol', $1, $2)`, [
    DATE,
    JSON.stringify([["A", "B", "C", "D"]]),
  ]);
  await db.query(`insert into public.progress (user_id, puzzle_date) values ('alice', '2026-06-01')`);

  // Heartbeats: alice fresh, zach is not in the id set (no score, no card) so he must be dropped.
  await db.query(
    `insert into public.presence (user_id, puzzle_date, last_seen) values ('alice', $1, now() - interval '3 seconds')`,
    [DATE],
  );
  await db.query(`insert into public.presence (user_id, puzzle_date, last_seen) values ('zach', $1, now())`, [
    DATE,
  ]);
});

describe("roster_bundle (schema.sql)", () => {
  it("dedupes members to one row each, carrying the most recent identity", async () => {
    const b = await bundle("g:1");
    const alice = b.members.filter((m) => m.id === "alice");
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({ name: "Alice", avatar: "alice.png" });
    expect(b.members.map((m) => m.id).sort()).toEqual(["alice", "bob", "dave"]); // eve (g:9) excluded
  });

  it("unions card openers into the set and scopes cards to the day", async () => {
    const b = await bundle("g:1");
    expect(b.card_players.map((p) => p.id)).toEqual(["carol"]); // yesterday's card dropped
    expect(b.progress.map((p) => p.user_id)).toEqual(["carol"]); // her id made the set; alice's old row date-filtered
  });

  it("pulls today's scores for members from ANY scope, and only today's", async () => {
    const b = await bundle("g:1");
    expect(b.scores.map((s) => s.user_id).sort()).toEqual(["alice", "dave"]); // dave's g:2 game follows him in
  });

  it("narrows members and cards to a channel when asked", async () => {
    const b = await bundle("g:1", "ch1");
    expect(b.members.map((m) => m.id).sort()).toEqual(["alice", "dave"]); // bob is ch2-only
    expect(b.card_players.map((p) => p.id)).toEqual(["carol"]);
    const b2 = await bundle("g:1", "ch2");
    expect(b2.members.map((m) => m.id)).toEqual(["bob"]);
    expect(b2.card_players).toEqual([]);
  });

  it("returns heartbeats only for the id set", async () => {
    const b = await bundle("g:1");
    expect(b.seen.map((s) => s.user_id)).toEqual(["alice"]); // zach (not in set) dropped
    expect(Date.parse(b.seen[0].last_seen)).not.toBeNaN();
  });

  it("stamps the caller's heartbeat in the same trip, last-write-wins", async () => {
    await bundle("g:1", null, "dave");
    await bundle("g:1", null, "dave");
    const rows = await db.query<{ n: number; fresh: boolean }>(
      `select count(*)::int as n, bool_and(last_seen > now() - interval '5 seconds') as fresh
       from public.presence where user_id = 'dave' and puzzle_date = $1`,
      [DATE],
    );
    expect(rows.rows[0]).toEqual({ n: 1, fresh: true }); // upserted in place, not duplicated
    // and now dave's beat is visible in the bundle's seen set
    const b = await bundle("g:1");
    expect(b.seen.map((s) => s.user_id).sort()).toEqual(["alice", "dave"]);
  });

  it("returns empty arrays (not nulls) for a room with no history", async () => {
    const b = await bundle("g:none");
    expect(b).toEqual({ members: [], card_players: [], scores: [], progress: [], seen: [] });
  });
});
