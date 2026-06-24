import { useEffect, useRef, useState, type RefObject } from "react";
import iconUrl from "./assets/connections-nyt.png";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
import { useInfoLinks } from "./infolinks";
import { LEVELS, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./player";
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
  tip = false,
}: {
  error?: boolean;
  blocked?: boolean;
  onRetry: () => void;
  date?: string;
  number?: number;
  // show the /enable-posts tip — App passes true only in a guild that positively
  // lacks the bot, so installed servers and DMs load clean.
  tip?: boolean;
}) {
  const inner = blocked ? (
    <>
      <div className="text-balance text-sm font-medium text-zinc-300">
        Open in Discord to play.
      </div>
      <div className="text-pretty text-xs text-zinc-500">
        Connections runs as a Discord Activity — launch it from a server or
        call.
      </div>
    </>
  ) : error ? (
    <>
      <div className="text-balance text-sm font-medium text-zinc-300">
        Couldn’t load the puzzle.
      </div>
      <div className="text-pretty text-xs text-zinc-500">
        Check your connection and try again.
      </div>
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
      <LoadLockup
        caption="Loading today’s puzzle"
        date={date}
        number={number}
      />
      {/* Game-style loading tip (redesign "Loading Animations" · BotNotice): a borderless
          line under the lockup nudging the room to add the bot so it gets the live "who's
          playing" card + daily recap. Cold-start only — not error/blocked, and not the
          midnight turnover (a returning player already knows) — and TARGETED: App passes
          `tip` only in a guild that positively lacks the bot, so it never noises up an
          installed server or a DM. Benefit-first copy; the command is the path, not the
          lead. The green is the puzzle's category green used as a quiet accent. In flow
          (not viewport-pinned), so it rides just under the centered lockup at every
          height, mt-12 keeping it a clearly separate, quieter block; it fades in with the
          screen's animate-fade-in. */}
      {tip && (
        <div className="mt-12 flex flex-col items-center gap-[7px] text-center">
          <span className="font-sans text-[10px] font-bold tracking-[0.22em] text-[#a0c35a] uppercase">
            Tip
          </span>
          <p className="max-w-[300px] text-pretty font-sans text-[12.5px] leading-[1.7] text-zinc-400">
            Want the day’s results and the leaderboard posted here at every
            reset? Run{" "}
            <span className="rounded-[5px] bg-white/[0.06] px-[5px] py-px font-semibold text-zinc-300">
              /enable-posts
            </span>
            .
          </p>
        </div>
      )}
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

// Brand masthead for the desktop players-rail header (per the "Desktop Connections"
// redesign): the kept brick logo · the "Connections" serif wordmark on the left, and a
// right-aligned dateline — the serif date over a small uppercase "No. 642" — with the two
// columns bottom-aligned beneath a single hairline rule. Sits atop the players rail on
// desktop only; hidden on mobile, where Discord shows its own activity header above the
// board — which is why no transient feedback routes through here anymore: everything
// lives on the Submit pill / end footer (visible at every width) instead.
function Header({
  puzzle,
  className = "",
}: {
  puzzle: Puzzle;
  className?: string;
}) {
  const dateLabel = new Date(`${puzzle.date}T00:00:00`).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );
  return (
    <header
      className={
        "flex items-end justify-between gap-[18px] border-b border-white/[0.08] pb-[14px] " +
        className
      }
    >
      {/* left lockup — the kept brick icon (frameless, wordmark-height) · "Connections" */}
      <div className="flex items-center gap-2.5">
        <img
          src={iconUrl}
          alt=""
          className="h-[27px] w-[27px] flex-none object-contain"
        />
        <span className="font-display text-[27px] font-bold leading-none tracking-[-0.025em] text-[#efefe6] [text-box:trim-both_cap_alphabetic]">
          Connections
        </span>
      </div>
      {/* right dateline — the serif date riding the right edge, over a small uppercase
          puzzle number; the column bottom-aligns with the wordmark via the header's items-end.
          Semibold to match the design file: its mh-date declares font-weight 400 but only
          loads Newsreader 600/700, so it renders at 600 (we ship the full 400–700 range). */}
      <div className="flex flex-col items-end gap-[3px] text-right">
        <span className="whitespace-nowrap font-display text-[15px] font-semibold leading-[1.05] text-zinc-300">
          {dateLabel}
        </span>
        <span className="whitespace-nowrap text-[10px] font-semibold uppercase leading-none tracking-[0.08em] tabular-nums text-zinc-600">
          No. {puzzle.id}
        </span>
      </div>
    </header>
  );
}

// Responsive game shell. Mobile / tablet: a single column — header, board + footer,
// then the players section (Live / Season / All-time tabs + list) — capped at
// max-w-480 and centered, so the in-between (tablet) band reads as a roomy phone
// rather than stretching the board wide. Desktop (≥800px): a 50/50
// split — board + footer on the left, and a right rail (header, tabs, list) that
// absolute-fills the column so it matches the board's height and scrolls its list
// rather than driving the layout taller. Season and All-time share one standings
// table (different window); the end-screen locate arrow scrolls + pulses your row in
// whichever tab is open.
// Desktop "scale to fit". The wide layout is the board + roster rail side by side as ONE
// unit (board fills the left half, rail the right half — matched height via the rail's
// absolute inset-0). We scale the WHOLE unit uniformly with a CSS transform, so the board
// and rail ALWAYS share the same height and stay tight, and every aspect ratio is preserved
// (incl. the solved bars, which would otherwise flatten). The factor is bounded by the
// viewport width and height, capped at MAX_SCALE (big-monitor scale-up) and floored at
// MIN_SCALE — scaling BELOW 1 keeps tiles/bars square on short windows instead of the dvh
// clamp flattening tile height; below the floor a rare ultra-short window scrolls.
//
// `transform: scale` doesn't change the LAYOUT box, so the unit would still occupy its
// UNSCALED height in flow: a short window then strands a gap above (origin-center) AND a
// phantom scroll below (the tall unscaled box overflowing). To fix that we ALSO return
// `height` = natH × scale and put it on an OUTER box, with the scaled unit positioned
// `absolute` inside (origin top): the unit no longer contributes its unscaled height, the
// outer box flows at exactly the VISUAL height, so it top-aligns, fills, and only scrolls
// when even MIN_SCALE overflows. natW/natH are the unscaled box (transforms/abs-position
// don't change offsetWidth/Height), so measuring is loop-free; a ResizeObserver re-measures
// on board-height changes (rows → solved bars). V_GUTTER/GUTTER are the small vertical/
// horizontal breathing the unit keeps from the viewport edges. Keep DESKTOP_BP in sync with
// the `min-[800px]:` class literals (components/roster/season) — the JS mirror of the wide
// breakpoint.
const DESKTOP_BP = 800;
const MAX_SCALE = 1.5;
// Floor for the wide-layout shrink: below this the board would read too small / its text
// too fine, so we stop scaling and let the (rare) ultra-short window scroll.
const MIN_SCALE = 0.62;
const GUTTER = 28; // horizontal breathing per edge (binds only on narrow-tall windows)
const V_GUTTER = 12; // vertical breathing per edge — the "little padding" the unit keeps
// Desktop frame: padding between the (borderless) rounded card edge and the board, matched
// to the footer's horizontal padding so the board and the footer links line up. Reserved on
// both axes before fitting so the framed card (board + padding + footer) never overflows.
const FRAME_PAD = 22;

// Scale the board to fill the window, then frame it (rounded, padded card) with the
// info-links footer sharing the frame. Two reservations come out of the viewport before
// fitting: FRAME_PAD on each axis (the card's inner padding) and the footer's real,
// unscaled height — so the framed card (board + padding + footer) always fits.
//
// The board's VISUAL box must equal its LAYOUT box so the frame hugs it at any scale. We
// size the box to the scaled dimensions (natW×scale, natH×scale) and scale the board from
// `top left` to fill it exactly — anchored, not centered-with-overflow. natW is read from a
// separate zero-height probe (`measureRef`, the frame's outer width) minus the padding, so
// it's stable regardless of the live transform; natH is the board's offsetHeight at that
// width (transform-invariant). `width` = natW (applied to the scaled board) and `boxWidth`
// = natW×scale (the framed board area) are both returned.
function useScaleToFit(
  ref: RefObject<HTMLElement | null>,
  footerRef: RefObject<HTMLElement | null>,
  measureRef: RefObject<HTMLElement | null>,
): {
  scale: number;
  height?: number;
  width?: number;
  natW?: number;
} {
  const [fit, setFit] = useState<{
    scale: number;
    height?: number;
    width?: number;
    natW?: number;
  }>({ scale: 1 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      if (window.innerWidth < DESKTOP_BP) {
        setFit({ scale: 1 });
        return;
      }
      // natW: the board's natural width = the probe's full width (the frame's outer width)
      // minus the frame padding, i.e. the board area inside the card. Read from the unscaled
      // probe (not the live, scaled board, whose layout width we drive from this value).
      const probe = measureRef.current?.offsetWidth;
      const natW = probe ? probe - FRAME_PAD * 2 : el.offsetWidth;
      const natH = el.offsetHeight; // transform-invariant; measured at width = natW
      if (!natW || !natH) return;
      // Reserve the footer's real (constant, single-row) height; it isn't scaled.
      const footH = footerRef.current?.offsetHeight ?? 0;
      const fitW = (window.innerWidth - GUTTER * 2 - FRAME_PAD * 2) / natW;
      const fitH =
        (window.innerHeight - V_GUTTER * 2 - FRAME_PAD * 2 - footH) / natH;
      let scale = Math.min(fitW, fitH, MAX_SCALE);
      if (scale < MIN_SCALE) scale = MIN_SCALE;
      setFit({ scale, height: natH * scale, width: natW * scale, natW });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (footerRef.current) ro.observe(footerRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, footerRef, measureRef]);
  return fit;
}

export function GameView({
  game,
  gameKey,
  players,
  selfId,
  season,
  allTime,
  roomKey,
  today,
  scope,
  onScopeChange,
  onAddBot,
  onPresence,
  onCommit,
  onFinish,
  onSubmitFeedback,
  onOpenExternal,
  initialRevealed,
}: {
  game: Game;
  gameKey: string;
  players: PlayerState[];
  selfId: string;
  season: Standings;
  allTime: Standings;
  // stable room id keying the standings position-change snapshot; forwarded to Roster.
  roomKey?: string | null;
  // current ET puzzle-day; the position-change baseline resets when it rolls. Forwarded to Roster.
  today?: string | null;
  // shared Channel/Server toggle (guild launches only); omitted → no toggle.
  scope?: RosterScope;
  onScopeChange?: (s: RosterScope) => void;
  // opens the guild-install consent — present only in a guild without the bot, where
  // the end screen pitches the daily recap (see Roster's RecapPrompt).
  onAddBot?: () => void;
  onPresence: (snap: BoardSnapshot) => void;
  onCommit?: (guess: string[]) => Promise<boolean>;
  onFinish: () => void;
  // Sends a feedback note (the footer's "Send feedback" form). Returns whether it landed.
  // Omitted by the dev preview / landing, where the form falls back to a local thank-you.
  onSubmitFeedback?: (category: string, text: string) => Promise<boolean>;
  // Opens an external URL (the footer's Ko-fi link). App routes it through the Discord SDK
  // when embedded; omitted in preview/landing, where useInfoLinks falls back to window.open.
  onOpenExternal?: (url: string) => void;
  initialRevealed?: number[];
}) {
  // which list the rail/section shows: the live room, or the cumulative season /
  // all-time table (same table, different window).
  const [view, setView] = useState<RosterView>("live");
  // whether today's run is over — drives the next-puzzle countdown under the roster.
  // Mirrored into state (not read off game.status at render) so the Board finishing
  // mid-session re-renders this view even when nothing else changes.
  const [done, setDone] = useState(game.status !== "playing");

  useEffect(() => {
    setView("live");
    setDone(game.status !== "playing");
  }, [game]);

  // Grow the whole board to fill large desktop windows (mobile is untouched). The footer
  // shares the desktop frame below the board; both the footer height and the frame padding
  // are reserved here. measureRef is a zero-height probe for the board's natural width.
  const scaleRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const {
    scale,
    height: boxHeight,
    width: boxWidth,
    natW,
  } = useScaleToFit(scaleRef, footerRef, measureRef);

  const header = (className: string) => (
    <Header puzzle={game.puzzle} className={className} />
  );

  // Info links (redesign "Desktop/Mobile Connections"): a full-width LinkBar footer
  // under the game on desktop; a kebab (⋮) in the players-tab row → bottom sheet on
  // mobile. Both open the same full-screen DetailView (changelog / FAQ / feedback).
  // overlays (sheet + detail screen) portal to <body>.
  const info = useInfoLinks(onSubmitFeedback, onOpenExternal);

  return (
    // Mobile: the unit fills the viewport (#app content box = 100dvh − top safe-area
    // (--sait, floored 12px) − bottom safe-area; mirror index.html's #app) and top-anchors,
    // the players column flex-growing into freed space. Desktop: an OUTER box sized to the
    // scaled unit's VISUAL height (boxHeight) so it flows at that height — #app's
    // [&>*]:my-auto then centers it with no scale gap and no phantom scroll — holding the
    // board+rail UNIT positioned absolute and scaled (origin top). The rail's absolute-fill
    // matches the board's height so the two are always the same height.
    <>
      <div className="mx-auto flex w-full max-w-[480px] flex-col items-center animate-fade-in min-[800px]:max-w-[860px]">
        {/* zero-height probe for the board's natural width (desktop scale math); never
          painted, never scaled, so it stays a stable reference as the board transforms. */}
        <div
          ref={measureRef}
          aria-hidden
          className="pointer-events-none h-0 w-full max-w-[860px]"
        />

        {/* The game. Mobile: a full-bleed column. Desktop: a borderless rounded card — the
          padded board area, then the info-links footer sharing the frame (its top border is
          the divider). overflow-hidden rounds the corners. The width is set explicitly
          (board area + padding) so it doesn't collapse to content. */}
        <div
          className="flex w-full min-w-0 flex-col min-[800px]:overflow-hidden min-[800px]:rounded-[14px]"
          style={boxWidth ? { width: boxWidth + FRAME_PAD * 2 } : undefined}
        >
          {/* board area — desktop padding insets the board from the rounded card edge */}
          <div className="flex min-h-[calc(100dvh_-_max(0.75rem,var(--sait))_-_max(1.5rem,var(--saib)))] w-full flex-col min-[800px]:min-h-0 min-[800px]:p-[22px]">
            {/* game box — desktop: occupies the board's VISUAL box (boxWidth × boxHeight)
              in flow, with the scaled board filling it from the top-left so the frame hugs
              it exactly. Mobile: the column fills the viewport (the box just wraps it). */}
            <div
              className="flex w-full min-w-0 flex-1 flex-col min-[800px]:relative min-[800px]:flex-none"
              style={
                boxHeight ? { height: boxHeight, width: boxWidth } : undefined
              }
            >
              <div
                ref={scaleRef}
                // Desktop: scale from top-left so the board's visual bounds == its layout
                // box (no centering overflow); width is pinned to the measured natural
                // width. Mobile: no transform (the column flows at scale 1).
                style={
                  boxWidth
                    ? {
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                        width: natW,
                      }
                    : undefined
                }
                className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 min-[800px]:max-w-[860px] min-[800px]:flex-none min-[800px]:absolute min-[800px]:left-0 min-[800px]:top-0 min-[800px]:flex-row min-[800px]:items-stretch min-[800px]:gap-6"
              >
                {/* main column — the board. No header on mobile: Discord shows its own
                  activity header there, so we hide ours; #app's top padding already clears
                  that bar. The header sits atop the players rail on desktop (below).
                  Desktop: flex-1 — the board fills the left half, snug against the rail. */}
                <div className="flex w-full min-w-0 flex-col gap-3 min-[800px]:flex-1">
                  <Board
                    key={gameKey}
                    game={game}
                    onPresence={onPresence}
                    onCommit={onCommit}
                    onFinish={() => {
                      setView("live");
                      setDone(true);
                      onFinish();
                    }}
                    initialRevealed={initialRevealed}
                  />
                </div>

                {/* players column — mobile flex-grows into the freed vertical space (list
                  fills + scrolls internally); desktop rail absolute-fills its half so it
                  matches the board's height exactly and scrolls its list within. */}
                <div className="relative flex w-full min-w-0 flex-1 flex-col min-h-0">
                  <div className="flex min-h-0 flex-1 flex-col gap-2.5 min-[800px]:absolute min-[800px]:inset-0">
                    {header("hidden min-[800px]:flex")}
                    <Roster
                      players={players}
                      selfId={selfId}
                      view={view}
                      onViewChange={setView}
                      scope={scope}
                      onScopeChange={onScopeChange}
                      season={season}
                      allTime={allTime}
                      roomKey={roomKey}
                      today={today}
                      nextPuzzle={done}
                      onAddBot={done ? onAddBot : undefined}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* info-links footer — desktop only, sharing the card frame in normal flow: its
            real height is reserved by useScaleToFit, and its top border divides it from the
            board area. Mobile hides it (links live in the kebab sheet). */}
          <div ref={footerRef} className="hidden min-[800px]:block">
            {info.footer()}
          </div>
        </div>
      </div>
      {info.overlays}
    </>
  );
}
