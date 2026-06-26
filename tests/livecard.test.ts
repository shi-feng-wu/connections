import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { botCardUrl, cardPayload, interactionMessageUrl, playerFinished, tokenStillEditable, withinPostCooldown } from "../api/_livecard";
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
    const p = cardPayload({ messageId: "111", channelId: "222" }) as {
      message_reference?: { message_id: string; channel_id: string; fail_if_not_exists: boolean };
    };
    expect(p.message_reference).toEqual({ message_id: "111", channel_id: "222", fail_if_not_exists: false });
  });

  // The live card is routine churn, so it posts silently (SUPPRESS_NOTIFICATIONS,
  // 1 << 12 = 4096) on both create and edit; only the recap is allowed to notify.
  it("suppresses notifications on create and reply", () => {
    expect((cardPayload() as { flags?: number }).flags).toBe(4096);
    expect((cardPayload({ messageId: "1", channelId: "2" }) as { flags?: number }).flags).toBe(4096);
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
