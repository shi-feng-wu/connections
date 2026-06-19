import { Clock, Eraser, Shuffle as ShuffleIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { Game, LEVELS, MAX_MISTAKES, shuffle, type Group } from "./game";
import { HoverButton } from "./hoverbutton";

// Playable board + solve animations (correct: pop, FLIP gather, morph to bar;
// wrong: shake, spend a dot; end: fade controls, reveal missed groups on loss).
// Keeps a parallel display model because Game resolves a guess atomically but
// the FLIP sequence needs the intermediate states.

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Final solve time, MM:SS, for the end-screen score summary.
const fmtClock = (ms: number | null): string => {
  const s = Math.max(1, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// One additive column of the breakdown the end-screen bar fades up to reveal: a tiny
// caption stacked over its signed point value, the row reading left→right as an
// equation. `neg` greys the mistakes deduction; `total` is the sum the rest add up to —
// right-aligned in the serif score voice, set off by a hairline divider.
function BreakItem({
  caption,
  value,
  neg,
  total,
}: {
  caption: string;
  value: string;
  neg?: boolean;
  total?: boolean;
}) {
  return (
    <div
      className={
        "flex min-w-0 flex-col gap-[3px] leading-none " +
        (total ? "items-end border-l border-white/10 pl-2.5" : "items-start")
      }
    >
      <span
        className={
          "whitespace-nowrap text-[8.5px] font-semibold uppercase leading-none tracking-[0.06em] max-[380px]:text-[7.5px] max-[360px]:tracking-[0.02em] " +
          (total ? "text-zinc-400" : "text-zinc-500")
        }
      >
        {caption}
      </span>
      <span
        className={
          "leading-none tabular-nums " +
          (total
            ? "font-display text-[17px] font-bold tracking-[-0.01em] text-[#efefe6]"
            : "text-[14px] font-bold " + (neg ? "text-zinc-400" : "text-emerald-400"))
        }
      >
        {value}
      </span>
    </div>
  );
}

// End-screen footer. At rest it's the run summary, two clusters at the far edges with
// room to breathe: mistake dots (left), then the clock-icon solve-time chip, a hairline
// divider, the serif score, and the ⓘ affordance (right). The next-puzzle countdown
// lives under the players list (see Roster), not here. Inspecting doesn't open a
// floating tooltip: the WHOLE bar FADES UP in place — the summary face fades out while
// the itemized breakdown (categories, bonus, speed, mistakes → total) fades in and rises
// a few px into its place, the gentle fade-up reveal from the redesign. The whole bar is
// the trigger now, not just the score cluster, so a mouse anywhere over it reveals the
// makeup. Hover is mouse-only — this ships as a Discord Activity where CSS :hover sticks
// after a tap (same reason as HoverButton) — so a real mouse reveals it on hover, touch
// toggles it on tap, and a tap/Esc outside closes a pinned-open one.
// Losses read the same: partial-credit categories, a 0 bonus/speed.
// `note` is the transient "Couldn’t save that guess" warning for a commit that fails
// after the game ends (the final guess's commit usually resolves mid-end-choreography):
// it rides a face that overlays the bar (and outranks the reveal) because the
// playing-state Submit pill — the note's home during play — is gone, and the old slot
// (the desktop header's date) is hidden on mobile, which made the warning invisible
// exactly where scores matter.
function EndSummary({ game, note }: { game: Game; note?: string | null }) {
  const b = game.scoreBreakdown;
  const won = game.status === "won";
  const perfect = won && game.mistakesLeft === MAX_MISTAKES;
  const label = perfect ? "Perfect" : won ? "Solved" : "Out of guesses";
  const [over, setOver] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const showNote = note != null;
  const open = (over || pinned) && !showNote;
  // hold the last note text through the face's fade-out, so the words don't vanish
  // a beat before the opacity does.
  const lastNote = useRef("");
  if (note) lastNote.current = note;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <div
      ref={ref}
      className="relative flex cursor-help select-none items-center [-webkit-tap-highlight-color:transparent]"
      role="button"
      tabIndex={0}
      aria-label="Score breakdown"
      aria-expanded={open}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setOver(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setOver(false);
      }}
      onClick={() => setPinned((p) => !p)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setPinned((p) => !p);
        }
      }}
    >
      {/* The fade-up stage spans the whole bar. The summary face sits in normal flow and
          fixes the row height; the breakdown face is absolutely overlaid and fades up
          over it on open (.sb-open drives both). The note (below) overlays the whole
          thing, fading the stage out under it so the reveal never peeks through. */}
      <div
        className={
          "sb-stage relative min-w-0 flex-1 transition-opacity duration-200 ease-out " +
          (showNote ? "pointer-events-none opacity-0 " : "opacity-100 ") +
          (open ? "sb-open" : "")
        }
      >
        {/* SUMMARY — the run summary. In normal flow, so it alone fixes the row height:
            mistake dots (left); solve-time chip · divider · status + score · ⓘ (right).
            Fades out in place on open. */}
        <div
          aria-hidden={open || showNote}
          className="sb-front flex items-center justify-between gap-3 max-[360px]:gap-2"
        >
          <span
            className="inline-flex flex-none items-center gap-1.75"
            aria-label="Mistakes remaining"
          >
            {Array.from({ length: MAX_MISTAKES }, (_, i) => (
              <span
                key={i}
                className={
                  "inline-block h-3.5 w-3.5 rounded-full " +
                  (i < game.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
                }
              />
            ))}
          </span>
          <div className="flex min-w-0 items-center gap-3.5 self-stretch max-[360px]:gap-2.5">
            <div className="flex items-center gap-2 text-[15px] font-semibold tabular-nums text-zinc-400">
              <Clock size={15} strokeWidth={2.25} className="flex-none text-zinc-500" aria-hidden />
              <span>{fmtClock(game.durationMs)}</span>
            </div>
            <span className="my-1 w-px flex-none self-stretch bg-white/10" aria-hidden />
            <div className="flex min-w-0 flex-col items-end gap-0.75">
              {/* At the narrow-Android floor (<=360px) "Out of guesses" would widen
                  the stack and push it off the right edge — cap it so it wraps to two
                  lines; "Solved"/"Perfect" never reach the cap, so they stay one. */}
              <span
                className={
                  "text-right text-[10px] font-semibold uppercase leading-tight tracking-[0.16em] max-[360px]:max-w-[4.5rem] " +
                  (won ? "text-emerald-400" : "text-zinc-400")
                }
              >
                {label}
              </span>
              <span className="font-display text-[26px] font-bold leading-none tracking-[-0.02em] text-[#efefe6]">
                +{game.score.toLocaleString()}
              </span>
            </div>
            <span
              className={
                "inline-grid h-[15px] w-[15px] flex-none place-items-center rounded-full border font-serif text-[10px] font-bold not-italic leading-none transition-colors duration-150 " +
                (open ? "border-zinc-400 text-[#efefe6]" : "border-zinc-600 text-zinc-500")
              }
              aria-hidden
            >
              i
            </span>
          </div>
        </div>

        {/* BREAKDOWN — the additive makeup spread across the bar as a left→right
            equation, landing on the total where the score sat. Absolutely overlaid;
            fades in and rises a few px into place on open (see .sb-break). */}
        <div
          aria-hidden={!open}
          className="sb-break flex items-center justify-between gap-1.5 px-0.5 max-[360px]:gap-1 max-[360px]:px-0"
        >
          <BreakItem caption="Categories" value={`+${b.completion}`} />
          <BreakItem caption="Bonus" value={`+${b.solveBonus}`} />
          <BreakItem caption="Speed" value={won ? `+${b.speed}` : "+0"} />
          <BreakItem caption="Mistakes" value={won ? `−${b.penalty}` : "−0"} neg />
          <BreakItem caption="Total" value={`+${game.score.toLocaleString()}`} total />
        </div>
      </div>

      {/* NOTE — the rare post-game "couldn’t save" warning; overlays the bar and
          outranks the reveal while it shows (open is forced false), then fades back.
          role=status announces it (the playing-state pill's aria-live is gone by now). */}
      <div
        role="status"
        aria-hidden={!showNote}
        className={
          "absolute inset-0 flex items-center justify-center text-[12.5px] font-bold text-zinc-100 transition-opacity duration-300 ease-out " +
          (showNote ? "opacity-100" : "pointer-events-none opacity-0")
        }
      >
        {note ?? lastNote.current}
      </div>
    </div>
  );
}

