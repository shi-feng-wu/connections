import { LEVELS, MAX_MISTAKES, type Game } from "./game";
import logoUrl from "./assets/connections-logo.webp";

// Compact board shown when the activity is collapsed to Discord's picture-in-picture
// layout (ACTIVITY_LAYOUT_MODE_UPDATE → PIP). A left-rail design: the chrome lives in a
// left rail — logo, serif "Connections" wordmark, a "No. 642 · June 2" serif meta line,
// and (pinned to the bottom) the "Mistakes remaining" dots + "Groups found" track — and
// the board fills the full height on the right as a square mini of the desktop board (a
// colored bar per solved category, cream tiles for the words still in play, selected
// ones charcoal). Using the horizontal space keeps the tiles large and legible when the
// window is minimized. Mirrors the "Connections Thumbnail" design (1280×800 artboard).
//
// Sizing: the frame is a `size` container, so the artboard sizes against BOTH axes
// (min of a width-driven and a height-driven value) and letterboxes to fit any PIP
// aspect ratio while holding the design's 16:10 proportions. The artboard is itself an
// `inline-size` container, so every child scales in cqw (1% of the artboard width) —
// 1cqw == 12.8px in the design's 1280px-wide reference, so a design px is `px / 12.8`
// cqw. Works full-bleed in the app (the frame fills the fixed inset-0 wrapper) and
// inside the preview harness's sized box alike.
export function PipThumbnail({
  game,
  // Levels surfaced by a loss back-fill (not deduced) — dimmed like the live board.
  revealed = [],
}: {
  game: Game | null;
  revealed?: number[];
}) {
  const revealedSet = new Set(revealed);

  const frame =
    "flex h-full w-full items-center justify-center overflow-hidden bg-black";
  const frameStyle = { containerType: "size" } as const;

  // Branded placeholder until the puzzle loads (or if collapsed mid-load).
  if (!game) {
    return (
      <div className={frame} style={frameStyle}>
        <div className="font-display text-[7cqw] font-bold tracking-tight text-[#efefe6]">
          Connections
        </div>
      </div>
    );
  }

  const dateLabel = new Date(`${game.puzzle.date}T00:00:00`).toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric" },
  );

  const remaining = game.board; // words still in play → cream tiles
  const rows: string[][] = [];
  for (let i = 0; i < remaining.length; i += 4) rows.push(remaining.slice(i, i + 4));

  return (
    <div className={frame} style={frameStyle}>
      {/* 1280×800 artboard, letterboxed to fit any PIP aspect; children scale in cqw
          (1cqw == 12.8px in the design). rail on the left, board on the right. */}
      <div
        className="flex flex-row items-stretch gap-[4.375cqw] overflow-hidden p-[4.6875cqw_5cqw] font-sans"
        style={{
          containerType: "inline-size",
          width: "min(100cqw, 160cqh)",
          aspectRatio: "1280 / 800",
        }}
      >
        {/* left rail: identity up top, status pinned to the bottom */}
        <div className="flex min-w-0 flex-1 flex-col justify-between py-[0.46875cqw]">
          <div className="flex flex-col gap-[2.03125cqw]">
            <img
              src={logoUrl}
              alt=""
              className="block h-[5.78125cqw] w-[5.78125cqw] rounded-[1.40625cqw]"
            />
            <div className="flex flex-col items-start gap-[1.40625cqw]">
              <h1 className="m-0 font-display text-[4.375cqw] font-bold leading-[0.92] tracking-[-0.025em] text-[#efefe6]">
                Connections
              </h1>
              {/* one consistent serif meta line: No. 642 · June 2 */}
              <div className="flex items-baseline gap-[0.9375cqw]">
                <span className="whitespace-nowrap font-display text-[1.875cqw] font-normal leading-none tabular-nums text-zinc-500">
                  No. {game.puzzle.id}
                </span>
                <span className="font-display text-[1.5625cqw] leading-none text-zinc-700">·</span>
                <span className="whitespace-nowrap font-display text-[1.875cqw] font-normal leading-none tabular-nums text-zinc-500">
                  {dateLabel}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-[2.65625cqw]">
            {/* mistakes remaining */}
            <div>
              <p className="m-0 mb-[1.25cqw] font-sans text-[1.328125cqw] font-semibold uppercase leading-none tracking-[0.04em] text-zinc-500">
                Mistakes remaining
              </p>
              <div className="flex gap-[1.09375cqw]">
                {Array.from({ length: MAX_MISTAKES }, (_, i) => (
                  <span
                    key={i}
                    className={
                      "block h-[1.71875cqw] w-[1.71875cqw] rounded-full " +
                      (i < game.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
                    }
                  />
                ))}
              </div>
            </div>
            {/* groups found: a colored segment per solved group (in solve order) + count */}
            <div>
              <p className="m-0 mb-[1.25cqw] font-sans text-[1.328125cqw] font-semibold uppercase leading-none tracking-[0.04em] text-zinc-500">
                Groups found
              </p>
              <div className="flex items-center gap-[1.25cqw]">
                <div className="flex gap-[0.703125cqw]">
                  {Array.from({ length: 4 }, (_, i) => {
                    const g = game.solved[i];
                    const dim = g ? revealedSet.has(g.level) : false;
                    return (
                      <span
                        key={i}
                        className={
                          "block h-[1.015625cqw] w-[3.4375cqw] rounded-full" + (dim ? " opacity-56" : "")
                        }
                        style={{ background: g ? LEVELS[g.level].color : "#3f3f46" }}
                      />
                    );
                  })}
                </div>
                <span className="whitespace-nowrap font-sans text-[1.71875cqw] font-bold tabular-nums text-zinc-300">
                  {game.solved.length} / 4
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* right board: a square mini of the desktop board — a colored bar per solved
            group (in solve order), then rows of the remaining tiles. The fixed 12.5cqw
            bar height ≈ the aspect-square tile height, so the board stays square across
            solve states and fills the 680px-wide column. */}
        <div className="flex w-[53.125cqw] flex-none flex-col gap-[1.09375cqw] self-center">
          {game.solved.map((g) => (
            <div
              key={`bar-${g.level}`}
              className={
                "flex h-[12.5cqw] flex-col items-center justify-center gap-[0.703125cqw] overflow-hidden rounded-[1.09375cqw] px-[1.09375cqw] text-center" +
                (revealedSet.has(g.level) ? " opacity-56" : "")
              }
              style={{ background: LEVELS[g.level].color }}
            >
              <span className="block max-w-full truncate font-sans text-[2.34375cqw] font-extrabold uppercase leading-[1.05] tracking-[-0.01em] text-[#121212]">
                {g.category}
              </span>
              <span className="block max-w-full truncate font-sans text-[1.5625cqw] font-normal uppercase leading-[1.15] text-[#121212]">
                {g.members.join(", ")}
              </span>
            </div>
          ))}
          {rows.map((row, r) => (
            <div key={`row-${r}`} className="grid grid-cols-4 gap-[1.09375cqw]">
              {row.map((w) => (
                <div
                  key={w}
                  className={
                    "flex aspect-square items-center justify-center overflow-hidden rounded-[1.09375cqw] px-[0.3125cqw] text-center font-sans text-[1.953125cqw] font-extrabold uppercase tracking-[0.01em] " +
                    (game.selected.has(w)
                      ? "bg-[#5a594e] text-white"
                      : "bg-[#efefe6] text-[#121212]")
                  }
                >
                  <span className="block max-w-full truncate leading-none">{w}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
