import {
  ChevronRight,
  CircleHelp,
  Coffee,
  FileText,
  Inbox,
  MessageCircle,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { APP_VERSION, CHANGELOG } from "./changelog";
import type { ChatBundle } from "./chat";
import { AdminInbox, ChatPanel } from "./chatview";

// Info links from the redesign ("Desktop/Mobile Connections" handoff). Desktop surfaces
// them as a LinkBar footer beneath the game; mobile as a hamburger in the masthead that
// opens a UtilitySheet bottom sheet. Both routes open the same full-screen DetailView
// — a screen that slides over the game, not a modal.
//
// Three links, all internal: Changelog (rolled up from the commit history), How it works
// (what's specific to playing on Discord — scoring, leaderboards, recap/live cards), and
// Send feedback. Structure mirrors the design files; the content is ours.

// Current version + the changelog entries are derived from changelog.md (see ./changelog),
// where the latest release sets APP_VERSION. Re-exported so existing importers of this
// module keep resolving it here.
export { APP_VERSION };

type LinkId = "changelog" | "faq" | "feedback" | "inbox";
type LinkDef = {
  key: string;
  label: string;
  Icon: typeof FileText;
  badge?: boolean;
  // Internal links open a DetailView page; external links open a URL in the browser
  // (with their own sub-line, since they have no page title to borrow). Exactly one is set.
  page?: LinkId;
  href?: string;
  sub?: string;
};

const LINKS: LinkDef[] = [
  {
    key: "changelog",
    label: "Changelog",
    Icon: FileText,
    badge: true,
    page: "changelog",
  },
  { key: "faq", label: "FAQ", Icon: CircleHelp, page: "faq" },
  {
    key: "feedback",
    label: "Feedback",
    Icon: MessageCircle,
    page: "feedback",
  },
  {
    key: "kofi",
    label: "Ko-fi",
    Icon: Coffee,
    href: "https://ko-fi.com/borgardev",
    sub: "Help cover the server costs",
  },
];

// Dev-only entry, appended to the link list when the chat load reports isDev. Opens the admin
// inbox (every player's thread) on the same DetailView the other pages use.
const INBOX_LINK: LinkDef = { key: "inbox", label: "Inbox", Icon: Inbox, page: "inbox" };

// The DetailView header (centered title card): a tracked eyebrow over a big serif title.
// The eyebrow is the section/nav name; the title reads editorial.
const META: Record<LinkId, { eyebrow: string; title: string }> = {
  changelog: {
    eyebrow: `Changelog · ${APP_VERSION}`,
    title: "What’s New",
  },
  faq: {
    eyebrow: "FAQ",
    title: "How to Use",
  },
  feedback: {
    eyebrow: "Feedback",
    title: "Bugs, Ideas, General Thoughts",
  },
  inbox: {
    eyebrow: "Admin",
    title: "Inbox",
  },
};

// ---- content screens ----

// One Q&A pair — a question heading over its answer.
function QA({ q, children }: { q: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-sans text-[15px] font-semibold text-zinc-100">{q}</h3>
      <div className="flex flex-col gap-2 font-sans text-[14px] leading-[1.55] text-zinc-400">
        {children}
      </div>
    </div>
  );
}

// The everyday rules of Connections are assumed — this answers what's specific to playing
// it on Discord, as a Q&A. Copy tracks the real mechanics: the exact score formula (game.ts
// finishedScore / SCORING), the per-channel/server leaderboards, and /enable-posts
// (api/interactions.ts).
const BOLD = "font-semibold text-zinc-100";
function Faq(): ReactNode {
  const cmd =
    "rounded-[5px] bg-white/[0.06] px-[5px] py-px font-semibold text-zinc-300";
  const SCORE_LINES: ReactNode[] = [
    <>
      <b className={BOLD}>Solving the puzzle:</b> a flat{" "}
      <b className={BOLD}>+400</b> for getting all four groups.
    </>,
    <>
      <b className={BOLD}>Speed:</b> up to <b className={BOLD}>+100</b>, full
      for a fast solve and fading to zero by about ten minutes in.
    </>,
    <>
      <b className={BOLD}>Mistakes:</b> <b className={BOLD}>−30</b> each, but
      only when you win.
    </>,
  ];
  return (
    <div className="flex flex-col gap-7">
      <QA q="How does scoring work?">
        <p className="m-0">
          Every puzzle you finish adds to the leaderboard. Here’s the gist:
        </p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {SCORE_LINES.map((it, i) => (
            <li
              key={i}
              className="relative pl-4 before:absolute before:left-0.5 before:top-[9px] before:h-1.25 before:w-1.25 before:rounded-full before:bg-zinc-600 before:content-['']"
            >
              {it}
            </li>
          ))}
        </ul>
        <p className="m-0">
          Solve it fast with a clean board and you hit the cap of{" "}
          <b className={BOLD}>500</b>. Run out of guesses and you still keep
          partial credit for the groups you found — 20 × groups², so up to{" "}
          <b className={BOLD}>80</b>.
        </p>
      </QA>

      <QA q="How do I join a server/channel's leaderboard?">
        <p className="m-0">
          Just play there once. Your first solve in a channel puts you on its
          leaderboard, and the server’s, and you’ll keep showing up every time
          you play after that. Start playing somewhere new and you’ll join that
          board too, without ever dropping off the old ones. Flip between the{" "}
          <b className={BOLD}>Season</b> and <b className={BOLD}>All-time</b>{" "}
          tabs, and the <b className={BOLD}>Channel</b>/
          <b className={BOLD}>Server</b> toggle, next to the players list.
        </p>
      </QA>

      <QA q="How do we enable the who's playing cards and nightly recaps?">
        <p className="m-0">
          Yep. Run <span className={cmd}>/enable-posts</span> to add the bot
          (one tap, though it needs Manage Server, so grab an admin if that’s
          not you). After that the channel gets a{" "}
          <b className={BOLD}>daily recap</b> with yesterday’s results and the
          standings, plus a live <b className={BOLD}>“who’s playing”</b> card
          whenever a game starts.
        </p>
      </QA>

      <QA q="The recap or card isn't showing up in our channel?">
        <p className="m-0">
          The bot’s in your server but can’t post in that specific channel —
          almost always a <b className={BOLD}>private channel</b> its role was
          never added to. Open the channel’s settings, go to{" "}
          <b className={BOLD}>Permissions</b>, and give the{" "}
          <b className={BOLD}>Connections</b> bot (or its role){" "}
          <b className={BOLD}>View Channel</b>,{" "}
          <b className={BOLD}>Send Messages</b>, and{" "}
          <b className={BOLD}>Attach Files</b>. The next nightly recap posts on
          its own.
        </p>
      </QA>
    </div>
  );
}

// Keep-a-Changelog category accents. The label color (and its matching bullet dot) lets you
// scan feature vs. fix at a glance — mirroring the SemVer bump: Added → minor, Fixed → patch,
// a breaking Changed/Removed → major. Unknown labels fall back to a neutral zinc.
const SECTION_TONE: Record<string, { text: string; dot: string }> = {
  Added: { text: "text-[#a3c65b]", dot: "before:bg-[#a3c65b]" },
  Changed: { text: "text-[#7ea8d6]", dot: "before:bg-[#7ea8d6]" },
  Fixed: { text: "text-[#d6a45e]", dot: "before:bg-[#d6a45e]" },
  Deprecated: { text: "text-[#d6a45e]", dot: "before:bg-[#d6a45e]" },
  Removed: { text: "text-[#d67e7e]", dot: "before:bg-[#d67e7e]" },
  Security: { text: "text-[#d67e7e]", dot: "before:bg-[#d67e7e]" },
};
const SECTION_FALLBACK = { text: "text-zinc-500", dot: "before:bg-zinc-600" };

function Changelog(): ReactNode {
  return (
    <div className="flex flex-col gap-7">
      {CHANGELOG.map((e) => (
        <div key={e.v} className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-bold tabular-nums text-zinc-100">
              {e.v}
            </span>
            {e.isNew && (
              <span className="rounded-full bg-[#a0c35a] px-1 py-0.5 text-[8px] font-extrabold uppercase leading-none tracking-[0.04em] text-[#0d1a0d]">
                New
              </span>
            )}
            <span className="ml-auto text-[12px] text-zinc-500">{e.d}</span>
          </div>
          {e.sections.map((s, si) => {
            const tone = SECTION_TONE[s.label] ?? SECTION_FALLBACK;
            return (
              <div key={si} className="flex flex-col gap-1.75">
                {s.label && (
                  <div
                    className={
                      "text-[10.5px] font-bold uppercase tracking-[0.14em] " + tone.text
                    }
                  >
                    {s.label}
                  </div>
                )}
                {s.items.map((it, i) => (
                  <div
                    key={i}
                    className={
                      "relative pl-4 text-[13.5px] leading-[1.45] text-zinc-400 before:absolute before:left-0.5 before:top-2 before:h-1.25 before:w-1.25 before:rounded-full before:content-[''] " +
                      tone.dot
                    }
                  >
                    {it}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Full-screen content view that slides over the game (a screen, not a modal): opaque
// app background, its own header with a back button. Portaled to <body> with fixed
// positioning so it covers the whole game and escapes GameView's desktop scale
// transform (a transformed ancestor would otherwise anchor `fixed` to itself).
// Freeze document scroll while an overlay is mounted, so the game can't scroll behind the
// sheet/detail. The mobile page itself is the scroller (no overflow-y on html/body), so we
// pin <html> overflow; the scroll position is preserved across lock and release. Both
// overlays use it, and they're never mounted at once, so the lock/restore stays balanced.
function useScrollLock(): void {
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = prev;
    };
  }, []);
}

function DetailView({
  id,
  onBack,
  chat,
}: {
  id: LinkId;
  onBack: () => void;
  chat?: ChatBundle;
}): ReactNode {
  useScrollLock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  const m = META[id];
  return createPortal(
    <div className="fixed inset-0 z-50 animate-detail-in bg-zinc-950">
      {/* Close, pinned top-right. We portal to <body>, OUTSIDE #app, so we don't inherit its
        pt-[max(0.75rem,--sait)] mobile-header clearance — pin the button below the safe area
        (floored at the original 1rem for desktop/dev where --sait is 0) so Discord's mobile
        top bar can't cover it. CSS :hover is safe here — closing unmounts the screen on tap,
        so a stranded touch :hover has nothing to sit on. Esc closes it too (above). */}
      <button
        type="button"
        onClick={onBack}
        aria-label="Close"
        className="absolute right-4 top-[max(1rem,var(--sait))] z-10 grid h-9 w-9 cursor-pointer place-items-center rounded-[10px] bg-white/[0.05] text-zinc-400 transition-colors hover:bg-white/[0.09] hover:text-zinc-200 min-[800px]:right-5 min-[800px]:top-5"
      >
        <X size={18} strokeWidth={2.25} aria-hidden />
      </button>
      {/* Content top padding clears the close button AND the same safe area (pt-14 + --sait),
        so the title never tucks under Discord's mobile header either. */}
      <div className="scrollbar-thin h-full overflow-y-auto px-5 pt-[calc(3.5rem_+_var(--sait))] pb-[max(2rem,var(--saib))] min-[800px]:pt-16">
        {/* Feedback/Inbox run wider so the composer and message list can sit side by side; the
          other pages stay in a comfortable reading column. */}
        <div
          className={
            "mx-auto w-full " +
            (id === "feedback" || id === "inbox" ? "max-w-[760px]" : "max-w-[600px]")
          }
        >
          {/* centered title card over a hairline; the content below stays left-aligned */}
          <header className="mb-7 flex flex-col items-center border-b border-white/[0.08] pb-7 text-center">
            <div className="font-sans text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">
              {m.eyebrow}
            </div>
            <h1 className="mt-3.5 font-display text-[34px] font-bold leading-[1.04] tracking-[-0.025em] text-[#efefe6] min-[800px]:text-[40px]">
              {m.title}
            </h1>
          </header>
          {id === "faq" && <Faq />}
          {id === "changelog" && <Changelog />}
          {id === "feedback" && <ChatPanel api={chat?.api} onUnread={chat?.onUnread} />}
          {id === "inbox" && chat && <AdminInbox api={chat.api} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// One row inside the bottom sheet: icon · label (+ "New" / unread dot) · sub · chevron.
function SheetRow({
  l,
  showBadge,
  chatUnread,
  onSelect,
}: {
  l: LinkDef;
  showBadge: boolean;
  chatUnread: boolean;
  onSelect: (l: LinkDef) => void;
}): ReactNode {
  return (
    // Design's `.uitem:hover { background: rgba(255,255,255,0.06) }`. CSS :hover is safe —
    // a row tap closes (unmounts) the sheet, so a stranded :hover has nothing to sit on.
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-transparent p-2.5 text-left transition-colors hover:bg-white/[0.06]"
      onClick={() => onSelect(l)}
    >
      <span className="grid h-9.5 w-9.5 flex-none place-items-center rounded-[10px] bg-white/[0.06] text-zinc-300">
        <l.Icon size={19} strokeWidth={2} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-sans text-[15px] font-semibold text-zinc-100">
          {l.label}
          {showBadge && l.badge && (
            <span className="rounded-full bg-[#a0c35a] px-1.25 py-0.5 text-[8px] font-extrabold uppercase leading-none tracking-[0.04em] text-[#0d1a0d]">
              New
            </span>
          )}
          {l.key === "feedback" && chatUnread && (
            <span className="h-2 w-2 rounded-full bg-[#a0c35a]" aria-label="New reply" />
          )}
        </span>
        <span className="font-sans text-[12px] text-zinc-500">
          {l.page ? META[l.page].title : l.sub}
        </span>
      </span>
      <span className="flex-none text-zinc-600">
        <ChevronRight size={17} strokeWidth={2} aria-hidden />
      </span>
    </button>
  );
}

// Mobile bottom sheet (scrim + sheet) listing the links. Slides up from the bottom.
function UtilitySheet({
  links,
  showBadge,
  chatUnread,
  onSelect,
  onClose,
}: {
  links: LinkDef[];
  showBadge: boolean;
  chatUnread: boolean;
  onSelect: (l: LinkDef) => void;
  onClose: () => void;
}): ReactNode {
  useScrollLock();

  // Swipe-to-dismiss. The sheet follows the finger downward (never up); on release it
  // dismisses if dragged far enough or flicked, else snaps back. The scrim fades with the
  // drag. We pointer-capture so the gesture survives the finger leaving the sheet, and
  // swallow the click after any real drag so a downward swipe never opens a row.
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  // Animated dismiss: slide the sheet down + fade the scrim, then unmount. Every "close"
  // gesture (scrim tap, Escape, swipe-flick) runs through here so the sheet never just
  // vanishes. Idempotent — a second trigger mid-animation is ignored.
  const animateOut = useCallback((): void => {
    if (closing.current) return;
    closing.current = true;
    const el = sheetRef.current;
    if (el) {
      el.style.transition = "transform 0.22s ease-out";
      el.style.transform = "translateY(110%)";
    }
    if (scrimRef.current) {
      scrimRef.current.style.transition = "opacity 0.22s ease-out";
      scrimRef.current.style.opacity = "0";
    }
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") animateOut();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [animateOut]);

  const drag = useRef({
    startY: 0,
    down: false,
    dragging: false,
    dy: 0,
    moved: false,
    lastY: 0,
    lastT: 0,
    vy: 0,
  });

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = {
      startY: e.clientY,
      down: true,
      dragging: false,
      dy: 0,
      moved: false,
      lastY: e.clientY,
      lastT: e.timeStamp,
      vy: 0,
    };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d.down) return;
    const dy = e.clientY - d.startY;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vy = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    // Commit to a drag only once it's clearly downward. Capturing the pointer up front
    // would steal the click from the row under the finger, so a tap could never open a link.
    if (!d.dragging && dy > 6) {
      d.dragging = true;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (sheetRef.current) sheetRef.current.style.transition = "none";
    }
    if (d.dragging) {
      const off = Math.max(0, dy);
      d.dy = off;
      if (sheetRef.current)
        sheetRef.current.style.transform = `translateY(${off}px)`;
      if (scrimRef.current)
        scrimRef.current.style.opacity = String(Math.max(0.15, 1 - off / 320));
    }
  };
  const onUp = (): void => {
    const d = drag.current;
    d.down = false;
    if (!d.dragging) return; // a tap, not a drag — let the click open the row
    const el = sheetRef.current;
    if (!el) return;
    const dismiss = d.dy > 80 || (d.vy > 0.6 && d.dy > 24);
    if (dismiss) {
      animateOut();
    } else {
      el.style.transition = "transform 0.22s ease-out";
      el.style.transform = "translateY(0)";
      if (scrimRef.current) {
        scrimRef.current.style.transition = "opacity 0.22s ease-out";
        scrimRef.current.style.opacity = "1";
      }
    }
  };

  return createPortal(
    <div
      ref={scrimRef}
      className="fixed inset-0 z-50 flex animate-overlay-fade items-end justify-center bg-[rgba(6,6,8,0.62)] backdrop-blur-[3px]"
      onClick={animateOut}
    >
      <div
        ref={sheetRef}
        className="w-full max-w-[520px] touch-none animate-sheet-up rounded-t-[20px] border-t border-white/10 bg-[#141417] px-2.5 pt-2 pb-[max(1.25rem,var(--saib))] shadow-[0_-16px_50px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        onClickCapture={(e) => {
          // A drag just happened; eat the click so it doesn't open the row under the finger.
          if (drag.current.moved) {
            e.stopPropagation();
            drag.current.moved = false;
          }
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* Grab handle: the swipe-down affordance (no header/close button anymore). */}
        <div className="mx-auto mb-3 mt-1 h-1.5 w-10 rounded-full bg-zinc-600" />
        <div className="flex flex-col gap-0.5">
          {links.map((l) => (
            <SheetRow
              key={l.key}
              l={l}
              showBadge={showBadge}
              chatUnread={chatUnread}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Desktop footer: a full-width link row beneath the game. Each link opens the DetailView.
// Version sits at the far right.
function LinkBar({
  links,
  showBadge,
  chatUnread,
  onSelect,
  onRedo,
  className = "",
}: {
  links: LinkDef[];
  showBadge: boolean;
  chatUnread: boolean;
  onSelect: (l: LinkDef) => void;
  onRedo?: () => void; // dev-only "Refresh" (replay today); undefined for everyone else
  className?: string;
}): ReactNode {
  const linkCls =
    "inline-flex items-center gap-1.75 font-sans text-[12px] font-medium text-zinc-500 transition-colors";
  return (
    <div
      className={
        "flex items-center gap-4.5 border-t border-white/[0.07] bg-white/[0.012] px-5.5 py-3.25 " +
        className
      }
    >
      {links.map((l) => (
        // CSS :hover (not HoverButton): the footer is desktop-only (mouse), and a real
        // `hover:` variant reliably beats the base text-zinc-500 — a plain appended class
        // loses to it on source order. Matches the design's `.lbl-link:hover { color:
        // zinc-100 }`; transition-colors fades the label and the icon stroke together.
        <button
          key={l.key}
          type="button"
          onClick={() => onSelect(l)}
          className={
            linkCls + " cursor-pointer bg-transparent hover:text-zinc-100"
          }
        >
          <l.Icon size={14} strokeWidth={2} aria-hidden />
          <span>{l.label}</span>
          {showBadge && l.badge && (
            <span className="h-1.5 w-1.5 rounded-full bg-[#a0c35a]" />
          )}
          {l.key === "feedback" && chatUnread && (
            <span className="h-1.5 w-1.5 rounded-full bg-[#a0c35a]" aria-label="New reply" />
          )}
        </button>
      ))}
      {onRedo && (
        // Dev-only: clear today's progress and replay. ml-auto pushes it (and the version after
        // it) to the right edge.
        <button
          type="button"
          onClick={onRedo}
          title="Dev: clear today's progress and replay"
          className={linkCls + " ml-auto cursor-pointer bg-transparent hover:text-zinc-100"}
        >
          <RefreshCw size={14} strokeWidth={2} aria-hidden />
          <span>Refresh</span>
        </button>
      )}
      <span className="ml-auto font-sans text-[11px] tabular-nums text-zinc-700">
        {APP_VERSION}
      </span>
    </div>
  );
}

// Controller wiring the two entry points (desktop footer link-bar + the mobile masthead's
// hamburger) to one DetailView, with a shared "New" badge gate. GameView renders `footer`
// under the game (desktop) and `overlays` once (the bottom sheet + detail screen, portaled
// to <body>); on mobile it draws its own hamburger in the masthead, wired to the returned
// `openMenu` / `hasNew` (so the trigger is an in-flow header element, not a button floating
// over the scrolling roster).
export function useInfoLinks(
  chat?: ChatBundle,
  onOpenExternal?: (url: string) => void,
): {
  footer: (className?: string) => ReactNode;
  overlays: ReactNode;
  openMenu: () => void;
  hasNew: boolean;
} {
  const [active, setActive] = useState<LinkId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Whether the open detail was reached via the mobile sheet. If so, closing it returns to
  // the sheet (slid back up) rather than all the way to the game; the desktop footer opens
  // a detail directly, so closing there just returns to the game.
  const [fromSheet, setFromSheet] = useState(false);
  // Show the "New" badge until the player has opened the current version's changelog.
  const [seen, setSeen] = useState<string | null>(() => readSeen());
  const showBadge = seen !== APP_VERSION;
  // A dev (per the chat load) also gets the admin Inbox entry; everyone sees the unread dot
  // for a reply waiting on their own thread.
  const links = chat?.isDev ? [...LINKS, INBOX_LINK] : LINKS;
  const chatUnread = !!chat?.unread;

  const markSeen = (id: LinkId): void => {
    if (id === "changelog" && seen !== APP_VERSION) {
      writeSeen(APP_VERSION);
      setSeen(APP_VERSION);
    }
  };
  // From the desktop footer: straight to the detail, no sheet to come back to.
  const open = (id: LinkId): void => {
    markSeen(id);
    setFromSheet(false);
    setActive(id);
  };
  // From the mobile sheet: close the sheet under the detail, but remember to bring it back.
  const openFromSheet = (id: LinkId): void => {
    markSeen(id);
    setMenuOpen(false);
    setFromSheet(true);
    setActive(id);
  };
  const closeDetail = (): void => {
    setActive(null);
    if (fromSheet) {
      setFromSheet(false);
      setMenuOpen(true); // slide the sheet back up
    }
  };
  // External links (e.g. Ko-fi) open in the browser. Embedded, App routes this through the
  // Discord SDK's openExternalLink (consent prompt); standalone (preview/landing) we just
  // window.open. A link is internal (a page) or external (an href), never both.
  const goExternal = (url: string): void => {
    if (onOpenExternal) onOpenExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  const selectFromFooter = (l: LinkDef): void => {
    if (l.href) goExternal(l.href);
    else if (l.page) open(l.page);
  };
  const selectFromSheet = (l: LinkDef): void => {
    if (l.href) {
      goExternal(l.href);
      setMenuOpen(false);
    } else if (l.page) openFromSheet(l.page);
  };

  // Dev-only "Refresh": clear today's progress server-side, then reload to replay from a clean
  // board. Same gate as the Inbox entry (chat.isDev, resolved server-side from DEV_DISCORD_IDS).
  // Desktop only — it lives in LinkBar, which the mobile sheet never renders.
  let onRedo: (() => void) | undefined;
  if (chat?.isDev) {
    const api = chat.api;
    onRedo = () => {
      void api.admin.resetProgress().then((ok) => {
        if (ok) window.location.reload();
      });
    };
  }

  return {
    footer: (className = "") => (
      <LinkBar
        links={links}
        showBadge={showBadge}
        chatUnread={chatUnread}
        onSelect={selectFromFooter}
        onRedo={onRedo}
        className={className}
      />
    ),
    // The mobile masthead owns the hamburger; it opens the same sheet the footer's links do.
    openMenu: () => setMenuOpen(true),
    hasNew: showBadge || chatUnread,
    overlays: (
      <>
        {menuOpen && (
          <UtilitySheet
            links={links}
            showBadge={showBadge}
            chatUnread={chatUnread}
            onSelect={selectFromSheet}
            onClose={() => setMenuOpen(false)}
          />
        )}
        {active && <DetailView id={active} onBack={closeDetail} chat={chat} />}
      </>
    ),
  };
}

// ---- "New" badge gate: remember the last changelog version the player opened, so the
// badge only shows when there's something unseen. Storage can be blocked in the Activity
// iframe; a blocked read just means "show it" and a blocked write is a silent no-op. ----
const SEEN_KEY = "conn-changelog-seen";
function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
function writeSeen(v: string): void {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* blocked iframe — nothing to remember */
  }
}
