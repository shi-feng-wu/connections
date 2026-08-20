import {
  useCallback,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, X } from "lucide-react";
import { Board, DiscordIcon, type BoardSnapshot } from "./board";
import { Game, LEVELS, MAX_MISTAKES, type Puzzle } from "./game";

// The public landing page: what a plain browser visit to the deployment gets, since
// the Activity itself only boots inside Discord (App.tsx renders this when the boot
// path finds no frame_id).
//
// Three things, nothing else:
//   1. TODAY'S REAL BOARD, playable right here. Not a scripted demo — the same Board
//      component the Activity runs, fed by /api/today (the one unauthenticated puzzle
//      route). Everything about the run stays on this device: no score is submitted,
//      no progress row is written, nothing is posted. A browser solve is a taste, and
//      the leaderboard it doesn't count towards is the reason to open Discord.
//   2. A leaderboard rail holding exactly ONE row: this visitor. It's the real rail's
//      row parts fed by the real local run beside it, because the only player this
//      page can honestly show is the one reading it. A room to share it with is the
//      thing Discord adds.
//   3. A heading and a couple of sentences, so there's something to index.

const GITHUB = "https://github.com/shi-feng-wu/connections";
const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;

// The CTA is a Discord QUICK LINK in the exact shape the app mints for shared results
// (api/_share.ts quickLinkUrl): /activities/<app id> with a custom_id ride-along. This
// one is static and has no sharer, which is a case the inbound half already handles —
// /api/referral records a sharer-less custom_id verbatim with referrer_user_id null,
// so arrivals from this page land in `referrals` as countable campaign rows. The tag
// has to look like a real campaign, not a placeholder: "undefined"/"null"/"none" are
// dropped there on purpose. Without a client id (a bare preview build) fall back to
// the repo so the button never dead-ends.
const CAMPAIGN = "web-landing";
const PLAY_IN_DISCORD = CLIENT_ID
  ? `https://discord.com/activities/${CLIENT_ID}?custom_id=${CAMPAIGN}`
  : GITHUB;

// ——— Local-only solve state ———————————————————————————————————————————
// Keyed by puzzle DAY (the `connections:` prefix every other client key uses), so
// reopening the tab resumes the same run and tomorrow's board starts clean. This is
// the ONLY place a web solve is recorded; nothing leaves the browser.
const KEY_PREFIX = "connections:web:";
const storeKey = (date: string): string => KEY_PREFIX + date;

type SavedRun = {
  guesses?: unknown;
  hints?: unknown;
  startedAt?: number;
  updatedAt?: number;
};

function saveRun(game: Game): void {
  const date = game.puzzle.date;
  try {
    localStorage.setItem(
      storeKey(date),
      JSON.stringify({
        guesses: game.guesses,
        hints: game.hintedLevels,
        startedAt: game.startedAt,
        updatedAt: Date.now(),
      } satisfies SavedRun),
    );
    // Yesterday's run is dead weight the moment the day rolls; drop every other day's.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX) && k !== storeKey(date)) localStorage.removeItem(k);
    }
  } catch {
    /* private mode / storage off — the run just won't survive a reload */
  }
}

// Replay the saved guesses through the real rules, the same way the Activity rehydrates
// an abandoned game (App.tsx): the guess list is the record, Game.fromGuesses is the
// only thing that reads it, so a hand-edited entry can't invent a state the rules
// don't allow.
function restoreRun(puzzle: Puzzle): Game {
  let saved: SavedRun | null = null;
  try {
    const raw = localStorage.getItem(storeKey(puzzle.date));
    saved = raw ? (JSON.parse(raw) as SavedRun) : null;
  } catch {
    /* unreadable → start fresh */
  }
  const game = Game.fromGuesses(puzzle, saved?.guesses ?? [], saved?.startedAt, saved?.hints);
  // A finished run reopened later must show the time it was solved in, not the
  // wall clock since it started (mirrors App.tsx's rehydrate).
  if (game.status !== "playing" && saved?.startedAt && saved?.updatedAt) {
    game.durationMs = Math.max(1000, saved.updatedAt - saved.startedAt);
  }
  return game;
}

