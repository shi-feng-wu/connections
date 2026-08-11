import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// recap_pending() DORMANCY: a 'failed' ledger row is terminal for its DATE only, so a channel the
// bot was kicked from (or whose channel is gone) used to be re-rendered and re-POSTed every single
// night. It now drops out of the queue once its last 3 terminal outcomes are all 'failed' AND no
// bot-backed launch has happened since the last failure — a fresh launch is the revival signal.
// Runs the real recap_channels() + recap_pending() from supabase/schema.sql against Postgres-in-WASM
// (PGlite) over minimal live_cards / post_optouts / recap_posts tables.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const fnBlocks = ["recap_channels", "recap_pending"].map(
  (name) => schema.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\$\\$;`))?.[0],
);

// The date the nightly run is recapping. Every fixture's history sits before it.
const DATE = "2026-07-10";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  // Minimal shape of what the two functions read: live_cards (the recap target set), post_optouts
  // (subtracted by recap_channels), recap_posts (the outcome ledger dormancy is derived from). No
  // recap_posts_served_idx here — it's a planner concern, not a correctness one.
  await db.exec(`
    create table public.live_cards (
      scope_id    text not null,
      puzzle_date date not null,
      channel_id  text not null,
      message_id  text,
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
    create table public.recap_posts (
      scope_id    text not null,
      puzzle_date date not null,
      channel_id  text not null,
      status      text,
      attempted_at timestamptz,
      primary key (scope_id, puzzle_date, channel_id)
    );
  `);
  // `language sql` bodies are parsed at CREATE time, so recap_channels() must exist first.
  for (const block of fnBlocks) expect(block).toBeTruthy();
  for (const block of fnBlocks) await db.exec(block as string);
});

beforeEach(async () => {
  await db.exec(`truncate public.live_cards, public.post_optouts, public.recap_posts`);
});

type CardOpts = {
  message_id?: string | null;
  interaction_token?: string | null;
  bot_can_post?: boolean | null;
};

// A launch record. Defaults to a BOT-BACKED card (message_id set, no interaction token) — which is
// both what makes a (scope, channel) a recap target at all and what counts as a revival. Every
// dormancy fixture needs one dated at/before its failures, or the channel isn't in recap_channels()
// and the test would pass for the wrong reason.
const card = (scope: string, channel: string, date: string, o: CardOpts = {}) =>
  db.query(
    `insert into public.live_cards (scope_id, puzzle_date, channel_id, message_id, interaction_token, bot_can_post)
     values ($1, $2, $3, $4, $5, $6)`,
    [scope, date, channel, o.message_id ?? "m", o.interaction_token ?? null, o.bot_can_post ?? null],
  );

// Ledger history for a channel: [puzzle_date, status] pairs, oldest first by convention.
const ledger = async (scope: string, channel: string, rows: [string, string][]) => {
  for (const [date, status] of rows) {
    await db.query(
      `insert into public.recap_posts (scope_id, puzzle_date, channel_id, status, attempted_at)
       values ($1, $2, $3, $4, now())`,
      [scope, date, channel, status],
    );
  }
};

const pending = async (date = DATE): Promise<string[]> =>
  (
    await db.query<{ scope_id: string; channel_id: string }>(
      `select scope_id, channel_id from public.recap_pending($1::date, 100)`,
      [date],
    )
  ).rows
    .map((r) => `${r.scope_id}/${r.channel_id}`)
    .sort();

const channels = async (): Promise<string[]> =>
  (
    await db.query<{ scope_id: string; channel_id: string }>(
      `select scope_id, channel_id from public.recap_channels() order by scope_id, channel_id`,
    )
  ).rows.map((r) => `${r.scope_id}/${r.channel_id}`);

// A healthy control channel present in every test: a card, no failures. Nothing about dormancy may
// touch it.
const healthy = () => card("g:ok", "chOk", "2026-07-01");

describe("recap_pending dormancy", () => {
  it("goes dormant on the 3rd consecutive failed night, not the 2nd", async () => {
    await healthy();
    await card("g:1", "chA", "2026-07-01"); // the launch that made it a recap target
    await ledger("g:1", "chA", [
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
    ]);
    // Two failures is still a blip — the channel keeps getting tried.
    expect(await pending()).toEqual(["g:1/chA", "g:ok/chOk"]);

    await ledger("g:1", "chA", [["2026-07-09", "failed"]]);
    expect(await pending()).toEqual(["g:ok/chOk"]); // 3 in a row → dormant

    // The exclusion is dormancy, not target membership: chA is still a recap_channels() target.
    expect(await channels()).toEqual(["g:1/chA", "g:ok/chOk"]);
  });

  it("looks at the LAST 3 only: a 'posted' inside the window revives nothing, outside it doesn't save you", async () => {
    await healthy();
    // A 'posted' inside the last 3 → not 3 consecutive failures → still queued.
    await card("g:2", "chB", "2026-07-01");
    await ledger("g:2", "chB", [
      ["2026-07-06", "failed"],
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "posted"],
    ]);
    expect(await pending()).toContain("g:2/chB");

    // A 'posted' OLDER than the last 3 failures doesn't matter — the run of 3 is what counts.
    await card("g:3", "chC", "2026-07-01");
    await ledger("g:3", "chC", [
      ["2026-07-04", "failed"],
      ["2026-07-05", "failed"],
      ["2026-07-06", "posted"],
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);
    expect(await pending()).toEqual(["g:2/chB", "g:ok/chOk"]); // chC dormant, chB kept
  });

  it("is revived by a bot-backed launch after the last failure (bot_can_post null or true)", async () => {
    await healthy();
    // g:4 will be revived by a bot_can_post = NULL (unknown) card, g:5 by an explicit true one.
    for (const scope of ["g:4", "g:5"]) {
      await card(scope, "chD", "2026-07-01");
      await ledger(scope, "chD", [
        ["2026-07-07", "failed"],
        ["2026-07-08", "failed"],
        ["2026-07-09", "failed"],
      ]);
    }
    expect(await pending()).toEqual(["g:ok/chOk"]); // both dormant to start

    // Somebody played there again, and the bot posted the card: "play there again if you want
    // recaps there" — the channel comes straight back into the queue.
    await card("g:4", "chD", "2026-07-10");
    await card("g:5", "chD", "2026-07-10", { bot_can_post: true });
    expect(await pending()).toEqual(["g:4/chD", "g:5/chD", "g:ok/chOk"]);
  });

  it("needs the reviving launch to be strictly AFTER the last failure, not the same day", async () => {
    await healthy();
    await card("g:13", "chJ", "2026-07-01");
    await ledger("g:13", "chJ", [
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);
    // A card dated the same day as the last failure was posted BEFORE that night's recap ran (the
    // recap for 07-09 goes out on the 10th), so it's the launch that failure already knew about —
    // not evidence the bot came back.
    await card("g:13", "chJ", "2026-07-09");
    expect(await pending()).toEqual(["g:ok/chOk"]);
  });

  it("is NOT revived by a token-backed launch (the bot is absent — that's the whole point)", async () => {
    await healthy();
    await card("g:6", "chE", "2026-07-01");
    await ledger("g:6", "chE", [
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);
    // A bot-less launch: the card went out on the launcher's interaction token, which needs no bot
    // channel perms and so proves nothing about the bot being back.
    await card("g:6", "chE", "2026-07-10", { interaction_token: "tok-abc" });
    expect(await pending()).toEqual(["g:ok/chOk"]);
  });

  it("is NOT revived by a launch the bot explicitly can't post in (bot_can_post = false)", async () => {
    await healthy();
    await card("g:7", "chF", "2026-07-01"); // bot_can_post null → still a recap_channels() target
    await ledger("g:7", "chF", [
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);
    await card("g:7", "chF", "2026-07-10", { bot_can_post: false });

    // recap_channels() filters per ROW, so the old null row keeps chF a target — proving the
    // exclusion below is the revival probe rejecting the new row, not target membership.
    expect(await channels()).toEqual(["g:7/chF", "g:ok/chOk"]);
    expect(await pending()).toEqual(["g:ok/chOk"]);
  });

  it("ignores 'claimed' rows when counting the last 3 outcomes", async () => {
    await healthy();
    // A killed run left a 'claimed' row mid-history. It's in flight, not an outcome: the window
    // skips past it to the 3rd real failure → dormant.
    await card("g:8", "chG", "2026-07-01");
    await ledger("g:8", "chG", [
      ["2026-07-06", "failed"],
      ["2026-07-07", "failed"],
      ["2026-07-08", "claimed"],
      ["2026-07-09", "failed"],
    ]);

    // …and it can't be counted AS a failure either: two real failures plus a claim is a window of
    // 2, which is not dormant.
    await card("g:9", "chH", "2026-07-01");
    await ledger("g:9", "chH", [
      ["2026-07-07", "claimed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);

    expect(await pending()).toEqual(["g:9/chH", "g:ok/chOk"]); // chG dormant, chH kept
  });

  it("leaves healthy neighbours alone (no collateral exclusion)", async () => {
    await healthy();
    await card("g:10", "chDead", "2026-07-01");
    await ledger("g:10", "chDead", [
      ["2026-07-07", "failed"],
      ["2026-07-08", "failed"],
      ["2026-07-09", "failed"],
    ]);
    // Same GUILD, different channel: dormancy is per (scope, channel), so this one is untouched.
    await card("g:10", "chLive", "2026-07-01");
    await ledger("g:10", "chLive", [
      ["2026-07-07", "posted"],
      ["2026-07-08", "posted"],
      ["2026-07-09", "posted"],
    ]);
    // A channel with no ledger history at all is never dormant (empty window).
    await card("g:11", "chNew", "2026-07-09");

    expect(await pending()).toEqual(["g:10/chLive", "g:11/chNew", "g:ok/chOk"]);
  });

  it("still excludes a channel already terminal for p_date itself (the per-date guard is intact)", async () => {
    await healthy();
    await card("g:12", "chI", "2026-07-01");
    await ledger("g:12", "chI", [[DATE, "posted"]]); // tonight's recap already delivered
    expect(await pending()).toEqual(["g:ok/chOk"]);

    // …and a failure on p_date alone (1 in the window, from a later date's point of view) does not
    // make it dormant the next night.
    await db.exec(`update public.recap_posts set status = 'failed' where channel_id = 'chI'`);
    expect(await pending("2026-07-11")).toEqual(["g:12/chI", "g:ok/chOk"]);
  });
});
