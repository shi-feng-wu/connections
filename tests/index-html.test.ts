import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// index.html is not just the landing document — it is what the Discord Activity iframe loads, and
// Vite injects the app's entry <script type="module"> and its stylesheet by finding the FIRST
// "</head>" in this file. That makes the closing tag load-bearing in a way nothing else warns you
// about: any earlier occurrence of the literal text, INCLUDING INSIDE AN HTML COMMENT, silently
// captures the injection.
//
// This is not hypothetical. On 2026-08-15 an SEO comment explaining that the head "must stay INERT"
// contained the literal </head>, so Vite injected the entire bundle inside that comment. The build
// passed, every unit test passed, the assets served 200 — and the app never booted for anyone. Every
// launch died on the 20s watchdog for eight hours, across every platform, until it was reverted.
//
// So: the closing tags appear exactly once, and the entry script is the last thing before </head>.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("index.html", () => {
  it("contains exactly one </head> — Vite injects the entry bundle at the first one it finds", () => {
    const hits = html.match(/<\/head>/gi) ?? [];
    expect(
      hits.length,
      "A second </head> anywhere in this file — a comment, a string, a noscript block — steals the " +
        "bundle injection and the app silently never boots. Rephrase it (e.g. 'the closing head tag').",
    ).toBe(1);
  });

  it("contains exactly one </body>, for the same reason", () => {
    expect((html.match(/<\/body>/gi) ?? []).length).toBe(1);
  });

  // The failure mode above is invisible in the source: it only appears once Vite has injected. Pin
  // the shape the injector needs — a head that closes after everything else in it.
  it("closes the head after the last element in it", () => {
    const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
    expect(head).toContain("<title>");
    expect(head.split("<!--").length).toBe(head.split("-->").length);
  });
});
