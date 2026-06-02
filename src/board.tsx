import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { Game, LEVELS, MAX_MISTAKES, shuffle, type Group } from "./game";
import { HoverButton } from "./hoverbutton";
import { Leaderboard, type Standings } from "./season";

// Playable board + solve animations (correct: pop, FLIP gather, morph to bar;
// wrong: shake, spend a dot; end: fade controls, reveal missed groups on loss).
// Keeps a parallel display model because Game resolves a guess atomically but
// the FLIP sequence needs the intermediate states.

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Time until next daily puzzle (local midnight), HH:MM:SS.
function nextMidnight(): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const s = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

// End-screen footer countdown; the daily doesn't replay.
function Countdown() {
  const [t, setT] = useState(nextMidnight);
  useEffect(() => {
    const id = setInterval(() => setT(nextMidnight()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-[27px] font-bold leading-none tracking-[0.03em] tabular-nums text-zinc-200">
      {t}
    </div>
  );
}

const TILE =
  "relative h-20 min-w-0 break-words rounded-lg font-extrabold uppercase tracking-[0.01em] text-[clamp(9px,3vw,17px)] leading-none px-1 text-center flex items-center justify-center cursor-pointer select-none transition duration-150 ease-out";
// Hover lift rides on JS pointer events (mouse-only), NOT CSS :hover — a tap on a
// touch/hybrid device sets :hover and never clears it, which would strand the tile
// lifted. Driving it from pointerenter/leave filtered to pointerType==="mouse"
// means touch gets only the press-pop, never a sticky lift. Press feedback is the
// WAAPI scale in onTileClick, so the press still works for both touch and mouse.
const TILE_LIFT = " z-10 -translate-y-[1px] scale-[1.03]";
// palette is [selected][hovered]; exactly one bg utility applies per state so no
// two background utilities ever collide.
const TILE_DEFAULT = " bg-[#efefe6] text-[#121212] active:bg-[#e3e3d9]";
const TILE_DEFAULT_HOVER = " bg-[#f5f5ee] text-[#121212] active:bg-[#e3e3d9]";
const TILE_SELECTED = " bg-[#5a594e] text-white";
const TILE_SELECTED_HOVER = " bg-[#66645a] text-white";
// cursor-pointer (default cursor when disabled). The hover lift/scale is the
// *_HOVER fragment, applied mouse-only via <HoverButton> — CSS :hover sticks after
// a tap on touch/hybrid (Discord Activity). :active press feedback stays here since
// :active clears reliably on touchend. (Same reasoning as TILE_LIFT above.)
const BTN =
  "cursor-pointer rounded-full px-5 py-2.5 border border-zinc-600 text-zinc-100 font-semibold text-sm transition duration-150 ease-out active:translate-y-0 active:scale-100 active:bg-zinc-800 disabled:opacity-40 disabled:cursor-default";
const BTN_HOVER = "bg-zinc-800 -translate-y-[1px] scale-[1.02]";
const BTN_PRIMARY =
  "cursor-pointer rounded-full px-5 py-2.5 border border-zinc-100 bg-zinc-100 text-zinc-900 font-semibold text-sm transition duration-150 ease-out active:translate-y-0 active:scale-100 active:bg-zinc-200 disabled:opacity-40 disabled:cursor-default";
const BTN_PRIMARY_HOVER =
  "-translate-y-[1px] scale-[1.02] shadow-[0_6px_18px_-8px_rgba(244,244,245,0.55)]";

const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const GLIDE = "cubic-bezier(.22,.61,.36,1)";

export type BoardSnapshot = {
  mistakesLeft: number;
  solvedLevels: number[];
  picking: boolean;
  done: "won" | "lost" | null;
};

export function Board({
  game,
  onPresence,
  onFinish,
  onFeedback,
  season,
  allTime,
  selfId,
  selfName,
  selfAvatar,
  initialRevealed = [],
}: {
  game: Game;
  onPresence: (snap: BoardSnapshot) => void;
  onFinish: () => void;
  // transient guess feedback ("One away…", "Already guessed"), surfaced as text
  // in the header score slot.
  onFeedback: (msg: string) => void;
  // end-screen leaderboard; empty in standalone play or before today's score posts.
  season: Standings;
  allTime: Standings;
  selfId: string;
  selfName: string;
  selfAvatar?: string;
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
  // word under the mouse, for the hover lift (mouse-only — see TILE_LIFT).
  const [hover, setHover] = useState<string | null>(null);

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const rerender = () => bump();
  const rerenderSync = () => flushSync(() => bump());

  const boardRef = useRef<HTMLDivElement>(null);
  const solvedRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  function broadcast(): void {
    const real = solvedLevels.current.filter(
      (l) => !revealedLevels.current.includes(l),
    );
    onPresence({
      mistakesLeft: game.mistakesLeft,
      solvedLevels: [...real].sort((a, b) => a - b),
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
            }, i * 85);
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
    await wait(80);
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
              duration: 190,
              easing: "ease-in",
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
    if (oneAway) onFeedback("One away…");
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
                duration: 150,
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
        bar?.animate(
          [
            { transform: "scale(.97)", opacity: 0.1 },
            { transform: "scale(1)", opacity: 0.56 },
          ],
          {
            duration: 260,
            easing: "ease-out",
          },
        );
        await playFlip(prev2, 320);
        await wait(90);
      }
    }
    // await the webfont; the Fraunces headline would reflow mid-swap otherwise.
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

    if (result.type === "duplicate") {
      onFeedback("Already guessed");
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2" ref={boardRef}>
        <div className="flex flex-col gap-2" ref={solvedRef}>
          {solvedLevels.current.map((lvl) => {
            const g = group(lvl);
            const revealed = revealedLevels.current.includes(lvl);
            return (
              <div
                key={lvl}
                data-flip={`bar-${lvl}`}
                className={
                  "flex h-20 flex-col items-center justify-center rounded-lg px-2 text-center text-[#121212]" +
                  // loss-revealed bar reads dimmer than a solved one.
                  (revealed ? " opacity-56" : "")
                }
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
              const palette = sel
                ? lifted
                  ? TILE_SELECTED_HOVER
                  : TILE_SELECTED
                : lifted
                  ? TILE_DEFAULT_HOVER
                  : TILE_DEFAULT;
              return (
                <button
                  key={w}
                  data-flip={w}
                  className={TILE + palette + (lifted ? TILE_LIFT : "")}
                  onClick={(e) => onTileClick(e, w)}
                  // mouse-only so a touch tap never strands the tile lifted
                  onPointerEnter={(e) => {
                    if (e.pointerType === "mouse") setHover(w);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse")
                      setHover((h) => (h === w ? null : h));
                  }}
                >
                  {w}
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

  function renderControls() {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-center gap-2 text-sm text-zinc-400">
          Mistakes remaining:
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
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <HoverButton className={BTN} hover={BTN_HOVER} onClick={doShuffle}>
            Shuffle
          </HoverButton>
          <HoverButton
            className={BTN}
            hover={BTN_HOVER}
            onClick={clearSelection}
            disabled={selected.current.size === 0}
          >
            Deselect all
          </HoverButton>
          <HoverButton
            className={BTN_PRIMARY}
            hover={BTN_PRIMARY_HOVER}
            onClick={() => void submit()}
            disabled={selected.current.size !== 4}
          >
            Submit
          </HoverButton>
        </div>
      </div>
    );
  }

  // Room standing + next-puzzle countdown, shown below the puzzle on the end screen.
  function renderBelowEnd() {
    // leaderboard only when the room has scored rows.
    const hasBoard = season.board.length > 0 || allTime.board.length > 0;

    return (
      <div className="flex flex-col gap-5.5">
        {hasBoard && (
          <Leaderboard
            season={season}
            allTime={allTime}
            selfId={selfId}
            name={selfName}
            avatar={selfAvatar}
          />
        )}

        {/* daily doesn't replay; count down to the next. */}
        <div className="flex flex-col items-center gap-2 border-t border-white/6 pt-5">
          <div className="text-[10px] uppercase tracking-[0.15em] whitespace-nowrap text-zinc-500">
            Next puzzle in
          </div>
          <Countdown />
        </div>
      </div>
    );
  }
}
