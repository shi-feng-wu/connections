import { useEffect, useState } from "react";
import { Flame, X } from "lucide-react";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { colorFor, initials } from "./roster";
import { HoverButton } from "./hoverbutton";

// End-screen room leaderboard: two tabs ("This season" = the month, "All-time")
// over the same scores rows, differing only by window. Dense table per tab
// (rank, player, score, streak, played, win%, avg mistakes). Top players, then
// your pinned row, then "+N below you". Fed by room_board / room_self RPCs.

function LeaderAvatar({
  id,
  name,
  avatar,
  you,
}: {
  id: string;
  name: string;
  avatar: string | null;
  you: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = avatar && broken !== avatar;
  return (
    <div
      className={
        "relative grid h-7.5 w-7.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none" +
        (you ? " shadow-[0_0_0_2px_#000,0_0_0_4px_#f4f4f5]" : "")
      }
      style={{ background: colorFor(id) }}
    >
      {initials(name)}
      {showPhoto && (
        <img
          src={avatar}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          onError={() => setBroken(avatar)}
        />
      )}
    </div>
  );
}

// Streak as a flame + count. Cold/zinc at 0, warms and brightens past a week-long run.
function Streak({ n }: { n: number }) {
  const flame = n === 0 ? "text-zinc-700" : n >= 7 ? "text-orange-400" : "text-orange-300/70";
  const num = n === 0 ? "text-zinc-600" : "text-zinc-200";
  return (
    <span className="inline-flex items-center gap-1 font-bold tabular-nums">
      <Flame className={flame} size={11} fill="currentColor" strokeWidth={0} aria-hidden />
      <span className={num}>{n}</span>
    </span>
  );
}

function ScoreCell({ v }: { v: number }) {
  return (
    <span className="font-extrabold tabular-nums tracking-[-0.01em] text-[#efefe6]">
      {v.toLocaleString()}
      <span className="ml-0.5 text-[0.62em] font-semibold tracking-[0.02em] text-zinc-500">
        pts
      </span>
    </span>
  );
}

// Shared column track on header + every row so they line up.
const LGRID =
  "grid grid-cols-[26px_minmax(0,1fr)_64px_52px_40px_44px_40px] items-center gap-2.5";

type LedgerEntry = {
  id: string;
  name: string;
  avatar: string | null;
  rank: number;
  total: number;
  streak: number;
  plays: number;
  win_pct: number;
  avg_mistakes: number;
};

function LedgerRow({ e, you, first }: { e: LedgerEntry; you: boolean; first: boolean }) {
  return (
    <div
      className={
        LGRID +
        " px-2 py-2 " +
        (you ? "rounded-lg bg-zinc-100/6" : first ? "" : "border-t border-white/[0.045]")
      }
    >
      {e.rank === 1 ? (
        <div className="text-center text-[13px] tabular-nums">
          <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
            1
          </span>
        </div>
      ) : (
        <div className="text-center text-[13px] tabular-nums text-zinc-500">{e.rank}</div>
      )}
      <div className="flex min-w-0 items-center gap-2.5">
        <LeaderAvatar id={e.id} name={e.name} avatar={e.avatar} you={you} />
        <span
          className={
            "truncate text-[13.5px] " +
            (you ? "font-bold text-zinc-100" : "text-[#d4d4d8]")
          }
        >
          {e.name + (you ? " (you)" : "")}
        </span>
      </div>
      <div className="text-right text-[15px]">
        <ScoreCell v={e.total} />
      </div>
      <div className="flex justify-end">
        <Streak n={e.streak} />
      </div>
      <div className="text-right text-[13px] tabular-nums text-zinc-400">{e.plays}</div>
      <div className="text-right text-[13px] text-zinc-400">
        <span className="font-semibold text-zinc-300">{e.win_pct}</span>%
      </div>
      <div className="text-right text-[13px] tabular-nums text-zinc-400">
        {Number(e.avg_mistakes).toFixed(1)}
      </div>
    </div>
  );
}

const toEntry = (r: BoardRow, rank: number): LedgerEntry => ({
  id: r.user_id,
  name: r.name,
  avatar: r.avatar,
  rank,
  total: r.total,
  streak: r.streak,
  plays: r.plays,
  win_pct: r.win_pct,
  avg_mistakes: r.avg_mistakes,
});

export type Standings = { board: BoardRow[]; self: SelfStanding | null };

// One tab's body: header, top players, your pinned row, "+N below you".
function LedgerBody({
  data,
  selfId,
  name,
  avatar,
  query = "",
  fill = false,
}: {
  data: Standings;
  selfId: string;
  name: string;
  avatar?: string;
  query?: string;
  // fill: the row list flexes to fill its parent's height instead of capping at 46vh
  fill?: boolean;
}) {
  const { board, self } = data;
  if (!board.length) {
    return (
      <div className="px-2 py-7 text-center text-[13px] text-zinc-600">No games yet.</div>
    );
  }
  const q = query.trim().toLowerCase();
  const all = board.map((r, i) => toEntry(r, i + 1));
  const rows = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
  const selfRank = self?.rank ?? null;
  const selfShown = rows.some((e) => e.id === selfId);
  const selfEntry: LedgerEntry | null =
    self && selfRank != null
      ? {
          id: selfId,
          name,
          avatar: avatar ?? null,
          rank: selfRank,
          total: self.total,
          streak: self.streak,
          plays: self.plays,
          win_pct: self.win_pct,
          avg_mistakes: self.avg_mistakes,
        }
      : null;
  const below = self && selfRank != null ? self.total_players - selfRank : 0;

  return (
    <>
      <div className={LGRID + " px-2 pb-2 text-[10px] uppercase tracking-[0.055em] text-zinc-600"}>
        <span />
        <span className="text-left">Player</span>
        <span className="text-right text-zinc-500">Score</span>
        <span className="text-right">Streak</span>
        <span className="text-right">Plyd</span>
        <span className="text-right">Win</span>
        <span className="flex items-center justify-end gap-0.5">
          Avg <X size={9} strokeWidth={2.6} aria-hidden />
        </span>
      </div>
      <div
        className={
          (fill ? "min-h-0 flex-1" : "max-h-[46vh]") +
          " overflow-y-auto scrollbar-thin"
        }
      >
        {rows.length ? (
          rows.map((e, i) => (
            <LedgerRow key={e.id} e={e} you={e.id === selfId} first={i === 0} />
          ))
        ) : (
          <div className="px-2 py-6 text-center text-[13px] text-zinc-600">
            No players match.
          </div>
        )}
      </div>
      {!q && selfEntry && !selfShown && (
        <>
          <div className="flex items-center justify-center gap-1.25 py-2">
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
          </div>
          <LedgerRow e={selfEntry} you first={false} />
        </>
      )}
      {!q && below > 0 && (
        <div className="mt-1 flex items-center justify-between border-t border-dashed border-white/12 px-1.5 pt-2.75 pb-0.5">
          <div className="text-[12.5px] text-zinc-500">
            + {below.toLocaleString()} {below === 1 ? "player" : "players"} below you
          </div>
          <div className="flex items-center gap-1 text-[11px] text-zinc-600">
            <X size={10} strokeWidth={2.6} aria-hidden /> = mistakes per game
          </div>
        </div>
      )}
    </>
  );
}

// Live-pulsing title + season/all-time tab switch over the dense table.
export function Leaderboard({
  season,
  allTime,
  selfId,
  name,
  avatar,
  bare = false,
  fill = false,
  searchable = false,
  onClose,
}: {
  season: Standings;
  allTime: Standings;
  selfId: string;
  name: string;
  avatar?: string;
  // bare drops the standalone card surface (the modal supplies its own).
  bare?: boolean;
  // fill: stretch to the parent's height, scrolling the rows internally. Used when
  // the leaderboard takes over the end-screen board area at its exact footprint.
  fill?: boolean;
  searchable?: boolean;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<"season" | "all">("season");
  const [query, setQuery] = useState("");
  const data = tab === "season" ? season : allTime;
  const tabs = [
    ["season", "This season"],
    ["all", "All-time"],
  ] as const;

  return (
    <div
      className={
        (bare
          ? "flex min-h-0 flex-col"
          : "rounded-lg bg-zinc-900/60 p-3" + (fill ? " flex min-h-0 flex-col" : "")) +
        (fill ? " h-full" : "")
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pt-0.5 pb-3">
        <span className="text-xs uppercase tracking-[0.05em] text-zinc-500">Leaderboard</span>
        <div className="flex items-center gap-2">
          <div className="inline-flex gap-0.5 rounded-full border border-[#26262a] bg-zinc-900 p-0.75">
            {tabs.map(([k, label]) => (
              <HoverButton
                key={k}
                type="button"
                onClick={() => setTab(k)}
                hover="-translate-y-[1px]"
                className={
                  "cursor-pointer rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition duration-150 ease-out " +
                  (tab === k
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:text-zinc-100")
                }
              >
                {label}
              </HoverButton>
            ))}
          </div>
          {onClose && (
            <HoverButton
              type="button"
              onClick={onClose}
              aria-label="Close"
              hover="scale-110"
              className="grid h-7.5 w-7.5 flex-none cursor-pointer place-items-center rounded-lg text-zinc-400 transition duration-150 ease-out hover:bg-zinc-800 hover:text-zinc-100"
            >
              <X size={16} strokeWidth={2.2} aria-hidden />
            </HoverButton>
          )}
        </div>
      </div>
      {searchable && (
        <div className="px-1.5 pb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players by name…"
            autoComplete="off"
            className="w-full rounded-full border border-[#2a2a2e] bg-zinc-900 px-3.75 py-2 font-sans text-[13px] text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 hover:border-zinc-600 focus:border-zinc-500"
          />
        </div>
      )}
      <LedgerBody
        data={data}
        selfId={selfId}
        name={name}
        avatar={avatar}
        query={searchable ? query : ""}
        fill={fill}
      />
    </div>
  );
}

// Same leaderboard in a dismissable modal, opened any time from the top-right
// toggle. Mirrors the roster "see all" overlay (Esc / backdrop click to close).
export function LeaderboardModal({
  season,
  allTime,
  selfId,
  name,
  avatar,
  onClose,
}: {
  season: Standings;
  allTime: Standings;
  selfId: string;
  name: string;
  avatar?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-100 flex animate-overlay-fade items-start justify-center overflow-y-auto bg-[#030304]/72 p-4 pt-14 sm:items-center sm:pt-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="flex max-h-[85vh] w-[min(560px,94vw)] animate-sheet-rise flex-col overflow-hidden rounded-2xl border border-[#26262a] bg-zinc-950 p-3.5 shadow-[0_40px_120px_-30px_#000]"
        role="dialog"
        aria-modal="true"
        aria-label="Room leaderboard"
      >
        <Leaderboard
          season={season}
          allTime={allTime}
          selfId={selfId}
          name={name}
          avatar={avatar}
          bare
          searchable
          onClose={onClose}
        />
      </div>
    </div>
  );
}
