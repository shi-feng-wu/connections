import { useEffect, useMemo, useRef, useState } from "react";
import { LEVELS, MAX_MISTAKES } from "./game";
import type { PlayerState } from "./realtime";

// Live room tracker: ranked list (avatar, mini-board, mistake dots, status),
// pinned "your standing", and a "see all" full-room overlay.
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

type Size = "row" | "full";

function Avatar({
  p,
  selfId,
  tip = true,
  size = "row",
}: {
  p: PlayerState;
  selfId: string;
  tip?: boolean;
  size?: Size;
}) {
  const you = p.userId === selfId;
  const dims = size === "row" ? "h-7.5 w-7.5 text-[11px]" : "h-7 w-7 text-[10px]";
  // Photo layers over the initial placeholder; `broken` tracks a failed src so
  // a missing/broken image falls back to it.
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = p.avatar && broken !== p.avatar;
  return (
    <div
      className={
        "group relative grid flex-none place-items-center rounded-full font-extrabold text-[#0c0c0c] select-none " +
        dims +
        (you ? " shadow-[0_0_0_2px_#09090b,0_0_0_4px_#f4f4f5]" : "") +
        (p.picking
          ? " before:absolute before:-inset-1 before:animate-pick-ring before:rounded-full before:shadow-[0_0_0_2px_#34d399] before:content-['']"
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
      {tip && (
        <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 translate-y-1 rounded-md bg-zinc-100 px-2.25 py-1 text-xs font-semibold whitespace-nowrap text-zinc-900 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 after:absolute after:top-full after:left-1/2 after:-translate-x-1/2 after:border-[5px] after:border-transparent after:border-t-zinc-100 after:content-['']">
          {p.name + (you ? " (you)" : "")}
        </span>
      )}
    </div>
  );
}

function MiniBoard({
  p,
  flash,
  size = "row",
}: {
  p: PlayerState;
  flash: boolean;
  size?: Size;
}) {
  const solved = [...p.solvedLevels].sort((a, b) => a - b);
  const width = size === "row" ? "w-7.5" : "w-6.5";
  const rowH = size === "row" ? "h-1.5" : "h-[5.5px]";
  return (
    <div className={"flex flex-none flex-col gap-[1.5px] " + width}>
      {solved.map((lvl, i) => (
        <div
          key={`s${lvl}`}
          className={
            "flex gap-0 overflow-hidden rounded-xs " +
            rowH +
            (flash && i === solved.length - 1 ? " animate-solve-flash" : "")
          }
          style={{ background: LEVELS[lvl].color }}
        >
          {[0, 1, 2, 3].map((c) => (
            <div className="flex-1 bg-inherit" key={c} />
          ))}
        </div>
      ))}
      {Array.from({ length: 4 - solved.length }, (_, r) => (
        <div className={"flex gap-[1.5px] rounded-xs " + rowH} key={`e${r}`}>
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
    <span className="inline-flex items-center gap-0.75">
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

const CHIP =
  "rounded-full px-1.75 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] whitespace-nowrap";
const TIME = "text-[13px] tabular-nums tracking-[0.01em]";

function Status({ p, now, wide = false }: { p: PlayerState; now: number; wide?: boolean }) {
  const time = fmtElapsed(p, now);
  const box = "flex items-center justify-end gap-1.75" + (wide ? " min-w-14" : "");
  if (p.done === "lost")
    return (
      <div className={box}>
        <span className={CHIP + " border border-zinc-700 text-zinc-500"}>Out</span>
        <span className={TIME + " text-zinc-600"}>{time}</span>
      </div>
    );
  if (p.picking)
    return (
      <div className={box}>
        <span className="text-[12px] font-semibold whitespace-nowrap text-emerald-400">
          picking
          <span className="after:animate-dots after:content-['']" />
        </span>
      </div>
    );
  if (p.done === "won")
    return (
      <div className={box}>
        <span className={CHIP + " bg-zinc-300 text-zinc-900"}>Solved</span>
        <span className={TIME + " text-zinc-200"}>{time}</span>
      </div>
    );
  return (
    <div className={box}>
      <span className={TIME + " text-zinc-400"}>{time}</span>
    </div>
  );
}

function Rank({ rank, w }: { rank: number; w: string }) {
  if (rank === 1)
    return (
      <div className={"flex-none text-center text-[13px] tabular-nums " + w}>
        <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
          1
        </span>
      </div>
    );
  return (
    <div className={"flex-none text-center text-[13px] tabular-nums text-zinc-500 " + w}>
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
}: {
  p: PlayerState;
  rank: number;
  selfId: string;
  now: number;
  flash: boolean;
}) {
  const you = p.userId === selfId;
  return (
    <div
      className={
        "flex items-center gap-2.75 rounded-lg px-3 py-2.5 " +
        (you ? "bg-zinc-100/10" : "bg-zinc-900/60")
      }
    >
      <Rank rank={rank} w="w-5.5" />
      <Avatar p={p} selfId={selfId} />
      <MiniBoard p={p} flash={flash} />
      <div className="min-w-0 flex-1" />
      <div className="ml-auto flex items-center gap-2.75">
        <Mistakes p={p} />
        <Status p={p} now={now} wide />
      </div>
    </div>
  );
}

export function Roster({
  players,
  selfId,
  defaultOpen = false,
  sidebar = false,
}: {
  players: PlayerState[];
  selfId: string;
  // preview harness can force the "see all" overlay open
  defaultOpen?: boolean;
  // in the sidebar the scroll area flexes to fill the column; standalone uses a fixed cap
  sidebar?: boolean;
}) {
  const now = useNow(players.some((p) => p.done === null));
  const flashing = useFlash(players);
  const [open, setOpen] = useState(defaultOpen);

  const sorted = useMemo(() => sortRoster(players, now), [players, now]);
  const selfIdx = sorted.findIndex((p) => p.userId === selfId);
  const self = selfIdx >= 0 ? sorted[selfIdx] : null;

  return (
    <div className="flex w-full flex-col">
      <div
        className={
          "flex flex-col gap-1.5 overflow-y-auto scrollbar-thin " +
          (sidebar
            ? "min-h-0 flex-1 max-h-75 min-[820px]:max-h-[min(60vh,460px)]"
            : "max-h-81.5")
        }
      >
        {sorted.map((p, i) => (
          <RosterRow
            key={p.userId}
            p={p}
            rank={i + 1}
            selfId={selfId}
            now={now}
            flash={flashing.has(p.userId)}
          />
        ))}
      </div>

      {self && (
        <div className="mt-2 border-t border-dashed border-white/12 pt-2.5 pb-0.5">
          <div className="px-1 pb-1.5 text-[10px] uppercase tracking-[0.07em] text-zinc-600">
            Your standing
          </div>
          <RosterRow
            p={self}
            rank={selfIdx + 1}
            selfId={selfId}
            now={now}
            flash={false}
          />
        </div>
      )}

      <div className="px-1 pt-2.75 pb-0.5 text-center text-[12.5px] text-zinc-500">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="cursor-pointer border-b border-[#2a2a2e] text-zinc-400 hover:text-zinc-100"
        >
          see all
        </button>
      </div>

      {open && (
        <SeeAll
          players={players}
          selfId={selfId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

type Filter = "all" | "playing" | "picking" | "solved" | "out";
const FILTERS: { f: Filter; label: string }[] = [
  { f: "all", label: "All" },
  { f: "playing", label: "Playing" },
  { f: "picking", label: "Picking now" },
  { f: "solved", label: "Solved" },
  { f: "out", label: "Out" },
];

function FullRow({
  p,
  rank,
  selfId,
  now,
}: {
  p: PlayerState;
  rank: number;
  selfId: string;
  now: number;
}) {
  const you = p.userId === selfId;
  return (
    <div
      className={
        "flex items-center gap-2.75 px-1 py-2 first:border-t-transparent " +
        (you
          ? "rounded-lg border-t border-t-transparent bg-zinc-100/6"
          : "border-t border-white/4")
      }
      data-self={you || undefined}
    >
      <Rank rank={rank} w="w-7.5" />
      <Avatar p={p} selfId={selfId} tip={false} size="full" />
      <div
        className={
          "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] " +
          (you ? "font-bold text-zinc-100" : "text-[#d4d4d8]")
        }
      >
        {p.name + (you ? " (you)" : "")}
      </div>
      <MiniBoard p={p} flash={false} size="full" />
      <div className="flex flex-none items-center gap-2.5">
        <Mistakes p={p} />
        <Status p={p} now={now} />
      </div>
    </div>
  );
}

function SeeAll({
  players,
  selfId,
  onClose,
}: {
  players: PlayerState[];
  selfId: string;
  onClose: () => void;
}) {
  const now = useNow(players.some((p) => p.done === null));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const ranked = useMemo(() => sortRoster(players, now), [players, now]);
  const rankById = useMemo(() => {
    const m = new Map<string, number>();
    ranked.forEach((p, i) => m.set(p.userId, i + 1));
    return m;
  }, [ranked]);
  const self = ranked.find((p) => p.userId === selfId) ?? null;

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function matches(p: PlayerState): boolean {
    if (filter === "picking" && !p.picking) return false;
    if (filter === "solved" && p.done !== "won") return false;
    if (filter === "out" && p.done !== "lost") return false;
    if (filter === "playing" && p.done !== null) return false;
    const q = query.trim().toLowerCase();
    if (q && !p.name.toLowerCase().includes(q)) return false;
    return true;
  }
  const rows = ranked.filter(matches);

  function jumpToMe(): void {
    setFilter("all");
    setQuery("");
    // wait for the unfiltered re-render, then scroll the self row into view
    requestAnimationFrame(() => {
      const me = listRef.current?.querySelector<HTMLElement>("[data-self]");
      if (me && listRef.current)
        listRef.current.scrollTop = Math.max(0, me.offsetTop - 90);
    });
  }

  return (
    <div
      className="fixed inset-0 z-100 flex animate-overlay-fade items-center justify-center bg-[#030304]/66 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="flex max-h-[88vh] w-[min(560px,94vw)] animate-sheet-rise flex-col overflow-hidden rounded-2xl border border-[#26262a] bg-zinc-950 shadow-[0_40px_120px_-30px_#000]"
        role="dialog"
        aria-modal="true"
        aria-label="Everyone playing"
      >
        <div className="flex items-center gap-3 px-4.5 pt-4.5 pb-3.5">
          <h3 className="m-0 font-serif text-[22px] font-bold tracking-[-0.02em] text-[#efefe6]">
            Everyone playing
          </h3>
          <span className="flex items-center gap-1.75 text-[12px] text-zinc-500">
            <span className="h-1.75 w-1.75 animate-livedot rounded-full bg-emerald-400" />
            {rows.length === ranked.length
              ? `${ranked.length} playing`
              : `${rows.length} of ${ranked.length}`}
          </span>
          <button
            className="ml-auto grid h-7.5 w-7.5 flex-none cursor-pointer place-items-center rounded-lg bg-transparent text-[15px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-2.75 border-b border-[#1c1c1f] px-4.5 pb-3.5">
          <input
            ref={searchRef}
            className="w-full rounded-full border border-[#2a2a2e] bg-zinc-900 px-3.75 py-2.25 font-sans text-[13.5px] text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
            type="text"
            placeholder="Search players by name…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map(({ f, label }) => (
              <button
                key={f}
                className={
                  "cursor-pointer rounded-full border px-2.75 py-1.25 font-sans text-[11px] font-semibold uppercase tracking-wider transition " +
                  (filter === f
                    ? "border-zinc-100 bg-zinc-100 text-zinc-900"
                    : "border-zinc-700 bg-transparent text-zinc-400 hover:border-zinc-500 hover:text-zinc-100")
                }
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div
          className="relative flex-1 overflow-y-auto px-4 pt-1.5 pb-2.5 scrollbar-thin"
          ref={listRef}
        >
          {rows.length ? (
            rows.map((p) => (
              <FullRow
                key={p.userId}
                p={p}
                rank={rankById.get(p.userId)!}
                selfId={selfId}
                now={now}
              />
            ))
          ) : (
            <div className="py-10 text-center text-[13px] text-zinc-600">
              No players match.
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-dashed border-white/13 px-4 py-2.75">
          <div className="min-w-0 flex-1">
            {self && (
              <>
                <div className="px-1 pb-1.25 text-[10px] uppercase tracking-[0.07em] text-zinc-600">
                  Your standing · #{rankById.get(self.userId)} of {ranked.length}
                </div>
                <FullRow
                  p={self}
                  rank={rankById.get(self.userId)!}
                  selfId={selfId}
                  now={now}
                />
              </>
            )}
          </div>
          <button
            className="flex-none cursor-pointer rounded-full border border-zinc-600 bg-transparent px-3.75 py-2.25 font-sans text-[12.5px] font-semibold text-zinc-100 transition hover:bg-zinc-800"
            onClick={jumpToMe}
          >
            Jump to me
          </button>
        </div>
      </div>
    </div>
  );
}
