import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end exercise of the real api/chat.ts request handler — the actual route logic, not just the
// pure predicates (chat.test.ts) or the schema DDL (chat-sql.test.ts, which covers the real SQL
// constraints + cascade). The Supabase service client is shimmed onto a tiny in-memory table store
// that mimics the exact query chains the handler issues; Discord identity, the signed-ticket auth,
// and the webhook mirror are stubbed. (In-memory rather than PGlite on purpose: the handler test is
// about routing/unread/ownership logic, and a WASM Postgres per file pushes the parallel suite over
// a memory cliff.) We drive a whole conversation: a player opens a ticket (subject + first note),
// lists it, the dev sees it as "new" and replies, the player's unread flips on then clears on open,
// the player replies — and the ownership + dev-allowlist guards reject the wrong caller.

// ---- in-memory tables + a Supabase-builder shim over them (only the chains api/chat.ts uses) ----
type Row = Record<string, any>;
const store: Record<string, Row[]> = { chat_threads: [], chat_messages: [], progress: [], scores: [] };
const seq: Record<string, number> = { chat_threads: 0, chat_messages: 0 };

class Q {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: [string, unknown][] = [];
  private inList: [string, unknown[]][] = [];
  private notNullCols: string[] = [];
  private ord: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private values: Row | null = null;
  private returning = false;
  constructor(private table: string) {}
  select(): this {
    if (this.op !== "insert") this.op = "select";
    else this.returning = true;
    return this;
  }
  insert(obj: Row): this {
    this.op = "insert";
    this.values = obj;
    return this;
  }
  update(obj: Row): this {
    this.op = "update";
    this.values = obj;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  in(col: string, arr: unknown[]): this {
    this.inList.push([col, arr]);
    return this;
  }
  // Only the "column is not null" shape the avatar lookup uses (.not('avatar','is',null)).
  not(col: string, op: string, val: unknown): this {
    if (op === "is" && val === null) this.notNullCols.push(col);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.ord = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    return this;
  }
  async maybeSingle(): Promise<{ data: Row | null }> {
    return { data: (await this.run())[0] ?? null };
  }
  async single(): Promise<{ data: Row | null }> {
    return { data: (await this.run())[0] ?? null };
  }
  // Thenable so `await db.from(t).update(x).eq(...)` and `...select().order().limit(n)` resolve.
  then(resolve: (v: { data: unknown }) => void, reject: (e: unknown) => void): void {
    this.run().then((r) => {
      if (this.op === "insert") resolve({ data: this.returning ? (r[0] ?? null) : null });
      else if (this.op === "update" || this.op === "delete") resolve({ data: null });
      else resolve({ data: r });
    }, reject);
  }
  private async run(): Promise<Row[]> {
    const rows = store[this.table];
    if (this.op === "insert") {
      const id = ++seq[this.table];
      // Defaults the handler relies on but doesn't set explicitly (dev never-read, row birth time).
      const base: Row =
        this.table === "chat_threads"
          ? { dev_last_read_at: null, created_at: new Date().toISOString() }
          : { created_at: new Date().toISOString() };
      const row = { id, ...base, ...this.values };
      rows.push(row);
      return this.returning ? [{ ...row }] : [];
    }
    const keep = (r: Row): boolean =>
      this.filters.every(([c, v]) => r[c] === v) &&
      this.inList.every(([c, arr]) => arr.includes(r[c])) &&
      this.notNullCols.every((c) => r[c] != null);
    if (this.op === "delete") {
      store[this.table] = rows.filter((r) => !keep(r));
      return [];
    }
    const hit = rows.filter(keep);
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.values);
      return [];
    }
    let out = hit.slice();
    if (this.ord) {
      const { col, asc } = this.ord;
      // id is the insertion order — a stable tiebreak when two timestamps land in the same ms.
      out.sort((a, b) => {
        const c = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : a.id - b.id;
        return asc ? c : -c;
      });
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    return out.map((r) => ({ ...r }));
  }
}
const db = { from: (table: string) => new Q(table) };

