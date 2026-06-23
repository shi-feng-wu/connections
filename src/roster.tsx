import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Check, Newspaper, RotateCw, X } from "lucide-react";
import { ResetCountdown } from "./countdown";
import { finishedScore, LEVELS, MAX_MISTAKES } from "./game";
import type { PlayerState } from "./player";
import { HoverButton } from "./hoverbutton";
import { FlipList } from "./fliplist";
import { LedgerBody, StandingsEmpty, type Standings } from "./season";
import { useRankSnapshot } from "./standings-snapshot";

const EMPTY_STANDINGS: Standings = { board: [], self: null };

// Live room tracker, redesigned as a Live / Leaderboard tab heading over one ranked
// list (rank, avatar, mini-board, name, mistake dots — or the score once a run is
// done — time + ✓/✗), with a bottom fade.
// Avatars stand in for Discord photos. Category colors only mean "solved";
// emerald is reserved for live presence (a steady ring on players currently in the
// Activity). Everyone who has joined stays listed; the ring just marks who's still here.

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
  const total = Math.round(elapsedMs(p, now) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

// Finished runs only — their elapsed is frozen (finishedAt − startedAt), so no `now`.
const scoreOf = (p: PlayerState): number =>
  p.done ? finishedScore(p.done, p.solvedCount, p.mistakesLeft, elapsedMs(p, 0)) : 0;

// Points a live run has already BANKED — the score of busting right now, i.e. the
// loss partial credit for groups solved. It only ever grows (a solve adds, nothing
// subtracts — mistakes and time can't lower it), so against finished rows a live
// row only climbs, never sinks; and it moves only on submits, so the list shuffles
// on events, not on the clock.
const bankedOf = (p: PlayerState): number =>
  finishedScore("lost", p.solvedCount, p.mistakesLeft, 0);

// The Live tab's order, one comparator:
//   1. everyone ranks by points — the final score for finished runs (what the
//      Leaderboard tab shows), banked-so-far (above) for live ones. Any win
//      (≥250) outranks any live run (banked tops out at 80), so winners hold
//      their podium until someone actually finishes above them;
//   2. at equal points a live run outranks a finished one — it's still climbing,
//      the finished score is capped there;
//   3. remaining ties run the progress race: fastest, then fewest mistakes.
// Rule 3 is load-bearing among FINISHED winners now: the speed grace flattens
// every sub-20s clean solve to an identical 500 (and near-ties just above), so
// score alone can't separate the fastest runs — the elapsed tier is what keeps
// the quicker solve on top, then fewer mistakes breaks any remaining tie.
// Between two LIVE runs this whole comparator collapses to the hierarchical race
// sort — most groups solved, then fastest, then fewest mistakes — because banked
// points are a pure function of groups solved (20·g²): equal groups → equal
// points → the elapsed/mistakes tiers decide. Speed therefore ranks runners at
// the same group count, the only place comparing raw clocks is fair. That
// equivalence is also why no banding is needed (unlike the ceiling-based cut
// this replaces): the points key and the race order can't disagree. Once
// everyone is done the whole list is rule 1 — Live converges to the Leaderboard.
export function sortRoster(players: PlayerState[], now: number): PlayerState[] {
  const points = (p: PlayerState): number =>
    p.done ? scoreOf(p) : bankedOf(p);
  return players
    .slice()
    .sort(
      (a, b) =>
        points(b) - points(a) ||
        (a.done ? 1 : 0) - (b.done ? 1 : 0) ||
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

// One page-wide 1Hz heartbeat shared by every live clock (and the roster's re-sort),
// so each second costs a single batched render of the few components that subscribe —
// not one interval per consumer firing at scattered offsets. The interval only runs
// while someone subscribes; `lastTick` mutates only inside it (a stable
// useSyncExternalStore snapshot).
let lastTick = Date.now();
const tickSubs = new Set<() => void>();
let tickId: ReturnType<typeof setInterval> | null = null;
function subscribeTick(cb: () => void): () => void {
  tickSubs.add(cb);
  tickId ??= setInterval(() => {
    lastTick = Date.now();
    tickSubs.forEach((f) => f());
  }, 1000);
  return () => {
    tickSubs.delete(cb);
    if (tickSubs.size === 0 && tickId != null) {
      clearInterval(tickId);
      tickId = null;
    }
  };
}
const noSub = (): (() => void) => () => {};
const readTick = (): number => lastTick;

function useNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribeTick : noSub, readTick);
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

// Colored initial circle. `online` adds a steady emerald presence ring (live view only)
// when the player is currently in the Activity; your own row gets a white ring that
// overrides it (you're always online, so the two never stack). Both rings are
// box-shadows of identical extent, so a ring never changes the avatar's footprint or
// nudges neighbouring rows/columns. Photo layers over the initial placeholder.
function Avatar({
  p,
  selfId,
  online,
}: {
  p: PlayerState;
  selfId: string;
  online: boolean;
}) {
  const you = p.userId === selfId;
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = p.avatar && broken !== p.avatar;
  // White (you) takes precedence over green (online); same dark-separator + 2px-colour
  // box-shadow so every state occupies the exact same box.
  const ring = you
    ? " shadow-[0_0_0_2px_#09090b,0_0_0_4px_#f4f4f5]"
    : online
      ? " shadow-[0_0_0_2px_#09090b,0_0_0_4px_#34d399]"
      : "";
  return (
    <div
      className={
        "relative grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[11px] font-extrabold text-[#0c0c0c] select-none min-[800px]:h-8 min-[800px]:w-8 min-[800px]:text-[13px]" +
        ring
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

// Vertical stack: a solid colored bar per solved group (in solve order), grey
// segmented rows for the rest. Flashes the newest bar when a group just landed.
function MiniBoard({ p, flash }: { p: PlayerState; flash: boolean }) {
  const solved = p.solvedLevels;
  return (
    <div className="flex w-5.5 flex-none flex-col gap-[2px] min-[800px]:w-7.5">
      {solved.map((lvl, i) => (
        <div
          key={`s${lvl}`}
          className={
            "h-[5px] overflow-hidden rounded-[2px] min-[800px]:h-1.5 " +
            (flash && i === solved.length - 1 ? "animate-solve-flash" : "")
          }
          style={{ background: LEVELS[lvl].color }}
        />
      ))}
      {Array.from({ length: 4 - solved.length }, (_, r) => (
        <div className="flex h-[5px] gap-[1.5px] min-[800px]:h-1.5" key={`e${r}`}>
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

// Desktop only: a finished row keeps its mistake dots and adds the score beside
// them — styled like the leaderboard's score cell so the two tabs rhyme, dimmed on
// a loss to match the row's ✗/time. On mobile the score rides in the Status box
// instead (replacing the ✓/✗), since dots + score + time won't all fit there.
// The slot renders on EVERY row at a fixed width (empty until the run is done,
// sized for the widest case, "500pts") so the columns to the dots' right never
// vary — the dots sit at the same x in every row, and a score pops in without
// shifting anything.
function FinalScore({ p }: { p: PlayerState }) {
  return (
    <span
      className={
        "hidden w-[42px] flex-none text-right text-[13px] font-extrabold tabular-nums tracking-[-0.01em] min-[800px]:inline " +
        (p.done === "won" ? "text-[#efefe6]" : "text-zinc-500")
      }
    >
      {p.done && (
        <>
          {scoreOf(p)}
          <span className="ml-0.5 text-[0.62em] font-semibold tracking-[0.02em] text-zinc-500">
            pts
          </span>
        </>
      )}
    </span>
  );
}

// ml-auto pins the time to the box's right edge, leaving the status icon at the
// left — anchored next to the mistake dots rather than floating with the time.
const TIME =
  "ml-auto text-[12px] tabular-nums tracking-[0.01em] min-[800px]:text-[13px]";

// An in-progress row's running clock. The 1Hz subscription lives HERE — in a leaf
// that renders one span — so a second ticking over re-renders only these clocks, not
// every row of every roster. (That full-list tick was a per-second main-thread stall
// that visibly hitched whatever animation it landed on, e.g. the end bar's breakdown
// cross-fade.)
function LiveTime({ p }: { p: PlayerState }) {
  const now = useNow(true);
  return <span className={TIME + " text-zinc-400"}>{fmtElapsed(p, now)}</span>;
}

function Status({ p }: { p: PlayerState }) {
  // ONE fixed width for every state (not min-w, and not per-state): sized for the
  // widest case — the finished mobile box, where the score stands in for the ✓/✗
  // (the icons are desktop-only) next to the time. A per-state width (finished
  // rows used to run 6px wider) made the mistake dots column jitter left/right
  // from row to row depending on who had finished.
  const box = "flex w-[72px] flex-none items-center gap-1.5 min-[800px]:w-[74px]";
  // mobile stand-in for the ✓/✗: the run's score, bright on a win, dim on a loss
  const pts = p.done && (
    <span
      className={
        "flex-none text-[12.5px] font-extrabold tabular-nums min-[800px]:hidden " +
        (p.done === "won" ? "text-[#efefe6]" : "text-zinc-500")
      }
    >
      {scoreOf(p)}
    </span>
  );
  if (p.done === "lost")
    return (
      <div className={box}>
        <X className="hidden flex-none text-zinc-500 min-[800px]:block" size={15} strokeWidth={2.6} aria-label="Out" />
        {pts}
        <span className={TIME + " text-zinc-600"}>{fmtElapsed(p, 0)}</span>
      </div>
    );
  if (p.done === "won")
    return (
      <div className={box}>
        <Check className="hidden flex-none text-zinc-100 min-[800px]:block" size={15} strokeWidth={2.8} aria-label="Solved" />
        {pts}
        <span className={TIME + " text-zinc-200"}>{fmtElapsed(p, 0)}</span>
      </div>
    );
  return (
    <div className={box}>
      <LiveTime p={p} />
    </div>
  );
}

// w-5.5 matches the leaderboard's 22px rank column (season.tsx LGRID) so the rank number
// sits at the same x in both tabs. The rank→avatar gap is then tuned per breakpoint to
// match the leaderboard's (its grid gap + the player cell's pl-1/pl-0): on mobile the
// leaderboard's gap-1.5 + pl-1 totals 10px, so mr-0.5 tops up this row's gap-2; on
// desktop the row's wider gap-2.75 overshoots the leaderboard's gap-2 by 3px, so
// -mr-0.75 trims it back. Net: switching Live ↔ Season/All-time never nudges the row.
function Rank({ rank }: { rank: number }) {
  if (rank === 1)
    return (
      <div className="mr-0.5 w-5.5 flex-none text-center text-[13px] tabular-nums min-[800px]:-mr-0.75">
        <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
          1
        </span>
      </div>
    );
  return (
    <div className="mr-0.5 w-5.5 flex-none text-center text-[13px] tabular-nums text-zinc-500 min-[800px]:-mr-0.75">
      {rank}
    </div>
  );
}

// memo: the roster re-renders every second while anyone is mid-solve (the re-sort
// tick); every prop here is tick-stable, so finished rows bail out and only each
// in-progress row's LiveTime leaf actually updates.
const RosterRow = memo(function RosterRow({
  p,
  rank,
  selfId,
  flash,
  online,
  rowRef,
}: {
  p: PlayerState;
  rank: number;
  selfId: string;
  flash: boolean;
  online: boolean;
  // attached only to your row, so the locate arrow can scroll + pulse it.
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const you = p.userId === selfId;
  return (
    <div
      ref={rowRef}
      data-flip-row={p.userId}
      className={
        "relative flex flex-none items-center gap-2 rounded-[9px] px-2.5 py-2 min-[800px]:gap-2.75 min-[800px]:px-3 min-[800px]:py-2.25 " +
        (you ? "bg-zinc-100/10" : "bg-zinc-900/60")
      }
    >
      <Rank rank={rank} />
      <Avatar p={p} selfId={selfId} online={online} />
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
      <FinalScore p={p} />
      <Status p={p} />
    </div>
  );
});

export type RosterView = "live" | "season" | "all";
// Which room the roster + leaderboard show: the channel you're playing in, or the whole
// server. Shared across all three tabs (a launch in a guild only — DMs have no distinction).
export type RosterScope = "channel" | "server";

// The visible tab is only ~26px tall (11px text + slim padding) — well under the
// ~44px touch minimum, and this is a touch app (Discord Activity). The ::before
// pseudo extends the HIT AREA to ~44px without moving a pixel of the layout: it's
// part of the button, so taps on it land. ±8px horizontally stays inside the gap-4
// between tabs, so neighbouring targets touch but never overlap.
const TAB =
  "relative inline-flex cursor-pointer items-center gap-1.5 bg-transparent px-0 pt-0.5 pb-1.75 font-sans text-[11px] font-bold uppercase tracking-[0.07em] transition-opacity duration-150 ease-out before:absolute before:-inset-x-2 before:-inset-y-[9px] before:content-['']";
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
  scope,
  onScopeChange,
}: {
  view: RosterView;
  setView: (v: RosterView) => void;
  showSeason: boolean;
  // Channel/Server toggle; rendered only when provided (a guild launch). Controls all tabs.
  scope?: RosterScope;
  onScopeChange?: (s: RosterScope) => void;
}) {
  return (
    <div className="flex flex-none items-center justify-between gap-4 px-0.5 pb-0.5">
      <div className="flex items-center gap-4">
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
      {scope && onScopeChange && (
        <div className="flex items-center gap-3">
          <HoverButton
            hover="opacity-60"
            onClick={() => onScopeChange("channel")}
            className={TAB + (scope === "channel" ? TAB_ON : TAB_OFF)}
          >
            Channel
          </HoverButton>
          <HoverButton
            hover="opacity-60"
            onClick={() => onScopeChange("server")}
            className={TAB + (scope === "server" ? TAB_ON : TAB_OFF)}
          >
            Server
          </HoverButton>
        </div>
      )}
    </div>
  );
}

// Renders as a fragment: the tab heading and the active list. Live shows the ranked
// player rows; Season / All-time share one cumulative standings table. The list is
// End-screen recap pitch (rail footer): shown only in a guild that positively lacks the
// bot, once the run is over — the moment the recap makes intuitive sense ("this, every
// morning"). One notch louder than the countdown row below it (a hairline panel, not a
// bare row) but in the same editorial voice: benefit-first copy (balanced wraps, no
// orphans) with the primary pill bottom-right opening Discord's guild-install consent
// (App's onAddBot → openExternalLink). Non-admins get the quiet handoff line instead of
// a dead end. The ✕ dismisses it for this mount only (it returns next game — the pitch
// is once-a-day-ish by nature, not a modal to suppress forever).
function RecapPrompt({ onAdd }: { onAdd: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="relative flex flex-none animate-fade-in flex-col rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
      <HoverButton
        onClick={() => setDismissed(true)}
        hover="text-zinc-300"
        aria-label="Dismiss"
        title="Dismiss"
        className="absolute right-1.5 top-1.5 cursor-pointer rounded-full p-2 text-zinc-600 transition-colors duration-150 ease-out active:text-zinc-300"
      >
        <X size={14} strokeWidth={2.5} aria-hidden />
      </HoverButton>
      {/* icon-anchored heading: the newspaper glyph echoes the RotateCw on the
          Next-puzzle row below, so the rail footer reads as one consistent stack */}
      <div className="flex gap-2.5 pr-7">
        <Newspaper
          size={15}
          strokeWidth={2}
          className="mt-px flex-none text-zinc-400"
          aria-hidden
        />
        <div className="min-w-0">
          <div className="text-balance text-[12.5px] font-semibold leading-snug text-zinc-200">
            Get the daily recap here
          </div>
          <div className="mt-0.5 text-pretty text-[11.5px] leading-snug text-zinc-500">
            The day’s results and the leaderboard, posted at the nightly reset.
          </div>
        </div>
      </div>
      {/* footer row: the admin caveat sits on the Enable button's baseline (no dead
          space under the copy) and /enable-posts reads as a command token */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
        <div className="text-pretty text-[10.5px] leading-snug text-zinc-600">
          Needs Manage Server, or ask an admin to run{" "}
          <span className="whitespace-nowrap rounded-[5px] bg-white/[0.06] px-[5px] py-px font-semibold text-zinc-400">
            /enable-posts
          </span>
        </div>
        <HoverButton
          onClick={onAdd}
          hover="opacity-85"
          className="flex-none cursor-pointer rounded-full bg-zinc-100 px-3.5 py-2 text-[12px] font-semibold leading-none text-zinc-900 transition-opacity duration-150 ease-out active:opacity-70"
        >
          Enable
        </HoverButton>
      </div>
    </div>
  );
}

// capped + scrolls on mobile and flexes to fill the rail on desktop.
export function Roster({
  players,
  selfId,
  view: viewProp,
  onViewChange,
  scope,
  onScopeChange,
  season,
  allTime,
  roomKey,
  today,
  nextPuzzle,
  onAddBot,
}: {
  players: PlayerState[];
  selfId: string;
  // controlled by GameView; uncontrolled (own state) when omitted (preview panel).
  view?: RosterView;
  onViewChange?: (v: RosterView) => void;
  // shared Channel/Server toggle (guild launches only); omitted → no toggle shown.
  scope?: RosterScope;
  onScopeChange?: (s: RosterScope) => void;
  // cumulative standings behind the Season / All-time tabs; tabs hidden when absent.
  season?: Standings;
  allTime?: Standings;
  // stable room id (g:<guild> / c:<channel>) keying the per-board position-change
  // snapshot; null standalone/preview → no movement arrows.
  roomKey?: string | null;
  // current ET puzzle-day (YYYY-MM-DD); the position-change baseline resets when it rolls.
  today?: string | null;
  // your run is over → pin the next-puzzle countdown under the list (the footer's
  // score summary stays clean; this is the quiet "rail footer" slot of the redesign).
  nextPuzzle?: boolean;
  // post-game recap pitch for a bot-less guild (see RecapPrompt); omitted → no pitch.
  onAddBot?: () => void;
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
  // Position-change arrows: snapshot keyed per room + Channel/Server scope + window, so
  // each board tracks its own movement. Null on the live tab (or standalone) → no arrows.
  const snapshotKey =
    view !== "live" && roomKey ? `${roomKey}:${scope ?? "x"}:${view}` : null;
  const prevRanks = useRankSnapshot(snapshotKey, standingsData.board, today ?? null);
  // Remount key for the active panel: changing the tab OR the Channel/Server scope swaps it,
  // so animate-tab-in re-fires and the new list fades up the same way a tab switch does.
  const panelKey = `${view}:${scope ?? ""}`;

  const now = useNow(players.some((p) => p.done === null));
  const flashing = useFlash(players);
  const sorted = useMemo(() => sortRoster(players, now), [players, now]);

  // Switching tabs scrolls your row into view in the list you just opened, so you
  // never have to hunt for yourself. The active panel remounts per tab (panelKey),
  // so by the time this effect runs selfRowRef already points at the new tab's "you"
  // row. Skip the first run (the initial mount is not a tab switch); if you have no
  // row of your own, selfRowRef stays null and the scroll is simply a no-op.
  const selfRowRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    selfRowRef.current?.scrollIntoView({
      behavior: "smooth",
      // Desktop live list owns its scroller, so centering is contained. Everywhere
      // else — the standings table, and ALL lists on mobile (where the page is the
      // scroller, so centering would yank the whole view and drag the board
      // offscreen) — just nudge the row into view. 800 mirrors DESKTOP_BP.
      block:
        view === "live" && window.innerWidth >= 800 ? "center" : "nearest",
    });
  }, [view]);

  return (
    <>
      <Tabs
        view={view}
        setView={setView}
        showSeason={seasonAvailable}
        scope={scope}
        onScopeChange={onScopeChange}
      />
      {/* panelKey remounts the active panel on each tab OR scope change so animate-tab-in
          re-fires (incl. Season↔All-time, which reuse one element, and Channel↔Server) —
          the new list fades up on the site's score-hero glide. */}
      {standings ? (
        standingsData.board.length ? (
          <div key={panelKey} className="flex min-h-0 flex-1 animate-tab-in flex-col">
            <LedgerBody
              data={standingsData}
              selfId={selfId}
              selfRowRef={selfRowRef}
              prevRanks={prevRanks}
              fill
            />
          </div>
        ) : (
          // tabs stay live even with no scores; this is where they land
          <StandingsEmpty key={panelKey} window={view === "all" ? "all" : "season"} />
        )
      ) : (
        <FlipList
          key={panelKey}
          // Own scroller (matches the standings list): flex-1 + min-h-0 lets it fill the
          // rail and overflow-y-auto scrolls internally instead of spilling past the board
          // on desktop when the live room is long (the rail is a fixed-height panel there).
          // The bottom fade is desktop-only: on mobile the column grows with its content
          // (the PAGE scrolls, this list never does), so a fade would dim the last row
          // while falsely implying more rows inside the box.
          className="flex min-h-0 flex-1 animate-tab-in flex-col gap-1.5 overflow-y-auto scrollbar-thin pb-6 min-[800px]:list-fade"
        >
          {sorted.length ? (
            sorted.map((p, i) => {
              const you = p.userId === selfId;
              return (
                <RosterRow
                  key={p.userId}
                  p={p}
                  rank={i + 1}
                  selfId={selfId}
                  flash={flashing.has(p.userId)}
                  online={live && !!p.online}
                  rowRef={you ? selfRowRef : undefined}
                />
              );
            })
          ) : (
            <div className="px-2 py-6 text-center text-[13px] text-zinc-600">
              No one here yet.
            </div>
          )}
        </FlipList>
      )}
      {/* post-game recap pitch (bot-less guilds only), pinned above the countdown so
          the rail's last word stays the quietest */}
      {onAddBot && <RecapPrompt onAdd={onAddBot} />}
      {/* once your run is over, when today's board resets becomes relevant — a quiet
          countdown row pinned under whichever list is open (the live list's bottom
          fade dissolves into it) */}
      {nextPuzzle && (
        <div className="flex flex-none items-center gap-2.25 border-t border-white/[0.07] px-1 pt-2.75">
          <RotateCw size={15} strokeWidth={2.25} className="flex-none text-zinc-500" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
            Next puzzle
          </span>
          <ResetCountdown className="ml-auto text-[14px] font-semibold tabular-nums text-zinc-300" />
        </div>
      )}
    </>
  );
}
