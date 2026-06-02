import { useEffect, useRef, useState, type ReactNode } from "react";
import { Board, type BoardSnapshot } from "./board";
import { HoverButton } from "./hoverbutton";
import { LEVELS, MAX_MISTAKES, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./realtime";
import { Roster } from "./roster";
import type { Standings } from "./season";

// shimmer gradient swept across each skeleton tile while loading
const SHINE =
  "absolute inset-0 animate-shimmer [background:linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.05)_18%,rgba(255,255,255,0.09)_50%,rgba(255,255,255,0.05)_82%,transparent_100%)]";

// Loading screen: serif header + date land immediately, board is a skeleton
// with a diagonal shimmer wave, category colors pulse as the loader. id/editor
// aren't known until the fetch lands, so that sub-line is skeletoned too.
// Slow fetch adds a "taking longer" line; a failed one dims the board + retry.
export function LoadingScreen({
  error = false,
  blocked = false,
  onRetry,
  players = [],
  selfId = "",
}: {
  error?: boolean;
  blocked?: boolean;
  onRetry: () => void;
  // roster shown alongside the skeleton so it doesn't shift in after load
  players?: PlayerState[];
  selfId?: string;
}) {
  // surfaces the "taking longer" line after 5s
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (error || blocked) return;
    const id = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(id);
  }, [error, blocked]);

  // dim the board for any non-loading state (error or blocked).
  const dim = error || blocked;

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const main = (
    <>
      <header className="font-serif">
        <h1 className="text-4xl font-bold tracking-tight text-[#efefe6]">Connections</h1>
        <p className="font-sans text-xs text-zinc-500">{today}</p>
      </header>

      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: 16 }, (_, i) => {
          const row = Math.floor(i / 4);
          const col = i % 4;
          return (
            <div
              key={i}
              className={
                "relative h-20 overflow-hidden rounded-lg bg-[#161619]" +
                (dim ? " opacity-50" : "")
              }
            >
              {!dim && (
                <span className={SHINE} style={{ animationDelay: `${(row + col) * 0.11}s` }} />
              )}
            </div>
          );
        })}
      </div>

      {blocked ? (
        <div className="flex flex-col items-center gap-1.5 pt-1 text-center">
          <div className="text-sm font-medium text-zinc-300">Open in Discord to play.</div>
          <div className="mb-2 text-xs text-zinc-500">
            Connections runs as a Discord Activity — launch it from a server or call.
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-1.5 pt-1 text-center">
          <div className="text-sm font-medium text-zinc-300">Couldn’t load the puzzle.</div>
          <div className="mb-2 text-xs text-zinc-500">Check your connection and try again.</div>
          <HoverButton
            type="button"
            onClick={onRetry}
            hover="-translate-y-[1px] shadow-[0_6px_18px_-8px_rgba(244,244,245,0.55)]"
            className="cursor-pointer rounded-full border border-zinc-100 bg-zinc-100 px-5.5 py-2.5 text-sm font-semibold text-zinc-900 transition duration-150 ease-out hover:bg-white"
          >
            Try again
          </HoverButton>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3.5 pt-1">
          <div className="flex gap-1.75">
            {LEVELS.map((l, i) => (
              <span
                key={i}
                className="h-4.5 w-4.5 animate-qpulse rounded"
                style={{ background: l.color, animationDelay: `${i * 0.16}s` }}
              />
            ))}
          </div>
          <div className="text-[13px] tracking-[0.01em] text-zinc-500">Loading puzzle…</div>
          <div className="-mt-1.5 min-h-3.5 text-[11.5px] text-zinc-600">
            {slow ? "Taking longer than usual — hang tight." : ""}
          </div>
        </div>
      )}
    </>
  );

  // Blocked is terminal (no room) — center it alone. Loading/error share the game's
  // two-column shell so the board keeps its place and the roster doesn't shift in.
  if (blocked) {
    return <div className="mx-auto flex w-full max-w-xl flex-col gap-4">{main}</div>;
  }
  return (
    <GameShell sidebar={<Roster players={players} selfId={selfId} sidebar loading />}>
      {main}
    </GameShell>
  );
}

function Header({ puzzle }: { puzzle: Puzzle }) {
  const dateLabel = new Date(`${puzzle.date}T00:00:00`).toLocaleDateString(
    "en-US",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );
  return (
    <header className="font-serif">
      <h1 className="text-4xl font-bold tracking-tight text-[#efefe6]">
        Connections
      </h1>
      <p className="font-sans text-xs text-zinc-500">
        #{puzzle.id} · {dateLabel}
      </p>
    </header>
  );
}

