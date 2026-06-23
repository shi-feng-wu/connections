import { describe, it, expect } from "vitest";
import { parseChangelog, CHANGELOG, APP_VERSION } from "./changelog";

describe("parseChangelog", () => {
  const sample = [
    "<!-- a comment mentioning ## and - that must be ignored -->",
    "",
    "## v2.0 — Jul 1, 2026",
    "- First item.",
    "- Second item — with an em dash inside.",
    "",
    "## v1.9 — Jun 1, 2026",
    "- Only item.",
  ].join("\n");

  it("parses headers into version + date and lines into items", () => {
    const out = parseChangelog(sample);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ v: "v2.0", d: "Jul 1, 2026" });
    expect(out[0].items).toEqual([
      "First item.",
      "Second item — with an em dash inside.",
    ]);
    expect(out[1]).toMatchObject({ v: "v1.9", d: "Jun 1, 2026", items: ["Only item."] });
  });

  it("flags only the first (newest) release as new", () => {
    const out = parseChangelog(sample);
    expect(out[0].isNew).toBe(true);
    expect(out[1].isNew).toBe(false);
  });

  it("ignores the top comment, blank lines, and stray text", () => {
    const out = parseChangelog("intro line\n\n## v1.0 — Jan 1, 2026\nnot an item\n- Real.\n");
    expect(out).toHaveLength(1);
    expect(out[0].items).toEqual(["Real."]);
  });
});

describe("CHANGELOG (parsed from changelog.md)", () => {
  it("has entries, newest first, with the New flag only on the top one", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[0].isNew).toBe(true);
    expect(CHANGELOG.slice(1).every((e) => !e.isNew)).toBe(true);
  });

  it("derives APP_VERSION from the latest release", () => {
    expect(APP_VERSION).toBe(CHANGELOG[0].v);
  });

  it("gives every release a version, a date, and at least one non-empty item", () => {
    for (const e of CHANGELOG) {
      expect(e.v).toMatch(/^v\d/);
      expect(e.d.length).toBeGreaterThan(0);
      expect(e.items.length).toBeGreaterThan(0);
      expect(e.items.every((it) => it.trim().length > 0)).toBe(true);
    }
  });
});