const TILE =
  "relative h-[var(--tile-h)] min-w-0 rounded-lg font-extrabold uppercase tracking-[0.01em] leading-none px-1.5 flex items-center justify-center cursor-pointer select-none transition duration-150 ease-out";
// Ideal/ceiling word size (responsive); FitText only shrinks below this to fit.
const TILE_TEXT = "block w-full text-center text-[clamp(9px,3vw,17px)]";

// Solved-bar text. The bar height is fixed (--tile-h, up to 80px), so a category
// and/or answer list that wraps to two lines has to fit four total lines without
// overflowing. Phone portrait stays vw-governed (~13px / ~12px) and was already
// fine, so only the upper cap is pulled in — on wide layouts the font otherwise
// pins at the ceiling while the board sits in the narrow left half of the 50/50
// split, where 18px/16px crowded (and slightly overflowed) the four-line case.
// Shared by the plain solved bar and the SpoilerBar so the two never drift.
const BAR_CAT =
  "font-extrabold uppercase tracking-tight text-[clamp(12px,3.4vw,16px)] leading-tight";
const BAR_MEMBERS = "uppercase text-[clamp(10px,3vw,13px)] leading-tight";

// Tile word, auto-fitted to the tile like NYT Connections: short words render at the
// responsive ceiling; a word that would touch the edges has its font scaled down
// (never the tile padding) until it fits the content box — measured, not guessed, so
// it holds at any tile width. Multi-word entries wrap at spaces first; a single token
// that still won't fit at the floor breaks as an absolute last resort so nothing spills.
function FitText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const FLOOR = 6;
    const fit = (): void => {
      el.style.fontSize = "";
      el.style.overflowWrap = "normal";
      const cs = getComputedStyle(box);
      const availH =
        box.clientHeight -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom);
      const fits = (): boolean =>
        el.scrollWidth <= el.clientWidth + 0.5 &&
        el.scrollHeight <= availH + 0.5;
      if (el.clientWidth <= 0 || fits()) return; // fits at the ceiling → keep it
      let lo = FLOOR;
      let hi = parseFloat(getComputedStyle(el).fontSize); // the resolved ceiling
      let best = FLOOR;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = mid + "px";
        if (fits()) {
          best = mid;
          lo = mid;
        } else hi = mid;
      }
      el.style.fontSize = best + "px";
      if (!fits()) el.style.overflowWrap = "anywhere";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    let live = true;
    // the bold sans webfont can swap in after first paint and change metrics
    void document.fonts?.ready.then(() => live && fit()).catch(() => {});
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [text]);
  return (
    <span ref={ref} className={TILE_TEXT}>
      {text}
    </span>
  );
}
// Hover is a subtle opacity dim (per the redesign — no lift/scale), and it rides on
// JS pointer events (mouse-only), NOT CSS :hover — a tap on a touch/hybrid device
// sets :hover and never clears it, which would strand the tile dimmed. Driving it
// from pointerenter/leave filtered to pointerType==="mouse" means touch gets only
// the press-pop, never a sticky hover. Press feedback is the WAAPI scale in
// onTileClick, so the press still works for both touch and mouse.
const TILE_HOVER = " opacity-90";
const TILE_DEFAULT = " bg-[#efefe6] text-[#121212] active:bg-[#e3e3d9]";
const TILE_SELECTED = " bg-[#5a594e] text-white";
// Pill buttons. Hover is opacity-only (mouse-only via <HoverButton>, since CSS
// :hover sticks after a tap on touch/hybrid Discord). :active press feedback stays
// in className since :active clears reliably on touchend.
const BTN_ICON =
  "inline-flex h-[42px] w-[42px] flex-none items-center justify-center cursor-pointer rounded-full border border-zinc-600 text-zinc-100 transition-opacity duration-150 ease-out active:scale-[0.97] disabled:opacity-40 disabled:cursor-default";
