import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Game, LEVELS, type Puzzle } from "../src/game";
import { botCanPostInChannel, installNudgePayload, inviteWithinCooldown, isUserInstallOnly, missingPermsNudgePayload, routeInteraction, shareCard, unsubscribeResult, verifyDiscordSig } from "../api/interactions";

// api/interactions.ts: Discord signs every interaction (Ed25519); an unverified
// request must be refused, and the recap's Play button must map to a launch.
// Build a keypair and present the public key the way Discord does: 32 raw bytes
// as hex (the tail of the SPKI DER encoding).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubHex = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32).toString("hex");

const sigFor = (body: string, ts: string): string =>
  edSign(null, Buffer.from(ts + body), privateKey).toString("hex");

describe("verifyDiscordSig", () => {
  it("accepts a correctly signed request", () => {
    const body = JSON.stringify({ type: 1 });
    const ts = "1717200000";
    expect(verifyDiscordSig(body, sigFor(body, ts), ts, pubHex)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = "1717200000";
    const sig = sigFor(JSON.stringify({ type: 1 }), ts);
    expect(verifyDiscordSig(JSON.stringify({ type: 3 }), sig, ts, pubHex)).toBe(false);
  });

  it("rejects a swapped timestamp", () => {
    const body = JSON.stringify({ type: 1 });
    const sig = sigFor(body, "1717200000");
    expect(verifyDiscordSig(body, sig, "9999999999", pubHex)).toBe(false);
  });

  it("fails closed on missing/garbage inputs", () => {
    expect(verifyDiscordSig("{}", "", "1", pubHex)).toBe(false); // no signature
    expect(verifyDiscordSig("{}", "abcd", "1", "")).toBe(false); // no public key
    expect(verifyDiscordSig("{}", "zz", "1", pubHex)).toBe(false); // non-hex signature
  });
});

// inviteWithinCooldown throttles the DM Play invite per channel by reusing the live-card 2h
// cooldown, so relaunches don't spam the chat. "Never posted" (null) must not throttle.
describe("inviteWithinCooldown", () => {
  const now = 1_700_000_000_000;
  it("does not throttle when never posted", () => {
    expect(inviteWithinCooldown(null, now)).toBe(false);
    expect(inviteWithinCooldown(undefined, now)).toBe(false);
  });
  it("throttles within the 2h window and clears after it", () => {
    expect(inviteWithinCooldown(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(inviteWithinCooldown(new Date(now - 3 * 60 * 60 * 1000).toISOString(), now)).toBe(false);
  });
  it("does not throttle on an unparseable timestamp", () => {
    expect(inviteWithinCooldown("not-a-date", now)).toBe(false);
  });
});

describe("routeInteraction", () => {
  it("pongs a verification PING", () => {
    expect(routeInteraction({ type: 1 })).toEqual({ type: 1 });
  });

  it("launches the Activity for the Play button", () => {
    expect(routeInteraction({ type: 3, data: { custom_id: "connections_play" } })).toEqual({ type: 12 });
  });

  it("does not launch for an unknown component", () => {
    const r = routeInteraction({ type: 3, data: { custom_id: "nope" } }) as { type: number };
    expect(r.type).not.toBe(12);
  });

  it("launches the Activity for the /connections slash command", () => {
    expect(routeInteraction({ type: 2, data: { name: "connections" } })).toEqual({ type: 12 });
  });

  it("does not launch for an unknown slash command", () => {
    const r = routeInteraction({ type: 2, data: { name: "nope" } }) as { type: number };
    expect(r.type).not.toBe(12);
  });

  it("/enable-posts offers a one-click Add-to-Server button in a bot-less server", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "enable-posts" },
      application_id: "app123",
      guild_id: "guild123", // run in a server (just one the bot isn't installed in)
      authorizing_integration_owners: { "1": "user123" }, // user-install only
    }) as { type: number; data: { flags?: number; content?: string; components?: { components: { style?: number; url?: string }[] }[] } };
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBe(64); // ephemeral
    expect(r.data.content).toContain("this server");
    const btn = r.data.components?.[0].components[0];
    expect(btn?.style).toBe(5); // link button
    expect(btn?.url).toContain("client_id=app123");
    expect(btn?.url).toContain("integration_type=0");
  });

  // /enable-posts is registered GUILD-only (no DM context — see scripts/register-commands.mjs),
  // so there's no DM-flavoured response to test: it can't be invoked in a DM.

  it("/enable-posts says recaps are already on when the bot is guild-installed", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "enable-posts" },
      guild_id: "guild123",
      authorizing_integration_owners: { "0": "guild123" }, // guild install present
    }) as { type: number; data: { components?: unknown[]; content?: string } };
    expect(r.type).toBe(4);
    expect(r.data.components).toBeUndefined(); // no button
    expect(r.data.content).toContain("already");
  });

  it("/donate replies privately with the Ko-fi link button", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "donate" },
    }) as { type: number; data: { flags?: number; content?: string; components?: { components: { style?: number; url?: string }[] }[] } };
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBe(64); // ephemeral
    expect(r.data.content).toContain("server costs");
    const btn = r.data.components?.[0].components[0];
    expect(btn?.style).toBe(5); // link button
    expect(btn?.url).toBe("https://ko-fi.com/borgardev");
  });
});

