import { useEffect, useRef, useState } from "react";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
import { LEVELS, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./realtime";
import { Roster, type RosterView } from "./roster";
import { LeaderboardModal, type Standings } from "./season";

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

// "Connections #642 · · · June 2, 2026" lockup. The wordmark + number sit left; the
// date rides the right edge. During play the date slot cross-fades to transient
// guess feedback ("One away…") and back. Lives above the board on mobile and atop
// the players rail on desktop (rendered twice, one hidden per breakpoint).
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
    <header className={"flex items-baseline gap-3 " + className}>
      <span className="font-display text-[23px] font-bold tracking-[-0.02em] text-[#efefe6] min-[820px]:text-[21px]">
        Connections
      </span>
      <span className="font-sans text-[11px] text-zinc-500">#{puzzle.id}</span>
      <span className="relative ml-auto inline-flex items-center justify-end text-right">
        <span
          className={
            "font-sans text-[11px] whitespace-nowrap text-zinc-500 transition-opacity duration-300 " +
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
// players section (Live / Leaderboard tabs + list). Desktop (≥820px): a 50/50 split
// — board + footer on the left, and a right rail (header, tabs, list, pinned "Your
// standing") that absolute-fills the column so it matches the board's height and
// scrolls its list rather than driving the layout taller. The season leaderboard
// (cumulative stats) opens in a modal from the end-screen trophy.
export function GameView({
  game,
  gameKey,
  players,
  selfId,
  selfName,
  selfAvatar,
  season,
  allTime,
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
  // which list the rail/section shows: the live room or today's standings. Starts on
  // the leaderboard for an already-finished (rehydrated) game.
  const [view, setView] = useState<RosterView>(
    game.status === "playing" ? "live" : "board",
  );
  // season leaderboard modal (opened by the end-screen trophy).
  const [seasonOpen, setSeasonOpen] = useState(false);

  function showFeedback(msg: string): void {
    setFeedbackText(msg);
    setFeedbackOn(true);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedbackOn(false), 1600);
  }
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);
  useEffect(() => {
    setFeedbackOn(false);
    setView(game.status === "playing" ? "live" : "board");
  }, [game]);

  const hasSeason = season.board.length > 0 || allTime.board.length > 0;

  const header = (className: string) => (
    <Header
      puzzle={game.puzzle}
      feedbackText={feedbackText}
      feedbackOn={feedbackOn}
      className={className}
    />
  );

  return (
    <div className="flex w-full animate-fade-in flex-col gap-3 min-[820px]:mx-auto min-[820px]:max-w-[860px] min-[820px]:flex-row min-[820px]:items-stretch min-[820px]:gap-6">
      {/* main column — board + footer (header above it on mobile only) */}
      <div className="flex w-full min-w-0 flex-col gap-3 min-[820px]:flex-1">
        {header("min-[820px]:hidden")}
        <Board
          key={gameKey}
          game={game}
          onPresence={onPresence}
          onCommit={onCommit}
          onFeedback={showFeedback}
          onFinish={() => {
            setView("board");
            onFinish();
          }}
          onShowSeason={() => setSeasonOpen(true)}
          hasSeason={hasSeason}
          initialRevealed={initialRevealed}
        />
      </div>

      {/* players column — desktop rail absolute-fills to match the board's height */}
      <div className="relative flex w-full min-w-0 flex-col min-[820px]:flex-1">
        <div className="flex min-h-0 flex-col gap-2.5 min-[820px]:absolute min-[820px]:inset-0">
          {header("hidden min-[820px]:flex")}
          <Roster
            players={players}
            selfId={selfId}
            view={view}
            onViewChange={setView}
            showStanding
          />
        </div>
      </div>

      {seasonOpen && (
        <LeaderboardModal
          season={season}
          allTime={allTime}
          selfId={selfId}
          name={selfName}
          avatar={selfAvatar}
          onClose={() => setSeasonOpen(false)}
        />
      )}
    </div>
  );
}
