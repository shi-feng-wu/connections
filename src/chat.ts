// Player ↔ dev feedback threads over /api/chat — a support-ticket model. Each note a player sends
// opens its own thread, so the player has an inbox of separate conversations (one per feedback) and
// the dev has an inbox of every ticket. The browser is trusted for neither identity (the server
// resolves it from the Discord token for writes, or the signed auth ticket for reads) nor for who
// counts as a dev (the list response says). Every call degrades to a null/empty result — a hiccup
// just means "no chat", it never throws into the UI.

export type ChatMessage = {
  id: number;
  sender: 'user' | 'dev';
  text: string;
  created_at: string;
};

// One of the player's own tickets, for their inbox list.
export type ChatTicket = {
  id: number;
  category: string | null;
  subject: string | null; // the player-written title (the inbox row title)
  preview: string | null; // latest message from either side (the line beneath the title)
  lastMessageAt: string;
  lastSender: 'user' | 'dev';
  unread: boolean; // an unread reply from us
};

export type ChatList = {
  tickets: ChatTicket[];
  unread: boolean; // any ticket has an unread reply
  isDev: boolean; // whether this player may open the admin inbox
};

// One ticket in the dev's global inbox (carries the player identity).
export type InboxTicket = {
  threadId: number;
  userId: string;
  name: string | null;
  avatar: string | null;
  category: string | null;
  subject: string | null; // the player-written title (the inbox row title)
  preview: string | null; // latest message from either side (the line beneath the title)
  lastMessageAt: string;
  lastSender: 'user' | 'dev';
  unread: boolean; // a new player message we haven't read
};

export type TicketView = { messages: ChatMessage[]; category: string | null; subject: string | null };

// The handlers the chat UI needs, with identity/puzzle context already bound (App builds this from
// its refs). admin.* only do anything for an allowlisted dev; the UI gates on `isDev`.
export type ChatApi = {
  list: () => Promise<ChatList | null>;
  open: (threadId: number) => Promise<TicketView | null>;
  create: (
    text: string,
    category: string | null,
    subject: string,
  ) => Promise<{ threadId: number; messages: ChatMessage[] } | null>;
  reply: (threadId: number, text: string) => Promise<ChatMessage[] | null>;
  admin: {
    inbox: () => Promise<InboxTicket[]>;
    thread: (threadId: number) => Promise<(TicketView & { name: string | null }) | null>;
    reply: (threadId: number, text: string) => Promise<ChatMessage[] | null>;
    resetProgress: () => Promise<boolean>; // dev-only: clear my own progress for today, to replay
  };
};

// What App hands the menu/footer: the bound api plus the badge state it tracks at the app level
// (App lists tickets on open / tab-focus so the unread dot is right before the page is opened).
// Omitted entirely in preview/landing, where the chat falls back to a local-only form.
export type ChatBundle = {
  api: ChatApi;
  unread: boolean; // any unread reply → dot on the Feedback entry
  isDev: boolean; // surface the admin Inbox entry
  onUnread: (unread: boolean) => void; // the player read/added tickets → resync App's badge
};

async function postJson<T>(body: object, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ---- player ----

// List the caller's own tickets. `ticket` is the signed auth ticket (App's authTicketRef).
export async function listChat(ticket: string): Promise<ChatList | null> {
  try {
    const r = await fetch('/api/chat', { headers: { Authorization: `Bearer ${ticket}` } });
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<ChatList>;
    return { tickets: d.tickets ?? [], unread: !!d.unread, isDev: !!d.isDev };
  } catch {
    return null;
  }
}

// Open one of the caller's tickets (and mark it read). Ticket-gated.
export async function openTicket(ticket: string, threadId: number): Promise<TicketView | null> {
  return postJson<TicketView>({ op: 'open', threadId }, { Authorization: `Bearer ${ticket}` });
}

// Open a new ticket. `subject` is the player-written title; `category` is its tag; `puzzle` is the
// current puzzle.
export async function createTicket(input: {
  accessToken: string;
  text: string;
  category: string | null;
  subject: string;
  puzzle: number | null;
}): Promise<{ threadId: number; messages: ChatMessage[] } | null> {
  return postJson<{ threadId: number; messages: ChatMessage[] }>({ op: 'new', ...input });
}

// Add a message to one of the caller's tickets.
export async function replyTicket(
  accessToken: string,
  threadId: number,
  text: string,
): Promise<ChatMessage[] | null> {
  const d = await postJson<{ messages?: ChatMessage[] }>({ op: 'reply', accessToken, threadId, text });
  return d?.messages ?? null;
}

// ---- dev admin (the allowlist is enforced server-side; these no-op for everyone else) ----

export async function loadInbox(accessToken: string): Promise<InboxTicket[]> {
  const d = await postJson<{ tickets?: InboxTicket[] }>({ accessToken, admin: 'inbox' });
  return d?.tickets ?? [];
}

export async function loadAdminThread(
  accessToken: string,
  threadId: number,
): Promise<(TicketView & { name: string | null }) | null> {
  return postJson<TicketView & { name: string | null }>({ accessToken, admin: 'thread', threadId });
}

export async function sendAdminReply(
  accessToken: string,
  threadId: number,
  text: string,
): Promise<ChatMessage[] | null> {
  const d = await postJson<{ messages?: ChatMessage[] }>({ accessToken, admin: 'reply', threadId, text });
  return d?.messages ?? null;
}

// Dev-only: clear the caller's OWN progress + score for today so they can replay the puzzle (for
// testing). No-ops for everyone else — the server enforces the DEV_DISCORD_IDS allowlist.
export async function resetTodayProgress(accessToken: string): Promise<boolean> {
  const d = await postJson<{ ok?: boolean }>({ accessToken, admin: 'reset-progress' });
  return !!d?.ok;
}
