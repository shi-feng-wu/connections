import { Eraser, EyeOff, Navigation, Shuffle as ShuffleIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { ResetCountdown } from "./countdown";
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

const TILE =
  "relative h-[var(--tile-h)] min-w-0 rounded-lg font-extrabold uppercase tracking-[0.01em] leading-none px-1.5 flex items-center justify-center cursor-pointer select-none transition duration-150 ease-out";
// Ideal/ceiling word size (responsive); FitText only shrinks below this to fit.
const TILE_TEXT = "block w-full text-center text-[clamp(9px,3vw,17px)]";

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
const BTN_ICON_PRIMARY =
  "inline-flex h-[42px] w-[42px] flex-none items-center justify-center cursor-pointer rounded-full border border-zinc-100 bg-zinc-100 text-zinc-900 transition-opacity duration-150 ease-out active:scale-[0.97]";

const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const GLIDE = "cubic-bezier(.22,.61,.36,1)";

export type BoardSnapshot = {
  mistakesLeft: number;
  solvedLevels: number[];
  picking: boolean;
  done: "won" | "lost" | null;
};

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
// still morphs into place with the FLIP at game end.
function SpoilerBar({
  level,
  category,
  members,
  dim = false,
}: Group & { dim?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [gone, setGone] = useState(false);
  function reveal(): void {
    if (revealed) return;
    setRevealed(true);
    setTimeout(() => setGone(true), 460);
  }
  return (
    <button
      type="button"
      data-flip={`bar-${level}`}
      onClick={reveal}
      aria-label={revealed ? category : "Reveal the hidden category"}
      className={
        "spoiler-bar relative flex h-[var(--tile-h)] w-full cursor-pointer select-none appearance-none flex-col items-center justify-center overflow-hidden rounded-lg border-0 px-2 text-center text-[#121212] transition-opacity duration-300 ease-out active:scale-[0.99]" +
        (revealed ? " revealed" : "") +
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
      <div className="relative flex min-h-4 items-center justify-center">
        <div className="spoiler-cat font-extrabold uppercase tracking-tight text-[clamp(12px,3.4vw,18px)] leading-tight">
          {category}
        </div>
        {!gone && (
          <span className="spoiler-label">
            <EyeOff size={13} strokeWidth={2.25} aria-hidden />
            <span>Tap to reveal</span>
          </span>
        )}
      </div>
      <div className="relative z-[3] uppercase text-[clamp(10px,3vw,16px)] leading-tight">
        {members.join(", ")}
      </div>
    </button>
  );
}

export function Board({
  game,
  onPresence,
  onCommit,
  onFinish,
  onFeedback,
  onJumpToSelf,
  canJump,
  initialRevealed = [],
}: {
  game: Game;
  onPresence: (snap: BoardSnapshot) => void;
  // Commit a guess server-side before its result is revealed (returns false to
  // block the reveal on a failed commit). Absent in standalone/practice play, where
  // the game is purely in-memory. See commit-then-reveal in submit().
  onCommit?: (guess: string[]) => Promise<boolean>;
  onFinish: () => void;
  // transient submission feedback for the header date slot — now only the rare
  // "couldn’t save that guess" note when a background commit fails after retries
  // (guess results show on the Submit pill instead).
  onFeedback: (msg: string) => void;
  // jump the roster list to your row and pulse it (end-screen locate arrow).
  onJumpToSelf: () => void;
  // whether you have a row in the roster — gates the locate arrow.
  canJump: boolean;
  // seeds revealed-on-loss bars when rehydrating a finished game (preview harness).
  initialRevealed?: number[];
}) {
  // display model in refs; bump() re-renders after each mutation.
  const remaining = useRef<string[]>(game.board.slice());
  const selected = useRef<Set<string>>(new Set(game.selected));
  const solvedLevels = useRef<number[]>(game.solved.map((s) => s.level));
  const revealedLevels = useRef<number[]>(initialRevealed.slice());
  // dots lag the model one beat: wrong guess plays shake-then-dim.
  const shownMistakes = useRef<number>(game.mistakesLeft);
  const ended = useRef<boolean>(game.status !== "playing");
  const busy = useRef<boolean>(false);
  // word under the mouse, for the hover dim (mouse-only — see TILE_HOVER).
  const [hover, setHover] = useState<string | null>(null);
  // Transient label on the Submit pill ("One away…", "Already guessed"). This guess
  // feedback used to live in the header meta line (top-right, 12px — easy to miss);
  // the Submit button is where you're already looking, so it owns the message now and
  // carries aria-live for the announcement. Reverts after 1.6s.
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const rerender = () => bump();
  const rerenderSync = () => flushSync(() => bump());
  function flashHint(msg: string): void {
    setHint(msg);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 1600);
  }
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const boardRef = useRef<HTMLDivElement>(null);
  const solvedRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // Morph the Submit pill's width when its label swaps (Submit <-> a hint) instead of
  // letting it snap: measure the rendered width before and after the swap — the same
  // FLIP-by-measurement the board tiles use — then tween between them while the new
  // word rises in just behind the reshape. The pill is clipped + nowrap (see its
  // className) so the longer text can't reflow to a second line mid-morph.
  const submitW = useRef<number | null>(null);
  const submitWAnim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const label = tailRef.current?.querySelector<HTMLElement>("[data-submit-label]");
    const btn = label?.parentElement ?? null;
    if (!btn || !label) {
      submitW.current = null; // end-screen footer has no Submit — reset for next game
      return;
    }
    submitWAnim.current?.cancel(); // drop to natural width before measuring
    const next = btn.getBoundingClientRect().width;
    const prev = submitW.current;
    submitW.current = next;
    if (prev == null || Math.abs(prev - next) < 0.5) return; // first paint / unchanged
    submitWAnim.current = btn.animate(
      [{ width: `${prev}px` }, { width: `${next}px` }],
      { duration: 340, easing: GLIDE },
    );
    label.animate(
      [
        { opacity: 0, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 260, easing: GLIDE, delay: 50, fill: "backwards" },
    );
  }, [hint]);

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
    // still can't be saved after retries surfaces a quiet header note rather than
    // blocking play. Duplicates/noops aren't recorded server-side, so we skip them.
    if (onCommit && result.type !== "duplicate" && result.type !== "noop") {
      void onCommit(words).then((ok) => {
        if (!ok) onFeedback("Couldn’t save that guess");
      });
    }

    if (result.type === "duplicate") {
      flashHint("Already guessed");
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

  const playing = game.status === "playing";
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
              return <SpoilerBar key={lvl} {...g} dim={autoRevealed} />;
            }
            return (
              <div
                key={lvl}
                data-flip={`bar-${lvl}`}
                className="flex h-[var(--tile-h)] flex-col items-center justify-center rounded-lg px-2 text-center text-[#121212]"
                style={{ background: LEVELS[lvl].color }}
              >
                <div className="font-extrabold uppercase tracking-tight text-[clamp(12px,3.4vw,18px)] leading-tight">
                  {g.category}
                </div>
                <div className="uppercase text-[clamp(10px,3vw,16px)] leading-tight">
                  {g.members.join(", ")}
                </div>
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

      <div ref={tailRef}>
        {playing && !ended.current ? renderControls() : renderBelowEnd()}
      </div>
    </div>
  );

  // Playing footer — one compact row: mistakes dots pinned left, controls right.
  // Shuffle/Deselect collapse to icons; their labels stay in the DOM (sr-only) so
  // accessible names and the preview driver's text lookup still resolve.
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
        <div className="ml-auto flex items-center gap-2">
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
            className={BTN_PRIMARY + " overflow-hidden whitespace-nowrap"}
            hover="opacity-85"
            onClick={() => void submit()}
            disabled={selected.current.size !== 4 && !hint}
            aria-label={hint ?? "Submit"}
            aria-live="polite"
            title={hint ?? "Submit"}
          >
            <span data-submit-label className="inline-block">
              {hint ?? "Submit"}
            </span>
          </HoverButton>
        </div>
      </div>
    );
  }

  // End-screen footer — replaces the controls with the score summary at the same
  // footprint: mistakes dots pinned left (same spot as in play), the solve time and
  // groups centered, and the score (right-aligned, serif) with an optional locate
  // arrow that scrolls the roster to your row and pulses it.
  function renderBelowEnd() {
    const won = game.status === "won";
    const perfect = won && game.mistakesLeft === MAX_MISTAKES;
    const label = perfect ? "Perfect" : won ? "Solved" : "Out of guesses";
    return (
      <div className="flex items-center gap-3 max-[360px]:gap-2">
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
        <div className="flex flex-1 flex-col items-center justify-center gap-0.5">
          <div className="flex items-center gap-1.75 text-[13px] tabular-nums text-zinc-400">
            <span>{fmtClock(game.durationMs)}</span>
            <span className="text-zinc-700">·</span>
            <span>{game.groupsSolved}/4</span>
          </div>
          <ResetCountdown className="text-[11px] tabular-nums text-zinc-500" />
        </div>
        <div className="flex flex-none items-center gap-3.5 max-[360px]:gap-2.5">
          <div className="flex min-w-0 flex-col items-end gap-0.75">
            {/* At the narrow-Android floor (<=360px) the longest label, "Out of
                guesses", would push the score + jump button off the right edge. Cap
                it so it wraps to two right-aligned lines there; "Solved"/"Perfect"
                are short enough to never reach the cap, so they stay one line. */}
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
          {canJump && (
            <HoverButton
              className={BTN_ICON_PRIMARY}
              hover="opacity-85"
              onClick={onJumpToSelf}
              aria-label="Jump to your row"
              title="Jump to your row"
            >
              <Navigation
                size={16}
                strokeWidth={2}
                fill="currentColor"
                className="-translate-x-px"
                aria-hidden
              />
            </HoverButton>
          )}
        </div>
      </div>
    );
  }
}
