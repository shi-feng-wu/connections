import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { botCardUrl, cardNeedsRefresh, cardPayload, dmWindowClosing, gridFinished, interactionMessageUrl, playerFinished, playingLine, tokenStillEditable, withinPostCooldown, withinUpdateThrottle } from "../api/_livecard";
import type { Puzzle } from "../src/game";

// api/_livecard.ts: the room card is a bot message. On create it replies to the
// launcher's "<user> used /connections" message (message_reference); edits address the
// stored message id. These helpers shape the Discord REST request.
describe("cardPayload", () => {
  it("is a plain message with no message_reference when not replying", () => {
    const p = cardPayload() as { message_reference?: unknown };
    expect(p.message_reference).toBeUndefined();
  });

  it("replies to the launch message when given a reference", () => {
    const p = cardPayload({ replyTo: { messageId: "111", channelId: "222" } }) as {
      message_reference?: { message_id: string; channel_id: string; fail_if_not_exists: boolean };
    };
    expect(p.message_reference).toEqual({ message_id: "111", channel_id: "222", fail_if_not_exists: false });
  });

  // The live card is routine churn, so it posts silently (SUPPRESS_NOTIFICATIONS,
  // 1 << 12 = 4096) on both create and edit; only the recap is allowed to notify.
  it("suppresses notifications on create and reply", () => {
    expect((cardPayload() as { flags?: number }).flags).toBe(4096);
    expect((cardPayload({ replyTo: { messageId: "1", channelId: "2" } }) as { flags?: number }).flags).toBe(4096);
  });

  // The "who's playing" caption rides in message content; absent when not provided so a post
  // without a roster line stays image-only.
  it("carries the content caption when given, and omits it otherwise", () => {
    expect((cardPayload({ content: "Alice is playing!" }) as { content?: string }).content).toBe(
      "Alice is playing!",
    );
    expect((cardPayload() as { content?: string }).content).toBeUndefined();
  });
});

describe("botCardUrl", () => {
  it("targets the channel for a create (POST)", () => {
    expect(botCardUrl("222")).toBe("https://discord.com/api/v10/channels/222/messages");
  });

  it("targets the message for an edit (PATCH)", () => {
    expect(botCardUrl("222", "111")).toBe("https://discord.com/api/v10/channels/222/messages/111");
  });
});

// interactionMessageUrl edits a DM card via the launcher's interaction token (no bot), within the
// ~15-minute token window.
describe("interactionMessageUrl", () => {
  it("targets a followup message by id for a token edit (PATCH)", () => {
    expect(interactionMessageUrl("app", "tok", "123")).toBe(
      "https://discord.com/api/v10/webhooks/app/tok/messages/123",
    );
  });
});

