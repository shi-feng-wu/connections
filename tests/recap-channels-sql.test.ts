import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// recap_channels() is the daily-recap target set: every (guild, channel) in live_cards that has
// actually posted a card (message_id not null), MINUS channels a moderator turned off with
// /disable-posts (a post_optouts row). Runs the real function from supabase/schema.sql against
// Postgres-in-WASM (PGlite) over minimal live_cards + post_optouts tables.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlock = schema.match(
  /create or replace function public\.recap_channels[\s\S]*?\$\$;/,
)?.[0];

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  // Minimal shape of the two tables recap_channels reads (live_cards) and subtracts (post_optouts).
  await db.exec(`
    create table public.live_cards (
      scope_id   text not null,
      puzzle_date date not null,
      channel_id text not null,
      message_id text,
      interaction_token text,
      bot_can_post boolean,
      primary key (scope_id, puzzle_date, channel_id)
    );
    create table public.post_optouts (
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
  // scope (never a recap target); g:3/chE is a BOT-LESS server card (token-backed: interaction_token
  // not null → the recap is bot-only, so it's excluded even though it has a message_id).
  await db.exec(`
    insert into public.live_cards (scope_id, puzzle_date, channel_id, message_id, interaction_token) values
      ('g:1', '2026-06-23', 'chA', 'm1', null),
      ('g:1', '2026-06-24', 'chA', 'm2', null),
      ('g:1', '2026-06-24', 'chB', 'm3', null),
      ('g:2', '2026-06-24', 'chC', null, null),
      ('g:3', '2026-06-24', 'chE', 'm5', 'tok-abc'),
      ('c:9', '2026-06-24', 'chD', 'm4', null);
  `);
});

const channels = async (): Promise<string[]> =>
  (
    await db.query<{ scope_id: string; channel_id: string }>(
      `select * from public.recap_channels() order by scope_id, channel_id`,
    )
  ).rows.map((r) => `${r.scope_id}/${r.channel_id}`);

describe("recap_channels", () => {
  it("lists each guild channel the bot posted a card in (deduped), skipping null message_id, c: scopes, and bot-less cards", async () => {
    // chC has no card; chD is non-guild; chE is a bot-less (token-backed) card → no recap.
    expect(await channels()).toEqual(["g:1/chA", "g:1/chB"]);
  });

  it("drops a channel once it has a post_optouts row (/disable-posts), and re-lists it when cleared", async () => {
    await db.exec(`insert into public.post_optouts (scope_id, channel_id) values ('g:1', 'chA')`);
    expect(await channels()).toEqual(["g:1/chB"]); // chA turned off — cron skips it

    // /enable-posts in chA clears the opt-out (a launch no longer does — it's sticky) → recap target again.
    await db.exec(`delete from public.post_optouts where scope_id = 'g:1' and channel_id = 'chA'`);
    expect(await channels()).toEqual(["g:1/chA", "g:1/chB"]);
  });

  it("excludes a channel the bot can't post in (bot_can_post = false); NULL/true stay in", async () => {
    // NULL bot_can_post (the seed rows) is fail-open — both channels list. Marking chB not-postable
    // (a command launch made it a target via the webhook, but the bot can't post its own recap there)
    // drops it; an explicit true keeps chA.
    await db.exec(`update public.live_cards set bot_can_post = false where scope_id = 'g:1' and channel_id = 'chB'`);
    await db.exec(`update public.live_cards set bot_can_post = true  where scope_id = 'g:1' and channel_id = 'chA'`);
    expect(await channels()).toEqual(["g:1/chA"]); // chB excluded, chA kept

    await db.exec(`update public.live_cards set bot_can_post = null`); // restore fail-open seed state
    expect(await channels()).toEqual(["g:1/chA", "g:1/chB"]);
  });
});