// ---- stub the non-DB collaborators (Discord identity, signed-ticket auth, webhook mirror) ----
vi.mock("../api/_admin.js", () => ({ admin: () => db }));
vi.mock("../api/_discord.js", () => ({
  bearerToken: (hd: unknown) =>
    typeof hd === "string" && hd.startsWith("Bearer ") ? hd.slice(7) : null,
  // The access token IS the user id in the test; "Name-<id>" is their display name.
  fetchDiscordUser: async (token: unknown) =>
    token ? { id: String(token), name: `Name-${token}` } : null,
}));
vi.mock("../api/_session.js", () => ({
  // The signed ticket IS the uid in the test.
  verifyAuth: (token: unknown) => (token ? { uid: String(token), iat: 0 } : null),
  isLocalDev: () => false,
}));
vi.mock("../api/_feedback.js", () => ({
  isCategory: (c: unknown) => c === "Bug" || c === "Idea" || c === "Other",
  postFeedbackWebhook: async () => true,
}));
// Record the player DMs the handler fires (only a dev reply should), so we can assert the target +
// full reply + quoted context without a real Discord call.
const dmCalls: any[] = [];
vi.mock("../api/_dm.js", () => ({
  sendReplyDM: async (dm: any) => {
    dmCalls.push(dm);
    return true;
  },
}));
vi.mock("../api/_nyt.js", () => ({ todayET: () => "2026-06-26" }));

// Imported after the mocks are registered (vi.mock is hoisted, so this is fine).
const { default: handler, devUnread, playerUnread } = await import("../api/chat");

type Res = { statusCode: number; body: any; headers: Record<string, string> };
function mkRes(): Res & {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => any;
  json: (b: unknown) => any;
} {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}
async function call(
  method: "GET" | "POST",
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  const res = mkRes();
  await handler({ method, headers: opts.headers ?? {}, body: opts.body } as any, res as any);
  return res;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  process.env.DEV_DISCORD_IDS = "dev1"; // dev1 is the only allowlisted dev
});
beforeEach(() => {
  store.chat_threads = [];
  store.chat_messages = [];
  store.progress = [];
  store.scores = [];
  seq.chat_threads = 0;
  seq.chat_messages = 0;
  dmCalls.length = 0;
});

describe("api/chat — dev reset-progress (redo today)", () => {
  const today = "2026-06-26"; // matches the mocked todayET

  it("deletes only the dev's own progress + scores for today", async () => {
    store.progress = [
      { user_id: "dev1", puzzle_date: today, guesses: [] },
      { user_id: "dev1", puzzle_date: "2026-06-25", guesses: [] }, // other day — keep
      { user_id: "p1", puzzle_date: today, guesses: [] }, // other user — keep
    ];
    store.scores = [
      { user_id: "dev1", puzzle_date: today, score: 400 },
      { user_id: "p1", puzzle_date: today, score: 300 }, // other user — keep
    ];

    const r = await call("POST", { body: { admin: "reset-progress", accessToken: "dev1" } });

    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(store.progress).toEqual([
      { user_id: "dev1", puzzle_date: "2026-06-25", guesses: [] },
      { user_id: "p1", puzzle_date: today, guesses: [] },
    ]);
    expect(store.scores).toEqual([{ user_id: "p1", puzzle_date: today, score: 300 }]);
  });

  it("rejects a non-dev caller and deletes nothing", async () => {
    store.progress = [{ user_id: "p1", puzzle_date: today, guesses: [] }];
    store.scores = [{ user_id: "p1", puzzle_date: today, score: 300 }];

    const r = await call("POST", { body: { admin: "reset-progress", accessToken: "p1" } });

    expect(r.statusCode).toBe(403);
    expect(store.progress).toHaveLength(1);
    expect(store.scores).toHaveLength(1);
  });
});