// The no-bot card reuses the live-card 2h cooldown to decide post-fresh-vs-edit, and the
// interaction token's ~15-min window to decide whether it can still be edited at all.
describe("withinPostCooldown", () => {
  const now = 1_700_000_000_000;
  it("is false when never posted", () => {
    expect(withinPostCooldown(null, now)).toBe(false);
    expect(withinPostCooldown(undefined, now)).toBe(false);
  });
  it("is true within the 2h window and false after it", () => {
    expect(withinPostCooldown(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(withinPostCooldown(new Date(now - 3 * 60 * 60 * 1000).toISOString(), now)).toBe(false);
  });
  it("is false on an unparseable timestamp", () => {
    expect(withinPostCooldown("not-a-date", now)).toBe(false);
  });
});

describe("tokenStillEditable", () => {
  const now = 1_700_000_000_000;
  it("is false with no stored token timestamp", () => {
    expect(tokenStillEditable(null, now)).toBe(false);
    expect(tokenStillEditable(undefined, now)).toBe(false);
  });
  it("is true inside the ~15-min window and false past it", () => {
    expect(tokenStillEditable(new Date(now - 60_000).toISOString(), now)).toBe(true); // 1 min
    expect(tokenStillEditable(new Date(now - 20 * 60_000).toISOString(), now)).toBe(false); // 20 min
  });
  it("is false on an unparseable timestamp", () => {
    expect(tokenStillEditable("nope", now)).toBe(false);
  });
});

// dmWindowClosing: true once a DM card's token is in its final ~3 min (≥ 11 min old, given the
// 14-min window). Used so a relay flush and the finalize cron agree on past tense in that window.
describe("dmWindowClosing", () => {
  const now = 1_700_000_000_000;
  it("is false with no token", () => {
    expect(dmWindowClosing(null, now)).toBe(false);
    expect(dmWindowClosing(undefined, now)).toBe(false);
  });
  it("is false early in the window and true in the final stretch", () => {
    expect(dmWindowClosing(new Date(now - 5 * 60_000).toISOString(), now)).toBe(false); // 5 min
    expect(dmWindowClosing(new Date(now - 12 * 60_000).toISOString(), now)).toBe(true); // 12 min
  });
  it("is false on an unparseable timestamp", () => {
    expect(dmWindowClosing("nope", now)).toBe(false);
  });
});

// playerFinished gates the Join/Play card paths (api/interactions.ts, api/join.ts): a
// player who already won or lost today isn't playing, so clicking Join shouldn't add them
// to the room card or post a new one. Same fixed 16-word puzzle shape as game.test.ts.
const puzzle: Puzzle = {
  id: 42,
  date: "2026-06-01",
  editor: "Test",
  groups: [
    { level: 0, category: "L0", members: ["A0", "B0", "C0", "D0"] },
    { level: 1, category: "L1", members: ["A1", "B1", "C1", "D1"] },
    { level: 2, category: "L2", members: ["A2", "B2", "C2", "D2"] },
    { level: 3, category: "L3", members: ["A3", "B3", "C3", "D3"] },
  ],
  layout: [
    "A0", "B0", "C0", "D0",
    "A1", "B1", "C1", "D1",
    "A2", "B2", "C2", "D2",
    "A3", "B3", "C3", "D3",
  ],
};
const group = (lvl: number): string[] => puzzle.groups[lvl].members.slice();
// Four distinct wrong guesses from the two hardest groups — spends all four mistakes.
const FOUR_WRONG = [
  ["A2", "B2", "C2", "A3"],
  ["A2", "B2", "B3", "C3"],
  ["A2", "A3", "B3", "C3"],
  ["B2", "C2", "D2", "D3"],
];

// Minimal stand-in for the one query playerFinished runs:
// db.from('progress').select('guesses').eq(...).eq(...).maybeSingle()
type Chain = {
  select: () => Chain;
  eq: () => Chain;
  maybeSingle: () => Promise<{ data: { guesses: string[][] } | null }>;
};
function dbWithGuesses(guesses: string[][] | null): SupabaseClient {
  const data = guesses === null ? null : { guesses };
  const chain: Chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

// playingLine builds the card's "who's playing" caption: lists up to three names, then caps to two
// plus "and N others"; `past` flips is/are → was/were (guild roster finished, or the DM finalize cron).
describe("playingLine", () => {
  it("is empty for no players (no caption)", () => {
    expect(playingLine([], false)).toBe("");
    expect(playingLine(["", "  "], false)).toBe(""); // blanks filtered out
  });
  it("uses singular is/was for one player", () => {
    expect(playingLine(["Alice"], false)).toBe("Alice is playing!");
    expect(playingLine(["Alice"], true)).toBe("Alice was playing!");
  });
  it("joins two with 'and' and plural are/were", () => {
    expect(playingLine(["Alice", "Bob"], false)).toBe("Alice and Bob are playing!");
    expect(playingLine(["Alice", "Bob"], true)).toBe("Alice and Bob were playing!");
  });
  it("lists exactly three with an oxford-style 'and'", () => {
    expect(playingLine(["Alice", "Bob", "Carol"], false)).toBe("Alice, Bob and Carol are playing!");
  });
  it("caps beyond three to two names plus 'and N others'", () => {
    expect(playingLine(["Alice", "Bob", "Carol", "Dave"], false)).toBe("Alice, Bob and 2 others are playing!");
    expect(playingLine(["Alice", "Bob", "Carol", "Dave", "Eve"], true)).toBe("Alice, Bob and 3 others were playing!");
  });
});

// gridFinished: a grid is finished at four solved rows (win) or four miss rows (loss). Drives the
// guild card's past-tense flip (whole roster finished) in api/refresh-card.
describe("gridFinished", () => {
  const solvedRow = (lvl: number): number[] => [lvl, lvl, lvl, lvl];
  const missRow = [0, 1, 2, 3];
  it("is false for an undefined or in-progress grid", () => {
    expect(gridFinished(undefined)).toBe(false);
    expect(gridFinished([solvedRow(0), missRow])).toBe(false);
  });
  it("is true after four solved groups (win)", () => {
    expect(gridFinished([solvedRow(0), solvedRow(1), solvedRow(2), solvedRow(3)])).toBe(true);
  });
  it("is true after four misses (loss)", () => {
    expect(gridFinished([missRow, missRow, missRow, missRow])).toBe(true);
  });
});

// withinUpdateThrottle gates the live-card edit cadence (30s). It's the cheap pre-check api/guess
// uses and the window claimEditSlot enforces; a null/unset edited_at (a freshly posted DM card)
// counts as "not throttled" so the first refresh always lands.
describe("withinUpdateThrottle", () => {
  const now = 1_700_000_000_000;
  it("is false with no edited_at (e.g. a freshly posted DM card)", () => {
    expect(withinUpdateThrottle(null, now)).toBe(false);
    expect(withinUpdateThrottle(undefined, now)).toBe(false);
  });
  it("is true within the 30s window and false past it", () => {
    expect(withinUpdateThrottle(new Date(now - 10_000).toISOString(), now)).toBe(true);
    expect(withinUpdateThrottle(new Date(now - 31_000).toISOString(), now)).toBe(false);
  });
  it("is false on an unparseable timestamp", () => {
    expect(withinUpdateThrottle("nope", now)).toBe(false);
  });
});

// cardNeedsRefresh is the cheap gate api/guess runs before firing the /api/refresh-card self-call:
// skip when there's no card to edit, or when the 30s window is still open and the player hasn't
// just finished (a finish always refreshes so the final grid lands).
function dbWithCard(
  card: { message_id?: string | null; edited_at?: string | null; token_at?: string | null } | null,
): SupabaseClient {
  const chain: { select: () => unknown; eq: () => unknown; maybeSingle: () => Promise<{ data: unknown }> } = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: card }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("cardNeedsRefresh", () => {
  const date = "2026-06-01";
  it("is false when no card row exists", async () => {
    expect(await cardNeedsRefresh(dbWithCard(null), "g:1", date, "c1", false)).toBe(false);
  });
  it("is false when the row has no message_id (roster recorded, no card posted)", async () => {
    expect(
      await cardNeedsRefresh(dbWithCard({ message_id: null, edited_at: null }), "g:1", date, "c1", false),
    ).toBe(false);
  });
  it("is true for a finished player even if just edited (the final grid must land)", async () => {
    const justNow = new Date().toISOString();
    expect(
      await cardNeedsRefresh(dbWithCard({ message_id: "m1", edited_at: justNow }), "g:1", date, "c1", true),
    ).toBe(true);
  });
  it("is false mid-game when edited within the 30s window", async () => {
    const justNow = new Date().toISOString();
    expect(
      await cardNeedsRefresh(dbWithCard({ message_id: "m1", edited_at: justNow }), "g:1", date, "c1", false),
    ).toBe(false);
  });
  it("is true mid-game when the last edit is older than 30s", async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(
      await cardNeedsRefresh(dbWithCard({ message_id: "m1", edited_at: old }), "g:1", date, "c1", false),
    ).toBe(true);
  });
  it("is true for a freshly posted DM card within the token window (no edited_at yet)", async () => {
    const freshToken = new Date().toISOString();
    expect(
      await cardNeedsRefresh(
        dbWithCard({ message_id: "m1", edited_at: null, token_at: freshToken }),
        "c:1",
        date,
        "c1",
        false,
      ),
    ).toBe(true);
  });
  it("is false for a DM card whose interaction-token window has closed (frozen), even on a finish", async () => {
    const staleToken = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min > ~14 min window
    expect(
      await cardNeedsRefresh(
        dbWithCard({ message_id: "m1", edited_at: null, token_at: staleToken }),
        "c:1",
        date,
        "c1",
        true,
      ),
    ).toBe(false);
  });
});

describe("playerFinished", () => {
  it("is false when the player has no committed guesses yet", async () => {
    expect(await playerFinished(dbWithGuesses(null), puzzle, "u1", puzzle.date)).toBe(false);
  });

  it("is false mid-game (some groups solved, still playing)", async () => {
    expect(await playerFinished(dbWithGuesses([group(0), group(1)]), puzzle, "u1", puzzle.date)).toBe(false);
  });

  it("is true after a win (all four groups solved)", async () => {
    const won = [group(0), group(1), group(2), group(3)];
    expect(await playerFinished(dbWithGuesses(won), puzzle, "u1", puzzle.date)).toBe(true);
  });

  it("is true after a loss (four mistakes)", async () => {
    expect(await playerFinished(dbWithGuesses(FOUR_WRONG), puzzle, "u1", puzzle.date)).toBe(true);
  });
});
