import type { SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game, LEVELS, type Puzzle } from "../src/game";
import { default as interactionsHandler, disablePostsResult, enablePostsResponse, helpMessage, inviteBotMessage, memberCanManageChannels, missingPermsNudgePayload, routeInteraction, shareCard, verifyDiscordSig } from "../api/interactions";
// @ts-expect-error — plain .mjs command definitions shared with scripts/register-commands.mjs (no types).
import { CHAT_COMMANDS, MANAGE_CHANNELS as MANAGE_CHANNELS_BIT } from "../scripts/command-defs.mjs";

// ---- shims for the /share handler tests at the bottom of this file ----
// api/interactions.ts must stay canvas-free (it is the function Discord holds to a 3s deadline), so
// /share only DECIDES here and hands the render to /api/post-share. These mocks stand in for the two
// things that decision touches — the service DB and the puzzle fetch — plus waitUntil, which the
// self-call rides. The three enablePostsResponse cases above return before `admin()` is ever
// imported (no channel context), so the DB shim is invisible to them.
type Row = Record<string, unknown>;
const shareRoute: { progress: Row[]; pending: Promise<unknown>[] } = { progress: [], pending: [] };

const SHARE_UID = "111222333444555666";
const SHARE_DATE = "2026-08-11";
const SHARE_PUZZLE: Puzzle = {
  id: 1170,
  date: SHARE_DATE,
  editor: "Test",
  groups: [
    { level: 0, category: "L0", members: ["A0", "B0", "C0", "D0"] },
    { level: 1, category: "L1", members: ["A1", "B1", "C1", "D1"] },
    { level: 2, category: "L2", members: ["A2", "B2", "C2", "D2"] },
    { level: 3, category: "L3", members: ["A3", "B3", "C3", "D3"] },
  ],
  layout: ["A0", "B0", "C0", "D0", "A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "B3", "C3", "D3"],
};
const SHARE_WON = [
  ["A0", "B0", "C0", "D0"],
  ["A1", "B1", "C1", "D1"],
  ["A2", "B2", "C2", "D2"],
  ["A3", "B3", "C3", "D3"],
];

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    shareRoute.pending.push(p);
  },
}));
vi.mock("../api/_admin.js", () => {
  class Q {
    private eqs: [string, unknown][] = [];
    select(): this {
      return this;
    }
    eq(col: string, val: unknown): this {
      this.eqs.push([col, val]);
      return this;
    }
    async maybeSingle(): Promise<{ data: Row | null; error: null }> {
      const row = shareRoute.progress.find((r) => this.eqs.every(([c, v]) => r[c] === v)) ?? null;
      return { data: row, error: null };
    }
  }
  return { admin: () => ({ from: () => new Q() }) as unknown as SupabaseClient };
});
vi.mock("../api/_puzzles.js", () => ({
  fetchPuzzle: async () => SHARE_PUZZLE,
  todayET: () => SHARE_DATE,
  isValidDate: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
}));

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

  it("launches the Activity for the /disconnections slash command", () => {
    expect(routeInteraction({ type: 2, data: { name: "disconnections" } })).toEqual({ type: 12 });
  });

  it("also launches the Activity for the /connections alias", () => {
    expect(routeInteraction({ type: 2, data: { name: "connections" } })).toEqual({ type: 12 });
  });

  it("does not launch for an unknown slash command", () => {
    const r = routeInteraction({ type: 2, data: { name: "nope" } }) as { type: number };
    expect(r.type).not.toBe(12);
  });

  it("/unmute confirms posts are on in a bot-less server and offers the bot as the upgrade", async () => {
    // Posts DO happen without the bot now (token-backed card + piggybacked recap), so this reply
    // must not pitch an install as the only way to get them — it confirms they're on and offers the
    // invite link as an upgrade. The old "Add to Server" pitch moved to /invite-bot.
    const r = (await enablePostsResponse({
      type: 2,
      data: { name: "unmute" },
      application_id: "app123",
      guild_id: "guild123", // run in a server (just one the bot isn't installed in)
      authorizing_integration_owners: { "1": "user123" }, // user-install only
    })) as { type: number; data: { flags?: number; content?: string; components?: unknown[] } };
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBe(64); // ephemeral — nothing changed
    expect(r.data.content).toContain("Posts are on in this channel");
    expect(r.data.content).toContain("recap");
    expect(r.data.content).toContain("client_id=app123"); // the invite, as a masked link
    expect(r.data.components).toBeUndefined(); // one short reply, no button
  });

  it("/unmute is still reachable under its pre-rename /enable-posts name", async () => {
    // Global renames take ~an hour to reach every client, so the old name must keep working.
    const r = (await enablePostsResponse({
      type: 2,
      data: { name: "enable-posts" },
      application_id: "app123",
      guild_id: "guild123",
      authorizing_integration_owners: { "1": "user123" },
    })) as { data: { content?: string } };
    expect(r.data.content).toContain("Posts are on in this channel");
  });

  // /unmute is registered GUILD-only (no DM context — see scripts/command-defs.mjs), so there's no
  // DM-flavoured response to test: it can't be invoked in a DM.

  it("/unmute says posts are already on when the bot is guild-installed and nothing was muted", async () => {
    // Guild-installed but no channel context (and no DB configured in tests) → the "already on"
    // reassurance, ephemeral and buttonless. A real un-mute (clearing a /mute opt-out) needs a live
    // DB, so it's covered by the SQL/integration layers, not this pure-ish unit.
    const r = (await enablePostsResponse({
      type: 2,
      data: { name: "unmute" },
      guild_id: "guild123",
      authorizing_integration_owners: { "0": "guild123" }, // guild install present
    })) as { type: number; data: { components?: unknown[]; content?: string } };
    expect(r.type).toBe(4);
    expect(r.data.components).toBeUndefined(); // no button
    expect(r.data.content).toContain("already");
  });

  it("/invite-bot replies privately with the Add-to-Server link", () => {
    const r = routeInteraction({
      type: 2,
      data: { name: "invite-bot" },
      application_id: "app123",
    }) as { type: number; data: { flags?: number; components?: { components: { url?: string }[] }[] } };
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
    expect(r.data.components?.[0].components[0].url).toContain("client_id=app123");
  });

  it("/help replies privately with the command list", () => {
    const r = routeInteraction({ type: 2, data: { name: "help" } }) as {
      type: number;
      data: { flags?: number; content?: string };
    };
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toContain("`/disconnections`");
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
const title = (c: Container) => c.components.find((b) => b.content?.startsWith("Disconnections"))?.content ?? "";
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
    expect(title(c)).toBe("Disconnections #1106 4/4"); // plain text, groups-solved fraction (a win → 4/4)
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
    expect(title(c)).toBe("Disconnections 4/4"); // no "#1106", still the fraction
    expect(statline(c)).not.toMatch(/\d+s|\d+:\d\d/); // no time token
  });
});

