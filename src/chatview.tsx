import { Bug, Check, ChevronLeft, Lightbulb, MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatApi, ChatMessage, ChatTicket, InboxTicket } from "./chat";
import { HoverButton } from "./hoverbutton";

// The conversation surfaces for the player↔dev feedback chat (api/chat.ts) — a support-ticket
// model laid out as a "Feedback Inbox" (claude.ai/design import). ChatPanel is the player's Feedback
// page: a single screen where the composer and their message inbox sit side by side (no "New" gate).
// Each message you start gets a subject that names it — the title of its row — and the line beneath
// is the last message from either side ("You: …" when you sent last), so the inbox reads like any
// chat app. Opening a row drills into the thread, with the subject heading the conversation.
// AdminInbox is the dev-only screen (gated by the list response's isDev): every player's ticket,
// visually identical rows, openable to reply. Strictly zinc chrome; the only colour is the green
// unread dot, reused from the changelog badge.

const CHIPS = ["Bug", "Idea", "Other"];

// Category → line icon (no emoji): bug / lightbulb / message for Bug · Idea · Other.
const CAT_ICON: Record<string, typeof Bug> = { Bug, Idea: Lightbulb, Other: MessageSquare };
function CategoryIcon({
  category,
  size,
  strokeWidth = 2,
}: {
  category: string | null;
  size: number;
  strokeWidth?: number;
}): ReactNode {
  const Icon = CAT_ICON[category ?? ""] ?? MessageSquare;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden />;
}

// Shared field styling so the composer textarea + reply box never drift.
const TA_CLS =
  "w-full resize-y rounded-xl border border-zinc-700 bg-transparent px-3.5 py-3.25 font-sans text-[14px] leading-[1.5] text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-500";
const SEND_CLS =
  "inline-flex h-[44px] w-full cursor-pointer items-center justify-center gap-1.75 rounded-full bg-zinc-100 font-sans text-[14px] font-semibold text-zinc-900 transition-opacity disabled:cursor-default disabled:opacity-40";

// A short relative time for the inbox lists ("3m", "2h", "5d"). Coarse on purpose.
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// A tracked-caps section label ("New message", "Your messages").
function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="font-sans text-[11px] font-bold uppercase tracking-[0.07em] text-zinc-500">
      {children}
    </span>
  );
}

// One message bubble: the player's notes sit right (filled, like the Send button); ours sit left
// (a dark card).
function Bubble({ m }: { m: ChatMessage }): ReactNode {
  const mine = m.sender === "user";
  return (
    <div className={"flex " + (mine ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2.5 font-sans text-[14px] leading-[1.5] " +
          (mine
            ? "rounded-2xl rounded-br-md bg-zinc-100 text-zinc-900"
            : "rounded-2xl rounded-bl-md bg-white/[0.06] text-zinc-100")
        }
      >
        {m.text}
      </div>
    </div>
  );
}

// The Bug / Idea / Other selector — line-icon pills. Selected = outlined in zinc-100 (no fill), so
// the composer stays monochrome.
function CategoryChips({ value, onChange }: { value: string; onChange: (c: string) => void }): ReactNode {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={
              "inline-flex cursor-pointer items-center gap-1.75 rounded-full border px-3 py-2 font-sans text-[13px] font-semibold transition-colors " +
              (on
                ? "border-zinc-100 bg-transparent text-zinc-100"
                : "border-zinc-700 bg-transparent text-zinc-400 hover:border-zinc-600 hover:text-zinc-300")
            }
          >
            <CategoryIcon category={c} size={15} />
            {c}
          </button>
        );
      })}
    </div>
  );
}

// Textarea + send button for a reply (Enter sends, Shift+Enter newlines). Clears on success; a
// failure surfaces a retry line and keeps the draft.
function Composer({
  placeholder,
  sendLabel,
  onSend,
}: {
  placeholder: string;
  sendLabel: string;
  onSend: (text: string) => Promise<boolean>;
}): ReactNode {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (): Promise<void> => {
    const note = text.trim();
    if (!note || sending) return;
    setSending(true);
    setFailed(false);
    const ok = await onSend(note);
    setSending(false);
    if (ok) setText("");
    else setFailed(true);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {failed && (
        <p className="m-0 text-[13px] text-[#e06c75]">Couldn’t send that. Mind trying again in a sec?</p>
      )}
      <textarea
        className={TA_CLS + " min-h-[80px]"}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <HoverButton hover="opacity-85" disabled={!text.trim() || sending} onClick={submit} className={SEND_CLS}>
        {sending ? (
          "Sending…"
        ) : (
          <>
            {sendLabel}
            <Send size={15} strokeWidth={2.25} aria-hidden />
          </>
        )}
      </HoverButton>
    </div>
  );
}

