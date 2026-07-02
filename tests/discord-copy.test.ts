import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs parser shared with scripts/gen-discord-copy.mjs (no types).
import { parseDiscordCopy } from "../scripts/discord-copy-parse.mjs";
import { COPY } from "../src/discord-copy";

// src/discord-copy.md is the source of truth for every message we post to Discord; src/discord-copy.ts
// is generated from it (so it imports cleanly in both the server functions and the browser preview).
// This guards the two from drifting: if someone edits the .md without running `npm run gen:copy`, or
// hand-edits the generated .ts, this fails.
const md = readFileSync(new URL("../src/discord-copy.md", import.meta.url), "utf8");

describe("discord copy", () => {
  it("the generated COPY matches a fresh parse of discord-copy.md (run `npm run gen:copy`)", () => {
    expect({ ...COPY }).toEqual(parseDiscordCopy(md));
  });

  it("includes every key the code reads", () => {
    // Keep in sync with the COPY[...] lookups across api/ + src/. A missing key would render an
    // empty message, so fail loudly here instead.
    const required = [
      "donate",
      "enable-posts.add-bot",
      "enable-posts.already",
      "install-nudge",
      "missing-perms",
      "unsubscribe.done",
      "unsubscribe.already",
      "unsubscribe.no-guild",
      "unsubscribe.error",
      "share.no-account",
      "share.unavailable",
      "share.not-played",
      "share.load-failed",
      "share.mid-puzzle",
      "share.build-failed",
      "reply-dm.subject",
      "reply-dm.subject-blank",
      "reply-dm.context-label",
      "reply-dm.footer",
      "unsupported",
      "button.play",
      "button.add-server",
      "button.donate",
      "card.playing",
      "recap.tail",
      "recap.streak",
      "recap.broken-prefix",
      "recap.stumped",
      "recap.no-play",
      "recap.new-day",
    ];
    for (const key of required) {
      expect(COPY, `missing copy key: ${key}`).toHaveProperty([key]);
      expect((COPY as Record<string, string>)[key].length, `empty copy: ${key}`).toBeGreaterThan(0);
    }
  });

  it("templated messages keep their placeholders", () => {
    expect(COPY["card.playing"]).toContain("{subject}");
    expect(COPY["card.playing"]).toContain("{verb}");
    expect(COPY["share.mid-puzzle"]).toContain("{solved}");
    expect(COPY["share.mid-puzzle"]).toContain("{mistakes}");
    expect(COPY["recap.streak"]).toContain("{streak}");
    expect(COPY["recap.streak"]).toContain("{fires}");
    expect(COPY["reply-dm.subject"]).toContain("{subject}");
  });
});
