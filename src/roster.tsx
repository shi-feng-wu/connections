import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { LEVELS, MAX_MISTAKES } from "./game";
import type { PlayerState } from "./realtime";
import { HoverButton } from "./hoverbutton";
import { LedgerBody, StandingsEmpty, type Standings } from "./season";

const EMPTY_STANDINGS: Standings = { board: [], self: null };
const GLIDE = "cubic-bezier(0.22,0.61,0.36,1)";

// Inset focus pulse for the located row — a cream ring + inner glow, drawn entirely
// with inset shadows so it hugs the row's rounded rect (never clipped by the scroll
// container) and overlays any row tint (live /10, standings /6) without a background
// change, reverting cleanly when it ends.
const LOCATE_PULSE: Keyframe[] = [
  { boxShadow: "inset 0 0 0 0 rgba(244,244,245,0), inset 0 0 0 0 rgba(244,244,245,0)" },
  {
    boxShadow:
      "inset 0 0 0 1.8px rgba(244,244,245,0.95), inset 0 0 18px rgba(244,244,245,0.28)",
    offset: 0.12,
  },
  {
    boxShadow:
      "inset 0 0 0 1px rgba(244,244,245,0.45), inset 0 0 11px rgba(244,244,245,0.15)",
    offset: 0.5,
  },
  { boxShadow: "inset 0 0 0 0 rgba(244,244,245,0), inset 0 0 0 0 rgba(244,244,245,0)" },
];

// Live room tracker, redesigned as a Live / Leaderboard tab heading over one ranked
// list (rank, avatar, mini-board, name, mistake dots, time + ✓/✗), with a bottom
// fade and an optional pinned "Your standing" (desktop rail only).
// Avatars stand in for Discord photos. Category colors only mean "solved";
// emerald is reserved for "live" (picking / pulse).

// Identity palette, deliberately not the category colors.
const AVCOL = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#c678dd",
  "#d19a66",
  "#56b6c2",
  "#cd74a8",
  "#e5c07b",
  "#7f9cf5",
  "#5bb3a0",
  "#df8a5a",
  "#9f86e0",
];

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVCOL[h % AVCOL.length];
}

const elapsedMs = (p: PlayerState, now: number): number =>
  Math.max(0, (p.finishedAt ?? now) - (p.startedAt || now));
