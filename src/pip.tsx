import { LEVELS, MAX_MISTAKES, type Game } from "./game";
import logoUrl from "./assets/connections-logo.webp";

// Compact board shown when the activity is collapsed to Discord's picture-in-picture
// layout (ACTIVITY_LAYOUT_MODE_UPDATE → PIP). A faithful mini of the desktop board: a
// centered square board column (a colored bar per solved category, cream tiles for the
// words still in play — selected ones charcoal — always four equal rows), under a
// branded header (logo · wordmark · "No." pill · date) and over a mistakes/progress
// footer. Centered in the dark frame rather than stretched edge-to-edge, matching the
// app's narrow-column feel. Mirrors the "Connections Thumbnail v2" design.
//
// Sizing: the frame is a `size` container, so the column sizes against BOTH axes
// (min of a width-driven and a height-driven value) to keep the design's proportions
// and fit any PIP aspect ratio; the column is itself an `inline-size` container, so
// every child scales in cqw (1% of the column width) — the same scale the design uses
// at its 624px reference width. Works full-bleed in the app (the frame fills the fixed
// inset-0 wrapper) and inside the preview harness's sized box alike.
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
      {/* centered board column — design's 624px column in a 1280×800 frame */}
      <div
        className="flex flex-col gap-[3.205cqw]"
        style={{ containerType: "inline-size", width: "min(48.75cqw, 78cqh)" }}
      >
        {/* header: logo · wordmark · No. pill · date */}
        <div className="flex items-center gap-[2.564cqw]">
          <img
            src={logoUrl}
            alt=""
            className="block h-[7.372cqw] w-[7.372cqw] flex-none rounded-[1.923cqw]"
          />
          <h1 className="m-0 font-display text-[6.09cqw] font-bold leading-none tracking-[-0.025em] text-[#efefe6]">
            Connections
          </h1>
          <span
            className="flex-none whitespace-nowrap rounded-full px-[2.244cqw] py-[1.122cqw] font-sans text-[2.404cqw] font-bold uppercase leading-none tracking-[0.06em] tabular-nums text-zinc-400"
            style={{ border: "1px solid rgba(255,255,255,0.14)" }}
          >
            No. {game.puzzle.id}
          </span>
          <span className="ml-auto whitespace-nowrap font-display text-[3.365cqw] font-normal leading-none text-zinc-500">
            {dateLabel}
          </span>
        </div>

        {/* square board: four equal rows — a bar per solved group (in solve order),
            then rows of the remaining tiles. height = column width → square. */}
        <div className="flex w-full flex-col gap-[1.923cqw]" style={{ height: "100cqw" }}>
          {game.solved.map((g) => (
            <div
              key={`bar-${g.level}`}
              className={
                "flex min-h-0 flex-1 flex-col items-center justify-center gap-[1.282cqw] overflow-hidden rounded-[1.923cqw] px-[1.923cqw] text-center" +
                (revealedSet.has(g.level) ? " opacity-56" : "")
              }
              style={{ background: LEVELS[g.level].color }}
            >
              <span className="block max-w-full truncate font-sans text-[4.327cqw] font-extrabold uppercase leading-[1.05] tracking-[-0.01em] text-[#121212]">
                {g.category}
              </span>
              <span className="block max-w-full truncate font-sans text-[2.885cqw] font-normal uppercase leading-[1.15] text-[#121212]">
                {g.members.join(", ")}
              </span>
            </div>
          ))}
          {rows.map((row, r) => (
            <div key={`row-${r}`} className="grid min-h-0 flex-1 grid-cols-4 gap-[1.923cqw]">
              {row.map((w) => (
                <div
                  key={w}
                  className={
                    "flex items-center justify-center overflow-hidden rounded-[1.923cqw] px-[0.641cqw] text-center font-sans text-[3.686cqw] font-extrabold uppercase tracking-[0.01em] " +
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

        {/* footer: mistakes remaining · progress segments + count */}
        <div className="flex items-center gap-[2.564cqw]">
          <span className="whitespace-nowrap font-sans text-[3.045cqw] font-semibold text-zinc-400">
            Mistakes remaining
          </span>
          <div className="flex gap-[1.763cqw]">
            {Array.from({ length: MAX_MISTAKES }, (_, i) => (
              <span
                key={i}
                className={
                  "block h-[3.045cqw] w-[3.045cqw] rounded-full " +
                  (i < game.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
                }
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-[2.083cqw] whitespace-nowrap">
            <div className="flex gap-[1.282cqw]">
              {Array.from({ length: 4 }, (_, i) => {
                const g = game.solved[i];
                const dim = g ? revealedSet.has(g.level) : false;
                return (
                  <span
                    key={i}
                    className={
                      "block h-[1.763cqw] w-[5.449cqw] rounded-full" + (dim ? " opacity-56" : "")
                    }
                    style={{ background: g ? LEVELS[g.level].color : "#3f3f46" }}
                  />
                );
              })}
            </div>
            <span className="whitespace-nowrap font-sans text-[3.205cqw] font-bold tabular-nums text-zinc-300">
              {game.solved.length} / 4
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