const fmtTime = (ms: number | null): string => {
  const s = Math.max(1, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Score hero, shown opposite the title once the game ends. It's an absolute
// overlay (see GameView) so revealing it reflows nothing — the title block and
// board stay exactly where they were during play; the hero's extra height just
// spills into the gap below the title rather than shoving the board down.
function Hero({ game }: { game: Game }) {
  const won = game.status === "won";
  const perfect = won && game.mistakesLeft === MAX_MISTAKES;
  const status = perfect ? "Perfect" : won ? "Solved" : "Out of guesses";
  const made = MAX_MISTAKES - game.mistakesLeft;
  // groups deduced (excludes the loss back-fill), so a loss reads e.g. 2/4.
  const solved = game.groupsSolved;

  return (
    <div className="flex flex-none animate-hero-in flex-col items-end text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
        {status}
      </div>
      <div className="text-[clamp(30px,5.5vw,44px)] font-extrabold leading-[1.02] tracking-[-0.02em] tabular-nums text-[#efefe6]">
        +{game.score.toLocaleString()}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-zinc-400 [&>span]:whitespace-nowrap">
        <span className="inline-flex items-center gap-1">
          {Array.from({ length: MAX_MISTAKES }, (_, i) => (
            <span
              key={i}
              className={
                "h-1.5 w-1.5 rounded-full " +
                (i < MAX_MISTAKES - made ? "bg-zinc-300" : "bg-zinc-700")
              }
            />
          ))}
        </span>
        <span className="text-zinc-700">·</span>
        <span className="tabular-nums tracking-[0.01em]">{fmtTime(game.durationMs)}</span>
        <span className="text-zinc-700">·</span>
        <span className="tabular-nums">{solved}/4</span>
      </div>
    </div>
  );
}

// Shared two-column shell: main content left, live Roster sidebar right; they
// stack below the 820px breakpoint. Used by both the loading screen and the game
// so the board keeps its place and the roster never shifts in after load.
function GameShell({
  children,
  sidebar,
}: {
  children: ReactNode;
  sidebar: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col items-stretch justify-center gap-5.5 min-[820px]:flex-row min-[820px]:items-start">
      <div className="flex w-full min-w-0 flex-col gap-4 min-[820px]:max-w-xl min-[820px]:flex-1">
        {children}
      </div>
      <aside className="flex w-full flex-col gap-5 min-[820px]:w-75 min-[820px]:flex-none">
        {sidebar}
      </aside>
    </div>
  );
}

// Puzzle owns the left column, live Roster rides the sidebar. Leaderboard moved to
// the end screen, so the sidebar is just the Roster now.
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
  onFinish: () => void;
  initialRevealed?: number[];
}) {
  // hero rides the header row once the game ends; init from status so rehydrated
  // (preview) finished games show it at once, and reset when a new puzzle loads.
  const [finished, setFinished] = useState(game.status !== "playing");
  // transient guess feedback ("One away…") occupies the same header slot the
  // score hero will, so wrong-guess results land where the final score lands.
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackOn, setFeedbackOn] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  function showFeedback(msg: string): void {
    setFeedbackText(msg);
    setFeedbackOn(true);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedbackOn(false), 1600);
  }
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);
  useEffect(() => {
    setFinished(game.status !== "playing");
    setFeedbackOn(false);
  }, [game]);

  return (
    <GameShell sidebar={<Roster players={players} selfId={selfId} sidebar />}>
      <div className="relative flex items-start justify-between gap-4">
        <Header puzzle={game.puzzle} />
        {/* Title block stays flush and the board never moves: the scorecard is
            an absolute overlay over this row, so its extra height spills upward
            rather than reflowing anything. Bottom-aligned so its stats line ends
            level with the title's sub-line — both the same distance from the grid.
            During play this same slot carries transient guess feedback. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-end">
          {finished ? (
            <Hero game={game} />
          ) : (
            <div
              className={
                "text-sm font-bold text-zinc-100 transition-all duration-300 ease-out " +
                (feedbackOn
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-1.5")
              }
            >
              {feedbackText}
            </div>
          )}
        </div>
      </div>
      <Board
        key={gameKey}
        game={game}
        season={season}
        allTime={allTime}
        selfId={selfId}
        selfName={selfName}
        selfAvatar={selfAvatar}
        onPresence={onPresence}
        onFeedback={showFeedback}
        onFinish={() => {
          setFinished(true);
          onFinish();
        }}
        initialRevealed={initialRevealed}
      />
    </GameShell>
  );
}
