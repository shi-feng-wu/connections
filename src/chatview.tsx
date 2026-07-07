import { Bug, Check, ChevronLeft, Lightbulb, MessageSquare, Send, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatApi, ChatIdentity, ChatMessage, ChatTicket, InboxTicket, TicketView } from "./chat";
import { HoverButton } from "./hoverbutton";

// Session-scoped cache for the player's Feedback page. Opening Feedback mounts a fresh subtree and
// closing it unmounts the whole thing (DetailView is conditionally mounted), and opening a thread
// unmounts the inbox list — so without a cache every reopen reset to null and flashed "Loading…".
// The list response inlines whole conversations (ChatTicket.messages, budgeted server-side), so
// priming the list primes every thread too: clicking ANY row — even the first time — renders from
// cache instantly, and the open call just marks-read in the background. The app-level refresh
// primes on launch, tab-focus, and every relay chat poke, so the caches are always warm.
let ticketCache: ChatTicket[] | null = null;
const threadCache = new Map<number, TicketView>();
// The dev-only Inbox is the same story (it unmounts on close), with its own list + thread caches
// primed the same way from the inbox response's inlined conversations.
let adminCache: InboxTicket[] | null = null;
const adminThreadCache = new Map<number, { messages: ChatMessage[]; name: string | null }>();

export function primeTicketCache(tickets: ChatTicket[]): void {
  ticketCache = tickets;
  for (const t of tickets) {
    if (t.messages)
      threadCache.set(t.id, { messages: t.messages, category: t.category, subject: t.subject });
  }
}

// The conversation surfaces for the player↔dev feedback chat (api/chat.ts) — a support-ticket
// model laid out as a "Feedback Inbox" (claude.ai/design import). ChatPanel is the player's Feedback
// page, a mail-style two-pane screen: the inbox list on one side (headed by a "New message" row)
// and a detail pane on the other, which holds the compose form until a row is clicked and then
// swaps to that conversation in place — no separate screen, no navigation. Each message you start
// gets a subject that names it — the title of its row — and the line beneath is the last message
// from either side ("You: …" when you sent last), so the inbox reads like any chat app. On a
// narrow surface the panes stack (detail above list) and opening a row scrolls the detail pane
// into view. AdminInbox is the dev-only screen (gated by the list response's isDev): every
// player's ticket, visually identical rows, openable to reply (that one still drills in — it has
// no compose pane). Strictly zinc chrome; the only colour is the green unread dot, reused from
// the changelog badge.

const CHIPS = ["Bug", "Idea", "Other"];

// The two parties in a thread, keyed by a message's `sender`. This is the *fallback* identity for
// each side; a message carries its own author (the real sender's pic) and wins when present. The
// player is always "me" on their own side; dev messages fall back to the app's brand mark only for
// legacy rows that predate stored avatars.
type Participants = { user: ChatIdentity; dev: ChatIdentity };
const SUPPORT: ChatIdentity = { name: "Connections", avatar: "/connections-icon.png" };
// Fall back to a friendly name so the monogram never blanks before identity resolves.
function meIdent(me?: ChatIdentity): ChatIdentity {
  return { name: me?.name ?? "You", avatar: me?.avatar ?? null };
}

// The identity shown beside one message: the message's own author (so each dev's real avatar rides
// their own reply, and a multi-dev thread shows who actually answered), falling back per-field to
// the thread participant — the live viewer for their own side, or the brand mark for a legacy dev
// reply with no stored avatar.
function identFor(m: ChatMessage, base: ChatIdentity): ChatIdentity {
  return { name: m.author?.name ?? base.name, avatar: m.author?.avatar ?? base.avatar };
}

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
  "inline-flex h-[44px] w-full cursor-pointer items-center justify-center gap-1.75 rounded-full bg-zinc-100 font-sans text-[14px] font-semibold text-zinc-900 transition-opacity active:opacity-70 disabled:cursor-default disabled:opacity-40";

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

