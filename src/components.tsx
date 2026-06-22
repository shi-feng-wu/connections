import { useEffect, useRef, useState, type RefObject } from "react";
import iconUrl from "./assets/connections-nyt.png";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
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

// Brand lockup for the desktop players-rail header (per the "Desktop Connections"
// redesign): the kept brick logo · the "Connections" serif wordmark · a bordered "No. 642"
// pill, grouped on the left, with the serif date riding the right edge and a hairline
// divider beneath. Sits atop the players rail on desktop only; hidden on mobile, where
// Discord shows its own activity header above the board — which is why no transient
// feedback routes through here anymore: everything lives on the Submit pill / end
// footer (visible at every width) instead.
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
        {/* nudged down: the centered pill spans the wordmark's cap-to-baseline, which reads
            high against the lowercase mass — optically center it on the x-height band */}
        <span className="flex-none translate-y-[2px] rounded-full border border-white/[0.13] px-2 py-[3px] font-sans text-[10px] font-bold uppercase leading-none tracking-[0.08em] tabular-nums text-zinc-400">
          No. {puzzle.id}
        </span>
      </div>
      {/* serif date riding the right edge — translated down so its baseline sits on the
          wordmark's: both are cap-trimmed, so center-alignment leaves the smaller date's
          baseline (capHeight27 − capHeight14)/2 ≈ 4.4px high */}
      <span className="translate-y-[4.4px] whitespace-nowrap text-right font-display text-[14px] font-semibold leading-none text-zinc-500 [text-box:trim-both_cap_alphabetic]">
        {dateLabel}
      </span>
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

function useScaleToFit(ref: RefObject<HTMLElement | null>): {
  scale: number;
  height?: number;
} {
  const [fit, setFit] = useState<{ scale: number; height?: number }>({
    scale: 1,
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      if (window.innerWidth < DESKTOP_BP) {
        setFit({ scale: 1 });
        return;
      }
      const natW = el.offsetWidth;
      const natH = el.offsetHeight;
      if (!natW || !natH) return;
      const fitW = (window.innerWidth - GUTTER * 2) / natW;
      const fitH = (window.innerHeight - V_GUTTER * 2) / natH;
      let scale = Math.min(fitW, fitH, MAX_SCALE);
      if (scale < MIN_SCALE) scale = MIN_SCALE;
      setFit({ scale, height: natH * scale });
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
  scope,
  onScopeChange,
  onAddBot,
  onPresence,
  onCommit,
  onFinish,
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
  // shared Channel/Server toggle (guild launches only); omitted → no toggle.
  scope?: RosterScope;
  onScopeChange?: (s: RosterScope) => void;
  // opens the guild-install consent — present only in a guild without the bot, where
  // the end screen pitches the daily recap (see Roster's RecapPrompt).
  onAddBot?: () => void;
  onPresence: (snap: BoardSnapshot) => void;
  onCommit?: (guess: string[]) => Promise<boolean>;
  onFinish: () => void;
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

  // Grow the whole board to fill large desktop windows (mobile is untouched).
  const scaleRef = useRef<HTMLDivElement>(null);
  const { scale, height: boxHeight } = useScaleToFit(scaleRef);

  const header = (className: string) => (
    <Header puzzle={game.puzzle} className={className} />
  );

  return (
    // Mobile: the unit fills the viewport (#app content box = 100dvh − top safe-area
    // (--sait, floored 12px) − bottom safe-area; mirror index.html's #app) and top-anchors,
    // the players column flex-growing into freed space. Desktop: an OUTER box sized to the
    // scaled unit's VISUAL height (boxHeight) so it flows at that height — #app's
    // [&>*]:my-auto then centers it with no scale gap and no phantom scroll — holding the
    // board+rail UNIT positioned absolute and scaled (origin top). The rail's absolute-fill
    // matches the board's height so the two are always the same height.
    <div
      className="mx-auto w-full max-w-[480px] animate-fade-in min-[800px]:relative min-[800px]:max-w-[860px]"
      style={boxHeight ? { height: boxHeight } : undefined}
    >
      <div
        ref={scaleRef}
        // origin top: the scaled unit top-aligns to the outer box (no centering gap) and
        // centers horizontally. scale(1) is omitted so mobile gets no needless transform.
        style={
          scale !== 1
            ? { transform: `scale(${scale})`, transformOrigin: "top" }
            : undefined
        }
        className="flex min-h-[calc(100dvh_-_max(0.75rem,var(--sait))_-_max(1.5rem,var(--saib)))] w-full flex-col gap-3 min-[800px]:min-h-0 min-[800px]:absolute min-[800px]:inset-x-0 min-[800px]:top-0 min-[800px]:flex-row min-[800px]:items-stretch min-[800px]:gap-6"
      >
        {/* main column — board + footer. No header on mobile: Discord shows its own
          activity header there, so we hide ours; #app's top padding (max(0.75rem,--sait))
          already clears that bar — and floors at 12px when there's none — so no extra top
          padding here. The header sits atop the players rail on desktop instead (below).
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

        {/* players column — mobile flex-grows into the freed vertical space (list fills +
          scrolls internally); desktop rail absolute-fills its half so it matches the
          board's height exactly (same-height pair) and scrolls its list within. */}
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
              nextPuzzle={done}
              onAddBot={done ? onAddBot : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
