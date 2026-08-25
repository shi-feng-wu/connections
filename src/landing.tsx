import {
  useCallback,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, X } from "lucide-react";
import { Board, BTN_SHAPE, DiscordIcon, type BoardSnapshot } from "./board";
import { Header, MobileMasthead } from "./components";
import { Game, LEVELS, MAX_MISTAKES, type Puzzle } from "./game";
import { Mistakes, Rank, ROW, TAB_LOOK, TAB_OFF, TAB_ON } from "./roster";

// The public landing page: what a plain browser visit to the deployment gets, since the
// Activity itself only boots inside Discord (App.tsx renders this when the boot path finds no
// frame_id).
//
// The page IS the game. Same shell as the Activity's GameView (components.tsx): today's real
// board on the left, the players rail on the right, the same masthead, the same tab row, rows
// of the same geometry. There is no hero, no feature grid and no screenshot of the thing you
// could simply be handed — a daily puzzle argues for itself in about ten seconds, and every
// claim a pitch would have made is on screen being true instead.
//
// Two things differ from the Activity, and only two:
//
//   1. NOTHING LEAVES THE BROWSER. The board is today's real puzzle, fetched from /api/today
//      (the one unauthenticated puzzle route), but the run is written to localStorage and
//      nowhere else: no score submitted, no progress row, no card posted. A browser solve is a
//      taste, and the leaderboard it doesn't count towards is the reason to open Discord.
//
//   2. THE RAIL IS THE PITCH. A web page has no room attached to it, so the ranked list holds
//      the only player this page can honestly show — you, rank 1, fed by the run beside it —
//      over EMPTY SEATS. The seats are the whole argument: this is a leaderboard and it has
//      room on it, which lands in a way a sentence about multiplayer doesn't. The button under
//      them is where the other rows come from. When multiplayer stops being a Discord-only
//      thing, that block is the placeholder to replace and the rest of the page already fits.

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
// approved white-on-Blurple pairing. The pill is the game's own BTN_SHAPE, so it stands
// exactly as tall as the board's Submit beside it and only the colour is Discord's.
const BLURPLE = "#5865F2";

function PlayInDiscord({ label }: { label: string }) {
  return (
    <HoverLink
      href={PLAY_IN_DISCORD}
      hover="opacity-88"
      className={BTN_SHAPE + " gap-2.5 text-white"}
      style={{ background: BLURPLE }}
    >
      <DiscordIcon size={18} />
      {label}
    </HoverLink>
  );
}

// ——— Your row ——————————————————————————————————————————————————————————
// The real rail (src/roster.tsx) is live, per-server and per-channel, so most of it can't
// exist on a page with no server attached. One row of it can: the visitor's own. It's the
// real thing's row geometry (roster's ROW/Rank/Mistakes, so the two can't drift) reading the
// same local run as the board beside it, so nothing here is invented. No cast of sample
// players, and no invented identity either: the page has nobody signed in, so the avatar is a
// plain silhouette and the name is "You".
//
// It moves on GAME EVENTS only (a solve, a mistake, the finish) — never on a clock. The time
// cell holds a dash until the run ends and then shows what the solve took. That is deliberate:
// a 1Hz tick is this repo's known source of idle jank, which is why roster.tsx keeps its
// running clock in a single leaf component (LiveTime) and why that component isn't imported
// here.

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
    <div
      className={
        "relative overflow-hidden bg-zinc-800 shadow-[0_0_0_2px_#09090b,0_0_0_3px_rgba(244,244,245,0.32)] " +
        ROW.avatar
      }
    >
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
    <div className={ROW.shell + " bg-zinc-100/10"}>
      <span className="sr-only">{say(row)}</span>
      <Rank rank={1} />
      <SelfAvatar />
      {/* the row's mini board: one solid bar per solved group, the rest still cream */}
      <div aria-hidden className={ROW.mini}>
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
      <span aria-hidden className={ROW.name + " font-bold text-zinc-100"}>
        You
      </span>
      <Mistakes left={row.mistakesLeft} />
      <div aria-hidden className={ROW.status}>
        {/* ✓/✗ keeps a fixed slot on every state, so the time never shifts when a run ends */}
        <span className="grid h-4 w-4 flex-none place-items-center">
          {row.done === "won" && <Check className="text-zinc-100" size={15} strokeWidth={2.8} />}
          {row.done === "lost" && <X className="text-zinc-500" size={15} strokeWidth={2.6} />}
        </span>
        <span
          className={
            "ml-auto text-[12px] font-semibold tabular-nums tracking-[0.01em] min-[800px]:text-[13px] " +
            (row.done === "won" ? "text-zinc-200" : row.done ? "text-zinc-500" : "text-zinc-700")
          }
        >
          {/* Nothing to say until the run ends — there's no live clock here (see above),
              so the slot holds a dash to keep its width rather than a ticking time. */}
          {row.durationMs != null ? mmss(row.durationMs) : "–"}
        </span>
      </div>
    </div>
  );
}