// The avatar beside a message run: the sender's Discord pic, or a monogram of their name. Sized
// and circular-cropped like a Discord message avatar.
function MsgAvatar({ ident }: { ident: ChatIdentity }): ReactNode {
  if (ident.avatar)
    return <img src={ident.avatar} alt="" className="h-9.5 w-9.5 flex-none rounded-full object-cover" />;
  return (
    <span className="grid h-9.5 w-9.5 flex-none place-items-center rounded-full bg-zinc-700 font-sans text-[15px] font-extrabold text-zinc-100">
      {(ident.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

// One message bubble. The viewer's own notes sit right (filled, like the Send button); the other
// party's sit left (a dark card) — `self` is the viewer's sender, so the same layout reads right
// for the player (self="user") and for the dev (self="dev"). Each run of same-sender messages
// carries the sender's Discord avatar at its head; the rest of the run reserves the avatar's width
// so the bubbles stay aligned (Discord-style).
function Bubble({
  m,
  ident,
  self,
  showAvatar,
}: {
  m: ChatMessage;
  ident: ChatIdentity;
  self: ChatMessage["sender"];
  showAvatar: boolean;
}): ReactNode {
  const mine = m.sender === self;
  return (
    <div className={"flex items-start gap-2.5 " + (mine ? "flex-row-reverse" : "flex-row")}>
      {showAvatar ? <MsgAvatar ident={ident} /> : <span className="w-9.5 flex-none" aria-hidden />}
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2.5 font-sans text-[14px] leading-[1.5] " +
          (mine
            ? "rounded-2xl rounded-tr-md bg-zinc-100 text-zinc-900"
            : "rounded-2xl rounded-tl-md bg-white/[0.06] text-zinc-100")
        }
      >
        {m.text}
      </div>
    </div>
  );
}

// The Bug / Idea / Other selector — line-icon pills. Selected = outlined in zinc-100 (no fill), so
// the composer stays monochrome. Chips stay mounted after a tap, so hover must be mouse-only
// (HoverButton) — CSS :hover would strand on the tapped chip on touch. The hover is a faint
// bg tint rather than the border/text brightening: an appended class can't out-cascade the
// base border/text shade (lower zinc shades emit earlier in the sheet), a fresh property can.
function CategoryChips({ value, onChange }: { value: string; onChange: (c: string) => void }): ReactNode {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((c) => {
        const on = value === c;
        return (
          <HoverButton
            key={c}
            type="button"
            onClick={() => onChange(c)}
            hover={on ? "" : "bg-white/[0.04]"}
            className={
              "inline-flex cursor-pointer items-center gap-1.75 rounded-full border px-3 py-2 font-sans text-[13px] font-semibold transition-colors active:scale-[0.98] " +
              (on
                ? "border-zinc-100 text-zinc-100"
                : "border-zinc-700 text-zinc-400")
            }
          >
            <CategoryIcon category={c} size={15} />
            {c}
          </HoverButton>
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
    const subj = subject.trim();
    const r = await api.create(text.trim(), cat, subj);
    setSending(false);
    if (!r) {
      setFailed(true);
      return;
    }
    // Seed the thread cache from the create response so drilling into the freshly-made thread shows
    // it instantly instead of flashing "Loading…" while it re-fetches what we already have.
    threadCache.set(r.threadId, { messages: r.messages, category: cat, subject: subj });
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

// An icon-only back button shown at the head of a thread when the page chrome can't host one
// (the dev preview playground — the real app lifts this up to sit across from the close X).
// :hover is safe here — tapping unmounts the thread (and this button) so it can't strand.
// The ::before extends the 36px box to a ~44px hit area without moving the layout.
function InlineBack({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className="relative grid h-9 w-9 cursor-pointer place-items-center rounded-[10px] bg-white/[0.05] text-zinc-400 transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-white/[0.09] hover:text-zinc-200 active:scale-[0.97]"
    >
      <ChevronLeft size={18} strokeWidth={2.25} aria-hidden />
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
    <p className="m-0 rounded-xl border border-dashed border-zinc-800 px-3.5 py-6 text-center font-sans text-[13px] leading-[1.5] text-zinc-400">
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
// message as a preview line with the unread dot. `selected` marks the conversation the detail
// pane is showing (player inbox only — the dev inbox drills in, nothing stays selected).
function Row({
  leading,
  title,
  preview,
  time,
  unread,
  selected,
  onClick,
}: {
  leading: ReactNode;
  title: string;
  preview: ReactNode;
  time: string;
  unread: boolean;
  selected?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    // Rows persist after a tap (they just become `selected`), so the hover tint is
    // mouse-only via HoverButton — raw :hover would strand on the last-tapped row on touch.
    <HoverButton
      type="button"
      onClick={onClick}
      hover={selected ? "" : "bg-white/[0.055]"}
      className={
        "flex w-full cursor-pointer items-start gap-3 rounded-xl p-2.5 text-left transition-colors active:bg-white/[0.08]" +
        (selected ? " bg-white/[0.07]" : "")
      }
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
    </HoverButton>
  );
}

// The head row of the player's inbox: a "New message" action styled like a chat row, swapping the
// detail pane back to the compose form. The filled icon disc marks it as the primary action (it
// echoes the Send button); `selected` while the compose form is the pane showing.
function NewMessageRow({ selected, onClick }: { selected: boolean; onClick: () => void }): ReactNode {
  return (
    // Same mouse-only hover reasoning as Row above — this row persists after a tap too.
    <HoverButton
      type="button"
      onClick={onClick}
      hover={selected ? "" : "bg-white/[0.055]"}
      className={
        "flex w-full cursor-pointer items-center gap-3 rounded-xl p-2.5 text-left transition-colors active:bg-white/[0.08]" +
        (selected ? " bg-white/[0.07]" : "")
      }
    >
      <span className="grid h-9.5 w-9.5 flex-none place-items-center rounded-full bg-zinc-100 text-zinc-900">
        <SquarePen size={17} strokeWidth={2.25} aria-hidden />
      </span>
      <span className="font-sans text-[14.5px] font-semibold text-zinc-100">New message</span>
    </HoverButton>
  );
}

// The shared conversation layout (player + dev): the category as an eyebrow, the subject as a serif
// heading, the avatared bubbles, then a composer. The player's pane needs no back at all (the
// inbox stays beside it); the dev inbox drills in, so its back sits in the page chrome (across
// from the close X), with an inline one only on the chrome-less preview (showInlineBack).
function ThreadShell({
  onBack,
  showInlineBack,
  category,
  subject,
  messages,
  endRef,
  composer,
  participants,
  self,
}: {
  onBack?: () => void;
  showInlineBack?: boolean;
  category: string | null;
  subject: string | null;
  messages: ChatMessage[] | null;
  endRef: RefObject<HTMLDivElement | null>;
  composer: ReactNode;
  participants: Participants;
  self: ChatMessage["sender"];
}): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        {showInlineBack && onBack && <InlineBack onClick={onBack} />}
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
          {messages.map((m, i) => (
            <Bubble
              key={m.id}
              m={m}
              ident={identFor(m, participants[m.sender])}
              self={self}
              showAvatar={i === 0 || messages[i - 1].sender !== m.sender}
            />
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
  me,
  version,
}: {
  api?: ChatApi;
  onUnread?: (unread: boolean) => void;
  me?: ChatIdentity;
  // App bumps this on every relay chat poke — the list and any open thread re-read live.
  version?: number;
}): ReactNode {
  if (!api) return <LocalForm />;
  return <LiveChat api={api} onUnread={onUnread} me={me} version={version} />;
}

function LiveChat({
  api,
  onUnread,
  me,
  version,
}: {
  api: ChatApi;
  onUnread?: (unread: boolean) => void;
  me?: ChatIdentity;
  version?: number;
}): ReactNode {
  const [tickets, setTickets] = useState<ChatTicket[] | null>(ticketCache);
  // The conversation the detail pane is showing; null = the compose form (the resting state).
  const [openId, setOpenId] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Re-pull the list (also re-priming the thread caches) and resync the app-level unread badge.
  // Called after every change.
  const refresh = useCallback(async (): Promise<void> => {
    const l = await api.list();
    if (!l) return;
    primeTicketCache(l.tickets);
    setTickets(l.tickets);
    onUnread?.(l.unread);
  }, [api, onUnread]);

  useEffect(() => {
    let live = true;
    void api.list().then((l) => {
      if (!live) return;
      const next = l?.tickets ?? [];
      primeTicketCache(next);
      setTickets(next);
      if (l) onUnread?.(l.unread);
    });
    return () => {
      live = false;
    };
    // api/onUnread are stable (App memoizes); load on mount + whenever a chat poke bumps version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Swap what the detail pane shows. On a wide surface the pane is already beside the list (the
  // scroll is a no-op); stacked, the pane sits above the list, so scroll it back into view.
  const show = (id: number | null): void => {
    setOpenId(id);
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // Two-pane mail layout in one screen: the detail pane (compose form, or the open conversation
  // in its place) beside the inbox list — stacked on a narrow surface, columns split by a hairline
  // on a wide one (a container query, so it tracks the surface width, not the viewport). The pane
  // order flips at the breakpoint: stacked puts the detail on top (the compose form is the resting
  // state, same as before); wide reads list → detail like any inbox.
  return (
    <div className="@container">
      <div className="flex flex-col gap-7 @[620px]:grid @[620px]:grid-cols-2 @[620px]:gap-0">
        <div ref={detailRef} className="@[620px]:order-last @[620px]:pl-9">
          {/* keyed so a pane swap (compose ↔ thread) re-fires animate-tab-in — the same
              fade-up the roster tabs use, instead of an instant cut */}
          <div key={openId ?? "compose"} className="animate-tab-in">
            {openId === null ? (
              <ComposeBlock
                api={api}
                onCreated={(threadId) => {
                  void refresh();
                  setOpenId(threadId);
                }}
              />
            ) : (
              <TicketThread
                api={api}
                threadId={openId}
                ticket={tickets?.find((t) => t.id === openId)}
                version={version}
                onOpened={refresh}
                participants={{ user: meIdent(me), dev: SUPPORT }}
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-7 @[620px]:border-t-0 @[620px]:border-r @[620px]:border-white/[0.08] @[620px]:pt-0 @[620px]:pr-9">
          <Eyebrow>Your messages</Eyebrow>
          <div className="flex flex-col gap-0.5">
            <NewMessageRow selected={openId === null} onClick={() => show(null)} />
            {tickets === null ? (
              <Loading />
            ) : tickets.length === 0 ? (
              <EmptyNote>
                Your messages show up here. We read every one and reply right in the thread.
              </EmptyNote>
            ) : (
              tickets.map((t) => (
                <Row
                  key={t.id}
                  leading={<CatAvatar category={t.category} />}
                  title={t.subject || t.category || "Message"}
                  preview={(t.lastSender === "user" ? "You: " : "") + (t.preview ?? "")}
                  time={ago(t.lastMessageAt)}
                  unread={t.unread}
                  selected={t.id === openId}
                  onClick={() => show(t.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// One of the player's tickets, shown in the detail pane: the conversation + a reply composer.
// The row that was clicked (`ticket`) seeds the header instantly, and the primed cache seeds the
// messages — the open call below is just a background mark-read/refresh, so there's no loading
// screen on the way in. No back button: the inbox list stays right beside it.
function TicketThread({
  api,
  threadId,
  ticket,
  version,
  onOpened,
  participants,
}: {
  api: ChatApi;
  threadId: number;
  ticket?: ChatTicket;
  version?: number;
  onOpened: () => void;
  participants: Participants;
}): ReactNode {
  const cached = threadCache.get(threadId);
  const [messages, setMessages] = useState<ChatMessage[] | null>(cached?.messages ?? null);
  const [category, setCategory] = useState<string | null>(cached?.category ?? ticket?.category ?? null);
  const [subject, setSubject] = useState<string | null>(cached?.subject ?? ticket?.subject ?? null);
  const endRef = useScrollToEnd(messages?.length ?? 0);

  useEffect(() => {
    let live = true;
    void api.open(threadId).then((d) => {
      // A failed open keeps whatever the cache showed (and skips the read-resync) instead of
      // blanking a rendered conversation.
      if (!live || !d) return;
      const view: TicketView = { messages: d.messages, category: d.category, subject: d.subject };
      threadCache.set(threadId, view);
      setMessages(view.messages);
      setCategory(view.category);
      setSubject(view.subject);
      onOpened(); // opening marked it read — resync the badge/list
    });
    return () => {
      live = false;
    };
    // Re-runs on a chat poke (version bump): the viewer is looking at the thread, so re-opening
    // both pulls the new reply in and marks it read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, version]);

  return (
    <ThreadShell
      participants={participants}
      self="user"
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
            threadCache.set(threadId, { messages: next, category, subject });
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
export function AdminInbox({
  api,
  me,
  liftBack,
  version,
}: {
  api: ChatApi;
  me?: ChatIdentity;
  liftBack?: (back: (() => void) | null) => void;
  // App bumps this on every relay chat poke — the inbox and any open ticket re-read live.
  version?: number;
}): ReactNode {
  const [tickets, setTickets] = useState<InboxTicket[] | null>(adminCache);
  const [open, setOpen] = useState<InboxTicket | null>(null);

  const refresh = useCallback((): void => {
    void api.admin.inbox().then((t) => {
      if (!t) return; // a failed refresh keeps the last-known list rather than blanking to a spinner
      adminCache = t;
      // The inbox inlines whole conversations (budgeted server-side) — prime the thread cache so
      // clicking any row, even the first time, renders instantly.
      for (const row of t) {
        if (row.messages)
          adminThreadCache.set(row.threadId, { messages: row.messages, name: row.name });
      }
      setTickets(t);
    });
  }, [api]);
  useEffect(refresh, [refresh, version]);

  // Leave the open ticket back to the inbox (reading it cleared the unread flag; reflect that).
  const back = useCallback((): void => {
    setOpen(null);
    refresh();
  }, [refresh]);

  // Hand the back action to the page chrome while a ticket is open (across from the close X).
  useEffect(() => {
    if (!liftBack) return;
    liftBack(open ? back : null);
    return () => liftBack(null);
  }, [liftBack, open, back]);

  // The open thread and the list are keyed so the drill-in/back swap re-fires
  // animate-tab-in (the roster tabs' fade-up) rather than cutting.
  if (open) {
    return (
      <div key={open.threadId} className="animate-tab-in">
        <AdminThread
          api={api}
          ticket={open}
          version={version}
          onBack={back}
          showInlineBack={!liftBack}
          me={me}
        />
      </div>
    );
  }

  if (tickets === null) return <Loading />;
  if (tickets.length === 0) {
    return <p className="py-10 text-center font-sans text-[14px] text-zinc-500">No messages yet.</p>;
  }
  return (
    <div key="list" className="flex animate-tab-in flex-col gap-0.5">
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
  version,
  onBack,
  showInlineBack,
  me,
}: {
  api: ChatApi;
  ticket: InboxTicket;
  version?: number;
  onBack: () => void;
  showInlineBack: boolean;
  me?: ChatIdentity;
}): ReactNode {
  const cached = adminThreadCache.get(ticket.threadId);
  const [messages, setMessages] = useState<ChatMessage[] | null>(cached?.messages ?? null);
  const [name, setName] = useState<string | null>(cached?.name ?? ticket.name);
  const endRef = useScrollToEnd(messages?.length ?? 0);

  // Background mark-read/refresh (the cache already painted the thread); re-runs on a chat poke
  // (version bump) so a player reply lands in the open ticket live. A failed read keeps whatever
  // the cache showed instead of blanking a rendered conversation.
  useEffect(() => {
    let live = true;
    void api.admin.thread(ticket.threadId).then((d) => {
      if (!live || !d) return;
      const nm = d.name ?? ticket.name;
      adminThreadCache.set(ticket.threadId, { messages: d.messages, name: nm });
      setMessages(d.messages);
      if (d.name) setName(d.name);
    });
    return () => {
      live = false;
    };
  }, [api, ticket.threadId, ticket.name, version]);

  return (
    <ThreadShell
      onBack={onBack}
      showInlineBack={showInlineBack}
      participants={{ user: { name: name ?? ticket.userId, avatar: ticket.avatar }, dev: meIdent(me) }}
      self="dev"
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
            adminThreadCache.set(ticket.threadId, { messages: next, name });
            return true;
          }}
        />
      }
    />
  );
}
