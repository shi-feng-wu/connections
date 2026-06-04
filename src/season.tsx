import { Flame, Infinity as InfinityIcon, RotateCcw, X } from "lucide-react";
import { useState, type Ref } from "react";
import { LEVELS } from "./game";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { colorFor, initials } from "./roster";

// End-screen room leaderboard: two tabs ("This season" = the month, "All-time")
// over the same scores rows, differing only by window. Dense table per tab
// (rank, player, score, streak, played, win%, avg mistakes). Top players, then
// your pinned row. Fed by room_board / room_self RPCs.

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
        // same avatar as the live roster row (src/roster.tsx Avatar) for consistency
        "relative grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none min-[820px]:h-8 min-[820px]:w-8 min-[820px]:text-[13px]" +
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

// Streak as a flame + count. Cold/zinc at 0, warms and brightens past a week-long run.
function Streak({ n }: { n: number }) {
  const flame =
    n === 0
      ? "text-zinc-700"
      : n >= 7
        ? "text-orange-400"
        : "text-orange-300/70";
  const num = n === 0 ? "text-zinc-600" : "text-zinc-200";
  return (
    <span className="inline-flex items-center gap-1 font-bold tabular-nums">
      <Flame
        className={flame}
        size={11}
        fill="currentColor"
        strokeWidth={0}
        aria-hidden
      />
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

// Shared column track on header + every row so they line up. The stat columns are
// kept tight (and the gap snug) so the name column keeps real room in the ~418px
// desktop rail — names stay readable instead of truncating to a couple of letters.
const LGRID =
  "grid grid-cols-[22px_minmax(0,1fr)_64px_48px_28px_42px_34px] items-center gap-2";

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

function LedgerRow({
  e,
  you,
  rowRef,
}: {
  e: LedgerEntry;
  you: boolean;
  // attached to your row so the locate arrow can scroll + pulse it here too.
  rowRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={rowRef}
      className={
        // same card as the live roster row (src/roster.tsx RosterRow): a rounded
        // zinc-900/60 panel, your row lifted to zinc-100/10 — spaced, not divided.
        LGRID +
        " rounded-[9px] px-2.5 py-1.5 min-[820px]:px-3 min-[820px]:py-2.25 " +
        (you ? "bg-zinc-100/10" : "bg-zinc-900/60")
      }
    >
      {e.rank === 1 ? (
        <div className="text-center text-[13px] tabular-nums">
          <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
            1
          </span>
        </div>
      ) : (
        <div className="text-center text-[13px] tabular-nums text-zinc-500">
          {e.rank}
        </div>
      )}
      {/* pl-1 on mobile widens just the rank→avatar gap (matching the live roster);
          the legend's "Player" label gets the same pad so they stay aligned. */}
      <div className="flex min-w-0 items-center gap-2.5 pl-1 min-[820px]:pl-0">
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
      <div className="text-right text-[13px] tabular-nums text-zinc-400">
        {e.plays}
      </div>
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

// Empty state shown under the Season / All-time tabs before any game has been scored,
// so the tabs are never dead ends. The emblem is the app's own solved-bar motif rebuilt
// as a four-rank bar chart — the category colors pulsing in sequence, the same cue the
// loading screen uses — so it reads as "the board, waiting to fill" rather than a
// generic empty box. Spoiler-safe: no puzzle content, and no fake standings rows.
export function StandingsEmpty({ window }: { window: "season" | "all" }) {
  const allTime = window === "all";
  // descending bars = a ranking, brightest (yellow, #1) tallest on the left.
  const bars = [36, 28, 21, 15];
  return (
    <div className="flex min-h-0 flex-1 animate-fade-in flex-col items-center justify-center gap-5 px-6 py-12 text-center">
      {/* podium emblem — solved bars as a ranking chart, warm halo behind for depth */}
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-5 blur-2xl"
          style={{
            background:
              "radial-gradient(closest-side, rgba(249,223,109,0.13), transparent)",
          }}
        />
        <div className="relative flex h-[68px] w-[68px] items-end justify-center gap-1.25 rounded-2xl border border-white/[0.07] bg-zinc-900/60 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {bars.map((h, i) => (
            <span
              key={i}
              className="w-1.5 animate-qpulse rounded-full"
              style={{
                height: h,
                background: LEVELS[i].color,
                animationDelay: `${i * 0.16}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="font-display text-[19px] font-semibold leading-tight tracking-[-0.01em] text-[#efefe6]">
          First place is open
        </h3>
        <p className="mx-auto max-w-[32ch] font-sans text-[13px] leading-[1.55] text-zinc-400">
          No scores on the {allTime ? "all-time" : "season"} board yet — finish
          today’s puzzle to put the first one up.
        </p>
      </div>

      <div className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-zinc-900/50 px-2.75 py-1 font-sans text-[11px] font-medium tracking-[0.01em] text-zinc-500">
        {allTime ? (
          <InfinityIcon size={12} strokeWidth={2.2} aria-hidden />
        ) : (
          <RotateCcw size={11} strokeWidth={2.2} aria-hidden />
        )}
        {allTime ? "Every game counts" : "Season resets monthly"}
      </div>
    </div>
  );
}

// The standings table for one window (season or all-time): column header, top
// players, your pinned row. The roster renders it directly under
// the "Season" and "All-time" tabs, so both windows share this exact layout.
export function LedgerBody({
  data,
  selfId,
  name,
  avatar,
  query = "",
  fill = false,
  selfRowRef,
}: {
  data: Standings;
  selfId: string;
  name: string;
  avatar?: string;
  query?: string;
  // fill: the row list flexes to fill its parent's height instead of capping at 46vh
  fill?: boolean;
  // attached to your row (in-board or pinned) for the locate arrow.
  selfRowRef?: Ref<HTMLDivElement>;
}) {
  const { board, self } = data;
  if (!board.length) {
    return (
      <div className="px-2 py-7 text-center text-[13px] text-zinc-600">
        No games yet.
      </div>
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

  return (
    <>
      <div
        className={
          (fill ? "min-h-0 flex-1" : "max-h-[46vh]") +
          " list-fade flex flex-col gap-1.25 overflow-y-auto scrollbar-thin min-[820px]:gap-1.5"
        }
      >
        {rows.length ? (
          rows.map((e) => (
            <LedgerRow
              key={e.id}
              e={e}
              you={e.id === selfId}
              rowRef={e.id === selfId ? selfRowRef : undefined}
            />
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
          <LedgerRow e={selfEntry} you rowRef={selfRowRef} />
        </>
      )}
      {/* column labels sit at the BOTTOM (a legend), not the top — so the first row
          lands at the same height as the live list's first row (which has no header),
          keeping the two tabs visually consistent as you switch between them. */}
      <div
        className={
          LGRID +
          " mt-1.5 border-t border-white/[0.05] px-2.5 pt-2.5 text-[10px] uppercase tracking-[0.055em] text-zinc-600 min-[820px]:px-3"
        }
      >
        <span />
        <span className="pl-1 text-left min-[820px]:pl-0">Player</span>
        <span className="text-right text-zinc-500">Score</span>
        <span className="text-right">Streak</span>
        <span className="text-right">Plyd</span>
        <span className="text-right">Win</span>
        <span className="flex items-center justify-end gap-0.5">
          Avg <X size={9} strokeWidth={2.6} aria-hidden />
        </span>
      </div>
    </>
  );
}