const fmtElapsed = (p: PlayerState, now: number): string => {
  const s = Math.round(elapsedMs(p, now) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Furthest ahead first: most groups solved, then fastest, then fewest mistakes.
export function sortRoster(players: PlayerState[], now: number): PlayerState[] {
  return players
    .slice()
    .sort(
      (a, b) =>
        b.solvedCount - a.solvedCount ||
        elapsedMs(a, now) - elapsedMs(b, now) ||
        b.mistakesLeft - a.mistakesLeft,
    );
}

export function rankOf(
  players: PlayerState[],
  selfId: string,
  now: number,
): number | null {
  const i = sortRoster(players, now).findIndex((p) => p.userId === selfId);
  return i < 0 ? null : i + 1;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// One-shot flash on a row when a new group lands (not a looping ambient flash).
function useFlash(players: PlayerState[]): Set<string> {
  const prev = useRef<Map<string, number>>(new Map());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    for (const p of players) {
      const before = prev.current.get(p.userId);
      if (before != null && p.solvedCount > before) fresh.push(p.userId);
      prev.current.set(p.userId, p.solvedCount);
    }
    if (!fresh.length) return;
    setFlashing((s) => new Set([...s, ...fresh]));
    const id = setTimeout(
      () =>
        setFlashing((s) => {
          const next = new Set(s);
          fresh.forEach((u) => next.delete(u));
          return next;
        }),
      2600,
    );
    return () => clearTimeout(id);
  }, [players]);
  return flashing;
}

// Colored initial circle. `picking` adds the emerald pulse ring (live view only);
// the self avatar keeps a light ring. Photo layers over the initial placeholder.
function Avatar({
  p,
  selfId,
  picking,
}: {
  p: PlayerState;
  selfId: string;
  picking: boolean;
}) {
  const you = p.userId === selfId;
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = p.avatar && broken !== p.avatar;
  return (
    <div
      className={
        "relative grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none min-[820px]:h-8 min-[820px]:w-8 min-[820px]:text-[13px] " +
        (you ? "shadow-[0_0_0_2px_#09090b,0_0_0_4px_#f4f4f5] " : "") +
        (picking
          ? "before:absolute before:-inset-1 before:animate-pick-ring before:rounded-full before:shadow-[0_0_0_2px_#34d399] before:content-['']"
          : "")
      }
      style={{ background: colorFor(p.userId) }}
    >
      {initials(p.name)}
      {showPhoto && (
        <img
          src={p.avatar}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          onError={() => setBroken(p.avatar ?? null)}
        />
      )}
    </div>
  );
}

// Vertical stack: a solid colored bar per solved group (in difficulty order), grey
// segmented rows for the rest. Flashes the newest bar when a group just landed.
function MiniBoard({ p, flash }: { p: PlayerState; flash: boolean }) {
  const solved = [...p.solvedLevels].sort((a, b) => a - b);
  return (
    <div className="flex w-5.5 flex-none flex-col gap-[2px] min-[820px]:w-7.5">
      {solved.map((lvl, i) => (
        <div
          key={`s${lvl}`}
          className={
            "h-[5px] overflow-hidden rounded-[2px] min-[820px]:h-1.5 " +
            (flash && i === solved.length - 1 ? "animate-solve-flash" : "")
          }
          style={{ background: LEVELS[lvl].color }}
        />
      ))}
      {Array.from({ length: 4 - solved.length }, (_, r) => (
        <div className="flex h-[5px] gap-[1.5px] min-[820px]:h-1.5" key={`e${r}`}>
          {[0, 1, 2, 3].map((c) => (
            <div className="flex-1 rounded-[1px] bg-zinc-700" key={c} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Mistakes({ p }: { p: PlayerState }) {
  return (
    <span className="inline-flex flex-none items-center gap-[3px]">
      {Array.from({ length: MAX_MISTAKES }, (_, i) => (
        <span
          key={i}
          className={
            "h-1.75 w-1.75 rounded-full " +
            (i < p.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
          }
        />
      ))}
    </span>
  );
}

const TIME = "text-[12px] tabular-nums tracking-[0.01em] min-[820px]:text-[13px]";

function Status({ p, now }: { p: PlayerState; now: number }) {
  const time = fmtElapsed(p, now);
  const box =
    "flex min-w-12 flex-none items-center justify-end gap-1.5 min-[820px]:min-w-14";
  if (p.done === "lost")
    return (
      <div className={box}>
        <X className="flex-none text-zinc-500" size={15} strokeWidth={2.6} aria-label="Out" />
        <span className={TIME + " text-zinc-600"}>{time}</span>
      </div>
    );
  if (p.done === "won")
    return (
      <div className={box}>
        <Check className="flex-none text-zinc-100" size={15} strokeWidth={2.8} aria-label="Solved" />
        <span className={TIME + " text-zinc-200"}>{time}</span>
      </div>
    );
  return (
    <div className={box}>
      <span className={TIME + " text-zinc-400"}>{time}</span>
    </div>
  );
}

function Rank({ rank }: { rank: number }) {
  if (rank === 1)
    return (
      <div className="w-4 flex-none text-center text-[13px] tabular-nums min-[820px]:w-4.5">
        <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
          1
        </span>
      </div>
    );
  return (
    <div className="w-4 flex-none text-center text-[13px] tabular-nums text-zinc-500 min-[820px]:w-4.5">
      {rank}
    </div>
  );
}

function RosterRow({
  p,
  rank,
  selfId,
  now,
  flash,
  picking,
  rowRef,
}: {
  p: PlayerState;
  rank: number;
  selfId: string;
  now: number;
  flash: boolean;
  picking: boolean;
  // attached only to your row, so the locate arrow can scroll + pulse it.
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const you = p.userId === selfId;
  return (
    <div
      ref={rowRef}
      className={
        "relative flex flex-none items-center gap-2 rounded-[9px] px-2.5 py-1.5 min-[820px]:gap-2.75 min-[820px]:px-3 min-[820px]:py-2.25 " +
        (you ? "bg-zinc-100/10" : "bg-zinc-900/60")
      }
    >
      <Rank rank={rank} />
      <Avatar p={p} selfId={selfId} picking={picking} />
      <MiniBoard p={p} flash={flash} />
      <span
        className={
          "min-w-0 flex-1 truncate text-[13px] " +
          (you ? "font-bold text-zinc-100" : "text-zinc-300")
        }
      >
        {p.name}
        {you ? " (you)" : ""}
      </span>
      <Mistakes p={p} />
      <Status p={p} now={now} />
    </div>
  );
}

export type RosterView = "live" | "season" | "all";

const TAB =
  "relative inline-flex cursor-pointer items-center gap-1.5 bg-transparent px-0 pt-0.5 pb-1.75 font-sans text-[11px] font-bold uppercase tracking-[0.07em] transition-opacity duration-150 ease-out";
const TAB_ON =
  " text-zinc-100 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-zinc-300 after:content-['']";
const TAB_OFF = " text-zinc-600";

// Subtle tab heading that flips between the live room and (when there are scored
// rows) the cumulative season / all-time standings — the latter two share the exact
// same table, differing only by window.
function Tabs({
  view,
  setView,
  showSeason,
}: {
  view: RosterView;
  setView: (v: RosterView) => void;
  showSeason: boolean;
}) {
  return (
    <div className="flex flex-none items-center gap-4 px-0.5 pb-0.5">
      <HoverButton
        hover="opacity-60"
        onClick={() => setView("live")}
        className={TAB + (view === "live" ? TAB_ON : TAB_OFF)}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Live
      </HoverButton>
      {showSeason && (
        <>
          <HoverButton
            hover="opacity-60"
            onClick={() => setView("season")}
            className={TAB + (view === "season" ? TAB_ON : TAB_OFF)}
          >
            Season
          </HoverButton>
          <HoverButton
            hover="opacity-60"
            onClick={() => setView("all")}
            className={TAB + (view === "all" ? TAB_ON : TAB_OFF)}
          >
            All-time
          </HoverButton>
        </>
      )}
    </div>
  );
}

// Renders as a fragment: the tab heading and the active list. Live shows the ranked
// player rows; Season / All-time share one cumulative standings table. The list is
// capped + scrolls on mobile and flexes to fill the rail on desktop.
export function Roster({
  players,
  selfId,
  selfName,
  selfAvatar,
  view: viewProp,
  onViewChange,
  season,
  allTime,
  jumpSignal,
}: {
  players: PlayerState[];
  selfId: string;
  selfName?: string;
  selfAvatar?: string;
  // controlled by GameView; uncontrolled (own state) when omitted (preview panel).
  view?: RosterView;
  onViewChange?: (v: RosterView) => void;
  // cumulative standings behind the Season / All-time tabs; tabs hidden when absent.
  season?: Standings;
  allTime?: Standings;
  // bump (from the end-screen locate arrow) to scroll your row in + pulse it.
  jumpSignal?: number;
}) {
  const [viewState, setViewState] = useState<RosterView>("live");
  const view = viewProp ?? viewState;
  const setView = onViewChange ?? setViewState;
  const live = view === "live";
  const seasonAvailable = season != null || allTime != null;
  // Season + All-time share one table, differing only by which window feeds it.
  const standings = (view === "season" || view === "all") && seasonAvailable;
  const standingsData =
    view === "all" ? allTime ?? EMPTY_STANDINGS : season ?? EMPTY_STANDINGS;

  const now = useNow(players.some((p) => p.done === null));
  const flashing = useFlash(players);
  const sorted = useMemo(() => sortRoster(players, now), [players, now]);

  // Locate arrow. Clicking it (jumpSignal bumps) scrolls to + pulses your row in the
  // tab you're on, WITHOUT switching tabs; then for whichever other tab you open next
  // it repositions to your row once (no pulse) so it's already in view. selfRowRef
  // tracks whichever tab's "you" row is currently mounted. `repositioned` remembers,
  // per tab, the last jump it handled — so a tab repositions at most once per jump.
  const selfRowRef = useRef<HTMLDivElement>(null);
  const lastJump = useRef(0);
  const repositioned = useRef<Record<RosterView, number>>({
    live: 0,
    season: 0,
    all: 0,
  });
  const armed = useRef(false);

  const positionSelf = (pulse: boolean): void => {
    const row = selfRowRef.current;
    if (!row) return;
    row.scrollIntoView({
      behavior: pulse ? "smooth" : "auto",
      // the live list owns its scroller (safe to center); the standings table keeps
      // your row pinned/visible, so only nudge it in to avoid scrolling the page.
      block: view === "live" ? "center" : "nearest",
    });
    if (pulse) row.animate(LOCATE_PULSE, { duration: 1700, easing: GLIDE });
  };

  // The click itself: pulse + scroll the current tab, and mark it handled for this
  // jump so re-opening it later doesn't re-reposition. Skip the initial mount.
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      return;
    }
    if (!jumpSignal) return;
    lastJump.current = jumpSignal;
    repositioned.current[view] = jumpSignal;
    positionSelf(true);
  }, [jumpSignal]);

  // Opening a different tab after a jump: reposition to your row once (no pulse).
  useEffect(() => {
    if (!lastJump.current || repositioned.current[view] === lastJump.current) return;
    repositioned.current[view] = lastJump.current;
    positionSelf(false);
  }, [view]);

  return (
    <>
      <Tabs view={view} setView={setView} showSeason={seasonAvailable} />
      {standings ? (
        standingsData.board.length ? (
          <div className="flex max-h-[46vh] min-h-0 flex-col min-[820px]:max-h-none min-[820px]:flex-1">
            <LedgerBody
              data={standingsData}
              selfId={selfId}
              name={selfName ?? "You"}
              avatar={selfAvatar}
              selfRowRef={selfRowRef}
              fill
            />
          </div>
        ) : (
          // tabs stay live even with no scores; this is where they land
          <StandingsEmpty window={view === "all" ? "all" : "season"} />
        )
      ) : (
        <div className="list-fade flex max-h-[42vh] min-h-0 flex-col gap-1.25 overflow-y-auto scrollbar-thin min-[820px]:max-h-none min-[820px]:flex-1 min-[820px]:gap-1.5">
          {sorted.length ? (
            sorted.map((p, i) => {
              const you = p.userId === selfId;
              return (
                <RosterRow
                  key={p.userId}
                  p={p}
                  rank={i + 1}
                  selfId={selfId}
                  now={now}
                  flash={flashing.has(p.userId)}
                  picking={live && p.picking}
                  rowRef={you ? selfRowRef : undefined}
                />
              );
            })
          ) : (
            <div className="px-2 py-6 text-center text-[13px] text-zinc-600">
              No one here yet.
            </div>
          )}
        </div>
      )}
    </>
  );
}
