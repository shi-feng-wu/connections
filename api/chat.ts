import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { bearerToken, fetchDiscordUser, type DiscordUser } from './_discord.js';
import { sendReplyDM } from './_dm.js';
import { isCategory, postFeedbackWebhook } from './_feedback.js';
import { todayET } from './_nyt.js';
import { broadcastRoom } from './_realtime.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Player ↔ dev feedback threads — a support-ticket model. Each note a player sends opens its own
// thread, so a player has an inbox of separate conversations (one per feedback) and the dev has an
// inbox of every ticket. Kept to one route to stay under Vercel's function ceiling:
//
//   GET                         a player lists THEIR tickets (id, tag, preview, unread). Cheap:
//                               gated on the signed auth ticket (verifyAuth → uid), no Discord call.
//                               Whole conversations ride along (budgeted — see inlineMessages) so
//                               the client renders a clicked thread instantly, no fetch.
//   POST {op:'open', threadId}  load one of the player's tickets + mark it read (ownership checked).
//   POST {op:'new', …}          open a new ticket (authoritative Discord identity, like /api/score).
//   POST {op:'reply', threadId} add to one of the player's tickets (identity + ownership checked).
//   POST {admin:…}              the dev (id in DEV_DISCORD_IDS) lists the global inbox, opens a
//                               ticket, or replies.
//
// Both tables are RLS-locked with no policy, so every read/write goes through the service role
// here after identity is verified — a player only ever touches a ticket they own.

const MAX_LEN = 2000; // Discord embed description limit; the thread mirrors to the webhook
const MAX_MESSAGES = 500; // a ticket never needs to render more than this at once
const SUBJECT_LEN = 140; // player-written title kept on the ticket for the inbox row titles
const PREVIEW_LEN = 160; // latest message, truncated — the line under each inbox title
const LIST_MSG_BUDGET = 400; // total messages inlined across one inbox list response