// /invite-bot: the install pitch's new home now that the mid-launch popup is gone. Ephemeral, with
// the same one-click guild-install link the piggybacked recap's aside carries.
describe("inviteBotMessage", () => {
  const p = inviteBotMessage("app123") as {
    flags?: number;
    content?: string;
    components?: { components: { style?: number; url?: string; label?: string }[] }[];
  };

  it("is ephemeral (only the asker sees it)", () => {
    expect(p.flags).toBe(64);
  });

  it("says what the bot adds", () => {
    expect(p.content).toContain("who’s playing");
    expect(p.content).toContain("recaps");
  });

  it("carries the one-click guild-install link", () => {
    const btn = p.components?.[0].components[0];
    expect(btn?.style).toBe(5); // link button
    expect(btn?.label).toBe("Add to Server");
    expect(btn?.url).toContain("client_id=app123");
    expect(btn?.url).toContain("integration_type=0");
  });
});

// /help is the app's own command list, so it must stay in step with what's actually registered:
// every chat command in scripts/command-defs.mjs (the same data register-commands.mjs reconciles
// against) has to appear in the text, and the two moderator commands have to be marked as such.
describe("helpMessage", () => {
  const p = helpMessage() as { flags?: number; content?: string };
  const registered: string[] = (CHAT_COMMANDS as { name: string }[]).map((c) => c.name);

  it("is ephemeral (one person asked, the channel doesn't need it)", () => {
    expect(p.flags).toBe(64);
  });

  it("lists every registered command", () => {
    for (const name of registered) {
      expect(p.content, `/${name} missing from /help`).toContain(`\`/${name}\``);
    }
  });

  it("lists nothing that isn't registered", () => {
    // Every `/command` token in the help text must be a real registered name.
    for (const token of p.content!.match(/`\/([a-z-]+)`/g) ?? []) {
      const name = token.slice(2, -1);
      expect(registered, `/help lists unregistered /${name}`).toContain(name);
    }
  });

  it("marks the moderator-only pair", () => {
    for (const line of p.content!.split("\n")) {
      if (line.startsWith("`/mute`") || line.startsWith("`/unmute`"))
        expect(line, line).toContain("(mods)");
    }
  });
});