// /share posts the player's finished result as a Components V2 card (shareCard) — a plain bordered
// Container like Wordle's frame. The container holds a title+grid text block, a divider, and a
// subtext stat block; the ✅/❌ in the subtext carries the outcome. These cover that structure.
type Container = { type: number; components: { type: number; content?: string }[] };
const card = (g: Game, opts?: Parameters<typeof shareCard>[1]) => shareCard(g, opts)[0] as Container;
// The TextDisplay blocks inside the container: a plain title, the grid, and the subtext stats —
// each its own block (with spacers between) so Wordle-style spacing sits between them.
const title = (c: Container) => c.components.find((b) => b.content?.startsWith("Connections"))?.content ?? "";
const grid = (c: Container) => c.components.find((b) => /🟨|🟩|🟦|🟪/.test(b.content ?? ""))?.content ?? "";
const statline = (c: Container) => c.components.filter((b) => b.content?.startsWith("-#")).at(-1)?.content ?? "";

describe("shareCard", () => {
  // A 16-word puzzle whose word names encode their group ("A2" → level 2), mirroring game.test.
  const puzzle: Puzzle = {
    id: 1106,
    date: "2026-06-21",
    editor: "Test",
    groups: [
      { level: 0, category: "L0", members: ["A0", "B0", "C0", "D0"] },
      { level: 1, category: "L1", members: ["A1", "B1", "C1", "D1"] },
      { level: 2, category: "L2", members: ["A2", "B2", "C2", "D2"] },
      { level: 3, category: "L3", members: ["A3", "B3", "C3", "D3"] },
    ],
    layout: ["A0", "B0", "C0", "D0", "A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "B3", "C3", "D3"],
  };
  const play = (guesses: string[][]): Game => Game.fromGuesses(puzzle, guesses);
  const solveAll: string[][] = [["A0", "B0", "C0", "D0"], ["A1", "B1", "C1", "D1"], ["A2", "B2", "C2", "D2"], ["A3", "B3", "C3", "D3"]];

  it("puts a plain Wordle-style title and the grid in a bordered container, as separate blocks", () => {
    const c = card(play([["A0", "B0", "C0", "A1"], ...solveAll]), { puzzleNo: puzzle.id }); // one wrong, then a sweep
    expect(c.type).toBe(17); // CONTAINER
    expect(title(c)).toBe("Connections #1106 4/4"); // plain text, groups-solved fraction (a win → 4/4)
    const rows = grid(c).split("\n");
    // The mixed first guess colours each word by its own group; the four solves are mono rows.
    expect(rows[0]).toBe(LEVELS[0].emoji.repeat(3) + LEVELS[1].emoji);
    expect(rows[1]).toBe(LEVELS[0].emoji.repeat(4));
    expect(rows).toHaveLength(5); // 1 wrong + 4 solves (grid block only; title is separate)
  });

  it("shows four remaining dots on a flawless win, plus time + points", () => {
    const c = card(play(solveAll), { puzzleNo: 1106, durationMs: 94_000, score: 380 });
    const line = statline(c);
    expect(line).toContain("⚪⚪⚪⚪"); // 4 remaining, 0 spent
    expect(line).not.toContain("⚫"); // no spent dots on a clean grid
    expect(line).toContain("1:34"); // 94s → m:ss
    expect(line).toContain("380 pts");
  });

  it("renders the 4-dot tracker (remaining ⚪ then spent ⚫) on a win", () => {
    const c = card(play([["A0", "B0", "C0", "A1"], ["A0", "B0", "C0", "A2"], ...solveAll])); // 2 wrong, then solve
    expect(statline(c)).toContain("⚪⚪⚫⚫"); // 2 remaining, 2 spent — always four total
  });

  it("shows all four spent on a loss (time/points optional)", () => {
    // One correct group, then four wrong guesses from the two hardest groups to exhaust mistakes.
    const c = card(
      play([
        ["A0", "B0", "C0", "D0"],
        ["A2", "B2", "C2", "A3"],
        ["A2", "B2", "B3", "C3"],
        ["A2", "A3", "B3", "C3"],
        ["B2", "C2", "D2", "D3"],
      ]),
      { puzzleNo: 1106 },
    );
    expect(statline(c)).toContain("⚫⚫⚫⚫"); // 0 remaining, 4 spent → a loss
    expect(statline(c)).not.toContain("⚪"); // no remaining dots
    expect(statline(c)).not.toContain("pts");
  });

  it("drops the '#number' from the title when unknown (keeps the x/4), and drops a zero duration", () => {
    const c = card(play(solveAll), { durationMs: 0 });
    expect(title(c)).toBe("Connections 4/4"); // no "#1106", still the fraction
    expect(statline(c)).not.toMatch(/\d+s|\d+:\d\d/); // no time token
  });
});

// The ephemeral install nudge a bot-less launch gets instead of the card: same one-click
// Add-to-Server button as /enable-posts, plus the ask-an-admin handoff for non-admins.
describe("installNudgePayload", () => {
  const p = installNudgePayload("app123") as {
    flags?: number;
    content?: string;
    components?: { components: { style?: number; url?: string; label?: string }[] }[];
  };

  it("is ephemeral (only the launcher sees it)", () => {
    expect(p.flags).toBe(64);
  });

  it("leads with the live card, keeps the recap, and hands off to an admin", () => {
    expect(p.content).toContain("who’s playing");
    // The live card is the launch-moment payoff, so it must come before the recap pitch.
    expect(p.content!.indexOf("who’s playing")).toBeLessThan(p.content!.indexOf("nightly recap"));
    expect(p.content).toContain("/enable-posts"); // the admin handoff path
  });

  it("carries the one-click guild-install link", () => {
    const btn = p.components?.[0].components[0];
    expect(btn?.style).toBe(5); // link button
    expect(btn?.label).toBe("Add to Server");
    expect(btn?.url).toContain("client_id=app123");
    expect(btn?.url).toContain("integration_type=0");
  });
});

// /unsubscribe replies: "done" is a PUBLIC channel post (the channel sees recaps were turned off
// + how to permanently mute); "no-guild"/"error" stay ephemeral so they don't post noise.
describe("unsubscribeResult", () => {
  const data = (kind: "done" | "already" | "no-guild" | "error") =>
    (unsubscribeResult(kind) as { type: number; data: { flags?: number; content?: string } });

  it("confirms the opt-out publicly, with the auto re-arm and the permanent-mute tip", () => {
    const r = data("done");
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBeUndefined(); // public, not ephemeral
    expect(r.data.content).toContain("off for this channel");
    expect(r.data.content).toContain("come back automatically"); // re-arms on the next launch
    expect(r.data.content).toContain("View Channel"); // permanent-mute path
  });

  it("tells a re-runner recaps are already off — ephemerally, so it doesn't re-post", () => {
    const r = data("already");
    expect(r.data.flags).toBe(64); // ephemeral — no duplicate public confirmation
    expect(r.data.content).toContain("already off");
  });

  it("explains there's nothing to turn off in a DM/non-guild surface (ephemeral)", () => {
    const r = data("no-guild");
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toContain("server channel");
  });

  it("is an ephemeral apology on a DB error", () => {
    const r = data("error");
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toContain("try `/unsubscribe` again");
  });
});

// The card is a bot message, so it's skipped when the launch is a user install in a server
// without the bot (only "1" present, no "0") — there it would only 403. "0" = guild install,
// "1" = user install.
describe("isUserInstallOnly", () => {
  it("is true for a user-install-only launch (no guild install)", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "1": "user123" } })).toBe(true);
  });

  it("is false when the app is guild-installed (bot is present)", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "0": "guild123" } })).toBe(false);
  });

  it("is false when both install types authorized it", () => {
    expect(isUserInstallOnly({ authorizing_integration_owners: { "0": "guild123", "1": "user123" } })).toBe(false);
  });

  it("is false (proceeds) when the field is absent or empty", () => {
    expect(isUserInstallOnly({})).toBe(false);
    expect(isUserInstallOnly({ authorizing_integration_owners: {} })).toBe(false);
  });
});