function devIds(): string[] {
  return (process.env.DEV_DISCORD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
const isDevId = (id: string): boolean => devIds().includes(id);

// Poke the other side's personal relay room (u:<uid>) so their client refreshes live — the badge
// lights and an open thread updates without a poll. Contentless (just the threadId): the client
// re-reads over its own authenticated call, so nothing private rides the relay. Best-effort, like
// every relay push — a miss just means they see it on their next list.
async function pokeChat(userIds: string[], threadId: number): Promise<void> {
  await Promise.all(userIds.map((id) => broadcastRoom(`u:${id}`, 'chat', { threadId })));
}

// Local dev only (vercel dev + a plain browser, no Discord handshake): a stub identity so the inbox
// is usable at localhost without embedding. Every use is behind isLocalDev(), which is false on any
// real deploy (VERCEL/VERCEL_ENV set) — so this can never authenticate a production request. Uses
// the first DEV_DISCORD_IDS entry when set (so you see your own threads + the admin inbox).
function localDevUser(): DiscordUser {
  return { id: devIds()[0] ?? 'local-dev', name: 'Local Dev' };
}

export type ThreadRow = {
  id: number;
  user_id: string;
  name: string | null;
  avatar: string | null;
  category: string | null;
  subject: string | null;
  puzzle_id: number | null;
  last_message_at: string;
  last_sender: 'user' | 'dev';
  last_text: string | null;
  user_last_read_at: string;
  dev_last_read_at: string | null;
  msg_count: number;
};
type MessageRow = {
  id: number;
  sender: 'user' | 'dev';
  text: string;
  created_at: string;
  author_id: string;
  author_name: string | null;
};
type Db = NonNullable<ReturnType<typeof admin>>;

async function readThread(db: Db, threadId: number): Promise<ThreadRow | null> {
  const { data } = await db.from('chat_threads').select('*').eq('id', threadId).maybeSingle();
  return (data as ThreadRow | null) ?? null;
}

async function readMessages(db: Db, threadId: number): Promise<object[]> {
  const { data } = await db
    .from('chat_messages')
    .select('id, sender, text, created_at, author_id, author_name')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES);
  const rows = (data as MessageRow[] | null) ?? [];
  const avatars = await avatarsByUser(db, [...new Set(rows.map((m) => m.author_id))]);
  return rows.map((m) => ({
    id: m.id,
    sender: m.sender,
    text: m.text,
    created_at: m.created_at,
    // The sender's identity, so the client shows the real dev's avatar beside each reply. name
    // backs the monogram; avatar is resolved from their play history (below), not stored per message.
    author: { name: m.author_name, avatar: avatars.get(m.author_id) ?? null },
  }));
}

// The latest avatar each of these users last played with, from scores (indexed by user_id). Every
// dev is a player, so their reply shows their real Discord pic with no Discord call and no
// per-message copy — and it stays current as they keep playing. "Latest" matches the season boards:
// newest puzzle_date, then newest row. Users with no avatar on file are absent (→ monogram/fallback).
async function avatarsByUser(db: Db, ids: string[]): Promise<Map<string, string>> {
  const byUser = new Map<string, string>();
  if (ids.length === 0) return byUser;
  const { data } = await db
    .from('scores')
    .select('user_id, avatar')
    .in('user_id', ids)
    .not('avatar', 'is', null)
    .order('puzzle_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  for (const r of (data as { user_id: string; avatar: string }[] | null) ?? []) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, r.avatar); // first row per user = the latest
  }
  return byUser;
}

// Inline whole conversations into an inbox list response, so the client can render a thread the
// instant its row is clicked — no per-thread fetch, no "Loading…" flash. Bounded by a total message
// budget using each thread's denormalized msg_count: threads are considered newest-first, and one
// that would blow the budget is skipped (not a break) so later small threads still ride along. A
// thread that doesn't fit (or a legacy row with no count) simply omits `messages` and loads the
// old way on open. Returns threadId → messages in the same shape readThread serves.
async function inlineMessages(db: Db, threads: ThreadRow[]): Promise<Map<number, object[]>> {
  const ids: number[] = [];
  let used = 0;
  for (const t of threads) {
    if (!t.msg_count || used + t.msg_count > LIST_MSG_BUDGET) continue;
    used += t.msg_count;
    ids.push(t.id);
  }
  const byThread = new Map<number, object[]>();
  if (ids.length === 0) return byThread;
  const { data } = await db
    .from('chat_messages')
    .select('id, thread_id, sender, text, created_at, author_id, author_name')
    .in('thread_id', ids)
    .order('created_at', { ascending: true })
    .limit(LIST_MSG_BUDGET * 2);
  const rows = (data as (MessageRow & { thread_id: number })[] | null) ?? [];
  // Hitting the query cap means a drifted msg_count let more rows through than budgeted, and the
  // last thread may be cut mid-conversation. Serving a partial thread as if complete is worse than
  // the fetch-on-open fallback, so inline nothing.
  if (rows.length >= LIST_MSG_BUDGET * 2) return byThread;
  const avatars = await avatarsByUser(db, [...new Set(rows.map((m) => m.author_id))]);
  for (const m of rows) {
    let list = byThread.get(m.thread_id);
    if (!list) byThread.set(m.thread_id, (list = []));
    list.push({
      id: m.id,
      sender: m.sender,
      text: m.text,
      created_at: m.created_at,
      author: { name: m.author_name, avatar: avatars.get(m.author_id) ?? null },
    });
  }
  return byThread;
}

// The player's most recent message in a ticket — the note a dev reply is answering. Quoted into
// the DM as context. null when the player has somehow never written (shouldn't happen for a real
// ticket, which always opens with a player note).
async function lastUserText(db: Db, threadId: number): Promise<string | null> {
  const { data } = await db
    .from('chat_messages')
    .select('text')
    .eq('thread_id', threadId)
    .eq('sender', 'user')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { text: string } | null)?.text ?? null;
}

// The player has an unread reply when the latest message is ours and lands after they last looked.
export function playerUnread(t: ThreadRow): boolean {
  return t.last_sender === 'dev' && Date.parse(t.last_message_at) > Date.parse(t.user_last_read_at);
}

