import { ChevronDown, ChevronUp, Flame, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import type { BoardRow, SelfStanding } from "./leaderboard";
import { FlipList } from "./fliplist";
import { colorFor, initials } from "./roster";
import { type Delta, rankDelta } from "./standings-snapshot";

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
        "relative grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none min-[800px]:h-8 min-[800px]:w-8 min-[800px]:text-[13px]" +
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

// Position change since this board's daily baseline: a green up-arrow when the player
// climbed (fewer = better rank), red down-arrow when they slipped, with the number of
// places moved. An amber dash marks a brand-new entrant (on the board now, absent from the
// day-start baseline). Nothing for an unchanged player or the first-ever visit — delta is
// null/0 in those cases.
function RankDelta({ delta }: { delta: Delta }) {
  if (delta === "new")
    return (
      <span
        className="text-[11px] font-bold leading-none text-amber-400"
        aria-label="new"
      >
        –
      </span>
    );
  if (!delta) return null;
  const up = delta > 0;
  const Icon = up ? ChevronUp : ChevronDown;
  return (
    <span
      className={
        "inline-flex items-center gap-px text-[11px] font-bold tabular-nums " +
        (up ? "text-emerald-400" : "text-rose-400")
      }
    >
      <Icon size={11} strokeWidth={3} aria-hidden />
      {Math.abs(delta)}
    </span>
  );
}

// How long a delta stays up once revealed — the auto-flash on first view, and a tap on
// touch (where there's no hover to hold it open). Mouse hover holds it open directly.
const DELTA_HOLD_MS = 1500;

// A board's position-change deltas flash at most once per activity launch. The tab-switch
// reveal and the scroll-into-view reveal are the same thing underneath — "this row became
// visible for the first time" — so one IntersectionObserver per row drives both, and this
// launch-scoped set keeps it to a single flash. Keyed per board+player so Season, All-time,
// Channel and Server each get their own one-shot (genuinely different boards), and a row
// that already flashed stays quiet when you tab back to it.
const flashedDeltas = new Set<string>();

// True for one brief window the first time `key`'s row scrolls into view this launch, then
// never again. A null key never flashes (delta is 0/absent, so there's nothing to show).
function useDeltaFlash(
  ref: RefObject<HTMLDivElement | null>,
  key: string | null,
): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !key || flashedDeltas.has(key)) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || flashedDeltas.has(key)) return;
        flashedDeltas.add(key);
        io.disconnect();
        setFlashing(true);
        hold = setTimeout(() => setFlashing(false), DELTA_HOLD_MS);
      },
      // most of the row's rank cell on screen — not a sliver clipped at the scroll edge
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (hold) clearTimeout(hold);
    };
  }, [ref, key]);
  return flashing;
}

// The placement (rank number, or the #1 chip) with the position-change delta layered ON
// TOP of it rather than in its own column. The delta cross-fades in — flashed once when the
// row first comes into view (tab switch or scroll, via useDeltaFlash), and on demand while a
// mouse hovers or after a tap (touch has no hover, so the tap auto-hides after DELTA_HOLD_MS).
// With no delta the cell is inert and shows only the rank.
function RankCell({
  rank,
  delta,
  flashKey,
}: {
  rank: number;
  delta: Delta;
  // stable per board+player id; gates the once-per-launch flash. Null → never flashes.
  flashKey: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasDelta = !!delta;
  const flashing = useDeltaFlash(ref, hasDelta ? flashKey : null);
  const [hover, setHover] = useState(false); // mouse: held open while over the cell
  const [tapped, setTapped] = useState(false); // touch: revealed by a tap, then auto-hides
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
    },
    [],
  );

  const tap = () => {
    if (!hasDelta) return;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    setTapped(true);
    tapTimer.current = setTimeout(() => setTapped(false), DELTA_HOLD_MS);
  };

  const show = hasDelta && (flashing || hover || tapped);
  // A brand-new entrant (delta "new") shows an amber dash, not a count — so the numeric
  // tooltip and up/down only apply when the delta is an actual number of places moved.
  const places = typeof delta === "number" ? delta : null;
  const up = (places ?? 0) > 0;

  return (
    <div
      ref={ref}
      // self-stretch makes the 22px rank column a full-row-height tap target (the parent grid
      // centers cells, which would otherwise shrink this to the glyph); place-items-center keeps
      // the rank and the overlay dead-centered. Mouse-only hover (this is a touch app — a CSS
      // :hover would stick after a tap, see hoverbutton.tsx); tap is wired through onClick so a
      // scroll-drag that starts here doesn't trip it.
      className={
        "relative grid h-full w-full select-none place-items-center self-stretch text-[13px] tabular-nums" +
        (hasDelta ? " cursor-pointer" : "")
      }
      title={
        places
          ? `${Math.abs(places)} ${Math.abs(places) === 1 ? "place" : "places"} ${up ? "up" : "down"} today`
          : undefined
      }
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHover(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHover(false);
      }}
      onClick={tap}
    >
      <span
        className={
          "transition-opacity duration-200 ease-out " +
          (show ? "opacity-0" : "opacity-100")
        }
      >
        {rank === 1 ? (
          <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
            1
          </span>
        ) : (
          <span className="text-zinc-500">{rank}</span>
        )}
      </span>
      {hasDelta && (
        <span
          aria-hidden={!show}
          className={
            "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap transition-all duration-200 ease-out " +
            (show ? "scale-100 opacity-100" : "scale-90 opacity-0")
          }
        >
          <RankDelta delta={delta} />
        </span>
      )}
    </div>
  );
}