// The registration DEFINITIONS themselves (scripts/command-defs.mjs) — the gating contract, checked
// as data so a bad edit fails here instead of on the live app. /mute and /unmute are the moderator
// pair (Manage Channels, Discord-side); everything else is open to everyone.
describe("command definitions", () => {
  const defs = CHAT_COMMANDS as {
    name: string;
    description: string;
    contexts: number[];
    integration_types: number[];
    default_member_permissions: string | null;
    previousNames?: string[];
  }[];
  const byName = (n: string) => defs.find((d) => d.name === n)!;

  it("gates /mute and /unmute on Manage Channels", () => {
    expect(byName("mute").default_member_permissions).toBe(MANAGE_CHANNELS_BIT);
    expect(byName("unmute").default_member_permissions).toBe(MANAGE_CHANNELS_BIT);
  });

  it("leaves every other command open", () => {
    for (const d of defs.filter((x) => x.name !== "mute" && x.name !== "unmute")) {
      expect(d.default_member_permissions, `/${d.name} should be open`).toBeNull();
    }
  });

  it("offers /mute and /unmute in bot-less servers too (posts happen there now)", () => {
    for (const name of ["mute", "unmute"]) {
      expect(byName(name).integration_types).toContain(1); // USER_INSTALL
      expect(byName(name).contexts).toEqual([0]); // guild channels only
    }
  });

  it("keeps the pre-rename names so the commands are PATCHed in place, not duplicated", () => {
    expect(byName("mute").previousNames).toContain("disable-posts");
    expect(byName("mute").previousNames).toContain("unsubscribe");
    expect(byName("unmute").previousNames).toContain("enable-posts");
  });

  it("keeps every description inside Discord's 100-char limit", () => {
    for (const d of defs) expect(d.description.length, `/${d.name}`).toBeLessThanOrEqual(100);
  });
});

// The moderator gate for un-muting a channel: clearing a /mute opt-out requires Manage Channels —
// enforced by Discord on the command AND checked in code (defense in depth) from the interaction's
// member.permissions bitfield. Administrator (which implies all perms) counts;
// anything else, or absent/garbage perms, fails closed.
describe("memberCanManageChannels", () => {
  const MANAGE_CHANNELS = (1n << 4n).toString(); // "16"
  const ADMINISTRATOR = (1n << 3n).toString(); // "8"
  const SEND_MESSAGES = (1n << 11n).toString(); // "2048" — a non-mod permission

  it("passes a member with Manage Channels", () => {
    expect(memberCanManageChannels(MANAGE_CHANNELS)).toBe(true);
  });
  it("passes an Administrator (implies all perms)", () => {
    expect(memberCanManageChannels(ADMINISTRATOR)).toBe(true);
  });
  it("passes a full permission bitfield (owner/admin computed set)", () => {
    expect(memberCanManageChannels(((1n << 40n) - 1n).toString())).toBe(true);
  });
  it("fails a member with only ordinary permissions", () => {
    expect(memberCanManageChannels(SEND_MESSAGES)).toBe(false);
    expect(memberCanManageChannels("0")).toBe(false);
  });
  it("fails closed on absent or malformed perms", () => {
    expect(memberCanManageChannels(undefined)).toBe(false);
    expect(memberCanManageChannels("")).toBe(false);
    expect(memberCanManageChannels("not-a-number")).toBe(false);
  });
});

