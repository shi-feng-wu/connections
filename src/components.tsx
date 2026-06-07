import { useEffect, useRef, useState, type RefObject } from "react";
import iconUrl from "./assets/connections-nyt.png";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
import { LEVELS, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./realtime";
import { Roster, type RosterScope, type RosterView } from "./roster";
import { type Standings } from "./season";

// The four category squares doing the bounce+spin drop — the hero mark shared by the
// cold-start loader and the midnight turnover (redesign "Loading Animations"). Each
// square whips a full turn mid-air (direction alternates per square) and lands square;
// the launch is staggered by index so the row ripples. `delayBase` shifts the whole
// row's start so the turnover can hold a beat before the mark kicks in.
function BounceSpinMark({ delayBase = 0 }: { delayBase?: number }) {
  return (
    <div className="flex gap-4">
      {LEVELS.map((l, i) => (
        <span
          key={l.key}
          className={
            "h-[30px] w-[30px] rounded-[5px] " +
            (i % 2 ? "animate-bounce-spin-ccw" : "animate-bounce-spin-cw")
          }
          style={{
            background: l.color,
            willChange: "transform",
            animationDelay: `${delayBase + i * 0.13}s`,
          }}
        />
      ))}
    </div>
  );
}

// The shared loading lockup: a tracked all-caps eyebrow with animated dots, the
// bounce+spin mark, then the puzzle's date and number. The cold-start loader and the
// midnight turnover render the same lockup and differ only in copy, so they read as one
// family. The number isn't always known before the puzzle lands (NYT ids aren't
// derivable from the date), so the pill only appears once a number is supplied.
function LoadLockup({
  caption,
  date,
  number,
  delayBase = 0,
}: {
  caption: string;
  date?: string;
  number?: number;
  delayBase?: number;
}) {
  const label = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";
  return (
    <div className="relative flex flex-col items-center gap-[26px]">
      <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.26em] whitespace-nowrap text-zinc-500 after:animate-dots after:content-['']">
        {caption}
      </span>
      <BounceSpinMark delayBase={delayBase} />
      {(label || number != null) && (
        <div className="mt-1 flex flex-col items-center gap-[13px]">
          {label && (
            <span className="font-display text-[22px] font-semibold leading-none tracking-[-0.01em] whitespace-nowrap text-zinc-300">
              {label}
            </span>
          )}
          {number != null && (
            <span className="rounded-full border border-white/[0.14] px-2.5 py-[3px] font-sans text-[10px] font-bold uppercase tracking-[0.09em] whitespace-nowrap tabular-nums text-zinc-400">
              No. {number}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Loading / error / blocked screen, centered on the page. The in-progress state is the
// designed cold-start lockup — "Loading today's puzzle…", the bounce+spin mark, and the
// day's date + number — over a faint center glow. Once the puzzle lands the game fades in
// (GameView's animate-fade-in), so the loader dissolves into the page rather than swapping
// a full skeleton board out. `number` is best-effort (the puzzle hasn't loaded yet, so it
// comes from the last cached daily); when absent the pill is simply omitted.
export function LoadingScreen({
  error = false,
  blocked = false,
  onRetry,
  date,
  number,
}: {
  error?: boolean;
  blocked?: boolean;
  onRetry: () => void;
  date?: string;
  number?: number;
}) {
  const inner = blocked ? (
    <>
      <div className="text-sm font-medium text-zinc-300">Open in Discord to play.</div>
      <div className="text-xs text-zinc-500">
        Connections runs as a Discord Activity — launch it from a server or call.
      </div>
    </>
  ) : error ? (
    <>
      <div className="text-sm font-medium text-zinc-300">Couldn’t load the puzzle.</div>
      <div className="text-xs text-zinc-500">Check your connection and try again.</div>
      <HoverButton
        type="button"
        onClick={onRetry}
        hover="opacity-85"
        className="mt-1 cursor-pointer rounded-full border border-zinc-100 bg-zinc-100 px-5.5 py-2.5 text-sm font-semibold text-zinc-900 transition-opacity duration-150 ease-out"
      >
        Try again
      </HoverButton>
    </>
  ) : (
    <>
      {/* faint center glow so the flat near-black has depth behind the lockup */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(56%_44%_at_50%_44%,rgba(255,255,255,0.05),transparent_70%)]"
      />
      <LoadLockup caption="Loading today’s puzzle" date={date} number={number} />
      {/* Game-style loading tip (redesign "Loading Animations" · BotNotice): a borderless
          line at the foot of the cold-start screen nudging the room to add the bot so it gets
          the live "who's playing" card + daily recap. Cold-start only — not error/blocked, and
          not the midnight turnover (a returning player already knows). The green is the puzzle's
          category green used as a quiet accent. fixed so it sits at the viewport foot regardless
          of the centered lockup; it fades in with the screen's animate-fade-in. */}
      <div className="fixed inset-x-7 bottom-[34px] flex flex-col items-center gap-[7px] text-center">
        <span className="font-sans text-[10px] font-bold tracking-[0.22em] text-[#a0c35a] uppercase">
          Tip
        </span>
        <p className="max-w-[300px] font-sans text-[12.5px] leading-[1.7] text-zinc-400">
          Run{" "}
          <span className="rounded-[5px] bg-white/[0.06] px-[5px] py-px font-semibold text-zinc-300">
            /enable-posts
          </span>{" "}
          to get live player posts and daily recap posts.
        </p>
      </div>
    </>
  );

  return (
    <div className="flex w-full animate-fade-in flex-col items-center justify-center gap-3 py-20 text-center">
      {inner}
    </div>
  );
}

// Midnight day-rollover veil. When the ET date crosses, the daily swaps to the new puzzle;
// rather than the old board hard-cutting to the loader, App fades this veil over the live
// board, swaps the puzzle underneath (hidden behind the opaque veil), then drops the veil
// to reveal the fresh one. It carries the same lockup as the cold-start loader — only the
// copy differs ("Loading new puzzle…") and it shows the *new* day's date + number — so the
// turnover reads as a deliberate "new day" beat in the same visual language. The board
// ghosts through during the fade in/out. App owns the timing: `active` true → fade in +
// hold; false → fade out, then this self-unmounts after the fade. `number` is set once the
// new puzzle has loaded (mid-veil), so the pill resolves in before the reveal.
export function DayTurnover({
  active,
  date,
  number,
}: {
  active: boolean;
  date?: string;
  number?: number;
}) {
  const [mounted, setMounted] = useState(active);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (active) {
      setMounted(true);
      // Paint mounted (opacity-0) first, then flip to opacity-100 next frame so the
      // CSS opacity transition actually runs instead of snapping on.
      const r = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 520); // outlast the 500ms fade-out
    return () => clearTimeout(t);
  }, [active]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden
      className={
        "fixed inset-0 z-50 flex items-center justify-center bg-black transition-opacity duration-500 ease-out " +
        (shown ? "opacity-100" : "opacity-0")
      }
    >
      {/* faint center glow so the flat black has depth behind the lockup */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(58%_46%_at_50%_42%,rgba(255,255,255,0.05),transparent_72%)]" />
      {/* the lockup eases up + unblurs (animate-dayrise); delayBase holds the mark a
          beat so the rise reads before the squares start bouncing */}
      <div className="animate-dayrise">
        <LoadLockup
          caption="Loading new puzzle"
          date={date}
          number={number}
          delayBase={0.2}
        />
      </div>
    </div>
  );
}

// Brand lockup for the desktop players-rail header (per the "Desktop Connections"
// redesign): the kept brick logo · the "Connections" serif wordmark · a bordered "No. 642"
// pill, grouped on the left, with the serif date riding the right edge and a hairline
// divider beneath. During play the date slot cross-fades to transient guess feedback
// ("One away…" / the rare "couldn’t save that guess" note) and back — guess results show
// on the Submit pill. Sits atop the players rail on desktop only; hidden on mobile, where
// Discord shows its own activity header above the board.
function Header({
  puzzle,
  feedbackText,
  feedbackOn,
  className = "",
}: {
  puzzle: Puzzle;
  feedbackText: string;
  feedbackOn: boolean;
  className?: string;
}) {
  const dateLabel = new Date(`${puzzle.date}T00:00:00`).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );
  return (
    <header
      className={
        "flex items-center justify-between gap-3.5 border-b border-white/[0.08] pb-3 " +
        className
      }
    >
      {/* wordmark lockup — the brick icon (frameless, wordmark-height) · "Connections" · a bordered "No. 642" pill */}
      <div className="flex items-center gap-2.5">
        <img
          src={iconUrl}
          alt=""
          className="h-[27px] w-[27px] flex-none object-contain"
        />
        <span className="font-display text-[27px] font-bold leading-none tracking-[-0.025em] text-[#efefe6] [text-box:trim-both_cap_alphabetic]">
          Connections
        </span>
        <span className="flex-none rounded-full border border-white/[0.13] px-2 py-[3px] font-sans text-[10px] font-bold uppercase leading-none tracking-[0.08em] tabular-nums text-zinc-400">
          No. {puzzle.id}
        </span>
      </div>
      {/* serif date riding the right edge; cross-fades to transient guess feedback
          ("One away…") during play, then back. */}
      <span className="relative inline-flex items-baseline justify-end whitespace-nowrap text-right">
        <span
          className={
            "font-display text-[14px] font-semibold leading-none text-zinc-500 [text-box:trim-both_cap_alphabetic] transition-opacity duration-300 " +
            (feedbackOn ? "opacity-0" : "opacity-100")
          }
        >
          {dateLabel}
        </span>
        <span
          aria-live="polite"
          className={
            "pointer-events-none absolute right-0 font-sans text-[12px] font-bold whitespace-nowrap text-zinc-100 transition-all duration-300 ease-out " +
            (feedbackOn ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")
          }
        >
          {feedbackText}
        </span>
      </span>
    </header>
  );
}

// Responsive game shell. Mobile: a single column — header, board + footer, then the
// players section (Live / Season / All-time tabs + list). Desktop (≥820px): a 50/50
// split — board + footer on the left, and a right rail (header, tabs, list) that
// absolute-fills the column so it matches the board's height and scrolls its list
// rather than driving the layout taller. Season and All-time share one standings
// table (different window); the end-screen locate arrow scrolls + pulses your row in
// whichever tab is open.
// Desktop "scale to fill". The board layout caps out at max-w-860px with 80px tiles
// (--tile-h) and text frozen at its clamp ceilings, so on a big monitor it's a small
// island floating in black. Rather than bump each ceiling (tile height, the three
// text clamps, gaps, padding) in lockstep — which drifts the proportions apart — we
// scale the whole GameView uniformly with a CSS transform, which preserves every
// aspect ratio by construction. The factor is bounded by BOTH the viewport width and
// height (so the scaled board never clips), capped at MAX_SCALE, and never below 1:
// the sub-860px / mobile shrink is already handled by the layout's dvh/vw clamps, and
// anything under DESKTOP_BP opts out entirely. offsetWidth/offsetHeight read the
// *unscaled* layout box (CSS transforms don't affect them), so measuring the very
// element we scale is both correct and loop-free — and a ResizeObserver re-measures
// when the board's height changes (rows collapsing into solved bars).
const DESKTOP_BP = 820;
const MAX_SCALE = 1.5;
// Only let the board grow into this fraction of the viewport, leaving the rest as
// breathing room — ~12.5% on every side at 0.75. A fraction (not a fixed px margin)
// keeps the margins proportional, so bigger screens get proportionally bigger gutters.
const VIEWPORT_FILL = 0.75;

function useScaleToFit(ref: RefObject<HTMLElement | null>): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      if (window.innerWidth < DESKTOP_BP) {
        setScale(1);
        return;
      }
      const natW = el.offsetWidth;
      const natH = el.offsetHeight;
      if (!natW || !natH) return;
      const fitW = (window.innerWidth * VIEWPORT_FILL) / natW;
      const fitH = (window.innerHeight * VIEWPORT_FILL) / natH;
      const next = Math.min(fitW, fitH, MAX_SCALE);
      setScale(next < 1 ? 1 : next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return scale;
}

export function GameView({
  game,
  gameKey,
  players,
  selfId,
  selfName,
  selfAvatar,
  season,
  allTime,
  scope,
  onScopeChange,
  onPresence,
  onCommit,
  onFinish,
  initialRevealed,
}: {
  game: Game;
  gameKey: string;
  players: PlayerState[];
  selfId: string;
  selfName: string;
  selfAvatar?: string;
  season: Standings;
  allTime: Standings;
  // shared Channel/Server toggle (guild launches only); omitted → no toggle.
  scope?: RosterScope;
  onScopeChange?: (s: RosterScope) => void;
  onPresence: (snap: BoardSnapshot) => void;
  onCommit?: (guess: string[]) => Promise<boolean>;
  onFinish: () => void;
  initialRevealed?: number[];
}) {
  // transient guess feedback ("One away…") rides the header date slot during play.
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackOn, setFeedbackOn] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // which list the rail/section shows: the live room, or the cumulative season /
  // all-time table (same table, different window).
  const [view, setView] = useState<RosterView>("live");
  // bumping this asks the Roster to scroll to + pulse your row in the current tab
  // (end-screen locate arrow) without changing tabs.
  const [jumpNonce, setJumpNonce] = useState(0);
  const jumpToSelf = (): void => setJumpNonce((n) => n + 1);

  function showFeedback(msg: string): void {
    setFeedbackText(msg);
    setFeedbackOn(true);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedbackOn(false), 1600);
  }
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);
  useEffect(() => {
    setFeedbackOn(false);
    setView("live");
  }, [game]);

  const canJump = players.some((p) => p.userId === selfId);

  // Grow the whole board to fill large desktop windows (mobile is untouched).
  const scaleRef = useRef<HTMLDivElement>(null);
  const scale = useScaleToFit(scaleRef);

  const header = (className: string) => (
    <Header
      puzzle={game.puzzle}
      feedbackText={feedbackText}
      feedbackOn={feedbackOn}
      className={className}
    />
  );

  return (
    // Mobile: fill the viewport (#app content box = 100dvh − its pt-8/pb-6 = 3.5rem)
    // so the column anchors to the top instead of #app's [&>*]:my-auto centering it —
    // which, with a short roster, stranded a big gap above the board. The players
    // column then flex-grows into that space (see below). Desktop resets to content
    // height so the board stays vertically centered in the wide window.
    <div
      ref={scaleRef}
      // transform-origin defaults to center, so the board grows symmetrically and
      // stays centered (matching #app's auto-margin centering). scale(1) is omitted
      // so mobile never gets a needless containing block from the transform.
      style={scale !== 1 ? { transform: `scale(${scale})` } : undefined}
      className="flex min-h-[calc(100dvh-3.5rem)] w-full animate-fade-in flex-col gap-3 min-[820px]:mx-auto min-[820px]:min-h-0 min-[820px]:max-w-[860px] min-[820px]:flex-row min-[820px]:items-stretch min-[820px]:gap-6"
    >
      {/* main column — board + footer. No header on mobile: Discord shows its own
          activity header there, so we hide ours and keep some top padding (on top of
          #app's pt-8) to clear it. The header sits atop the players rail on desktop
          instead (below). */}
      <div className="flex w-full min-w-0 flex-col gap-3 pt-7 min-[820px]:flex-1 min-[820px]:pt-0">
        <Board
          key={gameKey}
          game={game}
          onPresence={onPresence}
          onCommit={onCommit}
          onFeedback={showFeedback}
          onFinish={() => {
            setView("live");
            onFinish();
          }}
          onJumpToSelf={jumpToSelf}
          canJump={canJump}
          initialRevealed={initialRevealed}
        />
      </div>

      {/* players column — mobile flex-grows into the freed vertical space (list fills +
          scrolls internally); desktop rail absolute-fills to match the board's height */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col min-h-0">
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 min-[820px]:absolute min-[820px]:inset-0">
          {header("hidden min-[820px]:flex")}
          <Roster
            players={players}
            selfId={selfId}
            selfName={selfName}
            selfAvatar={selfAvatar}
            view={view}
            onViewChange={setView}
            scope={scope}
            onScopeChange={onScopeChange}
            season={season}
            allTime={allTime}
            jumpSignal={jumpNonce}
          />
        </div>
      </div>
    </div>
  );
}
