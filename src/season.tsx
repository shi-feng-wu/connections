import { useEffect, useState } from "react";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { colorFor, initials } from "./roster";

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
        (you ? " shadow-[0_0_0_2px_#09090b,0_0_0_4px_#f4f4f5]" : "")
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

// Streak as a CSS "ember" (upward triangle) + count, no flame glyph.
// Cools to zinc at 0, brightens past a week-long run.
function Streak({ n }: { n: number }) {
  const tone = n === 0 ? "text-zinc-600" : n >= 7 ? "text-[#efefe6]" : "text-zinc-300";
  const ember = n === 0 ? "opacity-25" : n >= 7 ? "opacity-100" : "opacity-50";
  return (
    <span className={"inline-flex items-center gap-1.25 font-bold tabular-nums " + tone}>
      <span
        className={"rounded-[1px] " + ember}
        style={{
          width: 0,
          height: 0,
          borderLeft: "4px solid transparent",
          borderRight: "4px solid transparent",
          borderBottom: "8px solid currentColor",
        }}
      />
      {n}
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
}: {
  data: Standings;
  selfId: string;
  name: string;
  avatar?: string;
}) {
  const { board, self } = data;
  if (!board.length) {
    return (
      <div className="px-2 py-7 text-center text-[13px] text-zinc-600">No games yet.</div>
    );
  }
  const top = board.slice(0, 5).map((r, i) => toEntry(r, i + 1));
  const selfRank = self?.rank ?? null;
  const selfInTop = selfRank != null && selfRank <= top.length;
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
        <span className="text-right">Avg ✗</span>
      </div>
      {top.map((e, i) => (
        <LedgerRow key={e.id} e={e} you={e.id === selfId} first={i === 0} />
      ))}
      {selfEntry && !selfInTop && (
        <>
          <div className="flex items-center justify-center gap-1.25 py-2">
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
            <span className="h-[3px] w-[3px] rounded-full bg-zinc-700" />
          </div>
          <LedgerRow e={selfEntry} you first={false} />
        </>
      )}
      {below > 0 && (
        <div className="mt-1 flex items-center justify-between border-t border-dashed border-white/12 px-1.5 pt-2.75 pb-0.5">
          <div className="text-[12.5px] text-zinc-500">
            + {below.toLocaleString()} {below === 1 ? "player" : "players"} below you
          </div>
          <div className="text-[11px] text-zinc-600">✗ = mistakes per game</div>
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
}: {
  season: Standings;
  allTime: Standings;
  selfId: string;
  name: string;
  avatar?: string;
}) {
  const [tab, setTab] = useState<"season" | "all">("season");
  const data = tab === "season" ? season : allTime;
  const tabs = [
    ["season", "This season"],
    ["all", "All-time"],
  ] as const;

  return (
    <div className="rounded-lg bg-zinc-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pt-0.5 pb-3">
        <span className="flex items-center gap-2 text-xs uppercase tracking-[0.05em] text-zinc-500">
          <span className="h-1.75 w-1.75 animate-livedot rounded-full bg-emerald-400" />
          Leaderboard
        </span>
        <div className="inline-flex gap-0.5 rounded-full border border-[#26262a] bg-zinc-900 p-0.75">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                "cursor-pointer rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition " +
                (tab === k
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-100")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <LedgerBody data={data} selfId={selfId} name={name} avatar={avatar} />
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
      className="fixed inset-0 z-100 flex animate-overlay-fade items-start justify-center overflow-y-auto bg-[#030304]/66 p-4 pt-14 sm:items-center sm:pt-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-[min(560px,94vw)] animate-sheet-rise rounded-2xl border border-[#26262a] bg-zinc-950 p-2.5 shadow-[0_40px_120px_-30px_#000]"
        role="dialog"
        aria-modal="true"
        aria-label="Room leaderboard"
      >
        <div className="flex justify-end pb-0.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7.5 w-7.5 flex-none cursor-pointer place-items-center rounded-lg text-[15px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
        <Leaderboard
          season={season}
          allTime={allTime}
          selfId={selfId}
          name={name}
          avatar={avatar}
        />
      </div>
    </div>
  );
}