// ——— The empty seats ———————————————————————————————————————————————————
// Rows with nobody in them, in the exact geometry of the one above: a blank disc where a
// friend's avatar goes, a grey grid where their board goes, a bar where their name goes. The
// column edges line up with your row, which is what makes them read as SEATS rather than as a
// list still loading — and what makes the rail's emptiness the point instead of an accident.
// Opacity steps down the stack so the last one is nearly gone and the eye lands on the button
// under it. aria-hidden throughout: there is nobody here to announce.
const SEAT_FADE = [0.5, 0.34, 0.2];

function EmptySeat({ rank, opacity }: { rank: number; opacity: number }) {
  return (
    <div
      aria-hidden
      className={ROW.shell + " bg-zinc-900/60"}
      style={{ opacity }}
    >
      <Rank rank={rank} />
      <div className={ROW.avatar + " bg-zinc-100/10"} />
      <div className={ROW.mini}>
        {Array.from({ length: 16 }, (_, i) => (
          <div key={i} className="rounded-[1px] bg-zinc-100/10" />
        ))}
      </div>
      <span className={ROW.name}>
        {/* a name-shaped bar, not a word: any placeholder name is somebody's, and a
            greeked one ("Player 2") invites you to read it as a real absent player */}
        <span className="block h-[7px] w-[52%] max-w-[86px] rounded-full bg-zinc-100/10" />
      </span>
      <Mistakes left={0} />
      <div className={ROW.status} />
    </div>
  );
}

// ——— The rail ——————————————————————————————————————————————————————————
// Everything the Activity puts beside the board — masthead, tab row, ranked list — plus the
// one thing it doesn't need: somewhere to go. The CTA takes the rail's footer slot, the same
// place the game pins its next-puzzle countdown, so the panel keeps the shape a player will
// see again the moment they're inside Discord.

// The tab row, as text. Live is the tab you'd be on; Season and All-time are shown but not
// offered, because a page with one local run has no standings to put behind them — and hiding
// them would misrepresent what the rail actually holds. Spans, not buttons: nothing here is
// pressable, so nothing here takes the cursor or a tab stop (roster.tsx's TAB_LOOK is exactly
// the tab minus its control affordances).
function DeadTabs() {
  return (
    <div className="flex flex-none items-center gap-4 px-0.5 pb-0.5">
      <span className={TAB_LOOK + TAB_ON}>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Live
      </span>
      <span className={TAB_LOOK + TAB_OFF}>Season</span>
      <span className={TAB_LOOK + TAB_OFF}>All-time</span>
    </div>
  );
}