function ScoreCell({ v }: { v: number }) {
  return (
    <span className="font-extrabold tabular-nums tracking-[-0.01em] text-[#efefe6]">
      {v.toLocaleString()}
      {/* the unit only fits once the desktop rail frees up width; on mobile the
          column header ("Score") carries the meaning instead */}
      <span className="ml-0.5 hidden text-[0.62em] font-semibold tracking-[0.02em] text-zinc-500 min-[800px]:inline">
        pts
      </span>
    </span>
  );
}

// Shared column track on header + every row so they line up. The stat columns are
// kept tight (and the gap snug) so the name column keeps real room in the ~418px
// desktop rail — names stay readable instead of truncating to a couple of letters.
// Phones get a 4-column track: Played and Avg ✗ drop out (hidden cells below) and
// the gap tightens, otherwise the fixed columns swallow the name entirely at 360px.
// Rank leads in a 22px column; the position change is layered over it (RankCell), not
// given a column of its own — which also realigns rank→name with the live roster.
const LGRID =
  "grid grid-cols-[22px_minmax(0,1fr)_62px_32px_48px] items-center gap-1.5 min-[800px]:grid-cols-[22px_minmax(0,1fr)_64px_44px_52px_32px] min-[800px]:gap-2";

type LedgerEntry = {
  id: string;
  name: string;
  avatar: string | null;
  rank: number;
  // places moved since this board was last opened: + climbed, − slipped, "new" = brand-new
  // entrant (amber dash), null = no prior baseline
  delta: Delta;
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
  flashScope,
}: {
  e: LedgerEntry;
  you: boolean;
  // attached to your row so the locate arrow can scroll + pulse it here too.
  rowRef?: Ref<HTMLDivElement>;
  // per-board id (the snapshot key) so each row's delta flash is one-shot per launch; null
  // when there's no board context (delta is absent anyway).
  flashScope?: string | null;
}) {
  return (
    <div
      ref={rowRef}
      data-flip-row={e.id}
      className={
        // same card as the live roster row (src/roster.tsx RosterRow): a rounded
        // zinc-900/60 panel, your row lifted to zinc-100/10 — spaced, not divided.
        LGRID +
        " rounded-[9px] px-2.5 py-2 min-[800px]:px-3 min-[800px]:py-2.25 " +
        (you ? "bg-zinc-100/10" : "bg-zinc-900/60")
      }
    >
      <RankCell
        rank={e.rank}
        delta={e.delta}
        flashKey={flashScope ? `${flashScope}:${e.id}` : null}
      />
      {/* pl-1 on mobile widens just the rank→avatar gap (matching the live roster);
          the legend's "Player" label gets the same pad so they stay aligned. */}
      <div className="flex min-w-0 items-center gap-2.5 pl-1 min-[800px]:pl-0">
        <LeaderAvatar id={e.id} name={e.name} avatar={e.avatar} you={you} />
        <span
          className={
            "truncate text-[13.5px] " +
            (you ? "font-bold text-zinc-100" : "text-[#d4d4d8]")
          }
        >
          {e.name}
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
      <div className="hidden text-right text-[13px] tabular-nums text-zinc-400 min-[800px]:block">
        {Number(e.avg_mistakes).toFixed(1)}
      </div>
    </div>
  );
}

const toEntry = (r: BoardRow, rank: number, delta: Delta): LedgerEntry => ({
  id: r.user_id,
  name: r.name,
  avatar: r.avatar,
  rank,
  delta,
  total: r.total,
  streak: r.streak,
  plays: r.plays,
  wins: r.wins,
  avg_mistakes: r.avg_mistakes,
});

export type Standings = { board: BoardRow[]; self: SelfStanding | null };

// Shown under the Season / All-time tabs before any game has been scored, so the tabs are
// never dead ends. Intentionally blank — no placeholder copy and no fake rows; the panel just
// holds its space (flex-1) and stays empty until the first game is scored.
export function StandingsEmpty() {
  return <div className="flex min-h-0 flex-1 flex-col" aria-hidden />;
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
  prevRanks,
  flashScope,
}: {
  data: Standings;
  selfId: string;
  query?: string;
  // fill: the row list flexes to fill its parent's height instead of capping at 46vh
  fill?: boolean;
  // attached to your row (when you place on the board) for the locate arrow.
  selfRowRef?: Ref<HTMLDivElement>;
  // {user_id -> rank} from the last time this board was opened, for the position-change
  // arrows. Absent (preview/live) → no arrows. See src/standings-snapshot.ts.
  prevRanks?: Record<string, number> | null;
  // stable per-board id (the snapshot key) so each row's delta flashes once per launch.
  flashScope?: string | null;
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
  const all = board.map((r, i) =>
    toEntry(r, i + 1, rankDelta(prevRanks, r.user_id, i + 1)),
  );
  const rows = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;

  return (
    <>
      <FlipList
        className={
          (fill ? "min-h-0 flex-1" : "max-h-[46vh]") +
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
              flashScope={flashScope}
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
          " mt-1.5 border-t border-white/[0.05] px-2.5 pt-2.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500 min-[800px]:px-3"
        }
      >
        <span />
        <span className="pl-1 text-left min-[800px]:pl-0">Player</span>
        <span className="text-right">Score</span>
        {/* the word doesn't fit the mobile streak column; the flame alone reads fine
            since every row pairs it with a count */}
        <span className="flex items-center justify-end gap-[3px]">
          <Flame size={9} fill="currentColor" strokeWidth={0} aria-hidden />
          <span className="hidden min-[800px]:inline">Streak</span>
        </span>
        <span className="text-right">Won</span>
        <span className="hidden items-center justify-end gap-0.5 min-[800px]:flex">
          Avg <X size={9} strokeWidth={2.6} aria-hidden />
        </span>
      </div>
    </>
  );
}

