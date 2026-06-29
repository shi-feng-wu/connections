// Bakes src/discord-copy.md into src/discord-copy.ts so the copy can be imported as a plain object
// in BOTH the server functions (esbuild) and the browser preview (Vite) — a bare .md can't be
// imported uniformly across those two builds (Vite's ?raw breaks esbuild). The .md is the source of
// truth; this regenerates the .ts. Wired into `npm run gen:copy`, and into `dev`/`build` so it can't
// go stale; tests/discord-copy.test.ts fails if the committed .ts drifts from the .md.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDiscordCopy } from './discord-copy-parse.mjs';

const mdUrl = new URL('../src/discord-copy.md', import.meta.url);
const tsUrl = new URL('../src/discord-copy.ts', import.meta.url);

const copy = parseDiscordCopy(readFileSync(mdUrl, 'utf8'));
const out =
  '// GENERATED from src/discord-copy.md by scripts/gen-discord-copy.mjs — DO NOT EDIT BY HAND.\n' +
  '// Edit the wording in src/discord-copy.md, then run `npm run gen:copy` (the build also does this).\n' +
  `export const COPY = ${JSON.stringify(copy, null, 2)} as const;\n`;
writeFileSync(tsUrl, out);
console.log(`[gen-copy] wrote ${Object.keys(copy).length} keys to src/discord-copy.ts`);
