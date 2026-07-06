import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// The room_auth DDL (supabase/schema.sql) against real Postgres (PGlite), pinning the shape
// finish-time scoring leans on: one verified room per player per day, and a later join
// REPLACING the earlier one (last join wins — you score where you most recently opened the
// Activity, matching the client-posted /api/score semantics it supersedes).

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const tableBlock = schema.match(/create table if not exists public\.room_auth[\s\S]*?\n\);/)?.[0];

let db: PGlite;

// The same write shape as api/_scoring.ts stampRoomAuth (supabase-js upsert → ON CONFLICT DO UPDATE).
const stamp = (user: string, date: string, scope: string, channel: string | null): Promise<unknown> =>
  db.query(
    `insert into public.room_auth (user_id, puzzle_date, scope_id, channel_id, name, avatar)
     values ($1, $2, $3, $4, 'Player', null)
     on conflict (user_id, puzzle_date) do update
       set scope_id = excluded.scope_id, channel_id = excluded.channel_id,
           name = excluded.name, avatar = excluded.avatar, verified_at = now()`,
    [user, date, scope, channel],
  );

beforeAll(async () => {
  db = await PGlite.create();
  expect(tableBlock).toBeTruthy();
  await db.exec(tableBlock!);
});

describe("room_auth schema (schema.sql)", () => {
  it("keeps one room per player per day, last join wins", async () => {
    await stamp("u1", "2026-07-05", "g:serverA", "chanA");
    await stamp("u1", "2026-07-05", "c:groupB", "chanB"); // relaunched in a group DM
    await stamp("u2", "2026-07-05", "g:serverA", "chanA"); // another player, untouched

    const rows = await db.query<{ user_id: string; scope_id: string; channel_id: string }>(
      `select user_id, scope_id, channel_id from public.room_auth order by user_id`,
    );
    expect(rows.rows).toEqual([
      { user_id: "u1", scope_id: "c:groupB", channel_id: "chanB" },
      { user_id: "u2", scope_id: "g:serverA", channel_id: "chanA" },
    ]);
  });

  it("keeps days independent (yesterday's room can't claim today's finish)", async () => {
    await stamp("u3", "2026-07-04", "g:serverA", "chanA");
    await stamp("u3", "2026-07-05", "g:serverB", "chanB");
    const rows = await db.query<{ puzzle_date: string; scope_id: string }>(
      `select puzzle_date::text, scope_id from public.room_auth where user_id = 'u3' order by puzzle_date`,
    );
    expect(rows.rows).toEqual([
      { puzzle_date: "2026-07-04", scope_id: "g:serverA" },
      { puzzle_date: "2026-07-05", scope_id: "g:serverB" },
    ]);
  });
});
