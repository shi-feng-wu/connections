// User-facing changelog. The entries live in changelog.md (plain text, one block per
// release) so they're easy to edit without touching component code; this module parses
// that file into the structure the Changelog view renders. Both APP_VERSION (the latest
// release, which drives the "unseen" badge) and the per-release "New" flag are derived
// from the file — the top block is always the newest — so there's nothing to keep in
// sync by hand.
import changelogRaw from "./changelog.md?raw";

// A SemVer release, grouped into Keep-a-Changelog sections (Added / Changed / Fixed / …).
export type Section = { label: string; items: string[] };
export type Release = { v: string; d: string; isNew?: boolean; sections: Section[] };

// Parse the markdown source. Format, newest first:
//   ## <version> — <date>
//   ### <Category>
//   - one item per line
// A "## " header opens a release (version = first non-space token, date = the rest after
// the dash). A "### " line opens a category section within the current release; each
// following "- "/"* " line is an item appended to the open section. Items before any
// section (or in malformed input) fall into an implicit untitled section so nothing is
// dropped. Everything else (the top comment, blank lines) is ignored. The first release
// parsed is flagged isNew.
const HEADER = /^##\s+(\S+)\s+[—–-]\s+(.+?)\s*$/;
const SECTION = /^###\s+(.+?)\s*$/;
const ITEM = /^[-*]\s+(.+?)\s*$/;

export function parseChangelog(raw: string): Release[] {
  const releases: Release[] = [];
  for (const line of raw.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      releases.push({ v: header[1], d: header[2], sections: [], isNew: releases.length === 0 });
      continue;
    }
    const rel = releases[releases.length - 1];
    if (!rel) continue;

    const section = SECTION.exec(line);
    if (section) {
      rel.sections.push({ label: section[1], items: [] });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      let sec = rel.sections[rel.sections.length - 1];
      if (!sec) rel.sections.push((sec = { label: "", items: [] }));
      sec.items.push(item[1]);
    }
  }
  return releases;
}

export const CHANGELOG: Release[] = parseChangelog(changelogRaw);

// Latest shipped version — shown at the foot of the bar/sheet and tracked for the
// "What's New" badge. Falls back only if the file is somehow empty.
export const APP_VERSION: string = CHANGELOG[0]?.v ?? "v1.0";