const BTN_PRIMARY =
  "inline-flex h-[42px] items-center justify-center cursor-pointer rounded-full px-5.5 border border-zinc-100 bg-zinc-100 text-zinc-900 font-semibold text-sm transition-opacity duration-150 ease-out active:scale-[0.97] disabled:opacity-40 disabled:cursor-default";

const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const GLIDE = "cubic-bezier(.22,.61,.36,1)";

export type BoardSnapshot = {
  mistakesLeft: number;
  solvedLevels: number[];
  picking: boolean;
  done: "won" | "lost" | null;
};

// Spoiler reveals persist per puzzle in localStorage, so a reveal is permanent
// for the day: once you've uncovered a category it stays uncovered across reopens
// of the Activity (the finished game rehydrates covered otherwise — see Board).
// Keyed by puzzle id, so the next day's puzzle starts covered again. Best-effort:
// any storage failure (private mode, disabled) just falls back to session-only.
const spoilerKey = (puzzleId: number): string => `conn-spoiler-${puzzleId}`;
export function readSpoilerSeen(puzzleId: number): Set<number> {
  try {
    const raw = localStorage.getItem(spoilerKey(puzzleId));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}
function writeSpoilerSeen(puzzleId: number, seen: Set<number>): void {
  try {
    localStorage.setItem(spoilerKey(puzzleId), JSON.stringify([...seen]));
  } catch {
    /* storage unavailable — reveal stays session-only */
  }
}

// A diagonal-hatch spoiler bar: its four WORDS stay readable but the CATEGORY
// NAME is redacted under the hatch, so you can still guess the connection before
// revealing it. Used for two cases: the last group solved on a win (often
// completed by elimination, so its theme may be a surprise) and every group
// auto-revealed on a loss (`dim` — those read dimmer once revealed, matching the
// loss screen's "you didn't get this" bars). Tapping wipes the hatch off to the
// right and the name fades up underneath (see .spoiler-* in index.css). The
// reveal is throttle-proof: the cover unmounts once its exit has had time to
// play, so the name can never get stranded if CSS animations are throttled
// (e.g. a hidden preview iframe). Same box/data-flip as a normal bar, so it
// still morphs into place with the FLIP at game end. `defaultRevealed` (from a
// prior session, persisted) mounts it already uncovered — no cover, no animation.
function SpoilerBar({
  level,
  category,
  members,
  dim = false,
  defaultRevealed = false,
  onReveal,
}: Group & { dim?: boolean; defaultRevealed?: boolean; onReveal?: () => void }) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const [gone, setGone] = useState(defaultRevealed);
  function reveal(): void {
    if (revealed) return;
    setRevealed(true);
    setTimeout(() => setGone(true), 460);
    onReveal?.();
  }
  return (
    <button
      type="button"
      data-flip={`bar-${level}`}
      onClick={reveal}
      aria-label={revealed ? category : "Reveal the hidden category"}
      className={
        "spoiler-bar relative flex h-[var(--tile-h)] w-full select-none appearance-none flex-col items-center justify-center overflow-hidden rounded-lg border-0 px-2 text-center text-[#121212] transition-opacity duration-300 ease-out" +
        // once revealed the bar does nothing on click — drop the pointer cursor
        // and the press feedback so it reads as the static solved bar it now is
        (revealed
          ? " revealed cursor-default"
          : " cursor-pointer active:scale-[0.99]") +
        // a revealed failed (auto-revealed) bar reads dimmer than a solved one
        (dim && revealed ? " opacity-56" : "")
      }
      style={{ background: LEVELS[level].color }}
    >
      {!gone && (
        <span className="spoiler-cover" aria-hidden>
          <span className="spoiler-glint" />
        </span>
      )}
      {/* the REAL category name, shown blurred until tapped (see .spoiler-cat) */}
      <div className={"spoiler-cat " + BAR_CAT}>{category}</div>
      <div className={"relative z-[3] " + BAR_MEMBERS}>{members.join(", ")}</div>
    </button>
  );
}

