import { LEVELS, MAX_MISTAKES, type Game } from "./game";

// Compact board shown when the activity is collapsed to Discord's picture-in-picture
// layout (ACTIVITY_LAYOUT_MODE_UPDATE → PIP). Mirrors the live board in miniature: a
// colored bar per solved category and cream tiles for the words still in play, always
// four equal rows total, sized to fill the small PIP viewport. Fills its parent (App
// mounts it under a fixed inset-0 wrapper), so it adapts to whatever size Discord gives.
export function PipThumbnail({
  game,
  // Levels surfaced by a loss back-fill (not deduced) — dimmed like the live board.
  revealed = [],
}: {
  game: Game | null;
  revealed?: number[];
}) {
  const revealedSet = new Set(revealed);
  // Branded placeholder until the puzzle loads (or if collapsed mid-load).
  if (!game) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-[4%]">
        <div className="font-display text-[clamp(13px,7vw,30px)] font-bold tracking-tight text-[#efefe6]">
          Connections
        </div>
      </div>
    );
  }

  const remaining = game.board; // words still in play → cream tiles
  const rows: string[][] = [];
  for (let i = 0; i < remaining.length; i += 4) rows.push(remaining.slice(i, i + 4));

  return (
    <div className="flex h-full w-full flex-col gap-[2.5%] bg-black p-[4%]">
      <div className="font-display text-[clamp(9px,4.5vw,20px)] font-bold leading-none tracking-tight text-[#efefe6]">
        Connections
      </div>

      {/* Four equal rows: a bar per solved group (in solve order), then rows of the
          remaining tiles. flex-1 + min-h-0 splits the height evenly at any PIP size. */}
      <div className="flex min-h-0 flex-1 flex-col gap-[2.5%]">
        {game.solved.map((g) => (
          <div
            key={`bar-${g.level}`}
            className={
              "flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md px-1.5 text-center" +
              (revealedSet.has(g.level) ? " opacity-56" : "")
            }
            style={{ background: LEVELS[g.level].color }}
          >
            <span className="truncate text-[clamp(6px,2.7vw,14px)] font-extrabold uppercase leading-none tracking-tight text-[#121212]">
              {g.category}
            </span>
          </div>
        ))}
        {rows.map((row, r) => (
          <div key={`row-${r}`} className="grid min-h-0 flex-1 grid-cols-4 gap-[2.5%]">
            {row.map((w) => (
              <div
                key={w}
                className="flex items-center justify-center overflow-hidden rounded-md bg-[#efefe6] px-0.5 text-center"
              >
                <span className="truncate text-[clamp(5px,2vw,11px)] font-extrabold uppercase leading-none text-[#121212]">
                  {w}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {game.status === "playing" && (
        <div className="flex items-center justify-center gap-[1.5%]">
          {Array.from({ length: MAX_MISTAKES }, (_, i) => (
            <span
              key={i}
              className={
                "h-[clamp(4px,1.5vw,8px)] w-[clamp(4px,1.5vw,8px)] rounded-full " +
                (i < game.mistakesLeft ? "bg-zinc-300" : "bg-zinc-700")
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
