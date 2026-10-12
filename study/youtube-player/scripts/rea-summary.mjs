// Condenses one rea-study.sh run (rea-out/<run>/*.json) into a short Markdown
// study sheet: what loads, what talks to the network, what the controls are,
// and which code handles media events. Usage: node scripts/rea-summary.mjs <runDir>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const load = (name) => {
  const f = join(dir, `${name}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')).normalized_result ?? null;
  } catch {
    return null;
  }
};
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const short = (url) => {
  try {
    const u = new URL(url);
    return u.pathname.length > 70 ? `…${u.pathname.slice(-70)}` : u.pathname;
  } catch {
    return url;
  }
};
const where = (loc) => (loc ? `${short(loc.url)}:${loc.line_number + 1}` : '?');
const out = [];
const h = (s) => out.push('', `## ${s}`, '');

const page = load('page');
out.push(`# REA study sheet`, '', `Target: ${page?.target?.url ?? '(no page capture)'}  `, `Run: \`${dir}\``);

if (page) {
  h('Scripts');
  const scripts = page.scripts.items;
  out.push(`${scripts.length} scripts, ${kb(scripts.reduce((a, s) => a + s.length, 0))} total, ${scripts.filter((s) => s.is_module).length} ES modules.`, '');
  for (const s of [...scripts].sort((a, b) => b.length - a.length).slice(0, 12)) out.push(`- ${kb(s.length).padStart(9)}  ${short(s.url)}`);

  h('Network during the capture window');
  // Group by URL path with digits collapsed, so seg001/seg002/... become one row.
  const groups = new Map();
  for (const r of page.network.requests) {
    const key = `${r.resource_type} ${short(r.url).replace(/\d+/g, '#')}`;
    const g = groups.get(key) ?? { n: 0, bytes: 0, mime: r.mime_type, initiator: r.initiator };
    g.n++;
    g.bytes += r.encoded_data_length ?? 0;
    groups.set(key, g);
  }
  out.push('| count | bytes | type / path pattern | mime | initiator |', '|---|---|---|---|---|');
  for (const [k, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25)) {
    out.push(`| ${g.n} | ${kb(g.bytes)} | \`${k}\` | ${g.mime ?? ''} | ${g.initiator?.url ? where({ url: g.initiator.url, line_number: g.initiator.line ?? 0 }) : (g.initiator?.type ?? '')} |`);
  }
  out.push('', '_Coverage starts when REA attaches; requests made before that are not listed._');

  const shapes = page.network.requests.filter((r) => r.body_shapes?.response?.paths?.length);
  if (shapes.length) {
    h('JSON response shapes (top-level keys)');
    for (const r of shapes.slice(0, 8)) {
      const top = new Set(r.body_shapes.response.paths.map((p) => p.path?.[0]?.name).filter(Boolean));
      out.push(`- \`${short(r.url)}\`: ${[...top].slice(0, 30).join(', ')}`);
    }
  }

  h('Player controls (accessibility tree)');
  const controls = page.accessibility.nodes.filter((n) => !n.ignored && ['button', 'slider', 'menuitem', 'menuitemradio', 'checkbox'].includes(n.role) && n.name);
  out.push(controls.length ? controls.slice(0, 40).map((n) => `- ${n.role}: “${n.name}”`).join('\n') : '(none with names)');

  h('Page facts');
  out.push(`- DOM nodes: ${page.dom.total_nodes}`, `- Workers: ${page.workers.length}`, `- localStorage keys: ${page.storage.local_storage_keys.join(', ') || '(none)'}`);
  out.push(`- WebSocket connections: ${page.network.websocket_connections.length}`, `- Capture completeness: ${page.completeness.status}`);
}

for (const [name, label] of [
  ['listeners-video', '<video> element'],
  ['listeners-player', 'player root'],
]) {
  const l = load(name);
  if (!l?.listeners) continue;
  h(`Event listeners on the ${label}`);
  const byType = new Map();
  for (const x of l.listeners) byType.set(x.type, [...(byType.get(x.type) ?? []), where(x.location)]);
  for (const [type, locs] of byType) out.push(`- \`${type}\` → ${[...new Set(locs)].join(', ')}`);
}

const exec = load('execution');
if (exec?.coverage?.scripts) {
  h('Functions that ran during the interaction window');
  const fns = exec.coverage.scripts.flatMap((s) =>
    s.functions.map((f) => ({ url: s.reported_url, name: f.name || '(anonymous)', count: Math.max(...f.ranges.map((r) => r.count ?? 0)) })),
  );
  for (const f of fns.filter((f) => f.count > 0).sort((a, b) => b.count - a.count).slice(0, 25)) {
    out.push(`- ${String(f.count).padStart(6)}×  ${f.name}  _(${short(f.url)})_`);
  }
}

const bundle = load('bundle');
if (bundle?.observations) {
  h('Static bundle analysis');
  const o = bundle.observations;
  out.push(`- Module/chunk edges: ${o.chunks.edges.length}`, `- Route candidates: ${o.routes.length}`, `- Endpoint candidates: ${o.endpoints.length}`);
  for (const e of o.endpoints.slice(0, 15)) out.push(`  - \`${e.value}\` (${e.mechanism})`);
}

console.log(out.join('\n'));