// A ticket is "new" to the dev when the latest message is the player's and lands after the dev
// last read it (or they never have).
export function devUnread(t: ThreadRow): boolean {
  return (
    t.last_sender === 'user' &&
    (t.dev_last_read_at === null || Date.parse(t.last_message_at) > Date.parse(t.dev_last_read_at))
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return await listTickets(req, res);
    if (req.method === 'POST') return await post(req, res);
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}

// GET — a player lists their own tickets. Ticket-gated (no Discord call); read-only.
async function listTickets(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = isLocalDev()
    ? { uid: localDevUser().id, iat: 0 }
    : verifyAuth(bearerToken(req.headers.authorization));
  if (!auth) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const db = admin();
  if (!db) {
    res.status(200).json({ tickets: [], unread: false, isDev: isLocalDev() || isDevId(auth.uid) });
    return;
  }
  const { data } = await db
    .from('chat_threads')
    .select('id, category, subject, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count')
    .eq('user_id', auth.uid)
    .order('last_message_at', { ascending: false })
    .limit(200);
  const rows = (data as ThreadRow[] | null) ?? [];
  const inline = await inlineMessages(db, rows);
  const tickets = rows.map((t) => ({
    id: t.id,
    category: t.category,
    subject: t.subject,
    preview: t.last_text,
    lastMessageAt: t.last_message_at,
    lastSender: t.last_sender,
    unread: playerUnread(t),
    messages: inline.get(t.id), // undefined (over budget) drops out of the JSON → fetch on open
  }));
  res.status(200).json({
    tickets,
    unread: tickets.some((t) => t.unread),
    isDev: isLocalDev() || isDevId(auth.uid),
  });
}

async function post(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body ?? {};
  if (body.admin) return await adminAction(req, res);

  // Open a ticket: ticket-gated (uid), and the ticket must belong to the caller. Marks it read.
  if (body.op === 'open') {
    const auth = isLocalDev()
      ? { uid: localDevUser().id, iat: 0 }
      : verifyAuth(bearerToken(req.headers.authorization));
    if (!auth) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const threadId = Number(body.threadId);
    const db = admin();
    if (!db || !Number.isInteger(threadId)) {
      res.status(400).json({ error: 'bad request' });
      return;
    }
    const thread = await readThread(db, threadId);
    if (!thread || thread.user_id !== auth.uid) {
      res.status(404).json({ error: 'no ticket' });
      return;
    }
    await db
      .from('chat_threads')
      .update({ user_last_read_at: new Date().toISOString() })
      .eq('id', threadId);
    res.status(200).json({
      messages: await readMessages(db, threadId),
      category: thread.category,
      subject: thread.subject,
    });
    return;
  }

  // New ticket or reply: authoritative identity, like /api/score — the body isn't trusted for who
  // you are. A reply must target a ticket the caller owns.
  const user = isLocalDev() ? localDevUser() : await fetchDiscordUser(body.accessToken);
  if (!user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'empty' });
    return;
  }
  const db = admin();
  if (!db) {
    res.status(503).json({ error: 'chat unavailable' });
    return;
  }
  const now = new Date().toISOString();

  if (body.op === 'reply') {
    const threadId = Number(body.threadId);
    if (!Number.isInteger(threadId)) {
      res.status(400).json({ error: 'bad request' });
      return;
    }
    const thread = await readThread(db, threadId);
    if (!thread || thread.user_id !== user.id) {
      res.status(404).json({ error: 'no ticket' });
      return;
    }
    await insertMessage(db, threadId, 'user', user, text);
    await db
      .from('chat_threads')
      .update({
        name: user.name,
        avatar: user.avatar ?? null,
        last_message_at: now,
        last_sender: 'user',
        last_text: text.slice(0, PREVIEW_LEN),
        user_last_read_at: now, // they've seen their own message
        msg_count: (thread.msg_count ?? 0) + 1,
      })
      .eq('id', threadId);
    await mirror(thread, user, text, 'in');
    await pokeChat(devIds(), threadId); // a live dev sees the reply land in their inbox
    res.status(200).json({ ok: true, messages: await readMessages(db, threadId) });
    return;
  }

  // op 'new' (default): open a fresh ticket carrying the category/puzzle context of the form. The
  // player names it with a subject; if they leave it blank we fall back to the note itself so the
  // inbox row always has a title.
  const category = isCategory(body.category) ? body.category : null;
  const puzzle = Number.isInteger(body.puzzle) ? (body.puzzle as number) : null;
  const subject = (typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : text).slice(
    0,
    SUBJECT_LEN,
  );
  const { data: created } = await db
    .from('chat_threads')
    .insert({
      user_id: user.id,
      name: user.name,
      avatar: user.avatar ?? null,
      category,
      subject,
      puzzle_id: puzzle,
      last_message_at: now,
      last_sender: 'user',
      last_text: text.slice(0, PREVIEW_LEN),
      user_last_read_at: now,
      msg_count: 1,
    })
    .select('id')
    .single();
  const threadId = (created as { id: number } | null)?.id;
  if (!threadId) {
    res.status(503).json({ error: 'chat unavailable' });
    return;
  }
  await insertMessage(db, threadId, 'user', user, text);
  await postFeedbackWebhook({
    direction: 'in',
    authorName: user.name,
    authorId: user.id,
    text,
    category,
    puzzle,
  });
  await pokeChat(devIds(), threadId); // a live dev sees the new ticket land in their inbox
  res.status(200).json({ ok: true, threadId, messages: await readMessages(db, threadId) });
}