// New-message composer: category + a subject that names the thread + the note itself. Cmd/Ctrl+Enter
// sends (plain Enter newlines, since both a subject and a multi-line note are in play). Clears on
// success and drills into the freshly-opened thread.
function ComposeBlock({
  api,
  onCreated,
}: {
  api: ChatApi;
  onCreated: (threadId: number) => void;
}): ReactNode {
  const [cat, setCat] = useState("Bug");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const ready = !!subject.trim() && !!text.trim();
  const submit = async (): Promise<void> => {
    if (!ready || sending) return;
    setSending(true);
    setFailed(false);
    const r = await api.create(text.trim(), cat, subject.trim());
    setSending(false);
    if (!r) {
      setFailed(true);
      return;
    }
    setSubject("");
    setText("");
    setCat("Bug");
    onCreated(r.threadId);
  };

  return (
    <div className="flex flex-col gap-3">
      <Eyebrow>New message</Eyebrow>
      <CategoryChips value={cat} onChange={setCat} />
      {failed && (
        <p className="m-0 text-[13px] text-[#e06c75]">Couldn’t send that. Mind trying again in a sec?</p>
      )}
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        className="w-full rounded-[10px] border border-zinc-700 bg-transparent px-3.25 py-2.75 font-sans text-[14px] font-semibold text-zinc-100 outline-none transition-colors placeholder:font-medium placeholder:text-zinc-600 focus:border-zinc-500"
      />
      <textarea
        className={TA_CLS + " min-h-[120px]"}
        placeholder="Tell us what broke, or what you’d love to see…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <HoverButton hover="opacity-85" disabled={!ready || sending} onClick={submit} className={SEND_CLS}>
        {sending ? (
          "Sending…"
        ) : (
          <>
            Send
            <Send size={15} strokeWidth={2.25} aria-hidden />
          </>
        )}
      </HoverButton>
    </div>
  );
}

// A back link ("‹ Your messages" / "‹ player name") above a conversation.
function BackLink({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit cursor-pointer items-center gap-1 bg-transparent font-sans text-[13px] font-semibold text-zinc-400 transition-colors hover:text-zinc-100"
    >
      <ChevronLeft size={16} strokeWidth={2.25} aria-hidden />
      {label}
    </button>
  );
}

// Scroll a fresh message into view within the thread's scroller, once it grows.
function useScrollToEnd(dep: number): RefObject<HTMLDivElement | null> {
  const endRef = useRef<HTMLDivElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    if (dep > prev.current && prev.current > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    prev.current = dep;
  }, [dep]);
  return endRef;
}

function Loading(): ReactNode {
  return <p className="py-10 text-center font-sans text-[14px] text-zinc-500">Loading…</p>;
}

// A dashed placeholder for an empty inbox.
function EmptyNote({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="m-0 rounded-xl border border-dashed border-zinc-800 px-3.5 py-6 text-center font-sans text-[13px] leading-[1.5] text-zinc-500">
      {children}
    </p>
  );
}

// The category-icon avatar on a player inbox row.
function CatAvatar({ category }: { category: string | null }): ReactNode {
  return (
    <span className="grid h-9.5 w-9.5 flex-none place-items-center rounded-full bg-white/[0.06] text-zinc-300">
      <CategoryIcon category={category} size={18} />
    </span>
  );
}

// The player-identity avatar on a dev inbox row (their Discord pic, or their initial).
function InitialAvatar({
  name,
  userId,
  avatar,
}: {
  name: string | null;
  userId: string;
  avatar: string | null;
}): ReactNode {
  if (avatar) return <img src={avatar} alt="" className="h-9.5 w-9.5 flex-none rounded-full" />;
  return (
    <span className="grid h-9.5 w-9.5 flex-none place-items-center rounded-full bg-zinc-700 font-sans text-[14px] font-extrabold text-zinc-100">
      {(name ?? userId).slice(0, 1).toUpperCase()}
    </span>
  );
}

// One inbox row: a leading avatar, the subject as a title with the time top-right, and the last
// message as a preview line with the unread dot.
function Row({
  leading,
  title,
  preview,
  time,
  unread,
  onClick,
}: {
  leading: ReactNode;
  title: string;
  preview: ReactNode;
  time: string;
  unread: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-3 rounded-xl bg-transparent p-2.5 text-left transition-colors hover:bg-white/[0.055]"
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2.5">
          <span
            className={
              "min-w-0 flex-1 truncate font-sans text-[14.5px] text-zinc-100 " +
              (unread ? "font-bold" : "font-semibold")
            }
          >
            {title}
          </span>
          <span className="flex-none font-sans text-[11px] tabular-nums text-zinc-600">{time}</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className={
              "min-w-0 flex-1 truncate font-sans text-[12.5px] " +
              (unread ? "text-zinc-300" : "text-zinc-500")
            }
          >
            {preview}
          </span>
          {unread && <span className="h-2 w-2 flex-none rounded-full bg-[#a0c35a]" aria-label="Unread" />}
        </span>
      </span>
    </button>
  );
}

