import {
  Check,
  Clock,
  Copy,
  Eraser,
  Image as ImageIcon,
  Lightbulb,
  Link as LinkIcon,
  LoaderCircle,
  Share2,
  Shuffle as ShuffleIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { Game, LEVELS, MAX_MISTAKES, shuffle, type Group } from "./game";
import { HoverButton } from "./hoverbutton";

// Playable board + solve animations (correct: pop, FLIP gather, morph to bar;
// wrong: shake, spend a dot; end: fade controls, reveal missed groups on loss).
// Keeps a parallel display model because Game resolves a guess atomically but
// the FLIP sequence needs the intermediate states.

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Final solve time, MM:SS, for the end-screen score summary.
const fmtClock = (ms: number | null): string => {
  const s = Math.max(1, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Where a shared grid points friends to come play: the public landing page, which carries
// the "Add to Discord" button. Bare domain reads cleaner than a full URL and the major
// share targets (Discord, X, iMessage) still linkify it.
const PLAY_URL = "disconnections.app";

// The shareable result as plain text — same shape as the /share Discord card
// (api/interactions.ts shareCard): a Wordle-style title line, the spoiler-free emoji grid
// (one row per guess, no group names), dots · time · score, then the play URL so a recipient
// knows where it's from and can come play. Fed to the OS share sheet or copied to the
// clipboard by the end-screen Share button.
function buildShareText(game: Game): string {
  const mistakes = MAX_MISTAKES - game.mistakesLeft;
  const dots = "⚪".repeat(game.mistakesLeft) + "⚫".repeat(mistakes);
  const title = `Disconnections #${game.puzzle.id} ${game.groupsSolved}/4`;
  const stats = [
    dots,
    fmtClock(game.durationMs),
    `${game.score.toLocaleString()} pts`,
  ].join(" · ");
  return `${title}\n${game.shareGrid()}\n${stats}\n${PLAY_URL}`;
}

// What a Discord share attempt ended up doing, so the footer can confirm the right thing:
// "shared" = Discord's own share modal opened (it IS the confirmation, so we stay quiet),
// "copied" = no share modal here, the link went to the clipboard instead, "failed" = neither.
export type ShareOutcome = "shared" | "copied" | "failed";

// Copy with a legacy fallback: the async Clipboard API is the happy path, but the
// Activity iframe can lack clipboard-write permission, so fall back to a throwaway
// <textarea> + execCommand. Returns whether the copy landed.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Brand glyphs the share menu needs that no icon set carries (logos, not icons): Discord's
// clyde and X's mark, from simple-icons' official paths (CC0). Filled with currentColor so
// they sit in the rows' zinc exactly like the lucide strokes beside them.
function DiscordIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  );
}

// One row of the breakdown popover: a tiny caption on the left, its signed point value
// right-aligned. `neg` greys the mistakes deduction (vs the emerald additions); `total`
// is the sum the rest add up to — set off above by a hairline rule and voiced in the
// serif score face, the same hierarchy the bar's +score uses.
function BreakRow({
  caption,
  value,
  neg,
  total,
}: {
  caption: string;
  value: string;
  neg?: boolean;
  total?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between gap-8 leading-none " +
        (total ? "mt-1.5 border-t border-white/10 pt-2" : "")
      }
    >
      <span
        className={
          "text-[10px] font-semibold uppercase tracking-[0.1em] " +
          (total ? "text-zinc-300" : "text-zinc-500")
        }
      >
        {caption}
      </span>
      <span
        className={
          "tabular-nums leading-none " +
          (total
            ? "font-display text-[20px] font-bold tracking-[-0.01em] text-[#e8eaee]"
            : "text-[13.5px] font-bold " +
              (neg ? "text-zinc-400" : "text-emerald-400"))
        }
      >
        {value}
      </span>
    </div>
  );
}

// One row of the share menu: the action in words on the left, its glyph right-aligned —
// the same left-caption/right-mark geometry BreakRow uses, so the two popovers read as
// siblings. Sized for a thumb (40px min) rather than for the popover's compact type, and
// hovered mouse-only (HoverButton): the menu outlives a tap, so a CSS :hover would stick to
// whatever finger last touched it. `pending` swaps the glyph for a spinner and, with
// `disabled`, blocks a second tap while the first is still working.
function ShareRow({
  label,
  icon,
  pending,
  disabled,
  tabbable,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  pending?: boolean;
  disabled?: boolean;
  // The menu stays mounted while closed (it needs both classes for the pop transition), so
  // its rows are pulled out of the tab order until it opens — .sb-pop's pointer-events:none
  // only stops the mouse.
  tabbable?: boolean;
  onSelect: () => void;
}) {
  return (
    <HoverButton
      type="button"
      role="menuitem"
      className="flex min-h-10 w-full cursor-pointer items-center justify-between gap-8 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-out active:bg-white/[0.09] disabled:cursor-default disabled:opacity-55"
      hover="bg-white/[0.06]"
      disabled={disabled}
      tabIndex={tabbable ? undefined : -1}
      onClick={onSelect}
    >
      <span className="text-[13.5px] font-semibold leading-none text-zinc-100">
        {label}
      </span>
      <span className="flex-none text-zinc-400">
        {pending ? (
          <LoaderCircle
            size={16}
            strokeWidth={2.5}
            className="animate-spin"
            aria-hidden
          />
        ) : (
          icon
        )}
      </span>
    </HoverButton>
  );
}