// ——— Mouse-only hover ——————————————————————————————————————————————————
// The anchor twin of HoverButton: this page is also served inside touch contexts,
// where CSS :hover sticks after a tap and strands the transition. Hover classes go on
// only while a real mouse is over the link.
function HoverLink({
  hover = "",
  className = "",
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { hover?: string }) {
  const [over, setOver] = useState(false);
  return (
    <a
      {...rest}
      className={className + (over ? " " + hover : "")}
      onPointerEnter={(e: ReactPointerEvent<HTMLAnchorElement>) => {
        if (e.pointerType === "mouse") setOver(true);
      }}
      onPointerLeave={(e: ReactPointerEvent<HTMLAnchorElement>) => {
        if (e.pointerType === "mouse") setOver(false);
      }}
    >
      {children}
    </a>
  );
}

// Discord's Blurple, and the mark in white on it — the treatment Discord's brand
// guidelines ask for. The glyph itself is the app's existing official path (the share
// menu's DiscordIcon), used as-is: never restyled, never recoloured beyond the
// approved white-on-Blurple pairing.
const BLURPLE = "#5865F2";

function PlayInDiscord({ label, className = "" }: { label: string; className?: string }) {
  return (
    <HoverLink
      href={PLAY_IN_DISCORD}
      hover="opacity-88"
      className={
        "inline-flex items-center gap-2.5 rounded-full px-5 py-2.5 font-sans text-sm font-semibold text-white transition-opacity duration-150 ease-out active:scale-[0.98] " +
        className
      }
      style={{ background: BLURPLE }}
    >
      <DiscordIcon size={18} />
      {label}
    </HoverLink>
  );
}

// ——— The leaderboard rail: one row, and it's yours ————————————————————
// The real rail (src/roster.tsx) is live, per-server and per-channel, so most of it
// can't exist on a page with no server attached. One row of it can: the visitor's own.
// It's the real thing's row parts — rank, avatar, four-by-four mini board, guess dots,
// time — reading the same local run as the board beside it, so nothing here is
// invented. No cast of sample players, and no invented identity either: the page has
// nobody signed in, so the avatar is a plain silhouette and the name is "You".
//
// It moves on GAME EVENTS only (a solve, a mistake, the finish) — never on a clock.
// The time cell holds a dash until the run ends and then shows what the solve took.
// That is deliberate: a 1Hz tick is this repo's known source of idle jank, which is
// why roster.tsx keeps its running clock in a single leaf component (LiveTime) and
// why that component isn't imported here.

// What the row draws. A subset of Game, so the row can render before a puzzle has
// even arrived and can be compared cheaply between updates.
type SelfRow = {
  // group levels solved by deduction, in solve order (each paints a full-width bar)
  solvedLevels: number[];
  mistakesLeft: number;
  done: "won" | "lost" | null;
  // set only once the run is over — there is no live clock on this page
  durationMs: number | null;
};

const IDLE_ROW: SelfRow = {
  solvedLevels: [],
  mistakesLeft: MAX_MISTAKES,
  done: null,
  durationMs: null,
};

// `deducedLevels`, not `solved`: a loss back-fills the unsolved groups, and the row
// must not paint four bars for a board you didn't crack (the same distinction the
// live roster and /api/roster draw).
const rowOf = (game: Game): SelfRow => ({
  solvedLevels: game.deducedLevels,
  mistakesLeft: game.mistakesLeft,
  done: game.status === "playing" ? null : game.status,
  durationMs: game.durationMs,
});

const sameRow = (a: SelfRow, b: SelfRow): boolean =>
  a.mistakesLeft === b.mistakesLeft &&
  a.done === b.done &&
  a.durationMs === b.durationMs &&
  a.solvedLevels.length === b.solvedLevels.length &&
  a.solvedLevels.every((l, i) => l === b.solvedLevels[i]);

// m:ss (h:mm:ss past an hour), same shape as the roster's finished times.
function mmss(ms: number): string {
  const total = Math.round(ms / 1000);
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Stand-in for a Discord photo. Nobody is signed in on this page, so this can't be a
// picture of anyone: a neutral silhouette, no identity colour and no initials of a
// name we'd have to make up. It wears the roster's own "this row is you" ring, dimmed
// — in the roster that ring picks you out of a crowd, and here there is no crowd, so
// at full white it just shouted over the rank chip.
function SelfAvatar() {
  return (
    <div className="relative h-8 w-8 flex-none overflow-hidden rounded-full bg-zinc-800 shadow-[0_0_0_2px_#09090b,0_0_0_3px_rgba(244,244,245,0.32)]">
      <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden focusable="false">
        <circle cx="32" cy="25" r="12.5" fill="#8b8b94" />
        <rect x="12" y="43" width="40" height="28" rx="14" fill="#8b8b94" />
      </svg>
    </div>
  );
}

// The row is a picture; this is the same state as a sentence, for screen readers.
function say(row: SelfRow): string {
  const n = row.solvedLevels.length;
  const time = row.durationMs != null ? ` in ${mmss(row.durationMs)}` : "";
  if (row.done === "won") return `You, rank 1. Solved${time}.`;
  if (row.done === "lost") return `You, rank 1. Out with ${n} of 4 groups${time}.`;
  if (n === 0 && row.mistakesLeft === MAX_MISTAKES) return "You, rank 1. Not started.";
  return `You, rank 1. ${n} of 4 groups, ${row.mistakesLeft} guesses left.`;
}

function SelfRowView({ row }: { row: SelfRow }) {
  const solved = row.solvedLevels;
  return (
    <div className="flex items-center gap-2.75 rounded-[9px] bg-zinc-100/10 px-3 py-2.25">
      <span className="sr-only">{say(row)}</span>
      <div aria-hidden className="w-5.5 flex-none text-center text-[13px] tabular-nums">
        <span className="inline-grid h-5 w-5 place-items-center rounded-md bg-zinc-100 text-[12px] font-extrabold text-zinc-900">
          1
        </span>
      </div>
      <SelfAvatar />
      {/* the row's mini board: one solid bar per solved group, the rest still cream */}
      <div
        aria-hidden
        className="grid flex-none grid-cols-[repeat(4,7px)] grid-rows-[repeat(4,7px)] gap-[1px]"
      >
        {solved.map((lvl) => (
          <div
            key={lvl}
            className="col-span-4 rounded-[1px]"
            style={{ background: LEVELS[lvl].color }}
          />
        ))}
        {Array.from({ length: (4 - solved.length) * 4 }, (_, i) => (
          <div key={i} className="rounded-[1px] bg-[#e8eaee]" />
        ))}
      </div>
      <span
        aria-hidden
        className="min-w-0 flex-1 whitespace-nowrap text-[13px] font-bold text-zinc-100"
      >
        You
      </span>
      <span aria-hidden className="inline-flex flex-none items-center gap-[3px]">
        {Array.from({ length: MAX_MISTAKES }, (_, i) => (
          <span
            key={i}
            className={
              "h-1.75 w-1.75 rounded-full " +
              (i < row.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
            }
          />
        ))}
      </span>
      {/* ✓/✗ keeps a fixed slot on every state, so the time never shifts when a run ends */}
      <span aria-hidden className="grid h-4 w-4 flex-none place-items-center">
        {row.done === "won" && <Check className="text-zinc-100" size={15} strokeWidth={2.8} />}
        {row.done === "lost" && <X className="text-zinc-500" size={15} strokeWidth={2.6} />}
      </span>
      <span
        aria-hidden
        className={
          "w-[38px] flex-none text-right text-[12.5px] font-semibold tabular-nums " +
          (row.done === "won" ? "text-zinc-200" : row.done ? "text-zinc-500" : "text-zinc-700")
        }
      >
        {/* Nothing to say until the run ends — there's no live clock here (see above),
            so the slot holds a dash to keep its width rather than a ticking time. */}
        {row.durationMs != null ? mmss(row.durationMs) : "–"}
      </span>
    </div>
  );
}

function LeaderboardRail({ row }: { row: SelfRow }) {
  return (
    <aside className="flex flex-col gap-4">
      {/* The "Today" header stays: it's what the one row is a ranking OF, and without
          it a lone row in a bordered box reads as a stray widget rather than the top
          of a leaderboard. */}
      <div className="rounded-2xl border border-white/10 bg-black/40 p-3">
        <div className="mb-2.5 px-0.5">
          <span className="font-sans text-[11px] font-bold uppercase tracking-[0.07em] text-zinc-100">
            Today
          </span>
        </div>
        <SelfRowView row={row} />
      </div>
      <div className="flex flex-col items-start gap-3.5 px-0.5">
        <p className="text-pretty font-sans text-[13.5px] leading-[1.7] text-zinc-400">
          Right now it's just you. Play in Discord to join your server on the same board,
          see your friends' progress live, and compete on the season leaderboard.
        </p>
        <PlayInDiscord label="Play in Discord" />
      </div>
    </aside>
  );
}

// ——— Today's board ————————————————————————————————————————————————————

// A quiet stand-in while today's board is on the wire: sixteen tiles at the real tile
// height, so the column doesn't jump when the game arrives.
function BoardSkeleton() {
  return (
    <div aria-hidden className="grid grid-cols-4 gap-2">
      {Array.from({ length: 16 }, (_, i) => (
        <div
          key={i}
          className="h-[var(--tile-h)] animate-pulse rounded-lg bg-zinc-900"
          style={{ animationDelay: `${(i % 4) * 90}ms` }}
        />
      ))}
    </div>
  );
}

function TodaysBoard({
  seed,
  onRow,
}: {
  seed?: Puzzle;
  // Hand the rail beside us this run's state. Called on the same beats the board
  // already reports on — every presence broadcast and the finish — plus once when a
  // saved run is rehydrated, which is what makes a mid-solve reload come back with
  // the row already filled in.
  onRow: (row: SelfRow) => void;
}) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(seed ?? null);
  const [failed, setFailed] = useState(false);
  const [game, setGame] = useState<Game | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (seed) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/today");
        if (!res.ok) throw new Error(String(res.status));
        const p = (await res.json()) as Puzzle;
        if (alive) setPuzzle(p);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [seed]);

  // Rehydrate whatever this browser already did with today's board.
  useEffect(() => {
    if (!puzzle) return;
    const g = restoreRun(puzzle);
    setGame(g);
    setFinished(g.status !== "playing");
    onRow(rowOf(g));
  }, [puzzle, onRow]);

  if (failed) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-2xl border border-white/10 bg-black/40 p-6">
        <p className="text-pretty font-sans text-[14px] leading-[1.7] text-zinc-400">
          Today's board didn't load. It's always waiting in Discord, so try there for now.
        </p>
        <PlayInDiscord label="Play in Discord" />
      </div>
    );
  }

  if (!game) return <BoardSkeleton />;

  return (
    <div>
      <Board
        key={puzzle?.date}
        game={game}
        onPresence={(snap: BoardSnapshot) => {
          saveRun(game);
          // The snapshot is the board's own view of the run (its solve animations
          // land a group in `solvedLevels` exactly when the bar appears), so the rail
          // fills in step with the board rather than one guess ahead of it.
          onRow({
            solvedLevels: snap.solvedLevels,
            mistakesLeft: snap.mistakesLeft,
            done: snap.done,
            durationMs: game.durationMs,
          });
        }}
        onFinish={() => {
          saveRun(game);
          setFinished(true);
          onRow(rowOf(game)); // now carries durationMs
        }}
      />
      {/* Post-solve beat. The board's own end footer carries the score and the share
          menu (whose "Copy emoji grid as text" row is the floor row: it needs no server
          behind it, which is exactly this page's situation). This adds the one thing the
          end screen can't, somewhere to go next. Mounted only once the run is over, on a
          plain opacity fade, so the link is never a hidden tab stop. */}
      {finished && (
        <div className="mt-7 flex animate-fade-in flex-col items-start gap-3">
          <p className="text-pretty font-sans text-[13.5px] leading-[1.7] text-zinc-400">
            That's today's. Copy your grid from the share button above, then play tomorrow's
            with your server.
          </p>
          <PlayInDiscord label="Play in Discord" />
        </div>
      )}
    </div>
  );
}