// /mute replies: "done" is a PUBLIC channel post (the channel sees posts were turned off + how to
// turn them back on); "already"/"no-guild"/"error" stay ephemeral so they don't post noise.
describe("disablePostsResult", () => {
  const data = (kind: "done" | "already" | "no-guild" | "error") =>
    (disablePostsResult(kind) as { type: number; data: { flags?: number; content?: string } });

  it("confirms the opt-out publicly and names the /unmute antidote", () => {
    const r = data("done");
    expect(r.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(r.data.flags).toBeUndefined(); // public, not ephemeral
    expect(r.data.content).toContain("off for this channel");
    expect(r.data.content).toContain("/unmute"); // the (only) way back on — it's sticky
    expect(r.data.content).not.toContain("come back automatically"); // no auto re-arm anymore
  });

  it("tells a re-runner posts are already off — ephemerally, so it doesn't re-post", () => {
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
    expect(r.data.content).toContain("`/mute` again");
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

// ——— the /share COMMAND, end to end through the interactions webhook ———
//
// /share posts the rendered PORTRAIT CARD now, not the emoji grid inline. api/interactions.ts is the
// function Discord holds to a 3s deadline and it must never carry @napi-rs/canvas (the owner rule
// the "who's playing" card already established), so the split is: DECIDE here, DEFER publicly, and
// fire a fire-and-forget self-call to /api/post-share, which renders and edits the deferred message.
//
// These drive the real signed webhook handler, so they pin both halves of that contract: a shareable
// game must answer type 5 (deferred, PUBLIC — same visibility the inline card had) AND fire the
// self-call; every pre-check that answers WITHOUT a result must still answer inline, ephemerally,
// and must NOT fire it (a not-yet-played /share still can't put anything in the channel).
describe("/share command handler", () => {
  const post = async (body: unknown): Promise<{ status: number; body: any }> => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const req: any = {
      method: "POST",
      headers: { "x-signature-ed25519": sigFor(raw, ts), "x-signature-timestamp": ts },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(raw);
      },
    };
    const res: any = {
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      json(b: unknown) {
        this.jsonBody = b;
        return this;
      },
      setHeader() {},
    };
    await interactionsHandler(req, res);
    // Drain the self-call the handler fires after the response is flushed.
    await Promise.all(shareRoute.pending.splice(0));
    return { status: res.statusCode, body: res.jsonBody };
  };

  const shareInteraction = (): object => ({
    type: 2,
    data: { name: "share" },
    application_id: "app1",
    token: "interaction_tok_abc",
    guild_id: "guild123",
    channel_id: "chan123",
    member: { user: { id: SHARE_UID, username: "alice" } },
  });

  const calls = (): [string, RequestInit][] => (globalThis.fetch as any).mock.calls;

  beforeEach(() => {
    shareRoute.progress = [];
    shareRoute.pending = [];
    process.env.DISCORD_PUBLIC_KEY = pubHex;
    process.env.INTERNAL_SECRET = "s3cret";
    process.env.POST_CARD_URL = "https://disconnections.test";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 })),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("defers PUBLICLY and hands the render to /api/post-share", async () => {
    shareRoute.progress.push({ user_id: SHARE_UID, puzzle_date: SHARE_DATE, guesses: SHARE_WON });
    const r = await post(shareInteraction());

    // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE. No flags: the picture lands in the channel,
    // exactly where the emoji card used to (an EPHEMERAL flag here would hide the share).
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ type: 5 });

    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(url).toBe("https://disconnections.test/api/post-share");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    // Identity + date only. The grid is NOT on the wire: post-share replays it from the player's
    // own progress record, so nothing here can be forged into someone else's result.
    expect(JSON.parse(init.body as string)).toEqual({
      appId: "app1",
      token: "interaction_tok_abc",
      userId: SHARE_UID,
      date: SHARE_DATE,
    });
  });

  it("nudges a player who hasn't played, ephemerally, and renders nothing", async () => {
    const r = await post(shareInteraction());
    expect(r.body.type).toBe(4); // inline reply, not a deferral
    expect(r.body.data.flags).toBe(64); // EPHEMERAL — only the invoker sees it
    expect(r.body.data.content).toContain("haven’t played");
    expect(calls()).toHaveLength(0);
  });

  it("nudges a player mid-puzzle, ephemerally, and renders nothing", async () => {
    shareRoute.progress.push({
      user_id: SHARE_UID,
      puzzle_date: SHARE_DATE,
      guesses: [["A0", "B0", "C0", "A1"]],
    });
    const r = await post(shareInteraction());
    expect(r.body.type).toBe(4);
    expect(r.body.data.flags).toBe(64);
    expect(r.body.data.content).toContain("Still mid-puzzle");
    expect(r.body.data.content).toContain("0/4"); // no group solved yet
    expect(calls()).toHaveLength(0);
  });

  it("nudges ephemerally when the interaction carries no user", async () => {
    const { member: _member, ...noUser } = shareInteraction() as Record<string, unknown>;
    const r = await post(noUser);
    expect(r.body.data.flags).toBe(64);
    expect(calls()).toHaveLength(0);
  });

  it("never defers on an unsigned request", async () => {
    shareRoute.progress.push({ user_id: SHARE_UID, puzzle_date: SHARE_DATE, guesses: SHARE_WON });
    const raw = JSON.stringify(shareInteraction());
    const req: any = {
      method: "POST",
      headers: { "x-signature-ed25519": "00", "x-signature-timestamp": "1" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(raw);
      },
    };
    const res: any = { status(n: number) { this.statusCode = n; return this; }, json(b: unknown) { this.jsonBody = b; return this; }, setHeader() {} };
    await interactionsHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(calls()).toHaveLength(0);
  });
});