// POST {admin:'inbox'|'thread'|'reply'} — dev-only, gated by the DEV_DISCORD_IDS allowlist.
async function adminAction(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body ?? {};
  const dev = isLocalDev() ? localDevUser() : await fetchDiscordUser(body.accessToken);
  if (!dev || (!isLocalDev() && !isDevId(dev.id))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const db = admin();
  if (!db) {
    res.status(503).json({ error: 'chat unavailable' });
    return;
  }

  if (body.admin === 'inbox') {
    const { data } = await db
      .from('chat_threads')
      .select('id, user_id, name, avatar, category, subject, last_message_at, last_sender, last_text, dev_last_read_at, msg_count')
      .order('last_message_at', { ascending: false })
      .limit(300);
    const rows = (data as ThreadRow[] | null) ?? [];
    const inline = await inlineMessages(db, rows);
    const tickets = rows.map((t) => ({
      threadId: t.id,
      userId: t.user_id,
      name: t.name,
      avatar: t.avatar,
      category: t.category,
      subject: t.subject,
      preview: t.last_text,
      lastMessageAt: t.last_message_at,
      lastSender: t.last_sender,
      unread: devUnread(t),
      messages: inline.get(t.id), // undefined (over budget) drops out of the JSON → fetch on open
    }));
    res.status(200).json({ tickets });
    return;
  }

  // Dev-only "redo today": wipe this dev's OWN progress + score for today so they can replay the
  // puzzle from scratch (for testing). Scoped to dev.id + today only — never another user or day.
  // Deleting the scores row matters because /api/score is first-finish-wins (ignoreDuplicates), so
  // without it a re-finish wouldn't re-score. Streaks/leaderboard self-correct off scores.
  if (body.admin === 'reset-progress') {
    const date = todayET();
    await db.from('progress').delete().eq('user_id', dev.id).eq('puzzle_date', date);
    await db.from('scores').delete().eq('user_id', dev.id).eq('puzzle_date', date);
    res.status(200).json({ ok: true });
    return;
  }

  const threadId = Number(body.threadId);
  if (!Number.isInteger(threadId)) {
    res.status(400).json({ error: 'bad request' });
    return;
  }
  const thread = await readThread(db, threadId);
  if (!thread) {
    res.status(404).json({ error: 'no ticket' });
    return;
  }

  if (body.admin === 'thread') {
    // Opening a ticket catches the dev up: stamp dev_last_read_at so it drops out of "new".
    await db
      .from('chat_threads')
      .update({ dev_last_read_at: new Date().toISOString() })
      .eq('id', threadId);
    res.status(200).json({
      messages: await readMessages(db, threadId),
      name: thread.name,
      category: thread.category,
      subject: thread.subject,
    });
    return;
  }

  if (body.admin === 'reply') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'empty' });
      return;
    }
    const now = new Date().toISOString();
    await insertMessage(db, threadId, 'dev', dev, text);
    // last_sender='dev' lights the player's badge; dev_last_read_at=now (we've read our own reply);
    // user_last_read_at omitted so the player stays "unread" until they open the ticket.
    await db
      .from('chat_threads')
      .update({
        last_message_at: now,
        last_sender: 'dev',
        last_text: text.slice(0, PREVIEW_LEN),
        dev_last_read_at: now,
        msg_count: (thread.msg_count ?? 0) + 1,
      })
      .eq('id', threadId);
    await mirror(thread, dev, text, 'out');
    // DM the player the full reply plus the message it answers, so they get it in Discord and not
    // only as the in-app badge. Best-effort: silently no-ops if the bot can't DM them (no mutual
    // guild / DMs closed), and the unread badge still covers those.
    await sendReplyDM({
      recipientId: thread.user_id,
      subject: thread.subject,
      replyText: text,
      contextText: await lastUserText(db, threadId),
    });
    await pokeChat([thread.user_id], threadId); // their badge/open thread updates live
    res.status(200).json({ ok: true, messages: await readMessages(db, threadId) });
    return;
  }

  res.status(400).json({ error: 'bad action' });
}

async function insertMessage(
  db: Db,
  threadId: number,
  sender: 'user' | 'dev',
  author: { id: string; name: string },
  text: string,
): Promise<void> {
  await db.from('chat_messages').insert({
    thread_id: threadId,
    sender,
    author_id: author.id,
    author_name: author.name,
    text: text.slice(0, MAX_LEN),
  });
}

// Mirror a message to the dev's Discord channel so they still get pinged where they always have.
// 'in' = the player's note (tagged with the ticket's category/puzzle); 'out' = our reply.
async function mirror(
  thread: ThreadRow,
  author: { id: string; name: string },
  text: string,
  direction: 'in' | 'out',
): Promise<void> {
  await postFeedbackWebhook({
    direction,
    authorName: author.name,
    authorId: author.id,
    text,
    category: direction === 'in' ? thread.category : null,
    puzzle: direction === 'in' ? thread.puzzle_id : null,
    playerName: thread.name,
  });
}