// ——— Page ——————————————————————————————————————————————————————————————

// Staggered load-in: tabIn is declared with `both`, so a delayed element holds
// opacity 0 until its turn.
const riseDelay = (i: number): { animationDelay: string } => ({
  animationDelay: `${i * 90}ms`,
});

export function Landing({ puzzle }: { puzzle?: Puzzle }) {
  // The one thing the two columns share: this visitor's run, as the rail draws it.
  // Held here because the board and the rail are siblings. Presence fires on every
  // tile tap too, and most of those don't change a thing the row shows — bail out on
  // an unchanged row so a selection never re-renders the board's parent mid-animation.
  const [row, setRow] = useState<SelfRow>(IDLE_ROW);
  const onRow = useCallback((next: SelfRow) => {
    setRow((prev) => (sameRow(prev, next) ? prev : next));
  }, []);

  return (
    <div className="relative w-full py-9 min-[820px]:py-12">
      {/* Atmosphere: two ultra-faint category-color washes over the black. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(560px 420px at 12% -4%, rgba(249,223,109,0.05), transparent 70%)," +
            "radial-gradient(640px 480px at 96% 32%, rgba(186,129,197,0.06), transparent 70%)",
        }}
      />

      {/* Wordmark, the game header's own lockup (components.tsx Header). */}
      <header className="flex animate-tab-in items-center gap-2.5" style={riseDelay(0)}>
        <span className="font-display text-[27px] font-bold leading-none tracking-[-0.025em] text-[#e8eaee] [text-box:trim-both_cap_alphabetic]">
          Disconnections
        </span>
      </header>

      <section className="mt-9 flex flex-col gap-4 min-[820px]:mt-12">
        <h1
          className="max-w-[18ch] animate-tab-in text-balance font-display text-[36px] font-bold leading-[1.06] tracking-[-0.015em] text-[#e8eaee] min-[820px]:text-[46px]"
          style={riseDelay(1)}
        >
          The daily puzzle, played together.
        </h1>
        <p
          className="max-w-[58ch] animate-tab-in text-pretty font-sans text-[15px] leading-[1.75] text-zinc-400"
          style={riseDelay(2)}
        >
          A new puzzle every day, written by us: sixteen words hiding four groups of four.
          Today's board is right here, and in Discord your whole server plays the same one.
        </p>
      </section>

      <section className="mt-10 grid items-start gap-11 min-[820px]:mt-12 min-[820px]:grid-cols-[minmax(0,1fr)_minmax(0,372px)] min-[820px]:gap-12">
        <div className="min-w-0 animate-tab-in" style={riseDelay(3)}>
          <TodaysBoard seed={puzzle} onRow={onRow} />
        </div>
        <div className="min-w-0 animate-tab-in" style={riseDelay(4)}>
          <LeaderboardRail row={row} />
        </div>
      </section>

      <footer className="mt-20 flex flex-col gap-4 border-t border-white/10 pt-7 pb-2 min-[820px]:flex-row min-[820px]:items-center min-[820px]:justify-between">
        <p className="max-w-[58ch] text-pretty font-sans text-[12px] leading-relaxed text-zinc-600">
          An independent game. Every board is written and edited in-house, one a day.
        </p>
        <nav className="flex items-center gap-5 font-sans text-[12px] font-semibold text-zinc-500">
          <a href={GITHUB} className="transition-colors hover:text-zinc-200">
            GitHub
          </a>
          <a href="/privacy.html" className="transition-colors hover:text-zinc-200">
            Privacy
          </a>
          <a href="/terms.html" className="transition-colors hover:text-zinc-200">
            Terms
          </a>
        </nav>
      </footer>
    </div>
  );
}
