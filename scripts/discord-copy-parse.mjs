// Pure parser for src/discord-copy.md → { "key": "text" }. Shared by scripts/gen-discord-copy.mjs
// (which bakes the result into src/discord-copy.ts at build time) and tests/discord-copy.test.ts
// (the drift guard). Zero deps so both can import it.
//
// Format: each message is a "## key" header followed by its text. The body is every line up to the
// next header, with leading/trailing blank lines trimmed and internal newlines kept (so a message
// can span multiple lines, e.g. a "-#" small-print line). HTML comments are stripped. Dynamic bits
// are written as {placeholders} and filled at runtime by fill() in src/copy-util.ts.
export function parseDiscordCopy(raw) {
  const noComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  const out = {};
  let key = null;
  let lines = [];
  const flush = () => {
    if (key === null) return;
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    out[key] = lines.join('\n');
    lines = [];
  };
  for (const line of noComments.split('\n')) {
    const header = /^##\s+(\S+)\s*$/.exec(line);
    if (header) {
      flush();
      key = header[1];
    } else if (key !== null) {
      lines.push(line);
    }
  }
  flush();
  return out;
}
