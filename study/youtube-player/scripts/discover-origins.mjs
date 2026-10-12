// Lists the origins a page has fetched resources from, using the page's own
// Resource Timing entries over CDP. REA scopes captures to exact origins and
// only reports *counts* of what it filtered out, so this is how the harness
// finds e.g. the per-server media host to add to --allowed-origins.
// Usage: node scripts/discover-origins.mjs <cdpEndpoint> <targetId> <regex>
// Needs Node 22+ (global WebSocket).
const [endpoint, targetId, pattern = '.'] = process.argv.slice(2);
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find((t) => t.id === targetId);
if (!target?.webSocketDebuggerUrl) process.exit(0);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `[...new Set(performance.getEntriesByType('resource').map((e) => { try { return new URL(e.name).origin } catch { return '' } }))]`,
      returnByValue: true,
    },
  }),
);
const reply = await new Promise((resolve) => {
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id === 1) resolve(msg);
  };
});
ws.close();

const re = new RegExp(pattern);
const origins = (reply.result?.result?.value ?? []).filter((o) => o.startsWith('http') && re.test(o));
console.log(origins.join('\n'));
