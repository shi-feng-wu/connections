// Vendors the web fonts the app uses into public/fonts/ as self-hosted woff2.
//
// Discord Activities sandbox ALL network requests through *.discordsays.com and
// only the mapped prefixes (/, /supabase) resolve — so a direct load from
// fonts.googleapis.com / fonts.gstatic.com is blocked and the UI silently falls
// back to Georgia/system fonts (the "flat" score serif). Serving the fonts from
// our own origin (the `/` mapping) makes them load inside Discord too.
//
// Both families are variable fonts, so we fetch ONE woff2 per family covering the
// whole weight range the UI spans — browsers (incl. Discord's Chromium webview)
// render every weight from it. (The server-side card renderer is the one that
// can't use variable axes; it keeps its own static TTFs in api/_assets.)
//
// Run once after changing the weight range:  node scripts/vendor-fonts.mjs
// Only the `latin` subset (U+0000-00FF) is fetched — the UI is English-only.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");

// Weight RANGES (not pinned weights) so Google serves the variable font once.
// Newsreader: 400 (clock) → 700 (score/wordmark). Libre Franklin: 400 → 800.
const CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Newsreader:opsz,wght@6..72,400..700" +
  "&family=Libre+Franklin:wght@400..800" +
  "&display=swap";

// A modern desktop UA makes Google serve woff2 (older UAs get ttf/woff).
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const slug = (family) => family.toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "-");

const css = await fetch(CSS_URL, { headers: { "User-Agent": UA } }).then((r) => {
  if (!r.ok) throw new Error(`Google Fonts CSS ${r.status}`);
  return r.text();
});

// Each family emits one @font-face per subset, prefixed by a `/* subset */`
// comment. Keep only `latin`, dedupe by family (the variable file is shared).
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];

await mkdir(OUT, { recursive: true });

const seen = new Set();
const faces = [];
for (const [, subset, body] of blocks) {
  if (subset !== "latin") continue;
  const family = body.match(/font-family:\s*'([^']+)'/)[1];
  if (seen.has(family)) continue;
  seen.add(family);

  const weight = body.match(/font-weight:\s*([\d ]+);/)[1].trim(); // ex. "400 700"
  const url = body.match(/url\((https:\/\/[^)]+\.woff2)\)/)[1];
  const file = `${slug(family)}.woff2`;

  const buf = Buffer.from(await fetch(url, { headers: { "User-Agent": UA } }).then((r) => r.arrayBuffer()));
  await writeFile(join(OUT, file), buf);
  console.log(`  ${file}  (${(buf.length / 1024).toFixed(1)} KB, weights ${weight})`);

  faces.push(
    `@font-face {\n` +
      `  font-family: "${family}";\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${weight};\n` +
      `  font-display: swap;\n` +
      `  src: url("/fonts/${file}") format("woff2");\n` +
      `}`,
  );
}

console.log(`\nGenerated ${faces.length} @font-face rules. Paste into src/index.css:\n`);
console.log(faces.join("\n"));