// botCanPostInChannel reads the bot's effective channel permissions off the interaction's
// app_permissions bitfield. The card/recap are PNG attachments, so it needs View Channel +
// Send Messages + Attach Files — short any one (e.g. a private channel the bot's role isn't in)
// and the recap silently 403s. Bitfield is compared as BigInt.
describe("botCanPostInChannel", () => {
  const VIEW = 1n << 10n, SEND = 1n << 11n, ATTACH = 1n << 15n, ADMIN = 1n << 3n;

  it("is true when View Channel + Send Messages + Attach Files are all present", () => {
    expect(botCanPostInChannel(String(VIEW | SEND | ATTACH))).toBe(true);
  });

  it("is false when Attach Files is missing (the card/recap are image attachments)", () => {
    expect(botCanPostInChannel(String(VIEW | SEND))).toBe(false);
  });

  it("is false when View Channel is missing (a private channel the bot isn't allowed into)", () => {
    expect(botCanPostInChannel(String(SEND | ATTACH))).toBe(false);
  });

  it("is true for Administrator (implies every permission)", () => {
    expect(botCanPostInChannel(String(ADMIN))).toBe(true);
  });

  it("fails OPEN (true) on an absent or unparseable field, so it never wrongly nudges", () => {
    expect(botCanPostInChannel(undefined)).toBe(true);
    expect(botCanPostInChannel("")).toBe(true);
    expect(botCanPostInChannel("not-a-number")).toBe(true);
  });
});

// The ephemeral "I can't post in this channel" nudge: names the three permissions the recap/card
// need and carries no button (granting channel permissions is a settings action, not a link).
describe("missingPermsNudgePayload", () => {
  const p = missingPermsNudgePayload() as { flags?: number; content?: string; components?: unknown[] };

  it("is ephemeral (only the launcher sees it)", () => {
    expect(p.flags).toBe(64);
  });

  it("names the three permissions the recap/card need", () => {
    expect(p.content).toContain("View Channel");
    expect(p.content).toContain("Send Messages");
    expect(p.content).toContain("Attach Files");
  });

  it("has no button — granting channel permissions is a Discord settings action, not a link", () => {
    expect(p.components).toBeUndefined();
  });
});