export function Board({
  game,
  onPresence,
  onCommit,
  onFinish,
  initialRevealed = [],
}: {
  game: Game;
  onPresence: (snap: BoardSnapshot) => void;
  // Commit a guess server-side before its result is revealed (returns false to
  // block the reveal on a failed commit). Absent in standalone/practice play, where
  // the game is purely in-memory. See commit-then-reveal in submit().
  onCommit?: (guess: string[]) => Promise<boolean>;
  onFinish: () => void;
  // seeds revealed-on-loss bars when rehydrating a finished game (preview harness).
  initialRevealed?: number[];
}) {
  // display model in refs; bump() re-renders after each mutation.
  const remaining = useRef<string[]>(game.board.slice());
  const selected = useRef<Set<string>>(new Set(game.selected));
  const solvedLevels = useRef<number[]>(game.solved.map((s) => s.level));
  const revealedLevels = useRef<number[]>(initialRevealed.slice());
  // spoiler categories the player has already uncovered (persisted per puzzle, so
  // a reveal stays revealed across reopens). Read once on mount.
  const spoilerSeen = useRef<Set<number> | null>(null);
  if (spoilerSeen.current === null)
    spoilerSeen.current = readSpoilerSeen(game.puzzle.id);
  // dots lag the model one beat: wrong guess plays shake-then-dim.
  const shownMistakes = useRef<number>(game.mistakesLeft);
  const ended = useRef<boolean>(game.status !== "playing");
  const busy = useRef<boolean>(false);
  // word under the mouse, for the hover dim (mouse-only — see TILE_HOVER).
  const [hover, setHover] = useState<string | null>(null);
  // Transient guess feedback ("One away…", "Guessed"): a chip that pops
  // into the footer's empty middle, between the mistake dots and the shuffle
  // button. It used to ride the Submit pill's label (and before that the header
  // meta line — easy to miss, hidden on mobile), but morphing the button made the
  // control itself shift underfoot; the chip keeps the message at the same eye
  // line without touching anything pressable. Once the game has ended the chip's
  // slot is gone, so the end footer shows the hint instead (EndSummary's note
  // face — the "couldn’t save" warning can land there). Reverts after `ms`
  // (default 1.6s). `hintN` bumps on every flash so a repeat of the same message
  // (a second "Guessed") still replays the pop.
  const [hint, setHint] = useState<string | null>(null);
  const [hintN, setHintN] = useState(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const rerender = () => bump();
  const rerenderSync = () => flushSync(() => bump());
  function flashHint(msg: string, ms = 1600): void {
    setHint(msg);
    setHintN((n) => n + 1);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), ms);
  }
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const boardRef = useRef<HTMLDivElement>(null);
  const solvedRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // The hint chip stays mounted (its text held in lastHint through the fade-out,
  // same trick as EndSummary's note face) and animates with WAAPI: a SPRING scale
  // pop on the way in — the same pop the tiles and mistake dots speak — and a
  // plain opacity fade on the way out (no translate on text, see the fades rule).
  // The chip starts at the className's opacity-0; both animations fill forwards,
  // so its resting state is always whichever ran last.
  const hintChipRef = useRef<HTMLDivElement>(null);
  const lastHint = useRef("");
  if (hint) lastHint.current = hint;
  useLayoutEffect(() => {
    const chip = hintChipRef.current;
    if (!chip) return; // end-screen footer — EndSummary's note face owns the hint
    if (hint) {
      chip.animate(
        [
          { opacity: 0, transform: "scale(.9)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 320, easing: SPRING, fill: "forwards" },
      );
    } else if (lastHint.current) {
      chip.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 240,
        easing: "ease-out",
        fill: "forwards",
      });
    }
  }, [hint, hintN]);

  function broadcast(): void {
    const real = solvedLevels.current.filter(
      (l) => !revealedLevels.current.includes(l),
    );
    onPresence({
      mistakesLeft: game.mistakesLeft,
      solvedLevels: real,
      picking: game.status === "playing" && selected.current.size > 0,
      done: game.status === "playing" ? null : game.status,
    });
  }

  function recordRects(): Map<string, DOMRect> {
    const m = new Map<string, DOMRect>();
    boardRef.current
      ?.querySelectorAll<HTMLElement>("[data-flip]")
      .forEach((e) => m.set(e.dataset.flip!, e.getBoundingClientRect()));
    return m;
  }
  function playFlip(
    prev: Map<string, DOMRect>,
    dur = 520,
    ease = GLIDE,
  ): Promise<unknown> {
    const proms: Promise<unknown>[] = [];
    boardRef.current
      ?.querySelectorAll<HTMLElement>("[data-flip]")
      .forEach((e) => {
        const b = prev.get(e.dataset.flip!);
        if (!b) return;
        const a = e.getBoundingClientRect();
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          proms.push(
            e.animate(
              [
                { transform: `translate(${dx}px,${dy}px)` },
                { transform: "translate(0,0)" },
              ],
              { duration: dur, easing: ease },
            ).finished,
          );
        }
      });
    return Promise.all(proms);
  }
  const tileByWord = (w: string): HTMLElement | null =>
    gridRef.current?.querySelector<HTMLElement>(
      `[data-flip="${CSS.escape(w)}"]`,
    ) ?? null;

  function onTileClick(e: ReactMouseEvent<HTMLButtonElement>, w: string): void {
    if (busy.current || game.status !== "playing") return;
    // press pop via WAAPI; the re-render after toggle would clobber a CSS one.
    e.currentTarget.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.9)" },
        { transform: "scale(1)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    if (selected.current.has(w)) selected.current.delete(w);
    else {
      if (selected.current.size >= 4) return;
      selected.current.add(w);
    }
    rerender();
    broadcast();
  }
  function clearSelection(): void {
    if (busy.current) return;
    selected.current.clear();
    rerender();
    broadcast();
  }

  function doShuffle(): void {
    if (busy.current || game.status !== "playing") return;
    const prev = recordRects();
    remaining.current = shuffle(remaining.current);
    rerenderSync();
    void playFlip(prev, 480);
  }

  // gather reorder: selected to top row, displaced into vacated holes.
  function reorderGather(words: string[]): void {
    const sel = new Set(words);
    const order = remaining.current.slice();
    const selPos: number[] = [];
    order.forEach((w, i) => {
      if (sel.has(w)) selPos.push(i);
    });
    const selOrdered = selPos.map((i) => order[i]);
    const displaced = [0, 1, 2, 3]
      .filter((i) => !sel.has(order[i]))
      .map((i) => order[i]);
    const holes = selPos.filter((i) => i >= 4);
    const res = order.slice();
    for (let k = 0; k < 4; k++) res[k] = selOrdered[k];
    for (let j = 0; j < displaced.length; j++) res[holes[j]] = displaced[j];
    remaining.current = res;
  }

  async function popTiles(words: string[]): Promise<void> {
    const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
    await Promise.all(
      tiles.map(
        (t, i) =>
          new Promise<void>((res) => {
            setTimeout(() => {
              t.animate(
                [
                  { transform: "scale(1)" },
                  { transform: "scale(1.14)" },
                  { transform: "scale(1)" },
                ],
                { duration: 300, easing: SPRING },
              ).finished.then(() => res());
            }, i * 110);
          }),
      ),
    );
  }

  async function animateCorrect(level: number, words: string[]): Promise<void> {
    // 1) sequential pop
    await popTiles(words);
    // 2) gather to top row
    const prev = recordRects();
    reorderGather(words);
    rerenderSync();
    await playFlip(prev, 520);
    // hold the gathered correct row so the win registers before it morphs away
    await wait(300);
    // 3) fade the top row, then morph the category bar in its place
    const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
    await Promise.all(
      tiles.map(
        (t) =>
          t.animate(
            [
              { opacity: 1, transform: "scale(1)" },
              { opacity: 0, transform: "scale(.9)" },
            ],
            {
              duration: 280,
              easing: "ease-out",
              fill: "forwards",
            },
          ).finished,
      ),
    );
    const prev2 = recordRects();
    remaining.current = remaining.current.filter((w) => !words.includes(w));
    solvedLevels.current.push(level);
    selected.current.clear();
    rerenderSync();
    const bar = solvedRef.current?.querySelector<HTMLElement>(
      `[data-flip="bar-${level}"]`,
    );
    bar?.animate(
      [
        { transform: "scale(.97)", opacity: 0.25 },
        { transform: "scale(1)", opacity: 1 },
      ],
      {
        duration: 300,
        easing: GLIDE,
      },
    );
    await playFlip(prev2, 360);
  }

  async function animateWrong(
    words: string[],
    oneAway: boolean,
  ): Promise<void> {
    const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
    // only the near-miss gets called out; a plain wrong guess just shakes.
    if (oneAway) flashHint("One away…");
    await Promise.all(
      tiles.map(
        (t) =>
          t.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(-8px)" },
              { transform: "translateX(8px)" },
              { transform: "translateX(-6px)" },
              { transform: "translateX(6px)" },
              { transform: "translateX(-3px)" },
              { transform: "translateX(0)" },
            ],
            { duration: 430, easing: "ease-in-out" },
          ).finished,
      ),
    );
    // spend the dot: dim + spring pop.
    shownMistakes.current = game.mistakesLeft;
    rerenderSync();
    const dot = tailRef.current?.querySelector<HTMLElement>(
      `[data-dot="${game.mistakesLeft}"]`,
    );
    dot?.animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], {
      duration: 300,
      easing: SPRING,
    });
  }

  async function endGame(won: boolean): Promise<void> {
    if (!won) {
      // reveal unsolved groups, gathered + dimmed, one by one
      const left = [0, 1, 2, 3].filter(
        (l) => !solvedLevels.current.includes(l),
      );
      for (const lvl of left) {
        const words = group(lvl).members.filter((w) =>
          remaining.current.includes(w),
        );
        const prev = recordRects();
        reorderGather(words);
        rerenderSync();
        await playFlip(prev, 380);
        const tiles = words.map(tileByWord).filter(Boolean) as HTMLElement[];
        await Promise.all(
          tiles.map(
            (t) =>
              t.animate([{ opacity: 1 }, { opacity: 0 }], {
                duration: 220,
                easing: "ease-in",
                fill: "forwards",
              }).finished,
          ),
        );
        const prev2 = recordRects();
        remaining.current = remaining.current.filter((w) => !words.includes(w));
        solvedLevels.current.push(lvl);
        revealedLevels.current.push(lvl);
        rerenderSync();
        const bar = solvedRef.current?.querySelector<HTMLElement>(
          `[data-flip="bar-${lvl}"]`,
        );
        // pop the bar in at full opacity — it morphs in spoiler-covered
        // (SpoilerBar), so it only dims once you tap to reveal the category.
        bar?.animate(
          [
            { transform: "scale(.97)", opacity: 0.25 },
            { transform: "scale(1)", opacity: 1 },
          ],
          {
            duration: 260,
            easing: "ease-out",
          },
        );
        await playFlip(prev2, 320);
        await wait(180);
      }
    }
    // await the webfont; the Newsreader score would reflow mid-swap otherwise.
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
    }
    // fade the controls out, swap to the end layout (leaderboard below the board),
    // then fade it in. The score hero rides up in the header row (see GameView).
    await tailRef.current!.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(8px)" },
      ],
      { duration: 220, easing: "ease-in", fill: "forwards" },
    ).finished;
    ended.current = true;
    rerenderSync();
    await tailRef.current!.animate(
      [
        { opacity: 0, transform: "translateY(12px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 380, easing: GLIDE, fill: "forwards" },
    ).finished;
  }

  async function submit(): Promise<void> {
    if (
      selected.current.size !== 4 ||
      busy.current ||
      game.status !== "playing"
    )
      return;
    busy.current = true;
    const words = [...selected.current];

    game.selected = new Set(words);
    const result = game.submit();

    // Optimistic reveal: the result is computed locally and matches the server's, so we
    // show it immediately instead of waiting on the /api/guess round-trip (which made
    // every guess feel laggy once a real network was in play). onCommit records the
    // guess in the background (keepalive + ordered queue, see commitGuess); a guess that
    // still can't be saved after retries surfaces a quiet warning — on the footer's
    // hint chip mid-game, or the end footer's note face if the game has ended by the
    // time the retries exhaust — rather than blocking play. Held longer than a guess hint: it's
    // the only signal the score may not record. Duplicates/noops aren't recorded
    // server-side, so we skip them.
    if (onCommit && result.type !== "duplicate" && result.type !== "noop") {
      void onCommit(words).then((ok) => {
        if (!ok) flashHint("Couldn’t save that guess", 4000);
      });
    }

    if (result.type === "duplicate") {
      flashHint("Guessed");
      busy.current = false;
      return;
    }
    if (result.type === "noop") {
      busy.current = false;
      return;
    }

    if (result.type === "correct" || result.type === "win") {
      await animateCorrect(game.levelOf(words[0])!, words);
    } else {
      // oneaway | incorrect | lose: all wrong guesses shake
      const levels = words.map((w) => game.levelOf(w)!);
      const counts: Record<number, number> = {};
      for (const l of levels) counts[l] = (counts[l] ?? 0) + 1;
      const oneAway = Math.max(...Object.values(counts)) === 3;
      await animateWrong(words, oneAway);
    }

    if (result.type === "win") await endGame(true);
    else if (result.type === "lose") await endGame(false);

    busy.current = false;
    broadcast();
    if (game.status !== "playing") onFinish();
  }

  const group = (lvl: number): Group =>
    game.puzzle.groups.find((g) => g.level === lvl)!;

  const showGrid = !ended.current && remaining.current.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* gap above the grid only once a solved bar exists — an empty solved
          container would otherwise reserve 8px atop the grid. Driven off
          solvedLevels (re-rendered on each solve) rather than a :has selector,
          so it holds even where :has isn't supported. */}
      <div
        className={"flex flex-col" + (solvedLevels.current.length ? " gap-2" : "")}
        ref={boardRef}
      >
        <div className="flex flex-col gap-2" ref={solvedRef}>
          {solvedLevels.current.map((lvl) => {
            const g = group(lvl);
            // Spoiler-cover the category for: (a) the final group solved on a
            // win — hidden until tapped so you can still guess it (gated on
            // length 4 so the in-flight 3-solved window during the winning
            // animation doesn't briefly cover the wrong bar), and (b) every
            // group auto-revealed on a loss, so you can guess the ones you
            // missed too. Genuinely-solved groups (other than the win's last)
            // render plainly.
            const autoRevealed = revealedLevels.current.includes(lvl);
            const winLastSolved =
              game.status === "won" &&
              solvedLevels.current.length === 4 &&
              lvl === solvedLevels.current[solvedLevels.current.length - 1];
            if (winLastSolved || autoRevealed) {
              return (
                <SpoilerBar
                  key={lvl}
                  {...g}
                  dim={autoRevealed}
                  defaultRevealed={spoilerSeen.current!.has(lvl)}
                  onReveal={() => {
                    spoilerSeen.current!.add(lvl);
                    writeSpoilerSeen(game.puzzle.id, spoilerSeen.current!);
                  }}
                />
              );
            }
            return (
              <div
                key={lvl}
                data-flip={`bar-${lvl}`}
                className="flex h-[var(--tile-h)] flex-col items-center justify-center rounded-lg px-2 text-center text-[#121212]"
                style={{ background: LEVELS[lvl].color }}
              >
                <div className={BAR_CAT}>{g.category}</div>
                <div className={BAR_MEMBERS}>{g.members.join(", ")}</div>
              </div>
            );
          })}
        </div>
        {showGrid && (
          <div className="grid grid-cols-4 gap-2" ref={gridRef}>
            {remaining.current.map((w) => {
              const sel = selected.current.has(w);
              const lifted = hover === w;
              const palette = sel ? TILE_SELECTED : TILE_DEFAULT;
              return (
                <button
                  key={w}
                  data-flip={w}
                  className={TILE + palette + (lifted ? TILE_HOVER : "")}
                  onClick={(e) => onTileClick(e, w)}
                  // mouse-only so a touch tap never strands the tile dimmed
                  onPointerEnter={(e) => {
                    if (e.pointerType === "mouse") setHover(w);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse")
                      setHover((h) => (h === w ? null : h));
                  }}
                >
                  <FitText text={w} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Gate purely on ended.current, NOT game.status: the winning guess flips
          status to "won" before the board's end choreography runs, so keying off
          status would swap the score footer in mid-morph — then endGame's
          fade-out/fade-in would re-introduce it, a visible double-appearance.
          ended.current only flips inside endGame, after the controls fade out, so
          the footer makes exactly one entrance. (Rehydrated finished games seed
          ended.current = true, so they render the footer immediately, no fade.) */}
      <div ref={tailRef}>
        {ended.current ? renderBelowEnd() : renderControls()}
      </div>
    </div>
  );

  // Playing footer — one compact row: mistakes dots pinned left, controls right.
  // Shuffle/Deselect collapse to icons; their labels stay in the DOM (sr-only) so
  // accessible names and the preview driver's text lookup still resolve.
  // The flex-1 middle is the hint chip's stage: guess feedback pops in centered
  // in the dead space between the dots and the shuffle button. The chip is
  // absolute (centered by the flex container's alignment, so WAAPI owns its
  // transform) and nowrap — on the narrowest layouts a long message overhangs
  // the dots rather than wrapping or squeezing the controls; it's opaque,
  // shadowed, and z-raised, so it reads fine for the beat it's on stage.
  // It's pointer-events-none and visually tile-material (the board's cream, not
  // the Submit pill's white) so it never reads as another button. The sr-only
  // twin carries the announcement: the visible chip holds its last text through
  // the fade-out, so its content alone wouldn't re-announce a repeated message.
  function renderControls() {
    return (
      <div className="flex items-center gap-3">
        <span
          className="inline-flex flex-none items-center gap-1.75"
          aria-label="Mistakes remaining"
          title="Mistakes remaining"
        >
          {Array.from({ length: MAX_MISTAKES }, (_, i) => (
            <span
              key={i}
              data-dot={i}
              className={
                "inline-block h-3.5 w-3.5 rounded-full " +
                (i < shownMistakes.current ? "bg-zinc-300" : "bg-zinc-700")
              }
            />
          ))}
        </span>
        <div className="relative flex min-w-0 flex-1 items-center justify-center self-stretch">
          <div
            ref={hintChipRef}
            aria-hidden
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-full bg-[#efefe6] px-3.5 py-2 text-[11px] font-bold uppercase leading-none tracking-[0.08em] text-[#121212] opacity-0 shadow-[0_3px_12px_rgba(0,0,0,0.45)] max-[420px]:px-3 max-[420px]:text-[10px] max-[420px]:tracking-[0.04em]"
          >
            {hint ?? lastHint.current}
          </div>
          <span className="sr-only" role="status">
            {hint}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <HoverButton
            className={BTN_ICON}
            hover="opacity-80"
            onClick={doShuffle}
            aria-label="Shuffle"
            title="Shuffle"
          >
            <ShuffleIcon size={18} strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Shuffle</span>
          </HoverButton>
          <HoverButton
            className={BTN_ICON}
            hover="opacity-80"
            onClick={clearSelection}
            disabled={selected.current.size === 0}
            aria-label="Deselect all"
            title="Deselect all"
          >
            <Eraser size={18} strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Deselect all</span>
          </HoverButton>
          <HoverButton
            className={BTN_PRIMARY}
            hover="opacity-85"
            onClick={() => void submit()}
            disabled={selected.current.size !== 4}
            title="Submit"
          >
            Submit
          </HoverButton>
        </div>
      </div>
    );
  }

  // End-screen footer — replaces the controls at the same footprint with the run
  // summary, which cross-fades in place to the itemized score breakdown on inspect
  // (hover/tap). The live hint flows in as the note face so a "couldn’t save"
  // warning arriving after the end swap still surfaces. See EndSummary.
  function renderBelowEnd() {
    return <EndSummary game={game} note={hint} />;
  }
}
