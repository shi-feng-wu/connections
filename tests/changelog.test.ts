import { describe, it, expect } from "vitest";
import { parseChangelog, CHANGELOG, APP_VERSION } from "../src/changelog";

describe("parseChangelog", () => {
  const sample = [
    "<!-- a comment mentioning ## and - that must be ignored -->",
    "",
    "## v2.0.0 — Jul 1, 2026",
    "### Added",
    "- First item.",
    "- Second item — with an em dash inside.",
    "### Fixed",
    "- A fix.",
    "",
    "## v1.9.0 — Jun 1, 2026",
    "### Added",
    "- Only item.",
  ].join("\n");

  it("parses headers into version + date and sections into labelled item lists", () => {
    const out = parseChangelog(sample);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ v: "v2.0.0", d: "Jul 1, 2026" });
    expect(out[0].sections).toEqual([
      { label: "Added", items: ["First item.", "Second item — with an em dash inside."] },
      { label: "Fixed", items: ["A fix."] },
    ]);
    expect(out[1]).toMatchObject({ v: "v1.9.0", d: "Jun 1, 2026" });
    expect(out[1].sections).toEqual([{ label: "Added", items: ["Only item."] }]);
  });

  it("flags only the first (newest) release as new", () => {
    const out = parseChangelog(sample);
    expect(out[0].isNew).toBe(true);
    expect(out[1].isNew).toBe(false);
  });

  it("ignores the top comment, blank lines, and stray text", () => {
    const out = parseChangelog(
      "intro line\n\n## v1.0.0 — Jan 1, 2026\n### Added\nnot an item\n- Real.\n",
    );
    expect(out).toHaveLength(1);
    expect(out[0].sections).toEqual([{ label: "Added", items: ["Real."] }]);
  });

  it("collects items before any section into an implicit untitled one", () => {
    const out = parseChangelog("## v1.0.0 — Jan 1, 2026\n- Loose item.\n### Added\n- Grouped.");
    expect(out[0].sections).toEqual([
      { label: "", items: ["Loose item."] },
      { label: "Added", items: ["Grouped."] },
    ]);
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

  it("uses three-part SemVer versions (vMAJOR.MINOR.PATCH)", () => {
    for (const e of CHANGELOG) {
      expect(e.v).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });

  it("gives every release a date and at least one non-empty item in a labelled section", () => {
    for (const e of CHANGELOG) {
      expect(e.d.length).toBeGreaterThan(0);
      expect(e.sections.length).toBeGreaterThan(0);
      const items = e.sections.flatMap((s) => s.items);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((it) => it.trim().length > 0)).toBe(true);
      // Real releases always label their sections (Added / Changed / Fixed / …).
      expect(e.sections.every((s) => s.label.trim().length > 0)).toBe(true);
    }
  });
});
