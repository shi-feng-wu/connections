import { useEffect, useRef, useState } from "react";
import iconUrl from "./assets/connections-nyt.png";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
import { LEVELS, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./realtime";
import { Roster, type RosterScope, type RosterView } from "./roster";
import { type Standings } from "./season";

// Loading / error / blocked screen, centered on the page. The in-progress state is
// deliberately minimal: just the four category squares pulsing in sequence. Once the
// puzzle lands the game fades in (GameView's animate-fade-in), so the loader simply
// dissolves into the page rather than swapping a full skeleton board out.
export function LoadingScreen({
  error = false,
  blocked = false,
  onRetry,
}: {
  error?: boolean;
  blocked?: boolean;
  onRetry: () => void;
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
    <div className="flex gap-2">
      {LEVELS.map((l, i) => (
        <span
          key={l.key}
          className="h-5 w-5 animate-qpulse rounded"
          style={{ background: l.color, animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </div>
  );

  return (
    <div className="flex w-full animate-fade-in flex-col items-center justify-center gap-3 py-20 text-center">
      {inner}
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
        <span className="font-display text-[27px] font-bold leading-none tracking-[-0.025em] text-[#efefe6]">
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
            "font-display text-[14px] font-semibold leading-none text-zinc-500 transition-opacity duration-300 " +
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
    <div className="flex min-h-[calc(100dvh-3.5rem)] w-full animate-fade-in flex-col gap-3 min-[820px]:mx-auto min-[820px]:min-h-0 min-[820px]:max-w-[860px] min-[820px]:flex-row min-[820px]:items-stretch min-[820px]:gap-6">
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
