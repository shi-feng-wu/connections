import { describe, expect, it } from "vitest";
import { type CardPlayer, mergePlayer, renderRoster } from "../api/_card";

// api/_card.ts: the roster shown on the "who's playing today" card.
// mergePlayer is append-only (join adds, leave never removes); renderRoster must
// emit a real PNG even with no avatars (the network-free placeholder path).

describe("mergePlayer", () => {
  const a: CardPlayer = { id: "1", name: "Alice", avatar: null };
  const b: CardPlayer = { id: "2", name: "Bob", avatar: null };

  it("adds a new player and reports the change", () => {
    const r = mergePlayer([a], b);
    expect(r.changed).toBe(true);
    expect(r.players.map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("is a no-op for someone already on the card (dedupe by id)", () => {
    const r = mergePlayer([a, b], { id: "1", name: "Alice (renamed)", avatar: "x" });
    expect(r.changed).toBe(false);
    expect(r.players).toHaveLength(2);
  });

  it("preserves join order", () => {
    let players: CardPlayer[] = [];
    for (const id of ["3", "1", "2"]) players = mergePlayer(players, { id, name: `u${id}` }).players;
    expect(players.map((p) => p.id)).toEqual(["3", "1", "2"]);
  });
});

describe("renderRoster", () => {
  const png = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG";

  it("renders a valid PNG with avatar-less players (placeholder path, no network)", async () => {
    const players: CardPlayer[] = [
      { id: "100", name: "Alice", avatar: null },
      { id: "200", name: "Bob" },
      { id: "300", name: "A-very-long-display-name-that-must-truncate" },
    ];
    const buf = await renderRoster(players, { puzzleNo: 123 });
    expect(png(buf)).toBe(true);
  });

  it("renders with a single player and no puzzle number", async () => {
    const buf = await renderRoster([{ id: "1", name: "Solo" }]);
    expect(png(buf)).toBe(true);
  });
});