// End-screen footer. The run summary, two clusters at the far edges with room to breathe:
// mistake dots (left), and the stats + action (right) — the clock-icon solve-time chip, a
// hairline divider, the serif score, then the Share button (where the ⓘ used to sit). The
// next-puzzle countdown lives under the players list (see Roster), not here. Tapping the
// score pops the itemized breakdown (solved, speed, mistakes → total) as a
// floating tooltip ABOVE the score — a quick scale/rise pop with a caret pointing back at
// it — while the summary stays put underneath. On a live finish the breakdown self-reveals
// a beat after the bar settles (autoOpen), so it's seen without an ⓘ to hunt for; tap the
// score again, or tap/Esc outside, to dismiss. It never opens on hover (this ships as a
// Discord Activity where CSS :hover sticks after a tap). The Share button pops up on the
// right as the bar fades in (see endGame); rehydrated finishes render at rest, closed.
// ONE Share button, not a row of them: every way a result leaves the app (into Discord, as
// an image, as text, to X, out through the OS sheet) hangs off it in a menu popover — the
// breakdown's twin, same pop, same dismiss. Which rows exist is decided by what actually
// works here (see the gates below), so the menu is never a list of dead ends; the two
// popovers are mutually exclusive, since they'd otherwise overlap over the same score.
// Losses read the same: partial-credit categories, a 0 speed.
// `note` is the transient "Couldn’t save that guess" warning for a commit that fails
// after the game ends (the final guess's commit usually resolves mid-end-choreography):
// it rides a face that overlays the bar (and outranks the reveal) because the
// playing-state Submit pill — the note's home during play — is gone, and the old slot
// (the desktop header's date) is hidden on mobile, which made the warning invisible
// exactly where scores matter.
function EndSummary({
  game,
  note,
  autoOpen,
  onShareLink,
  onCopyImage,
  onCopyLink,
  onExternal,
}: {
  game: Game;
  note?: string | null;
  // True only on a live finish — the breakdown then self-reveals once the entrance
  // settles, so the points makeup is seen without a trigger. Off on rehydrated finishes.
  autoOpen?: boolean;
  // Post the result into Discord as a share card (a quick link: our result image, a
  // description, and a Play button). Present only inside the Activity on the official
  // daily — everywhere else the menu drops the row. See App.tsx shareResult.
  onShareLink?: () => Promise<ShareOutcome>;
  // Put the result image (the same PNG the share card carries) on the clipboard, for the
  // chats Discord's share modal can't reach. Resolves false if the mint or the write
  // failed. Gated like onShareLink — the image is minted from the server's record — and
  // the row additionally needs a clipboard that takes images. See App.tsx copyResultImage.
  onCopyImage?: () => Promise<boolean>;
  // Put the PERMANENT url of that same card on the clipboard, as text — a link that re-renders
  // the result forever, for the chats and pages a pasted image can't live in. Gated like
  // onShareLink; unlike Copy image it needs nothing of the clipboard but text, so it's the row
  // that still works in the desktop app. See App.tsx copyResultLink.
  onCopyLink?: () => Promise<boolean>;
  // Open a URL outside the app (the "Post on X" row). Embedded it must route through the
  // Discord SDK's leave-app consent, so the footer never calls window.open itself.
  onExternal?: (url: string) => void;
}) {
  const b = game.scoreBreakdown;
  const won = game.status === "won";
  const perfect = won && game.mistakesLeft === MAX_MISTAKES;
  const label = perfect ? "Perfect" : won ? "Solved" : "Failed";
  const [pinned, setPinned] = useState(false);
  // Is the share menu up? Never at the same time as the breakdown — they'd stack over the
  // same corner — so each opener closes the other.
  const [menuOpen, setMenuOpen] = useState(false);
  // Transient confirmation chip ("Copied!", "Couldn’t share"). One slot, one message.
  const [flash, setFlash] = useState<string | null>(null);
  // A share is a render plus two round-trips, so the button holds a pending state rather
  // than looking dead. Also the re-entry guard: a double tap can't mint twice.
  const [sharing, setSharing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | null>(null);
  const autoOpenTimer = useRef<number | null>(null);
  const showNote = note != null;
  // Tapping the score toggles the breakdown popover (tap-only, no hover-open: a tap on
  // touch would strand a sticky :hover). Suppressed while a save-note shows, and while the
  // share menu holds the corner (the autoOpen self-reveal can't muscle in either).
  const open = pinned && !showNote && !menuOpen;
  const menu = menuOpen && !showNote;
  const shareText = buildShareText(game);
  // NO native-sheet ("Share…") row: navigator.share is untrustworthy in the one place this
  // menu ships (the Discord iframe) — on some mobile WebViews the function EXISTS but the
  // call is killed by the iframe's permissions policy, so a presence check shows a row that
  // then does nothing (owner-tested, 2026-08-14). Copy image / Copy link / Copy text are the
  // way out.
  // Can the clipboard hold a PNG? Safari/Chrome can, Firefox's write() is behind a flag,
  // and older webviews have no ClipboardItem at all — where it's missing the row is a dead
  // end, so it doesn't render.
  const canCopyImage =
    !!onCopyImage &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function";
  // hold the last note text through the face's fade-out, so the words don't vanish
  // a beat before the opacity does.
  const lastNote = useRef("");
  if (note) lastNote.current = note;

  // Tap/Esc outside the footer closes whichever popover is up (breakdown or share menu).
  useEffect(() => {
    if (!pinned && !menuOpen) return;
    const closeAll = (): void => {
      setPinned(false);
      setMenuOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeAll();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeAll();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned, menuOpen]);

  useEffect(
    () => () => {
      if (copiedTimer.current != null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Self-reveal the breakdown a beat after a live finish — once the bar's entrance has
  // settled — so the points makeup is seen without hunting for a trigger (it replaces the
  // old ⓘ affordance). Only on a fresh finish; a rehydrated end footer stays closed.
  useEffect(() => {
    if (!autoOpen) return;
    autoOpenTimer.current = window.setTimeout(() => setPinned(true), 650);
    return () => {
      if (autoOpenTimer.current != null) clearTimeout(autoOpenTimer.current);
    };
  }, [autoOpen]);

  // The two popovers share one corner, so each opener closes the other.
  const toggleBreakdown = (): void => {
    setMenuOpen(false);
    setPinned((p) => !p);
  };
  const toggleMenu = (): void => {
    setPinned(false);
    setMenuOpen((m) => !m);
  };

  const flashMsg = (text: string): void => {
    setFlash(text);
    if (copiedTimer.current != null) clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setFlash(null), 1800);
  };
  const flashCopied = (ok: boolean): void => {
    if (ok) flashMsg("Copied!");
  };

  // Share into Discord. The mint + the native share modal both live in App.tsx (it owns the
  // SDK and the token); this only drives the pending state and confirms the outcome. The
  // menu stays open, pending, while the card mints — closing it would leave a tap with
  // nothing to show for itself — and shuts once we know what happened. A clipboard fallback
  // flashes "Copied!" exactly like the Copy rows, so they never disagree about what just
  // happened.
  const onDiscordShare = (): void => {
    if (!onShareLink || sharing) return;
    setSharing(true);
    void onShareLink()
      .then((outcome) => {
        // "shared" needs no chip: Discord's own share modal is the confirmation.
        if (outcome === "copied") flashMsg("Copied!");
        else if (outcome === "failed") flashMsg("Couldn’t share");
      })
      .catch(() => flashMsg("Couldn’t share"))
      .finally(() => {
        setSharing(false);
        setMenuOpen(false);
      });
  };

  // Copy the result image. onCopyImage builds its clipboard write inside this gesture (see
  // App.tsx copyResultImage — iOS insists), so nothing may be awaited before calling it;
  // closing the menu is a state set, which doesn't yield the gesture.
  const onCopyImageRow = (): void => {
    if (!onCopyImage) return;
    setMenuOpen(false);
    void onCopyImage().then((ok) => flashMsg(ok ? "Copied!" : "Couldn’t copy"));
  };

  // Copy the permanent link to the result card. Text, not bytes, so there's no clipboard
  // capability to test for and no gesture to preserve — this one can await its round-trip.
  // Same fire-and-flash shape as Copy image otherwise: the menu closes on the tap and the chip
  // reports what happened.
  const onCopyLinkRow = (): void => {
    if (!onCopyLink) return;
    setMenuOpen(false);
    void onCopyLink().then((ok) => flashMsg(ok ? "Copied!" : "Couldn’t copy"));
  };

  // Copy the grid as text — the fallback that works everywhere, so it's the one row with
  // no gate on it.
  const onCopyText = (): void => {
    setMenuOpen(false);
    void copyToClipboard(shareText).then(flashCopied);
  };

  // Hand the grid to X's composer, prefilled. Routed out through onExternal because
  // embedded we can only leave via Discord's own leave-app consent.
  const onPostToX = (): void => {
    if (!onExternal) return;
    setMenuOpen(false);
    onExternal(
      `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`,
    );
  };

  return (
    <div
      ref={ref}
      className="relative flex items-center [-webkit-tap-highlight-color:transparent]"
    >
      {/* SUMMARY ROW — always present (it dims under a save-note). Mistake dots on the left;
          on the right the stats (solve-time · divider · status+score) and the Share button,
          which now sits where the ⓘ used to. The breakdown is a popover anchored above the
          score — it self-reveals on finish (see autoOpen), so there's no ⓘ affordance. */}
      <div
        className={
          "flex min-w-0 flex-1 items-center gap-3 transition-opacity duration-200 ease-out max-[360px]:gap-2 " +
          (showNote ? "pointer-events-none opacity-0" : "opacity-100")
        }
      >
        {/* LEFT — mistake dots */}
        <span
          className="inline-flex flex-none items-center gap-1.75"
          aria-label="Guesses left"
        >
          {Array.from({ length: MAX_MISTAKES }, (_, i) => (
            <span
              key={i}
              className={
                "inline-block h-3.5 w-3.5 rounded-full " +
                (i < game.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
              }
            />
          ))}
        </span>
        {/* CONFIRMATION CHIP — "Copied!" / "Couldn’t share" pops here, the dead space between
            the dots and the stats: the same stage (and cream-chip look) the in-play "One away…"
            hint uses. The chip is absolute (centred by the flex alignment, so it doesn't widen
            the row) and nowrap — it overhangs rather than squeezing the stats on narrow
            layouts; opaque + shadowed + z-raised so it reads over whatever it covers. The
            sr-only twin announces it. */}
        <div className="relative flex min-w-0 flex-1 items-center justify-center self-stretch">
          <span
            aria-hidden
            className={
              "pointer-events-none absolute z-20 whitespace-nowrap rounded-full bg-[#e8eaee] px-3.5 py-2 text-[11px] font-bold uppercase leading-none tracking-[0.08em] text-[#121212] shadow-[0_3px_12px_rgba(0,0,0,0.45)] transition-all duration-200 ease-[cubic-bezier(.34,1.56,.64,1)] max-[420px]:px-3 max-[420px]:text-[10px] max-[420px]:tracking-[0.04em] " +
              (flash ? "scale-100 opacity-100" : "scale-90 opacity-0")
            }
          >
            {flash ?? "Copied!"}
          </span>
          <span className="sr-only" role="status">
            {flash ?? ""}
          </span>
        </div>
        {/* RIGHT — solve-time · divider · status+score, then the Share button on the far
            edge (its menu pops above it). */}
        <div className="flex min-w-0 flex-none items-center gap-3.5 max-[360px]:gap-2.5">
          {/* Score cluster — taps to toggle the breakdown. Wrapped so the popover anchors to
              it (caret points at the score, not the Share button to its right). */}
          <div className="relative flex min-w-0 items-center self-stretch">
            <div
              className="flex min-w-0 cursor-pointer items-center gap-3.5 self-stretch select-none max-[360px]:gap-2.5"
              role="button"
              tabIndex={0}
              aria-label="Score breakdown"
              aria-expanded={open}
              onClick={toggleBreakdown}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleBreakdown();
                }
              }}
            >
              <div className="flex items-center gap-2 text-[15px] font-semibold tabular-nums text-zinc-400">
                <Clock
                  size={15}
                  strokeWidth={2.25}
                  className="flex-none text-zinc-500"
                  aria-hidden
                />
                <span>{fmtClock(game.durationMs)}</span>
              </div>
              <span
                className="my-1 w-px flex-none self-stretch bg-white/10"
                aria-hidden
              />
              <div className="flex min-w-0 flex-col items-end gap-0.75">
                <span
                  className={
                    "text-right text-[10px] font-semibold uppercase leading-tight tracking-[0.16em] " +
                    (won ? "text-emerald-400" : "text-zinc-400")
                  }
                >
                  {label}
                </span>
                <span className="font-display text-[26px] font-bold leading-none tracking-[-0.02em] text-[#e8eaee]">
                  +{game.score.toLocaleString()}
                </span>
              </div>
            </div>
            {/* BREAKDOWN POPOVER — pops up above the score: the additive makeup landing on
                the total, a caret pointing back down at the score. Mounted always;
                .sb-pop-open drives the scale/rise pop (see index.css). */}
            <div
              aria-hidden={!open}
              role="region"
              aria-label="Score breakdown"
              className={
                "sb-pop absolute bottom-full right-0 z-30 mb-2.5 w-max min-w-[178px] rounded-xl border border-white/12 bg-[#1c1c1e] px-3.5 py-2.5 shadow-[0_12px_34px_rgba(0,0,0,0.55)] " +
                (open ? "sb-pop-open" : "")
              }
            >
              <div className="flex flex-col gap-2">
                <BreakRow
                  caption={won ? "Solved" : "Categories"}
                  value={`+${b.completion}`}
                />
                <BreakRow caption="Speed" value={won ? `+${b.speed}` : "+0"} />
                <BreakRow
                  caption="Mistakes"
                  value={won ? `−${b.penalty}` : "−0"}
                  neg
                />
                {b.hints > 0 && (
                  <BreakRow
                    caption={`Hints (${b.hints})`}
                    value={won ? `−${b.hintPenalty}` : "−0"}
                    neg
                  />
                )}
                <BreakRow
                  caption="Total"
                  value={`+${game.score.toLocaleString()}`}
                  total
                />
              </div>
              <span className="sb-pop-caret" aria-hidden />
            </div>
          </div>
          {/* SHARE — one button on the far edge, wearing the filled treatment (the round
              twin of BTN_PRIMARY) because it's the end screen's only action, and every way
              a result leaves the app hangs off it. Wrapped so the menu anchors to the
              button rather than to the row. */}
          <div className="relative flex flex-none items-center">
            <HoverButton
              data-end="share"
              className={BTN_ICON_PRIMARY}
              hover="opacity-85"
              onClick={toggleMenu}
              disabled={sharing}
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label="Share your result"
              title="Share your result"
            >
              {/* Share2 is right-heavy (one node left, two right), so nudge it left a hair
                  to sit optically centred in the round button. */}
              <Share2
                size={18}
                strokeWidth={2.5}
                className="-translate-x-[0.75px]"
                aria-hidden
              />
              <span className="sr-only">Share</span>
            </HoverButton>
            {/* SHARE MENU — the breakdown popover's twin (same card, same pop, same
                dismiss), anchored above the button. Copies lead (they resolve instantly,
                no round-trip, no leaving the app), then the destinations. Rows only appear
                where they'd actually work: Discord's share modal, the result image, and the
                permanent card link all need the Activity and a server record, X needs a way
                out of the iframe. Copy emoji grid is the floor — it works everywhere, so the
                menu is never empty.
                Mounted always; .sb-pop-open drives the pop (see index.css), so closed rows
                leave the tab order by hand. */}
            <div
              role="menu"
              aria-hidden={!menu}
              aria-label="Share your result"
              className={
                "sb-pop absolute bottom-full right-0 z-30 mb-2.5 flex w-max min-w-[190px] flex-col rounded-xl border border-white/12 bg-[#1c1c1e] p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.55)] " +
                (menu ? "sb-pop-open" : "")
              }
            >
              {canCopyImage && (
                <ShareRow
                  label="Copy image"
                  icon={<ImageIcon size={16} strokeWidth={2.5} aria-hidden />}
                  tabbable={menu}
                  onSelect={onCopyImageRow}
                />
              )}
              <ShareRow
                label="Copy emoji grid as text"
                icon={<Copy size={16} strokeWidth={2.5} aria-hidden />}
                tabbable={menu}
                onSelect={onCopyText}
              />
              {onCopyLink && (
                <ShareRow
                  label="Copy image link"
                  icon={<LinkIcon size={16} strokeWidth={2.5} aria-hidden />}
                  tabbable={menu}
                  onSelect={onCopyLinkRow}
                />
              )}
              {onShareLink && (
                <ShareRow
                  label="Share to Discord"
                  icon={<DiscordIcon />}
                  pending={sharing}
                  disabled={sharing}
                  tabbable={menu}
                  onSelect={onDiscordShare}
                />
              )}
              {onExternal && (
                <ShareRow
                  label="Post on X"
                  icon={<XIcon />}
                  tabbable={menu}
                  onSelect={onPostToX}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* NOTE — the rare post-game "couldn’t save" warning; overlays the bar and
          outranks the reveal while it shows (open is forced false), then fades back.
          role=status announces it (the playing-state pill's aria-live is gone by now). */}
      <div
        role="status"
        aria-hidden={!showNote}
        className={
          "absolute inset-0 flex items-center justify-center text-balance text-[12.5px] font-bold text-zinc-100 transition-opacity duration-300 ease-out " +
          (showNote ? "opacity-100" : "pointer-events-none opacity-0")
        }
      >
        {note ?? lastNote.current}
      </div>
    </div>
  );
}

const TILE =
  "relative h-[var(--tile-h)] min-w-0 rounded-lg font-extrabold uppercase tracking-[0.01em] leading-none px-1.5 flex items-center justify-center cursor-pointer select-none transition duration-150 ease-out";
// Ideal/ceiling word size (responsive); FitText only shrinks below this to fit.
const TILE_TEXT = "block w-full text-center text-[clamp(9px,3vw,17px)]";

// Solved-bar text. The bar height is fixed (--tile-h, up to 80px), so a category
// and/or answer list that wraps to two lines has to fit four total lines without
// overflowing. Phone portrait stays vw-governed (~13px / ~12px) and was already
// fine, so only the upper cap is pulled in — on wide layouts the font otherwise
// pins at the ceiling while the board sits in the narrow left half of the 50/50
// split, where 18px/16px crowded (and slightly overflowed) the four-line case.
// Shared by the plain solved bar and the SpoilerBar so the two never drift.
const BAR_CAT =
  "text-balance font-extrabold uppercase tracking-tight text-[clamp(12px,3.4vw,16px)] leading-tight";
const BAR_MEMBERS =
  "text-balance uppercase text-[clamp(10px,3vw,13px)] leading-tight";

// Tile word, auto-fitted to the tile like NYT Connections: short words render at the
// responsive ceiling; a word that would touch the edges has its font scaled down
// (never the tile padding) until it fits the content box — measured, not guessed, so
// it holds at any tile width. Multi-word entries wrap at spaces first; a single token
// that still won't fit at the floor breaks as an absolute last resort so nothing spills.
function FitText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const FLOOR = 6;
    const fit = (): void => {
      el.style.fontSize = "";
      el.style.overflowWrap = "normal";
      const cs = getComputedStyle(box);
      const availH =
        box.clientHeight -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom);
      const fits = (): boolean =>
        el.scrollWidth <= el.clientWidth + 0.5 &&
        el.scrollHeight <= availH + 0.5;
      if (el.clientWidth <= 0 || fits()) return; // fits at the ceiling → keep it
      let lo = FLOOR;
      let hi = parseFloat(getComputedStyle(el).fontSize); // the resolved ceiling
      let best = FLOOR;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = mid + "px";
        if (fits()) {
          best = mid;
          lo = mid;
        } else hi = mid;
      }
      el.style.fontSize = best + "px";
      if (!fits()) el.style.overflowWrap = "anywhere";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    let live = true;
    // the bold sans webfont can swap in after first paint and change metrics
    void document.fonts?.ready.then(() => live && fit()).catch(() => {});
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [text]);
  return (
    <span ref={ref} className={TILE_TEXT}>
      {text}
    </span>
  );
}

// April-Fools "image puzzle" support (e.g. 2025-04-01): some cards are SVG glyphs,
// not text. The word stays the card's identity everywhere; only these faces render
// the image. Routed through the same-origin /api/card-image proxy so it loads inside
// Discord's iframe CSP (external NYT hosts are blocked there) and in a plain browser.
const cardImageSrc = (url: string): string =>
  `/api/card-image?u=${encodeURIComponent(url)}`;

// One tile's face: the card image if this word has one, else the auto-fit word. The
// glyph SVGs are bare black paths, so they read on the light/colored faces as-is and
// invert to white on the dark selected tile — matching NYT.
function TileFace({
  word,
  src,
  selected,
}: {
  word: string;
  src?: string;
  selected: boolean;
}) {
  if (!src) return <FitText text={word} />;
  return (
    <img
      src={cardImageSrc(src)}
      alt={word}
      draggable={false}
      className={
        "pointer-events-none h-[60%] w-[72%] object-contain" +
        (selected ? " invert" : "")
      }
    />
  );
}

// The four answers on a solved/spoiler bar: a row of glyph images for an image
// puzzle (NYT shows the images there too), else the plain comma-joined words. A
// solved bar spans the full board width, so its category always fits one line —
// leaving room to size the glyphs up well above the tiny BAR_MEMBERS text and set
// them in equal cells so the row reads as an even, deliberate strip (a bare h-auto
// row leaves wide glyphs like → crowding their neighbors). Every dimension (cell
// size, gap, top offset) is a fraction of the bar height (--tile-h), NOT the
// viewport — so the strip keeps the same proportions, and the same balance against
// the title, on mobile and desktop alike (both pin --tile-h at 80px). Sizing off vw
// instead made glyphs shrink on narrow screens and threw the balance off.
function MemberFaces({
  members,
  images,
}: {
  members: string[];
  images?: Record<string, string>;
}) {
  if (!images || !members.every((m) => images[m]))
    return <>{members.join(", ")}</>;
  return (
    <span className="mt-[calc(var(--tile-h)*0.05)] flex items-center justify-center gap-[calc(var(--tile-h)*0.13)]">
      {members.map((m) => (
        <span
          key={m}
          className="flex h-[calc(var(--tile-h)*0.4)] w-[calc(var(--tile-h)*0.4)] items-center justify-center"
        >
          <img
            src={cardImageSrc(images[m])}
            alt={m}
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        </span>
      ))}
    </span>
  );
}
// Tile hover is an inset wash: ONE text-free rect (rendered inside the grid, see
// the hlRef effect in Board) that rides exactly ON the hovered tile's rect and
// glides from tile to tile as the mouse moves. It tints the cream face toward the
// selected slate (rgba(74,79,90,.14)), and inverts to a cool light wash
// (rgba(214,224,242,.11)) on selected tiles, so hover reads as the tile itself
// responding rather than a box arriving. It rides on JS pointer events
// (mouse-only), NOT CSS :hover — a tap on a touch/hybrid device
// sets :hover and never clears it, which would strand the highlight. Driving it
// from pointerenter/leave filtered to pointerType==="mouse" means touch gets only
// the press-pop, never a sticky hover. Press feedback is the WAAPI scale in
// onTileClick, so the press still works for both touch and mouse.
// Why a separate rect and not a per-tile style: animating a tile's own opacity
// promotes/demotes its text to a compositor layer each hover, which re-rasterizes
// glyphs and flickered the page on some GPU/zoom setups. The wash is text-free
// and composited alone, so it can move all it likes without repainting a glyph.
const TILE_DEFAULT = " bg-[#e8eaee] text-[#121212] active:bg-[#dde0e6]";
const TILE_SELECTED = " bg-[#4a4f5a] text-white";
// Pill buttons. Hover is opacity-only (mouse-only via <HoverButton>, since CSS
// :hover sticks after a tap on touch/hybrid Discord). :active press feedback stays
// in className since :active clears reliably on touchend.
const BTN_ICON =
  "inline-flex h-[42px] w-[42px] flex-none items-center justify-center cursor-pointer rounded-full border border-zinc-600 text-zinc-100 transition-opacity duration-150 ease-out active:scale-[0.97] disabled:opacity-40 disabled:cursor-default";
const BTN_PRIMARY =
  "inline-flex h-[42px] items-center justify-center cursor-pointer rounded-full px-5.5 border border-zinc-100 bg-zinc-100 text-zinc-900 font-semibold text-sm transition-opacity duration-150 ease-out active:scale-[0.97] disabled:opacity-40 disabled:cursor-default";
// BTN_PRIMARY's round, icon-only twin — the filled counterpart to BTN_ICON, for the one
// end-screen action that outranks the rest (Share to Discord).
const BTN_ICON_PRIMARY =
  "inline-flex h-[42px] w-[42px] flex-none items-center justify-center cursor-pointer rounded-full border border-zinc-100 bg-zinc-100 text-zinc-900 transition-opacity duration-150 ease-out active:scale-[0.97] disabled:opacity-40 disabled:cursor-default";

const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const GLIDE = "cubic-bezier(.22,.61,.36,1)";

export type BoardSnapshot = {
  mistakesLeft: number;
  solvedLevels: number[];
  picking: boolean;
  // Currently-selected (not yet submitted) words, for the live "see them picking" broadcast.
  selected?: string[];
  done: "won" | "lost" | null;
};

// Spoiler reveals persist per puzzle in localStorage, so a reveal is permanent
// for the day: once you've uncovered a category it stays uncovered across reopens
// of the Activity (the finished game rehydrates covered otherwise — see Board).
// Keyed by puzzle id, so the next day's puzzle starts covered again. Best-effort:
// any storage failure (private mode, disabled) just falls back to session-only.
const spoilerKey = (puzzleId: number): string => `conn-spoiler-${puzzleId}`;
export function readSpoilerSeen(puzzleId: number): Set<number> {
  try {
    const raw = localStorage.getItem(spoilerKey(puzzleId));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}
function writeSpoilerSeen(puzzleId: number, seen: Set<number>): void {
  try {
    localStorage.setItem(spoilerKey(puzzleId), JSON.stringify([...seen]));
  } catch {
    /* storage unavailable — reveal stays session-only */
  }
}

// A diagonal-hatch spoiler bar: its four WORDS stay readable but the CATEGORY
// NAME is redacted under the hatch, so you can still guess the connection before
// revealing it. Used for two cases: the last group solved on a win (often
// completed by elimination, so its theme may be a surprise) and every group
// auto-revealed on a loss (`dim` — those read dimmer once revealed, matching the
// loss screen's "you didn't get this" bars). Tapping wipes the hatch off to the
// right and the name fades up underneath (see .spoiler-* in index.css). The
// reveal is throttle-proof: the cover unmounts once its exit has had time to
// play, so the name can never get stranded if CSS animations are throttled
// (e.g. a hidden preview iframe). Same box/data-flip as a normal bar, so it
// still morphs into place with the FLIP at game end. `defaultRevealed` (from a
// prior session, persisted) mounts it already uncovered — no cover, no animation.
function SpoilerBar({
  level,
  category,
  members,
  images,
  dim = false,
  defaultRevealed = false,
  onReveal,
}: Group & {
  images?: Record<string, string>;
  dim?: boolean;
  defaultRevealed?: boolean;
  onReveal?: () => void;
}) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const [gone, setGone] = useState(defaultRevealed);
  function reveal(): void {
    if (revealed) return;
    setRevealed(true);
    setTimeout(() => setGone(true), 460);
    onReveal?.();
  }
  return (
    // A <div role="button">, not a real <button>: Chrome won't let you drag-select
    // text inside a <button>, so once revealed the category couldn't be highlighted /
    // copied the way every other solved bar can. A div keeps the text selectable while
    // role + tabIndex + the keydown handler preserve the tap/keyboard reveal affordance
    // (and match the plain bars, which carry tabIndex too so ALL bars are focusable).
    <div
      data-flip={`bar-${level}`}
      role={revealed ? undefined : "button"}
      tabIndex={0}
      aria-label={revealed ? undefined : "Reveal the hidden category"}
      onClick={revealed ? undefined : reveal}
      onKeyDown={
        revealed
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                reveal();
              }
            }
      }
      className={
        // `isolate` keeps the bar's internal z-stack (cover/cat/glint/members)
        // contained — without it those z-indices leak into the root stacking
        // context and the reveal wipe paints over the end-screen score breakdown
        // popover (which is trapped inside the footer's transform stacking context).
        "spoiler-bar relative isolate flex h-[var(--tile-h)] w-full flex-col items-center justify-center overflow-hidden rounded-lg px-2 text-center text-[#121212] transition-opacity duration-300 ease-out" +
        // covered: a tappable control — pointer cursor + press feedback, and selection
        // is disabled so the blurred (hidden) name can't be drag-copied to peek.
        // revealed: inert (default cursor, no press) and text becomes selectable, so it
        // reads and behaves like the static solved bar it now is.
        (revealed
          ? " revealed cursor-default"
          : " cursor-pointer select-none active:scale-[0.99]") +
        // a revealed failed (auto-revealed) bar reads dimmer than a solved one
        (dim && revealed ? " opacity-56" : "")
      }
      style={{ background: LEVELS[level].color }}
    >
      {!gone && (
        <span className="spoiler-cover" aria-hidden>
          <span className="spoiler-glint" />
        </span>
      )}
      {/* the REAL category name, shown blurred until tapped (see .spoiler-cat) */}
      <div className={"spoiler-cat " + BAR_CAT}>{category}</div>
      <div className={"relative z-[3] " + BAR_MEMBERS}>
        <MemberFaces members={members} images={images} />
      </div>
    </div>
  );
}

