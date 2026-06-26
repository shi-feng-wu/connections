import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// Runs the chat DDL (supabase/schema.sql) against real Postgres (PGlite = Postgres in WASM), so a
// typo in the schema fails here, and the structure the route leans on holds: a player can own
// several tickets, messages hang off a ticket by thread_id (and cascade with it), and a message's
// sender is one of two values. The unread *logic* lives in api/chat.ts and is covered by chat.test.ts.

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const tableBlocks = [
  ...schema.matchAll(/create table if not exists public\.(?:chat_threads|chat_messages)[\s\S]*?\n\);/g),
].map((m) => m[0]);
const indexStmts = [...schema.matchAll(/create index if not exists chat_[^;]*;/g)].map((m) => m[0]);

let db: PGlite;
const openTicket = async (user: string, category: string, subject: string): Promise<number> => {
  const r = await db.query<{ id: number }>(
    `insert into public.chat_threads (user_id, name, category, subject) values ($1,$2,$3,$4) returning id`,
    [user, user, category, subject],
  );
  return r.rows[0].id;
};

beforeAll(async () => {
  db = await PGlite.create();
  expect(tableBlocks).toHaveLength(2); // chat_threads, chat_messages (threads first — messages reference it)
  for (const block of tableBlocks) await db.exec(block);
  expect(indexStmts).toHaveLength(3); // chat_threads_user_idx, chat_threads_recent_idx, chat_messages_thread_idx
  for (const stmt of indexStmts) await db.exec(stmt);
});

describe("chat schema (schema.sql)", () => {
  it("lets one player own several tickets, each with its own messages oldest-first", async () => {
    const bug = await openTicket("p1", "Bug", "it broke");
    const idea = await openTicket("p1", "Idea", "add dark mode"); // same player, second ticket
    expect(bug).not.toBe(idea);

    await db.query(
      `insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
       values ($1,'user','p1','Player','it broke'), ($1,'dev','dev9','Dev','on it')`,
      [bug],
    );
    await db.query(
      `insert into public.chat_messages (thread_id, sender, author_id, text) values ($1,'user','p1','add dark mode')`,
      [idea],
    );

    const mine = await db.query<{ id: number }>(
      `select id from public.chat_threads where user_id = 'p1'`,
    );
    expect(mine.rows).toHaveLength(2);

    const msgs = await db.query<{ sender: string; text: string }>(
      `select sender, text from public.chat_messages where thread_id = $1 order by created_at asc, id asc`,
      [bug],
    );
    expect(msgs.rows.map((m) => m.sender)).toEqual(["user", "dev"]);
  });

  it("rejects a message whose sender isn't user/dev", async () => {
    const t = await openTicket("p2", "Other", "hi");
    await expect(
      db.query(`insert into public.chat_messages (thread_id, sender, author_id, text) values ($1,'robot','x','hi')`, [t]),
    ).rejects.toThrow();
  });

  it("rejects a message pointing at a ticket that doesn't exist", async () => {
    await expect(
      db.query(`insert into public.chat_messages (thread_id, sender, author_id, text) values (999999,'user','x','hi')`),
    ).rejects.toThrow(); // foreign key violation
  });

  it("cascades: deleting a ticket removes its messages", async () => {
    const t = await openTicket("p3", "Bug", "temp");
    await db.query(`insert into public.chat_messages (thread_id, sender, author_id, text) values ($1,'user','p3','temp')`, [t]);
    await db.query(`delete from public.chat_threads where id = $1`, [t]);
    const left = await db.query<{ n: number }>(
      `select count(*)::int as n from public.chat_messages where thread_id = $1`,
      [t],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("is idempotent: no replayable chat DROP, and re-applying the DDL keeps existing rows", async () => {
    // A replayable `drop table ... chat_*` would wipe a live conversation on every schema apply.
    expect(schema).not.toMatch(/drop\s+table[^\n;]*chat_(?:threads|messages)/i);

    const id = await openTicket("keep-me", "Bug", "still here?");
    await db.query(
      `insert into public.chat_messages (thread_id, sender, author_id, text) values ($1,'user','keep-me','hi')`,
      [id],
    );
    // Replaying the create-table/index DDL is a no-op (everything is `if not exists`) — data lives.
    for (const block of tableBlocks) await db.exec(block);
    for (const stmt of indexStmts) await db.exec(stmt);

    const t = await db.query<{ subject: string }>(
      `select subject from public.chat_threads where id = $1`,
      [id],
    );
    expect(t.rows[0]?.subject).toBe("still here?");
    const m = await db.query<{ n: number }>(
      `select count(*)::int as n from public.chat_messages where thread_id = $1`,
      [id],
    );
    expect(m.rows[0].n).toBe(1);
  });
});
