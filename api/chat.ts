import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { bearerToken, fetchDiscordUser, type DiscordUser } from './_discord.js';
import { isCategory, postFeedbackWebhook } from './_feedback.js';
import { todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Player ↔ dev feedback threads — a support-ticket model. Each note a player sends opens its own
// thread, so a player has an inbox of separate conversations (one per feedback) and the dev has an
// inbox of every ticket. Kept to one route to stay under Vercel's function ceiling:
//
//   GET                         a player lists THEIR tickets (id, tag, preview, unread). Cheap:
//                               gated on the signed auth ticket (verifyAuth → uid), no Discord call.
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

function devIds(): string[] {
  return (process.env.DEV_DISCORD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
const isDevId = (id: string): boolean => devIds().includes(id);

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
};
type Db = NonNullable<ReturnType<typeof admin>>;

async function readThread(db: Db, threadId: number): Promise<ThreadRow | null> {
  const { data } = await db.from('chat_threads').select('*').eq('id', threadId).maybeSingle();
  return (data as ThreadRow | null) ?? null;
}

async function readMessages(db: Db, threadId: number): Promise<object[]> {
  const { data } = await db
    .from('chat_messages')
    .select('id, sender, text, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES);
  return ((data as MessageRow[] | null) ?? []).map((m) => ({
    id: m.id,
    sender: m.sender,
    text: m.text,
    created_at: m.created_at,
  }));
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
    .select('id, category, subject, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at')
    .eq('user_id', auth.uid)
    .order('last_message_at', { ascending: false })
    .limit(200);
  const rows = (data as ThreadRow[] | null) ?? [];
  const tickets = rows.map((t) => ({
    id: t.id,
    category: t.category,
    subject: t.subject,
    preview: t.last_text,
    lastMessageAt: t.last_message_at,
    lastSender: t.last_sender,
    unread: playerUnread(t),
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
      .select('id, user_id, name, avatar, category, subject, last_message_at, last_sender, last_text, dev_last_read_at')
      .order('last_message_at', { ascending: false })
      .limit(300);
    const tickets = ((data as ThreadRow[] | null) ?? []).map((t) => ({
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