export function Board({
  game,
  onPresence,
  onCommit,
  onHint,
  onFinish,
  onShareLink,
  onCopyImage,
  onCopyLink,
  onExternal,
  initialRevealed = [],
}: {
  game: Game;
  onPresence: (snap: BoardSnapshot) => void;
  // Commit a guess server-side before its result is revealed (returns false to
  // block the reveal on a failed commit). Absent in standalone/practice play, where
  // the game is purely in-memory. See commit-then-reveal in submit().
  onCommit?: (guess: string[]) => Promise<boolean>;
  // Record one revealed hint (its group level) to the authoritative record. Absent
  // in standalone/practice, where the reveal is purely local. See doHint.
  onHint?: (level: number) => void;
  onFinish: () => void;
  // Post the finished result to Discord as a share card. Forwarded to the end footer's
  // share menu; absent outside the Activity / off the daily, where that row is dropped.
  onShareLink?: () => Promise<ShareOutcome>;
  // Put the result image on the clipboard, copy the permanent link to that same card (both
  // gated like onShareLink), and open a URL outside the app — the end footer's other share
  // routes. See EndSummary.
  onCopyImage?: () => Promise<boolean>;
  onCopyLink?: () => Promise<boolean>;
  onExternal?: (url: string) => void;
  // seeds revealed-on-loss bars when rehydrating a finished game (preview harness).
  initialRevealed?: number[];
}) {
  // display model in refs; bump() re-renders after each mutation.
  const remaining = useRef<string[]>(game.board.slice());
  const selected = useRef<Set<string>>(new Set(game.selected));
  const solvedLevels = useRef<number[]>(game.solved.map((s) => s.level));
  const revealedLevels = useRef<number[]>(initialRevealed.slice());
  // spoiler categories the player has already uncovered (persisted per puzzle, so
  // a reveal stays revealed across reopens). Read once on mount.
  const spoilerSeen = useRef<Set<number> | null>(null);
  if (spoilerSeen.current === null)
    spoilerSeen.current = readSpoilerSeen(game.puzzle.id);
  // dots lag the model one beat: wrong guess plays shake-then-dim.
  const shownMistakes = useRef<number>(game.mistakesLeft);
  const ended = useRef<boolean>(game.status !== "playing");
  // True once endGame runs (a live finish), driving the breakdown's self-reveal. Stays
  // false for a rehydrated finished game (ended seeded true at construction), so reopening
  // a finished puzzle doesn't pop the breakdown every time.
  const freshFinish = useRef(false);
  // How many solve animations are running right now. Solves no longer serialize —
  // each runs concurrently (see submit) so a fast player can fire the next guess
  // without waiting — but a couple of things still need to know one is in flight:
  // shuffle stands down (it would fight the gather FLIP), and the end-screen
  // transition waits for the count to hit zero so it doesn't fade the controls out
  // over a still-gathering group.
  const inFlight = useRef<number>(0);
  // Levels currently "forming": solved and reserved a slot in the bar stack, but
  // still gathering their winning tiles / cross-fading into the category bar. Maps
  // level → its four words, which the slot renders as a tidy row until the bar
  // takes over. Each solve reserves its OWN slot, so concurrent solves never
  // contend for one (the whole reason overlap stays clean — see animateCorrect).
  const forming = useRef<Map<number, string[]>>(new Map());
  // Words animating out of the grid (a freshly-solved group, still popping in place
  // before it's lifted into its slot). They hold the selected styling but go
  // untappable, and they leave the live selection the moment they're locked so its
  // 4-slot capacity reopens for the next pick.
  const locked = useRef<Set<string>>(new Set());
  // word under the mouse, for the hover dim (mouse-only — see TILE_HOVER).
  const [hover, setHover] = useState<string | null>(null);
  // Transient guess feedback ("One away…", "Guessed…"): a chip that pops
  // into the footer's empty middle, between the mistake dots and the shuffle
  // button. It used to ride the Submit pill's label (and before that the header
  // meta line — easy to miss, hidden on mobile), but morphing the button made the
  // control itself shift underfoot; the chip keeps the message at the same eye
  // line without touching anything pressable. Once the game has ended the chip's
  // slot is gone, so the end footer shows the hint instead (EndSummary's note
  // face — the "couldn’t save" warning can land there). Reverts after `ms`
  // (default 1.6s). `hintN` bumps on every flash so a repeat of the same message
  // (a second "Guessed…") still replays the pop.
  const [hint, setHint] = useState<string | null>(null);
  const [hintN, setHintN] = useState(0);
  // Hint reveals are visual only (the tile's colour dot); this sr-only line keeps the
  // reveal announced to assistive tech without any on-screen chip.
  const [hintSR, setHintSR] = useState("");
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const rerender = () => bump();
  const rerenderSync = () => flushSync(() => bump());
  function flashHint(msg: string, ms = 1600): void {
    setHint(msg);
    setHintN((n) => n + 1);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), ms);
  }
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const boardRef = useRef<HTMLDivElement>(null);
  const solvedRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // The hint chip stays mounted (its text held in lastHint through the fade-out,
  // same trick as EndSummary's note face) and animates with WAAPI: a SPRING scale
  // pop on the way in — the same pop the tiles and mistake dots speak — and a
  // plain opacity fade on the way out (no translate on text, see the fades rule).
  // The chip starts at the className's opacity-0; both animations fill forwards,
  // so its resting state is always whichever ran last.
  const hintChipRef = useRef<HTMLDivElement>(null);
  const lastHint = useRef("");
  if (hint) lastHint.current = hint;
  useLayoutEffect(() => {
    const chip = hintChipRef.current;
    if (!chip) return; // end-screen footer — EndSummary's note face owns the hint
    if (hint) {
      chip.animate(
        [
          { opacity: 0, transform: "scale(.9)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 320, easing: SPRING, fill: "forwards" },
      );
    } else if (lastHint.current) {
      chip.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 240,
        easing: "ease-out",
        fill: "forwards",
      });
    }
  }, [hint, hintN]);

  function broadcast(): void {
    const real = solvedLevels.current.filter(
      (l) => !revealedLevels.current.includes(l),
    );
    onPresence({
      mistakesLeft: game.mistakesLeft,
      solvedLevels: real,
      picking: game.status === "playing" && selected.current.size > 0,
      selected: game.status === "playing" ? [...selected.current] : [],
      done: game.status === "playing" ? null : game.status,
    });
  }

  // FLIP measured in LAYOUT coordinates (offsetLeft/offsetTop), not screen rects.
  // Two reasons, both load-bearing now that solves overlap:
  //   • offsets ignore CSS transforms, so a tile that's mid-animation (or mid
  //     press-pop) reports its settled layout slot, not its in-flight position —
  //     a second solve measuring the board while the first is still sliding gets
  //     clean numbers instead of garbage. This is what makes concurrent FLIPs safe.
  //   • offsets are relative to boardRef (the positioned offsetParent), so the
  //     desktop scale-to-fit transform on an ancestor cancels out: the delta and
  //     the translate that inverts it live in the same pre-scale space.
  // boardRef must stay `position: relative` for the offsetParent to be shared
  // across the grid AND the solved stack (cross-container gather depends on it).
  function recordRects(): Map<string, { left: number; top: number }> {
    const m = new Map<string, { left: number; top: number }>();
    boardRef.current
      ?.querySelectorAll<HTMLElement>("[data-flip]")
      .forEach((e) =>
        m.set(e.dataset.flip!, { left: e.offsetLeft, top: e.offsetTop }),
      );
    return m;
  }
  function playFlip(
    prev: Map<string, { left: number; top: number }>,
    dur = 520,
    ease = GLIDE,
  ): Promise<unknown> {
    const proms: Promise<unknown>[] = [];
    boardRef.current
      ?.querySelectorAll<HTMLElement>("[data-flip]")
      .forEach((e) => {
        const b = prev.get(e.dataset.flip!);
        if (!b) return;
        // Fold in any translate the tile already carries from an overlapping FLIP
        // still in flight, so the new tween picks up from where it visually IS
        // rather than snapping to its layout box. Without this, a survivor caught
        // in two solves' reflows (e.g. two correct guesses ~400ms apart) would jump
        // a row. translate-only here; the press-pop is scale-only (no m41/m42).
        const tr = getComputedStyle(e).transform;
        const m = tr && tr !== "none" ? new DOMMatrixReadOnly(tr) : null;
        const dx = b.left - e.offsetLeft + (m ? m.m41 : 0);
        const dy = b.top - e.offsetTop + (m ? m.m42 : 0);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          proms.push(
            e.animate(
              [
                { transform: `translate(${dx}px,${dy}px)` },
                { transform: "translate(0,0)" },
              ],
              { duration: dur, easing: ease },
            ).finished,
          );
        }
      });
    return Promise.all(proms);
  }
  const tileByWord = (w: string): HTMLElement | null =>
    gridRef.current?.querySelector<HTMLElement>(
      `[data-flip="${CSS.escape(w)}"]`,
    ) ?? null;
  // Like tileByWord but board-scoped, so it still finds a winning tile once it's
  // moved out of the grid into its forming slot in the solved stack.
  const tileEl = (w: string): HTMLElement | null =>
    boardRef.current?.querySelector<HTMLElement>(
      `[data-flip="${CSS.escape(w)}"]`,
    ) ?? null;
  // The gliding hover wash (see the note above TILE_DEFAULT). One rect,
  // positioned imperatively so a hover change never re-renders the grid: entering
  // from nowhere SNAPS it under the cursor (transition on opacity only) and fades
  // it in; moving between tiles GLIDES it (transform/size, 120ms tight ease-out);
  // leaving fades it out where it sits. It carries no data-flip, so the FLIP
  // choreography never sees it.
  // While a tile is hovered, an rAF loop keeps re-reading its LIVE rect rather
  // than positioning once: tiles move and resize under a stationary pointer
  // (shuffle FLIP, a solve reflowing the grid, a window resize or breakpoint
  // swap), and a one-shot write left the halo stranded at a stale spot and size
  // (the "empty box floating off the board" bug). The loop also fades the halo
  // the moment the hovered word is gone from the DOM instead of orphaning it.
  const hlRef = useRef<HTMLDivElement>(null);
  const hlPlaced = useRef(false);
  const hlLast = useRef("");
  useLayoutEffect(() => {
    const hl = hlRef.current;
    if (!hl) return;
    if (!hover) {
      // Grace period: a mouse crossing the gap between tiles clears hover for a
      // few ms, and fading/snapping then would break the glide into the next
      // tile. Fade out only if the pointer is genuinely off the tiles; landing
      // on the next tile inside the window cancels this and glides instead.
      const t = setTimeout(() => {
        hl.style.opacity = "0";
        hlPlaced.current = false;
        hlLast.current = ""; // re-hovering the same tile must re-write
      }, 120);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const track = (): void => {
      const grid = gridRef.current;
      const tile = tileByWord(hover);
      if (!grid || !tile) {
        // hovered word left the grid (solved away / layout remount) — never
        // strand the halo where it sat.
        hl.style.opacity = "0";
        hlPlaced.current = false;
        hlLast.current = "";
        return;
      }
      const g = grid.getBoundingClientRect();
      const r = tile.getBoundingClientRect();
      // getBoundingClientRect is RENDERED pixels, but the halo's inline
      // transform/size apply in the grid's LOCAL space — and the app scales the
      // board (an ancestor transform), so rendered deltas written verbatim land
      // scale× too far and too big (the stray-box bug, invisible in the
      // unscaled preview harness). Divide by the grid's own rendered/layout
      // ratio to convert back; it is 1 wherever no ancestor scales.
      const scale = grid.offsetWidth > 0 ? g.width / grid.offsetWidth : 1;
      const sel = selected.current.has(hover) || locked.current.has(hover);
      const geo = `${r.left - g.left}|${r.top - g.top}|${r.width}|${r.height}|${scale}|${sel}`;
      if (geo !== hlLast.current) {
        hlLast.current = geo;
        hl.style.transitionProperty = hlPlaced.current
          ? "transform, width, height, opacity"
          : "opacity";
        hl.style.background = sel
          ? "rgba(214,224,242,0.11)"
          : "rgba(74,79,90,0.14)";
        hl.style.transform = `translate(${(r.left - g.left) / scale}px, ${(r.top - g.top) / scale}px)`;
        hl.style.width = `${r.width / scale}px`;
        hl.style.height = `${r.height / scale}px`;
        hl.style.opacity = "1";
        hlPlaced.current = true;
      }
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [hover]);

  function onTileClick(e: ReactMouseEvent<HTMLButtonElement>, w: string): void {
    // No busy gate: the board stays live during an animation so the next guess can
    // be built in flight. Only a word currently leaving the board (a solved group
    // mid-gather) is off-limits — tapping it would fold a vanishing tile into the
    // next selection (it'd be dropped at submit anyway, since it's off the board).
    if (game.status !== "playing" || locked.current.has(w)) return;
    // Press pop via WAAPI (the re-render after toggle would clobber a CSS one).
    // `composite: "add"` is load-bearing now that the board stays live mid-animation:
    // if you tap a tile that's gliding through a gather/reflow, a plain (replace)
    // scale would wipe its in-flight translate and snap it to its destination. Adding
    // the scale on top of the running translate lets it keep sliding while it pops.
    e.currentTarget.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.9)" },
        { transform: "scale(1)" },
      ],
      { duration: 150, easing: "ease-out", composite: "add" },
    );
    if (selected.current.has(w)) selected.current.delete(w);
    else {
      if (selected.current.size >= 4) return;
      selected.current.add(w);
    }
    rerender();
    broadcast();
  }
  function clearSelection(): void {
    // Safe at any time: it only empties the live selection (the leaving words live in
    // `locked`, not here), so it works on the in-flight next pick too.
    selected.current.clear();
    rerender();
    broadcast();
  }

  function doShuffle(): void {
    // Stands down while a solve is gathering — its own FLIP would fight the gather's.
    if (inFlight.current > 0 || game.status !== "playing") return;
    const prev = recordRects();
    remaining.current = shuffle(remaining.current);
    rerenderSync();
    void playFlip(prev, 480);
  }

  // Reveal one hint: the easiest unsolved group's colour, pinned to one of its words
  // (NYT's mechanic — see Game.useHint). Optimistic like a guess: reveal now from the
  // puzzle the client already holds, record the −hintPenalty server-side in the
  // background (onHint). rerenderSync paints the tile's colour dot and refreshes the
  // button's canHint state; a scale pop draws the eye (no visible chip — the dot is the
  // reveal); an sr-only status announces it; broadcast() refreshes the self row's hint
  // count so the live score reflects it.
  function doHint(): void {
    const h = game.useHint();
    if (!h) return;
    onHint?.(h.level);
    rerenderSync();
    tileByWord(h.word)?.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.09)" },
        { transform: "scale(1)" },
      ],
      { duration: 360, easing: SPRING },
    );
    setHintSR(`${h.word} is in the ${LEVELS[h.level].key} group`);
    broadcast();
  }

  // gather reorder: selected to top row, displaced into vacated holes.
  function reorderGather(words: string[]): void {
    const sel = new Set(words);
    const order = remaining.current.slice();
    const selPos: number[] = [];
    order.forEach((w, i) => {
      if (sel.has(w)) selPos.push(i);
    });
    const selOrdered = selPos.map((i) => order[i]);
    const displaced = [0, 1, 2, 3]
      .filter((i) => !sel.has(order[i]))
      .map((i) => order[i]);
    const holes = selPos.filter((i) => i >= 4);
    const res = order.slice();
    for (let k = 0; k < 4; k++) res[k] = selOrdered[k];
    for (let j = 0; j < displaced.length; j++) res[holes[j]] = displaced[j];
    remaining.current = res;
  }

  async function popTiles(words: string[]): Promise<void> {
    const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
    await Promise.all(
      tiles.map(
        (t, i) =>
          new Promise<void>((res) => {
            setTimeout(() => {
              t.animate(
                [
                  { transform: "scale(1)" },
                  { transform: "scale(1.14)" },
                  { transform: "scale(1)" },
                ],
                { duration: 300, easing: SPRING },
              ).finished.then(() => res());
            }, i * 110);
          }),
      ),
    );
  }

  // A correct solve, self-contained so any number can run at once. The group
  // reserves its OWN slot in the bar stack up front and gathers into it, so two
  // solves in flight target different slots and never fight over shared space (the
  // old version staged every gather in the grid's one top row, which is what made
  // overlap impossible). All motion is one FLIP measured in layout coordinates, so
  // a solve started while another is still sliding reads clean positions.
  async function animateCorrect(level: number, words: string[]): Promise<void> {
    // Free the board for the next pick right away: drop the winning words from the
    // live selection (reopening its 4-slot capacity) and mark them `locked` — they
    // keep the selected styling and stay untappable for the beat they pop in place.
    for (const w of words) {
      locked.current.add(w);
      selected.current.delete(w);
    }
    rerender();

    // 1) sequential pop, in place in the grid
    await popTiles(words);

    // 2) Reserve this group's slot and gather into it. One FLIP carries the whole
    //    move: the winners lift from their scattered grid cells into a tidy row in
    //    the reserved slot, the survivors settle into the now-smaller grid, and any
    //    bars already above shift to make room. `forming` makes the slot render the
    //    four words as a row until the bar takes over.
    const prev = recordRects();
    remaining.current = remaining.current.filter((w) => !words.includes(w));
    forming.current.set(level, words);
    solvedLevels.current.push(level);
    for (const w of words) locked.current.delete(w); // off the grid now
    rerenderSync();
    await playFlip(prev, 520);

    // hold the gathered row so the solve registers before it morphs to the bar
    await wait(300);

    // 3) Fade the gathered tiles out, then reveal the category bar in the very same
    //    slot — no move, the slot is already in place — popping it in.
    const ftiles = words.map(tileEl).filter(Boolean) as HTMLElement[];
    await Promise.all(
      ftiles.map(
        (t) =>
          t.animate(
            [
              { opacity: 1, transform: "scale(1)" },
              { opacity: 0, transform: "scale(.9)" },
            ],
            { duration: 280, easing: "ease-out", fill: "forwards" },
          ).finished,
      ),
    );
    forming.current.delete(level);
    rerenderSync();
    const bar = solvedRef.current?.querySelector<HTMLElement>(
      `[data-flip="bar-${level}"]`,
    );
    bar?.animate(
      [
        { transform: "scale(.97)", opacity: 0.25 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 300, easing: GLIDE },
    );
  }

  async function animateWrong(
    words: string[],
    oneAway: boolean,
  ): Promise<void> {
    const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
    // only the near-miss gets called out; a plain wrong guess just shakes.
    if (oneAway) flashHint("So close, one off…");
    await Promise.all(
      tiles.map(
        (t) =>
          t.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(-8px)" },
              { transform: "translateX(8px)" },
              { transform: "translateX(-6px)" },
              { transform: "translateX(6px)" },
              { transform: "translateX(-3px)" },
              { transform: "translateX(0)" },
            ],
            { duration: 430, easing: "ease-in-out" },
          ).finished,
      ),
    );
    // spend the dot: dim + spring pop.
    shownMistakes.current = game.mistakesLeft;
    rerenderSync();
    const dot = tailRef.current?.querySelector<HTMLElement>(
      `[data-dot="${game.mistakesLeft}"]`,
    );
    dot?.animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], {
      duration: 300,
      easing: SPRING,
    });
  }

  async function endGame(won: boolean): Promise<void> {
    if (!won) {
      // reveal unsolved groups, gathered + dimmed, one by one
      const left = [0, 1, 2, 3].filter(
        (l) => !solvedLevels.current.includes(l),
      );
      for (const lvl of left) {
        const words = group(lvl).members.filter((w) =>
          remaining.current.includes(w),
        );
        const prev = recordRects();
        reorderGather(words);
        rerenderSync();
        await playFlip(prev, 380);
        const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
        await Promise.all(
          tiles.map(
            (t) =>
              t.animate([{ opacity: 1 }, { opacity: 0 }], {
                duration: 220,
                easing: "ease-in",
                fill: "forwards",
              }).finished,
          ),
        );
        const prev2 = recordRects();
        remaining.current = remaining.current.filter((w) => !words.includes(w));
        solvedLevels.current.push(lvl);
        revealedLevels.current.push(lvl);
        rerenderSync();
        const bar = solvedRef.current?.querySelector<HTMLElement>(
          `[data-flip="bar-${lvl}"]`,
        );
        // pop the bar in at full opacity — it morphs in spoiler-covered
        // (SpoilerBar), so it only dims once you tap to reveal the category.
        bar?.animate(
          [
            { transform: "scale(.97)", opacity: 0.25 },
            { transform: "scale(1)", opacity: 1 },
          ],
          {
            duration: 260,
            easing: "ease-out",
          },
        );
        await playFlip(prev2, 320);
        await wait(180);
      }
    }
    // await the webfont; the Newsreader score would reflow mid-swap otherwise.
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
    }
    // fade the controls out, swap to the end layout (leaderboard below the board),
    // then fade it in. The score hero rides up in the header row (see GameView).
    await tailRef.current!.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(8px)" },
      ],
      { duration: 220, easing: "ease-in", fill: "forwards" },
    ).finished;
    freshFinish.current = true; // EndSummary mounts with autoOpen → self-reveals the breakdown
    ended.current = true;
    rerenderSync();
    // Entrance flourish, layered on the bar's fade-up: the mistake dots ride in on the left
    // (their play spot) while the Share button pops up on the right. Fired here (not in
    // EndSummary) so it plays only on a live finish; a rehydrated game renders at rest.
    const shareEl =
      tailRef.current?.querySelector<HTMLElement>('[data-end="share"]');
    shareEl?.animate(
      [
        { opacity: 0, transform: "scale(.8)" },
        { opacity: 0, transform: "scale(.8)", offset: 0.3 },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 520, easing: SPRING, fill: "backwards" },
    );
    await tailRef.current!.animate(
      [
        { opacity: 0, transform: "translateY(12px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 380, easing: GLIDE, fill: "forwards" },
    ).finished;
  }

  // Evaluate one guess and play its animation. Fire-and-forget: the model is
  // committed synchronously (so rapid-fire guesses stay correctly ordered and the
  // win/loss is detected on the right one), then the animation runs concurrently
  // with any others already in flight — no serialization, that's what lets a fast
  // player keep firing. `inFlight` counts the gathering solves so the end screen
  // can wait for them; a wrong-guess shake doesn't restructure the board, so it
  // isn't counted.
  async function runGuess(words: string[]): Promise<void> {
    game.selected = new Set(words);
    const result = game.submit();

    // Optimistic reveal: the result is computed locally and matches the server's, so we
    // show it immediately instead of waiting on the /api/guess round-trip (which made
    // every guess feel laggy once a real network was in play). onCommit records the
    // guess in the background (keepalive + ordered queue, see commitGuess); a guess that
    // still can't be saved after retries surfaces a quiet warning — on the footer's
    // hint chip mid-game, or the end footer's note face if the game has ended by the
    // time the retries exhaust — rather than blocking play. Held longer than a guess hint: it's
    // the only signal the score may not record. Duplicates/noops aren't recorded
    // server-side, so we skip them.
    if (onCommit && result.type !== "duplicate" && result.type !== "noop") {
      void onCommit(words).then((ok) => {
        if (!ok) flashHint("Couldn’t save that guess", 4000);
      });
    }

    if (result.type === "duplicate") {
      flashHint("Guessed…");
      return;
    }
    if (result.type === "noop") return;

    if (result.type === "correct" || result.type === "win") {
      inFlight.current++;
      await animateCorrect(game.levelOf(words[0])!, words);
      inFlight.current--;
    } else {
      // oneaway | incorrect | lose: all wrong guesses shake
      const levels = words.map((w) => game.levelOf(w)!);
      const counts: Record<number, number> = {};
      for (const l of levels) counts[l] = (counts[l] ?? 0) + 1;
      const oneAway = Math.max(...Object.values(counts)) === 3;
      await animateWrong(words, oneAway);
    }
    broadcast(); // this guess's outcome lands on the live roster

    if (result.type === "win" || result.type === "lose") {
      // Hold the end screen until every other in-flight solve has finished
      // gathering, so the controls never fade out over a still-forming group.
      while (inFlight.current > 0) await wait(16);
      await endGame(result.type === "win");
      broadcast();
      onFinish();
    }
  }

  async function submit(): Promise<void> {
    if (selected.current.size !== 4 || game.status !== "playing") return;
    // No gating on an in-flight animation: fire this guess now and let it animate
    // alongside any others. The selection is consumed per result inside the
    // animation (a correct guess frees it; a wrong guess keeps it for tweaking).
    await runGuess([...selected.current]);
  }

  const group = (lvl: number): Group =>
    game.puzzle.groups.find((g) => g.level === lvl)!;

  const showGrid = !ended.current && remaining.current.length > 0;

  // Revealed-hint marks: word → its group level, one per hinted group (the group's
  // first member). Rebuilt each render from game.hintedLevels so it reflects a live
  // reveal, a rehydrated day, and a group leaving the board on solve.
  const hintWords = new Map<string, number>();
  for (const lvl of game.hintedLevels) {
    const grp = game.puzzle.groups.find((g) => g.level === lvl);
    if (grp) hintWords.set(grp.members[0], lvl);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* gap above the grid only once a solved bar exists — an empty solved
          container would otherwise reserve 8px atop the grid. Driven off
          solvedLevels (re-rendered on each solve) rather than a :has selector,
          so it holds even where :has isn't supported. */}
      <div
        className={
          // `relative` makes this the shared offsetParent for every [data-flip]
          // element in both the solved stack and the grid, so the layout-coordinate
          // FLIP (recordRects/playFlip) reads one consistent space across them.
          "relative flex flex-col" +
          (solvedLevels.current.length ? " gap-2" : "")
        }
        ref={boardRef}
      >
        <div className="flex flex-col gap-2" ref={solvedRef}>
          {solvedLevels.current.map((lvl) => {
            const g = group(lvl);
            // While this level is still gathering, its slot renders the four winning
            // words as a tidy row (the tiles that just lifted out of the grid). It
            // sits exactly where the category bar will, so the bar takes over in
            // place with no further move. Takes precedence over the bar/spoiler
            // branches below — it's the same box, just mid-animation.
            if (forming.current.has(lvl)) {
              return (
                <div key={lvl} className="grid grid-cols-4 gap-2">
                  {forming.current.get(lvl)!.map((w) => (
                    <div key={w} data-flip={w} className={TILE + TILE_SELECTED}>
                      <TileFace
                        word={w}
                        src={game.puzzle.images?.[w]}
                        selected
                      />
                    </div>
                  ))}
                </div>
              );
            }
            // Spoiler-cover the category for: (a) the final group solved on a
            // win — hidden until tapped so you can still guess it (gated on
            // length 4 so the in-flight 3-solved window during the winning
            // animation doesn't briefly cover the wrong bar), and (b) every
            // group auto-revealed on a loss, so you can guess the ones you
            // missed too. Genuinely-solved groups (other than the win's last)
            // render plainly.
            const autoRevealed = revealedLevels.current.includes(lvl);
            const winLastSolved =
              game.status === "won" &&
              solvedLevels.current.length === 4 &&
              lvl === solvedLevels.current[solvedLevels.current.length - 1];
            if (winLastSolved || autoRevealed) {
              return (
                <SpoilerBar
                  key={lvl}
                  {...g}
                  images={game.puzzle.images}
                  dim={autoRevealed}
                  defaultRevealed={spoilerSeen.current!.has(lvl)}
                  onReveal={() => {
                    spoilerSeen.current!.add(lvl);
                    writeSpoilerSeen(game.puzzle.id, spoilerSeen.current!);
                  }}
                />
              );
            }
            return (
              <div
                key={lvl}
                data-flip={`bar-${lvl}`}
                // focusable like the SpoilerBar so every solved bar behaves the
                // same under keyboard focus (text stays selectable — it's a div).
                tabIndex={0}
                className="flex h-[var(--tile-h)] flex-col items-center justify-center rounded-lg px-2 text-center text-[#121212]"
                style={{ background: LEVELS[lvl].color }}
              >
                <div className={BAR_CAT}>{g.category}</div>
                <div className={BAR_MEMBERS}>
                  <MemberFaces
                    members={g.members}
                    images={game.puzzle.images}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {showGrid && (
          <div
            className="relative grid grid-cols-4 gap-2"
            ref={gridRef}
            // Backstop for a grid that re-renders UNDER a stationary pointer (a
            // breakpoint swap replaces the hovered tile without ever firing its
            // pointerleave, leaving `hover` stuck and the halo lit forever).
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setHover(null);
            }}
          >
            <div
              ref={hlRef}
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 z-10 rounded-lg bg-[rgba(74,79,90,0.14)] opacity-0 duration-[120ms] ease-[cubic-bezier(.2,.85,.3,1)]"
              style={{ transitionProperty: "opacity" }}
            />
            {remaining.current.map((w) => {
              // `locked` words have left the live selection but are still gathering/
              // fading out, so they keep the selected look until they're gone.
              const sel = selected.current.has(w) || locked.current.has(w);
              const palette = sel ? TILE_SELECTED : TILE_DEFAULT;
              // A revealed hint paints its word's whole tile in the group colour;
              // once selected, the tile takes the normal dark face and the word
              // carries the colour instead. Derived from game.hintedLevels
              // (persisted + rehydrated), so the mark survives reopens and vanishes
              // once its group is solved (the tile leaves the board).
              const hintLevel = hintWords.get(w);
              const hintStyle =
                hintLevel === undefined
                  ? undefined
                  : sel
                    ? { color: LEVELS[hintLevel].color }
                    : { background: LEVELS[hintLevel].color };
              return (
                <button
                  key={w}
                  data-flip={w}
                  className={TILE + palette}
                  style={hintStyle}
                  onClick={(e) => onTileClick(e, w)}
                  // mouse-only so a touch tap never strands the tile dimmed
                  onPointerEnter={(e) => {
                    if (e.pointerType === "mouse") setHover(w);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse")
                      setHover((h) => (h === w ? null : h));
                  }}
                >
                  <TileFace
                    word={w}
                    src={game.puzzle.images?.[w]}
                    selected={sel}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Gate purely on ended.current, NOT game.status: the winning guess flips
          status to "won" before the board's end choreography runs, so keying off
          status would swap the score footer in mid-morph — then endGame's
          fade-out/fade-in would re-introduce it, a visible double-appearance.
          ended.current only flips inside endGame, after the controls fade out, so
          the footer makes exactly one entrance. (Rehydrated finished games seed
          ended.current = true, so they render the footer immediately, no fade.) */}
      <div ref={tailRef}>
        {ended.current ? renderBelowEnd() : renderControls()}
      </div>
    </div>
  );

  // Playing footer — one compact row: mistakes dots pinned left, controls right.
  // Shuffle/Deselect collapse to icons; their labels stay in the DOM (sr-only) so
  // accessible names and the preview driver's text lookup still resolve.
  // The flex-1 middle is the hint chip's stage: guess feedback pops in centered
  // in the dead space between the dots and the shuffle button. The chip is
  // absolute (centered by the flex container's alignment, so WAAPI owns its
  // transform) and nowrap — on the narrowest layouts a long message overhangs
  // the dots rather than wrapping or squeezing the controls; it's opaque,
  // shadowed, and z-raised, so it reads fine for the beat it's on stage.
  // It's pointer-events-none and visually tile-material (the board's cream, not
  // the Submit pill's white) so it never reads as another button. The sr-only
  // twin carries the announcement: the visible chip holds its last text through
  // the fade-out, so its content alone wouldn't re-announce a repeated message.
  function renderControls() {
    return (
      // gap tightens below 360px so the fourth control (Hint) + Submit still fit the
      // narrowest phones / shrunk viewports, where Submit also collapses to an icon.
      <div className="flex items-center gap-3 max-[359px]:gap-2">
        <span
          className="inline-flex flex-none items-center gap-1.75"
          aria-label="Guesses left"
          title="Guesses left"
        >
          {Array.from({ length: MAX_MISTAKES }, (_, i) => (
            <span
              key={i}
              data-dot={i}
              className={
                "inline-block h-3.5 w-3.5 rounded-full " +
                (i < shownMistakes.current ? "bg-zinc-300" : "bg-zinc-700")
              }
            />
          ))}
        </span>
        <div className="relative flex min-w-0 flex-1 items-center justify-center self-stretch">
          <div
            ref={hintChipRef}
            aria-hidden
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-full bg-[#e8eaee] px-3.5 py-2 text-[11px] font-bold uppercase leading-none tracking-[0.08em] text-[#121212] opacity-0 shadow-[0_3px_12px_rgba(0,0,0,0.45)] max-[420px]:px-3 max-[420px]:text-[10px] max-[420px]:tracking-[0.04em]"
          >
            {hint ?? lastHint.current}
          </div>
          <span className="sr-only" role="status">
            {hint}
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            {hintSR}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <HoverButton
            className={BTN_ICON}
            hover="opacity-80"
            onClick={doHint}
            disabled={!game.canHint}
            aria-label="Reveal a hint"
            title="Reveal a hint (−30)"
          >
            <Lightbulb size={18} strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Reveal a hint</span>
          </HoverButton>
          <HoverButton
            className={BTN_ICON}
            hover="opacity-80"
            onClick={doShuffle}
            aria-label="Shuffle"
            title="Shuffle"
          >
            <ShuffleIcon size={18} strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Shuffle</span>
          </HoverButton>
          <HoverButton
            className={BTN_ICON}
            hover="opacity-80"
            onClick={clearSelection}
            disabled={selected.current.size === 0}
            aria-label="Clear picks"
            title="Clear picks"
          >
            <Eraser size={18} strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Clear picks</span>
          </HoverButton>
          <HoverButton
            // Below 360px the four controls + a text Submit overflow, so Submit
            // collapses to a square icon (a check) — the icon-only fallback the task
            // called for. Above it, the labelled pill stays (it reads clearer).
            className={BTN_PRIMARY + " max-[359px]:w-[42px] max-[359px]:px-0"}
            hover="opacity-85"
            onClick={() => void submit()}
            disabled={selected.current.size !== 4}
            aria-label="Submit"
            title="Submit"
          >
            <Check
              size={19}
              strokeWidth={2.75}
              aria-hidden
              className="hidden max-[359px]:block"
            />
            <span className="max-[359px]:hidden">Submit</span>
          </HoverButton>
        </div>
      </div>
    );
  }

  // End-screen footer — replaces the controls at the same footprint with the run
  // summary, which cross-fades in place to the itemized score breakdown on inspect
  // (hover/tap). The live hint flows in as the note face so a "couldn’t save"
  // warning arriving after the end swap still surfaces. See EndSummary.
  function renderBelowEnd() {
    return (
      <EndSummary
        game={game}
        note={hint}
        autoOpen={freshFinish.current}
        onShareLink={onShareLink}
        onCopyImage={onCopyImage}
        onCopyLink={onCopyLink}
        onExternal={onExternal}
      />
    );
  }
}