// The shared conversation layout (player + dev): back link, the category as an eyebrow, the subject
// as a serif heading, the bubbles, then a composer.
function ThreadShell({
  back,
  category,
  subject,
  messages,
  endRef,
  composer,
}: {
  back: ReactNode;
  category: string | null;
  subject: string | null;
  messages: ChatMessage[] | null;
  endRef: RefObject<HTMLDivElement | null>;
  composer: ReactNode;
}): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        {back}
        <div className="flex items-center gap-1.75 text-zinc-500">
          <CategoryIcon category={category} size={13} />
          <Eyebrow>{category ?? "Message"}</Eyebrow>
        </div>
        {subject && (
          <h2 className="m-0 font-display text-[20px] font-bold leading-[1.15] tracking-[-0.01em] text-[#efefe6]">
            {subject}
          </h2>
        )}
      </div>
      {messages === null ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          <div ref={endRef} />
        </div>
      )}
      {composer}
    </div>
  );
}

// ---- player ----

// The player's Feedback page. With an api (embedded) it's their ticket inbox; without one (dev
// preview / landing, no Discord) it falls back to the old one-shot form with a local thank-you.
export function ChatPanel({
  api,
  onUnread,
}: {
  api?: ChatApi;
  onUnread?: (unread: boolean) => void;
}): ReactNode {
  if (!api) return <LocalForm />;
  return <LiveChat api={api} onUnread={onUnread} />;
}

