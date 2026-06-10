import { Flame, X } from "lucide-react";
import { useState, type Ref } from "react";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { FlipList } from "./fliplist";
import { colorFor, initials } from "./roster";

// End-screen room leaderboard: two tabs ("This season" = the month, "All-time")
// over the same scores rows, differing only by window. Dense table per tab
// (rank, player, score, streak, won/played, avg mistakes). Top players only —
// your row is highlighted when it places. Fed by room_board / room_self RPCs.

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
        "relative grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none min-[900px]:h-8 min-[900px]:w-8 min-[900px]:text-[13px]" +
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
      {/* the unit only fits once the desktop rail frees up width; on mobile the
          column header ("Score") carries the meaning instead */}
      <span className="ml-0.5 hidden text-[0.62em] font-semibold tracking-[0.02em] text-zinc-500 min-[900px]:inline">
        pts
      </span>
    </span>
  );
}

// Shared column track on header + every row so they line up. The stat columns are
// kept tight (and the gap snug) so the name column keeps real room in the ~418px
// desktop rail — names stay readable instead of truncating to a couple of letters.
// Phones get a 5-column track: Played and Avg ✗ drop out (hidden cells below) and
// the gap tightens, otherwise the fixed columns swallow the name entirely at 360px.
const LGRID =
  "grid grid-cols-[22px_minmax(0,1fr)_62px_32px_48px] items-center gap-1.5 min-[900px]:grid-cols-[22px_minmax(0,1fr)_64px_44px_52px_32px] min-[900px]:gap-2";

type LedgerEntry = {
  id: string;
  name: string;
  avatar: string | null;
  rank: number;
  total: number;
  streak: number;
  plays: number;
  wins: number;
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
      data-flip-row={e.id}
      className={
        // same card as the live roster row (src/roster.tsx RosterRow): a rounded
        // zinc-900/60 panel, your row lifted to zinc-100/10 — spaced, not divided.
        LGRID +
        " rounded-[9px] px-2.5 py-2 min-[900px]:px-3 min-[900px]:py-2.25 " +
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
      <div className="flex min-w-0 items-center gap-2.5 pl-1 min-[900px]:pl-0">
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
      {/* wins over plays in one cell ("6/7"), wins carrying the emphasis */}
      <div className="text-right text-[13px] tabular-nums text-zinc-600">
        <span className="font-semibold text-zinc-300">{e.wins}</span>/{e.plays}
      </div>
      {/* Avg ✗ is a desktop-only column (see LGRID) */}
      <div className="hidden text-right text-[13px] tabular-nums text-zinc-400 min-[900px]:block">
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
  wins: r.wins,
  avg_mistakes: r.avg_mistakes,
});

export type Standings = { board: BoardRow[]; self: SelfStanding | null };

// Empty state shown under the Season / All-time tabs before any game has been scored,
// so the tabs are never dead ends. Just a headline + a line of copy — spoiler-safe (no
// puzzle content) and with no fake standings rows.
export function StandingsEmpty({ window }: { window: "season" | "all" }) {
  const allTime = window === "all";
  return (
    // Desktop: the rail starts this block below the header+tabs yet runs down past
    // the grid into the footer, so a plain center lands ~71px low. The extra bottom
    // padding lifts the centered text back onto the grid's vertical midline (offset
    // is fixed by the header/tabs/footer heights — independent of --tile-h).
    <div className="flex min-h-0 flex-1 animate-tab-in flex-col items-center justify-center gap-5 px-6 py-12 text-center min-[900px]:pt-0 min-[900px]:pb-[140px]">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-display text-[19px] font-semibold leading-tight tracking-[-0.01em] text-[#efefe6]">
          First place is open
        </h3>
        <p className="mx-auto max-w-[32ch] font-sans text-[13px] leading-[1.55] text-zinc-400">
          No scores on the {allTime ? "all-time" : "season"} board yet — finish
          today’s puzzle to put the first one up.
        </p>
      </div>
    </div>
  );
}

// The standings table for one window (season or all-time): top players with your
// row highlighted when it places, column legend below. The roster renders it
// directly under the "Season" and "All-time" tabs, so both windows share this
// exact layout.
export function LedgerBody({
  data,
  selfId,
  query = "",
  fill = false,
  selfRowRef,
}: {
  data: Standings;
  selfId: string;
  query?: string;
  // fill: the row list flexes to fill its parent's height instead of capping at 46vh
  fill?: boolean;
  // attached to your row (when you place on the board) for the locate arrow.
  selfRowRef?: Ref<HTMLDivElement>;
}) {
  const { board } = data;
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

  return (
    <>
      <FlipList
        className={
          // fill mode only scrolls internally on desktop (the fixed-height rail);
          // on mobile the column grows and the page scrolls, so the bottom fade
          // would falsely imply more rows — desktop-only there. The capped
          // (46vh) variant always scrolls internally, so it keeps the fade.
          (fill ? "min-h-0 flex-1 min-[900px]:list-fade" : "max-h-[46vh] list-fade") +
          " flex flex-col gap-1.5 overflow-y-auto scrollbar-thin pb-6"
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
      </FlipList>
      {/* column labels sit at the BOTTOM (a legend), not the top — so the first row
          lands at the same height as the live list's first row (which has no header),
          keeping the two tabs visually consistent as you switch between them. The
          Played / Avg ✗ labels drop out with their columns on mobile (LGRID). */}
      <div
        className={
          LGRID +
          " mt-1.5 border-t border-white/[0.05] px-2.5 pt-2.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500 min-[900px]:px-3"
        }
      >
        <span />
        <span className="pl-1 text-left min-[900px]:pl-0">Player</span>
        <span className="text-right">Score</span>
        {/* the word doesn't fit the mobile streak column; the flame alone reads fine
            since every row pairs it with a count */}
        <span className="flex items-center justify-end gap-[3px]">
          <Flame size={9} fill="currentColor" strokeWidth={0} aria-hidden />
          <span className="hidden min-[900px]:inline">Streak</span>
        </span>
        <span className="text-right">Won</span>
        <span className="hidden items-center justify-end gap-0.5 min-[900px]:flex">
          Avg <X size={9} strokeWidth={2.6} aria-hidden />
        </span>
      </div>
    </>
  );
}