function Rail({ puzzle, row, finished }: { puzzle?: Puzzle; row: SelfRow; finished: boolean }) {
  return (
    // The one place this rail parts company with GameView's. In the Activity the rail
    // absolute-fills its half and scrolls its list inside, because a live room is any length
    // and must never drive a fixed iframe taller. Here the list is four rows and always will
    // be — pinning it to the board's height only bought a seat sliced in half at the clip, so
    // the rail is a plain column that ends where its content ends. Mobile: the same column,
    // under the board, in the same order.
    <div className="flex w-full min-w-0 flex-1 flex-col gap-2.5">
      <Header puzzle={puzzle} className="hidden min-[800px]:flex" />
      <DeadTabs />
      <div className="flex flex-col gap-1.5">
        <SelfRowView row={row} />
        {SEAT_FADE.map((opacity, i) => (
          <EmptySeat key={i} rank={i + 2} opacity={opacity} />
        ))}
      </div>
      {/* The rail's footer slot — the game pins its next-puzzle countdown here, and this page
          pins the only thing it has to say. One sentence: the seats above already made the
          argument, so this just names where the players come from. */}
      <div className="mt-1 flex flex-col items-start gap-3 border-t border-white/[0.07] px-1 pt-3.5">
        <p className="text-pretty font-sans text-[12.5px] leading-[1.65] text-zinc-500">
          {finished
            ? "That was today's. In Discord your whole server gets the same board every day, with grids filling in live and a season leaderboard keeping score."
            : "In Discord your whole server plays this board with you: grids filling in live, and a season leaderboard keeping score."}
        </p>
        <PlayInDiscord label="Play in Discord" />
      </div>
    </div>
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

// ——— Page ——————————————————————————————————————————————————————————————

export function Landing({ puzzle: seed }: { puzzle?: Puzzle }) {
  // The puzzle is held HERE, not in the board: the masthead's dateline and puzzle number
  // come off the same fetch, and they're the rail's, not the board's.
  const [puzzle, setPuzzle] = useState<Puzzle | null>(seed ?? null);
  const [failed, setFailed] = useState(false);
  const [game, setGame] = useState<Game | null>(null);
  const [finished, setFinished] = useState(false);
  // This visitor's run, as the rail draws it. Held here because the board and the rail are
  // siblings. Presence fires on every tile tap too, and most of those don't change a thing the
  // row shows — bail out on an unchanged row so a selection never re-renders the board's
  // parent mid-animation.
  const [row, setRow] = useState<SelfRow>(IDLE_ROW);
  const onRow = useCallback((next: SelfRow) => {
    setRow((prev) => (sameRow(prev, next) ? prev : next));
  }, []);

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

  // Rehydrate whatever this browser already did with today's board — which is what makes a
  // mid-solve reload come back with the row already filled in.
  useEffect(() => {
    if (!puzzle) return;
    const g = restoreRun(puzzle);
    setGame(g);
    setFinished(g.status !== "playing");
    onRow(rowOf(g));
  }, [puzzle, onRow]);

  return (
    // The game's own shell (GameView): capped at 480 and centered as a single column, a 50/50
    // split at DESKTOP_BP. What it deliberately does NOT copy is the scale-to-fit — inside
    // Discord the board grows to fill a fixed iframe, but a browser tab is a document that
    // scrolls, with a footer under it that scaling would fight. The board renders at its
    // natural size, which is the size it is in an Activity window of this width anyway.
    <div className="mx-auto flex w-full max-w-[480px] animate-fade-in flex-col min-[800px]:max-w-[860px] min-[800px]:py-10">
      {/* Mobile only. In Discord this slot is the client's own activity chrome, so the game
          hides its masthead there; on the open web nothing else says whose page this is, and
          an anonymous board is a page a visitor can't come back to. Desktop's copy of it sits
          atop the rail (Rail above), exactly as in the game. */}
      <MobileMasthead puzzle={puzzle ?? undefined} />

      <div className="flex w-full min-w-0 flex-col gap-3 min-[800px]:flex-row min-[800px]:items-stretch min-[800px]:gap-6">
        <div className="flex w-full min-w-0 flex-col gap-3 min-[800px]:flex-1">
          {failed ? (
            // The rail's button is right there (beside on desktop, below on mobile), so this
            // says what happened and points at it rather than growing a CTA of its own.
            <p className="text-pretty font-sans text-[14px] leading-[1.7] text-zinc-400">
              Today's board didn't load. It's always waiting in Discord, so try there for now.
            </p>
          ) : game ? (
            <Board
              key={puzzle?.date}
              game={game}
              onPresence={(snap: BoardSnapshot) => {
                saveRun(game);
                // The snapshot is the board's own view of the run (its solve animations land a
                // group in `solvedLevels` exactly when the bar appears), so the rail fills in
                // step with the board rather than one guess ahead of it.
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
              // No onShareLink/onCopyImage/onCopyLink: every one of those mints a card from
              // the server's record of a player's daily, and this run has no record. The end
              // footer keeps its floor row, "Copy emoji grid as text", which needs nothing.
            />
          ) : (
            <BoardSkeleton />
          )}
        </div>

        <Rail puzzle={puzzle ?? undefined} row={row} finished={finished} />
      </div>

      {/* The one thing the game has no equivalent of: this is a public page, and the legal
          links have to be reachable from it. Kept to a single quiet line so it reads as a
          plate at the bottom of the frame rather than a site footer bolted to a game. */}
      <footer className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-white/[0.06] pt-5 font-sans text-[11.5px] text-zinc-600 min-[800px]:mt-10">
        <p>An independent game. Every board written and edited in-house, one a day.</p>
        <nav className="flex items-center gap-5 font-semibold text-zinc-500">
          <HoverLink href={GITHUB} hover="text-zinc-200" className="transition-colors">
            GitHub
          </HoverLink>
          <HoverLink href="/privacy.html" hover="text-zinc-200" className="transition-colors">
            Privacy
          </HoverLink>
          <HoverLink href="/terms.html" hover="text-zinc-200" className="transition-colors">
            Terms
          </HoverLink>
        </nav>
      </footer>
    </div>
  );
}