describe("api/chat handler — full ticket lifecycle", () => {
  it("runs a player↔dev conversation end to end with correct unread + subject + preview", async () => {
    // Both parties have game history; the thread read resolves each author's avatar from it (the
    // dev's newest play wins over an older one, proving "latest avatar").
    store.scores = [
      { user_id: "p1", avatar: "avatar-p1", puzzle_date: "2026-06-20", created_at: "2026-06-20T00:00:00Z" },
      { user_id: "dev1", avatar: "stale-dev1", puzzle_date: "2026-06-19", created_at: "2026-06-19T00:00:00Z" },
      { user_id: "dev1", avatar: "avatar-dev1", puzzle_date: "2026-06-26", created_at: "2026-06-26T00:00:00Z" },
    ];

    // 1) Player p1 opens a ticket with a subject distinct from the note.
    const created = await call("POST", {
      body: { op: "new", accessToken: "p1", text: "the clock rewound", category: "Bug", subject: "Timer rewind", puzzle: 314 },
    });
    expect(created.statusCode).toBe(200);
    const threadId = created.body.threadId as number;
    expect(threadId).toBeGreaterThan(0);
    expect(created.body.messages).toHaveLength(1);

    // The thread row carries the title (subject), the note as the preview (last_text), the tag.
    const row = store.chat_threads.find((t) => t.id === threadId)!;
    expect(row).toMatchObject({
      subject: "Timer rewind",
      last_text: "the clock rewound",
      category: "Bug",
      last_sender: "user",
      user_id: "p1",
      puzzle_id: 314,
    });

    // 2) Player lists their inbox: one ticket, not unread (their own message is the latest).
    let list = await call("GET", { headers: { authorization: "Bearer p1" } });
    expect(list.statusCode).toBe(200);
    expect(list.body.tickets).toHaveLength(1);
    expect(list.body.tickets[0]).toMatchObject({
      subject: "Timer rewind",
      preview: "the clock rewound",
      lastSender: "user",
      unread: false,
    });
    expect(list.body.unread).toBe(false);
    expect(list.body.isDev).toBe(false);

    // 3) Dev inbox: the ticket shows up as "new" (player wrote, dev never read).
    let inbox = await call("POST", { body: { admin: "inbox", accessToken: "dev1" } });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.body.tickets).toHaveLength(1);
    expect(inbox.body.tickets[0]).toMatchObject({
      threadId,
      userId: "p1",
      name: "Name-p1",
      subject: "Timer rewind",
      preview: "the clock rewound",
      unread: true,
    });

    // 4) Dev opens it → stamps dev_last_read_at, so it drops out of "new".
    const devOpen = await call("POST", { body: { admin: "thread", accessToken: "dev1", threadId } });
    expect(devOpen.statusCode).toBe(200);
    expect(devOpen.body.messages).toHaveLength(1);
    expect(devOpen.body.subject).toBe("Timer rewind");
    inbox = await call("POST", { body: { admin: "inbox", accessToken: "dev1" } });
    expect(inbox.body.tickets[0].unread).toBe(false);

    await sleep(8); // keep timestamps strictly increasing for the unread comparisons
    // 5) Dev replies. last_sender flips to dev; preview becomes the reply.
    const devReply = await call("POST", {
      body: { admin: "reply", accessToken: "dev1", threadId, text: "fixed in v2.3" },
    });
    expect(devReply.statusCode).toBe(200);
    expect(devReply.body.messages).toHaveLength(2);
    // The reply carries the responding dev's own identity, so the player sees that dev's avatar
    // beside it (not a generic brand mark).
    expect(devReply.body.messages[1]).toMatchObject({
      sender: "dev",
      text: "fixed in v2.3",
      author: { name: "Name-dev1", avatar: "avatar-dev1" },
    });
    // And the player's own note carries their identity for their side of the thread.
    expect(devReply.body.messages[0]).toMatchObject({
      sender: "user",
      author: { name: "Name-p1", avatar: "avatar-p1" },
    });

    // The reply DMs the ticket owner with the full reply + the player's note as quoted context.
    expect(dmCalls).toHaveLength(1);
    expect(dmCalls[0]).toMatchObject({
      recipientId: "p1",
      subject: "Timer rewind",
      replyText: "fixed in v2.3",
      contextText: "the clock rewound",
    });

    // 6) Player now has an unread reply.
    list = await call("GET", { headers: { authorization: "Bearer p1" } });
    expect(list.body.tickets[0]).toMatchObject({ preview: "fixed in v2.3", lastSender: "dev", unread: true });
    expect(list.body.unread).toBe(true);

    // 7) Player opens the ticket → marked read; unread clears.
    const open = await call("POST", {
      body: { op: "open", threadId },
      headers: { authorization: "Bearer p1" },
    });
    expect(open.statusCode).toBe(200);
    expect(open.body.messages).toHaveLength(2);
    expect(open.body.subject).toBe("Timer rewind");
    list = await call("GET", { headers: { authorization: "Bearer p1" } });
    expect(list.body.tickets[0].unread).toBe(false);

    await sleep(8);
    // 8) Player replies on their own thread; the dev sees it as new again.
    const reply = await call("POST", { body: { op: "reply", accessToken: "p1", threadId, text: "thanks!" } });
    expect(reply.statusCode).toBe(200);
    expect(reply.body.messages).toHaveLength(3);
    expect(reply.body.messages[2]).toMatchObject({ sender: "user", text: "thanks!" });
    inbox = await call("POST", { body: { admin: "inbox", accessToken: "dev1" } });
    expect(inbox.body.tickets[0].unread).toBe(true);

    // A player reply doesn't DM anyone — only the dev's reply did (still just the one DM).
    expect(dmCalls).toHaveLength(1);
  });

  it("derives a subject from the note when the player leaves it blank", async () => {
    const r = await call("POST", {
      body: { op: "new", accessToken: "p9", text: "love the live leaderboard", category: "Other", subject: "  " },
    });
    const row = store.chat_threads.find((t) => t.id === r.body.threadId)!;
    expect(row.subject).toBe("love the live leaderboard");
    expect(row.last_text).toBe("love the live leaderboard");
  });

  it("enforces ownership and the dev allowlist, and rejects empty notes", async () => {
    const mine = await call("POST", { body: { op: "new", accessToken: "owner", text: "hi", category: "Idea", subject: "s" } });
    const tid = mine.body.threadId as number;

    // A different player can neither open nor reply to someone else's ticket.
    const sneakOpen = await call("POST", { body: { op: "open", threadId: tid }, headers: { authorization: "Bearer intruder" } });
    expect(sneakOpen.statusCode).toBe(404);
    const sneakReply = await call("POST", { body: { op: "reply", accessToken: "intruder", threadId: tid, text: "mine now" } });
    expect(sneakReply.statusCode).toBe(404);

    // A non-dev is forbidden from the admin inbox.
    const notDev = await call("POST", { body: { admin: "inbox", accessToken: "owner" } });
    expect(notDev.statusCode).toBe(403);

    // Empty note → 400 (after identity passes).
    const empty = await call("POST", { body: { op: "new", accessToken: "owner", text: "   " } });
    expect(empty.statusCode).toBe(400);

    // Unauthenticated list → 401.
    const noAuth = await call("GET", {});
    expect(noAuth.statusCode).toBe(401);
  });

  it("predicate sanity: the denormalized row drives both badges", () => {
    const base = {
      id: 1, user_id: "u", name: null, avatar: null, category: null, subject: null, puzzle_id: null,
      last_text: null, user_last_read_at: "2026-06-20T10:00:00Z", dev_last_read_at: null, msg_count: 1,
    };
    expect(playerUnread({ ...base, last_sender: "dev", last_message_at: "2026-06-20T11:00:00Z" } as any)).toBe(true);
    expect(devUnread({ ...base, last_sender: "user", last_message_at: "2026-06-20T11:00:00Z" } as any)).toBe(true);
  });
});