function LiveChat({ api, onUnread }: { api: ChatApi; onUnread?: (unread: boolean) => void }): ReactNode {
  const [tickets, setTickets] = useState<ChatTicket[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  // Re-pull the list and resync the app-level unread badge. Called after every change.
  const refresh = useCallback(async (): Promise<void> => {
    const l = await api.list();
    if (!l) return;
    setTickets(l.tickets);
    onUnread?.(l.unread);
  }, [api, onUnread]);

  useEffect(() => {
    let live = true;
    void api.list().then((l) => {
      if (!live) return;
      setTickets(l?.tickets ?? []);
      if (l) onUnread?.(l.unread);
    });
    return () => {
      live = false;
    };
    // api/onUnread are stable (App memoizes); load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (tickets === null) return <Loading />;

  if (openId !== null) {
    return (
      <TicketThread
        api={api}
        threadId={openId}
        onBack={() => {
          void refresh();
          setOpenId(null);
        }}
        onOpened={refresh}
      />
    );
  }

  // Combined screen: composer and inbox together (stacked on a narrow surface, two columns split by
  // a hairline on a wide one — a container query, so it tracks the surface width, not the viewport).
  return (
    <div className="@container">
      <div className="flex flex-col gap-7 @[620px]:grid @[620px]:grid-cols-2 @[620px]:gap-0">
        <div className="@[620px]:border-r @[620px]:border-white/[0.08] @[620px]:pr-9">
          <ComposeBlock
            api={api}
            onCreated={(threadId) => {
              void refresh();
              setOpenId(threadId);
            }}
          />
        </div>
        <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-7 @[620px]:border-t-0 @[620px]:pt-0 @[620px]:pl-9">
          <Eyebrow>Your messages</Eyebrow>
          {tickets.length === 0 ? (
            <EmptyNote>
              Your messages show up here. We read every one and reply right in the thread.
            </EmptyNote>
          ) : (
            <div className="flex flex-col gap-0.5">
              {tickets.map((t) => (
                <Row
                  key={t.id}
                  leading={<CatAvatar category={t.category} />}
                  title={t.subject || t.category || "Message"}
                  preview={(t.lastSender === "user" ? "You: " : "") + (t.preview ?? "")}
                  time={ago(t.lastMessageAt)}
                  unread={t.unread}
                  onClick={() => setOpenId(t.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// One of the player's tickets: the conversation + a reply composer.
function TicketThread({
  api,
  threadId,
  onBack,
  onOpened,
}: {
  api: ChatApi;
  threadId: number;
  onBack: () => void;
  onOpened: () => void;
}): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const endRef = useScrollToEnd(messages?.length ?? 0);

  useEffect(() => {
    let live = true;
    void api.open(threadId).then((d) => {
      if (!live) return;
      setMessages(d?.messages ?? []);
      setCategory(d?.category ?? null);
      setSubject(d?.subject ?? null);
      onOpened(); // opening marked it read — resync the badge/list
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return (
    <ThreadShell
      back={<BackLink label="Your messages" onClick={onBack} />}
      category={category}
      subject={subject}
      messages={messages}
      endRef={endRef}
      composer={
        <Composer
          placeholder="Write a reply…"
          sendLabel="Send"
          onSend={async (text) => {
            const next = await api.reply(threadId, text);
            if (!next) return false;
            setMessages(next);
            return true;
          }}
        />
      }
    />
  );
}

// The pre-chat fallback (no Discord): a single note with a local thank-you, nothing sent.
function LocalForm(): ReactNode {
  const [cat, setCat] = useState("Bug");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3.25 px-4 py-11 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-400/[0.13] text-emerald-400">
          <Check size={26} strokeWidth={2.25} aria-hidden />
        </span>
        <div className="font-display text-[21px] font-bold text-[#efefe6]">Thanks, got it!</div>
        <p className="m-0 max-w-[280px] text-[14px] leading-[1.55] text-zinc-400">
          It comes straight to us, and we read every one.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Eyebrow>New message</Eyebrow>
      <CategoryChips value={cat} onChange={setCat} />
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        className="w-full rounded-[10px] border border-zinc-700 bg-transparent px-3.25 py-2.75 font-sans text-[14px] font-semibold text-zinc-100 outline-none transition-colors placeholder:font-medium placeholder:text-zinc-600 focus:border-zinc-500"
      />
      <textarea
        className={TA_CLS + " min-h-[120px]"}
        placeholder="Tell us what broke, or what you’d love to see…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <HoverButton
        hover="opacity-85"
        disabled={!text.trim()}
        onClick={() => setSent(true)}
        className={SEND_CLS}
      >
        Send
        <Send size={15} strokeWidth={2.25} aria-hidden />
      </HoverButton>
    </div>
  );
}

// ---- dev admin ----

// Dev-only inbox: every player's ticket, newest-active first, each openable to read + reply. Same
// rows as the player's inbox, only with the player's identity as the avatar + a name on the preview.
export function AdminInbox({ api }: { api: ChatApi }): ReactNode {
  const [tickets, setTickets] = useState<InboxTicket[] | null>(null);
  const [open, setOpen] = useState<InboxTicket | null>(null);

  const refresh = useCallback((): void => {
    void api.admin.inbox().then(setTickets);
  }, [api]);
  useEffect(refresh, [refresh]);

  if (open) {
    return (
      <AdminThread
        api={api}
        ticket={open}
        onBack={() => {
          setOpen(null);
          refresh(); // reading it cleared the unread flag; reflect that in the list
        }}
      />
    );
  }

  if (tickets === null) return <Loading />;
  if (tickets.length === 0) {
    return <p className="py-10 text-center font-sans text-[14px] text-zinc-500">No messages yet.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {tickets.map((t) => (
        <Row
          key={t.threadId}
          leading={<InitialAvatar name={t.name} userId={t.userId} avatar={t.avatar} />}
          title={t.subject || t.category || "Message"}
          preview={
            <>
              <span className="font-semibold text-zinc-400">{t.name ?? t.userId}</span>
              {" · "}
              {(t.lastSender === "dev" ? "You: " : "") + (t.preview ?? "")}
            </>
          }
          time={ago(t.lastMessageAt)}
          unread={t.unread}
          onClick={() => setOpen(t)}
        />
      ))}
    </div>
  );
}

function AdminThread({
  api,
  ticket,
  onBack,
}: {
  api: ChatApi;
  ticket: InboxTicket;
  onBack: () => void;
}): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [name, setName] = useState<string | null>(ticket.name);
  const endRef = useScrollToEnd(messages?.length ?? 0);

  useEffect(() => {
    let live = true;
    void api.admin.thread(ticket.threadId).then((d) => {
      if (!live) return;
      setMessages(d?.messages ?? []);
      if (d?.name) setName(d.name);
    });
    return () => {
      live = false;
    };
  }, [api, ticket.threadId]);

  return (
    <ThreadShell
      back={<BackLink label={name ?? ticket.userId} onClick={onBack} />}
      category={ticket.category}
      subject={ticket.subject}
      messages={messages}
      endRef={endRef}
      composer={
        <Composer
          placeholder="Write a reply…"
          sendLabel="Reply"
          onSend={async (text) => {
            const next = await api.admin.reply(ticket.threadId, text);
            if (!next) return false;
            setMessages(next);
            return true;
          }}
        />
      }
    />
  );
}
