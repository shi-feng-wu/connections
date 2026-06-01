import { useEffect, useState } from "react";
import { Board, type BoardSnapshot } from "./board";
import { LEVELS, type Game, type Puzzle } from "./game";
import type { PlayerState } from "./realtime";
import { Roster } from "./roster";
import { LeaderboardModal, type Standings } from "./season";

// shimmer gradient swept across each skeleton tile while loading
const SHINE =
  "absolute inset-0 animate-shimmer [background:linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.05)_18%,rgba(255,255,255,0.09)_50%,rgba(255,255,255,0.05)_82%,transparent_100%)]";

// Loading screen: serif header + date land immediately, board is a skeleton
// with a diagonal shimmer wave, category colors pulse as the loader. id/editor
// aren't known until the fetch lands, so that sub-line is skeletoned too.
// Slow fetch adds a "taking longer" line; a failed one dims the board + retry.
export function LoadingScreen({
  error = false,
  onRetry,
}: {
  error?: boolean;
  onRetry: () => void;
}) {
  // surfaces the "taking longer" line after 5s
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (error) return;
    const id = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(id);
  }, [error]);

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <header className="font-serif">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-4xl font-bold tracking-tight text-[#efefe6]">Connections</h1>
          <span className="text-lg text-zinc-400">{today}</span>
        </div>
        {/* id · editor unknown until the fetch lands, so skeleton it */}
        <div className="relative mt-2 h-[11px] w-[168px] overflow-hidden rounded bg-[#161619]">
          {!error && <span className={SHINE} style={{ animationDelay: "0.2s" }} />}
        </div>
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
                (error ? " opacity-50" : "")
              }
            >
              {!error && (
                <span className={SHINE} style={{ animationDelay: `${(row + col) * 0.11}s` }} />
              )}
            </div>
          );
        })}
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-1.5 pt-1 text-center">
          <div className="text-sm font-medium text-zinc-300">Couldn’t load the puzzle.</div>
          <div className="mb-2 text-xs text-zinc-500">Check your connection and try again.</div>
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer rounded-full border border-zinc-100 bg-zinc-100 px-5.5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white"
          >
            Try again
          </button>
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
    </div>
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
  const sub = [`#${puzzle.id}`, puzzle.editor && `Edited by ${puzzle.editor}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <header className="font-serif">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-4xl font-bold tracking-tight text-[#efefe6]">
          Connections
        </h1>
        <span className="text-lg text-zinc-400">{dateLabel}</span>
      </div>
      {sub && <p className="font-sans text-xs text-zinc-500">{sub}</p>}
    </header>
  );
}

// Puzzle owns the left column, live Roster rides the right sidebar; they stack
// below the 820px breakpoint. Leaderboard moved to the end screen, so the
// sidebar is just the Roster now.
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
  // leaderboard reachable any time via the top-right toggle, not just at finish
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  return (
    <div className="flex w-full flex-col items-stretch justify-center gap-5.5 min-[820px]:flex-row min-[820px]:items-start">
      <div className="flex w-full min-w-0 flex-col gap-4 min-[820px]:max-w-xl min-[820px]:flex-1">
        <div className="flex items-start justify-between gap-3">
          <Header puzzle={game.puzzle} />
          <button
            type="button"
            onClick={() => setShowLeaderboard(true)}
            aria-label="View leaderboard"
            title="Leaderboard"
            className="mt-1 grid h-9 w-9 flex-none cursor-pointer place-items-center rounded-full border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 21V11M12 21V4M19 21v-7" />
            </svg>
          </button>
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
          onFinish={onFinish}
          initialRevealed={initialRevealed}
        />
      </div>
      <aside className="flex w-full flex-col gap-5 min-[820px]:w-75 min-[820px]:flex-none">
        <Roster players={players} selfId={selfId} sidebar />
      </aside>

      {showLeaderboard && (
        <LeaderboardModal
          season={season}
          allTime={allTime}
          selfId={selfId}
          name={selfName}
          avatar={selfAvatar}
          onClose={() => setShowLeaderboard(false)}
        />
      )}
    </div>
  );
}
