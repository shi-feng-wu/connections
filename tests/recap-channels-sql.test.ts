import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// recap_channels() is the daily-recap target set: every (guild, channel) in live_cards that has
// actually posted a card (message_id not null), MINUS channels a moderator silenced with
// /unsubscribe (a recap_optouts row). Runs the real function from supabase/schema.sql against
// Postgres-in-WASM (PGlite) over minimal live_cards + recap_optouts tables.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlock = schema.match(
  /create or replace function public\.recap_channels[\s\S]*?\$\$;/,
)?.[0];

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  // Minimal shape of the two tables recap_channels reads (live_cards) and subtracts (recap_optouts).
  await db.exec(`
    create table public.live_cards (
      scope_id   text not null,
      puzzle_date date not null,
      channel_id text not null,
      message_id text,
      primary key (scope_id, puzzle_date, channel_id)
    );
    create table public.recap_optouts (
      scope_id   text not null,
      channel_id text not null,
      opted_out_by text,
      opted_out_at timestamptz not null default now(),
      primary key (scope_id, channel_id)
    );
  `);
  expect(fnBlock).toBeTruthy();
  await db.exec(fnBlock as string);

  // g:1/chA posted a card on two days (must dedupe to one row); g:1/chB posted once; g:2/chC has
  // only a roster row with no card (null message_id → never a recap target); c:9 is a non-guild
  // scope (never a recap target).
  await db.exec(`
    insert into public.live_cards (scope_id, puzzle_date, channel_id, message_id) values
      ('g:1', '2026-06-23', 'chA', 'm1'),
      ('g:1', '2026-06-24', 'chA', 'm2'),
      ('g:1', '2026-06-24', 'chB', 'm3'),
      ('g:2', '2026-06-24', 'chC', null),
      ('c:9', '2026-06-24', 'chD', 'm4');
  `);
});

const channels = async (): Promise<string[]> =>
  (
    await db.query<{ scope_id: string; channel_id: string }>(
      `select * from public.recap_channels() order by scope_id, channel_id`,
    )
  ).rows.map((r) => `${r.scope_id}/${r.channel_id}`);

describe("recap_channels", () => {
  it("lists each guild channel that posted a card (deduped), skipping null message_id and c: scopes", async () => {
    expect(await channels()).toEqual(["g:1/chA", "g:1/chB"]); // chC has no card; chD is non-guild
  });

  it("drops a channel once it has a recap_optouts row (/unsubscribe), and re-lists it when cleared", async () => {
    await db.exec(`insert into public.recap_optouts (scope_id, channel_id) values ('g:1', 'chA')`);
    expect(await channels()).toEqual(["g:1/chB"]); // chA silenced — cron skips it

    // A later launch in chA clears the opt-out (postCard) → it's a recap target again.
    await db.exec(`delete from public.recap_optouts where scope_id = 'g:1' and channel_id = 'chA'`);
    expect(await channels()).toEqual(["g:1/chA", "g:1/chB"]);
  });
});
