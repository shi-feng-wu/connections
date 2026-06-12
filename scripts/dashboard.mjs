// Private admin dashboard for the Connections Activity. LOCAL ONLY.
//
// WHY THIS IS PRIVATE: the server binds to 127.0.0.1 (loopback) — it is not reachable
// from your network, let alone the internet. It reads the database with the Supabase
// SERVICE ROLE key from .env (bypasses RLS, sees every table), which never leaves your
// machine. Nothing is deployed; "only I have access" = it only exists while you run it,
// only on this box. Do NOT expose this behind a tunnel/0.0.0.0 — that would publish the
// full database to anyone.
//
// Run:
//   pnpm dashboard            # opens http://127.0.0.1:7337
//   DASHBOARD_PORT=8080 pnpm dashboard
// Needs SUPABASE_URL (or VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY in .env
// (loaded via --env-file). No build step, no tsx — plain node, like `pnpm status`.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in .env.');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const PORT = Number(process.env.DASHBOARD_PORT ?? 7337);
const HOST = '127.0.0.1'; // loopback only — see header. Do not change to 0.0.0.0.
const ONLINE_TTL_MS = 15_000; // matches ROSTER_ONLINE_TTL_MS in api/roster.ts (green ring)

// ── data ────────────────────────────────────────────────────────────────────

// Pull every scores row (the app's core fact table) and aggregate in JS. A personal
// app's history is small; paginate past Supabase's 1000-row default just in case.
async function fetchAllScores() {
  const cols =
    'puzzle_id, puzzle_date, scope_id, channel_id, user_id, name, avatar, score, mistakes, solved, groups_solved, duration_ms, created_at';
  const page = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    const { data, error } = await db
      .from('scores')
      .select(cols)
      .order('created_at', { ascending: false })
      .range(from, from + page - 1);
    if (error) throw new Error('scores: ' + error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  return out;
}

// Every carded live_cards row (one per scope/day/channel — grows daily, so the
// table sailed past Supabase's 1000-row default and the old single select silently
// undercounted distinct servers). Paginate like fetchAllScores.
async function fetchAllCards() {
  const page = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    const { data, error } = await db
      .from('live_cards')
      .select('scope_id, message_id')
      .not('message_id', 'is', null)
      .order('scope_id')
      .range(from, from + page - 1);
    if (error) throw new Error('live_cards: ' + error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  return out;
}

// True bot installs, straight from Discord (same source as the email they send).
// live_cards can't tell you this: cards also exist in user-install servers (posted via
// the interaction webhook, no bot in the guild) and rows outlive servers that removed
// the bot. Guild listing mirrors fetchBotGuildIds in api/cron-recap.ts. Returns null
// when the token is missing or Discord errors, so the KPI shows "—" instead of a
// wrong number.
//
// The timeline comes from the bot's own member joined_at in each guild
// (GET /guilds/{id}/members/{botUserId} — the OAuth2-flavored /users/@me/guilds/{id}/member
// 403s for bot tokens). Discord keeps no log of past installs, so this is "current
// guilds by the day the bot joined"; servers that removed the bot drop out of the
// whole curve. joined_at never changes for a guild, so it's cached per guild id and
// only newly-seen guilds cost requests on the 30s auto-refresh.
let botUserId = null; // the bot's own user id, fetched once
const joinedAtByGuild = new Map(); // guild id -> 'YYYY-MM-DD' (absent = not fetched yet or last attempt failed)
async function fetchBotInstalls() {
  const token = process.env.DISCORD_BOT_TOKEN ?? '';
  if (!token) return null;
  const headers = { Authorization: `Bot ${token}` };
  try {
    const ids = new Set();
    let after = '';
    for (;;) {
      const url = `https://discord.com/api/v10/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      const page = await r.json();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const g of page) ids.add(g.id);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
    if (!botUserId) {
      const r = await fetch('https://discord.com/api/v10/users/@me', { headers });
      if (r.ok) botUserId = (await r.json()).id;
    }
    const missing = botUserId ? [...ids].filter((id) => !joinedAtByGuild.has(id)) : [];
    for (let i = 0; i < missing.length; i += 10) {
      await Promise.all(
        missing.slice(i, i + 10).map(async (id) => {
          const r = await fetch(`https://discord.com/api/v10/guilds/${id}/members/${botUserId}`, { headers });
          if (!r.ok) return; // left absent → retried on the next refresh
          const m = await r.json();
          if (m?.joined_at) joinedAtByGuild.set(id, m.joined_at.slice(0, 10));
        }),
      );
    }
    const joins = [...ids].map((id) => joinedAtByGuild.get(id)).filter(Boolean);
    return { count: ids.size, joins };
  } catch {
    return null;
  }
}

function isoMinusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadStats() {
  const rows = await fetchAllScores();

  const dateSet = new Set();
  for (const r of rows) if (r.puzzle_date) dateSet.add(r.puzzle_date);
  const allDates = [...dateSet].sort();
  const latestDate = allDates.length ? allDates[allDates.length - 1] : null;

  const [{ data: presence }, cards, { count: puzzlesCached }, installs] = await Promise.all([
    latestDate
      ? db.from('presence').select('user_id, last_seen').eq('puzzle_date', latestDate)
      : Promise.resolve({ data: [] }),
    fetchAllCards(),
    db.from('puzzles').select('*', { count: 'exact', head: true }),
    fetchBotInstalls(),
  ]);

  const now = Date.now();
  const players = new Set();
  const scopes = new Set();
  let solved = 0;
  let mistakesSum = 0;
  let scoreSum = 0;

  const byDate = new Map(); // date -> { players:Set, wins, scopes:Set }
  const byScope = new Map(); // scope -> { games, players:Set, wins, first, last }
  const byUser = new Map(); // user -> aggregate (rows are created_at desc → first seen = newest)
  const firstSeenUser = new Map(); // user -> earliest puzzle_date
  const firstSeenScope = new Map(); // scope -> earliest puzzle_date
  const userDayNums = new Map(); // user -> Set of epoch-day numbers they played (for retention)

  for (const r of rows) {
    players.add(r.user_id);
    if (r.scope_id) scopes.add(r.scope_id);
    if (r.solved) solved++;
    mistakesSum += r.mistakes ?? 0;
    scoreSum += r.score ?? 0;

    if (r.puzzle_date) {
      const d = byDate.get(r.puzzle_date) ?? { players: new Set(), wins: 0, scopes: new Set() };
      d.players.add(r.user_id);
      if (r.solved) d.wins++;
      if (r.scope_id) d.scopes.add(r.scope_id);
      byDate.set(r.puzzle_date, d);

      const fu = firstSeenUser.get(r.user_id);
      if (!fu || r.puzzle_date < fu) firstSeenUser.set(r.user_id, r.puzzle_date);
      let uset = userDayNums.get(r.user_id);
      if (!uset) userDayNums.set(r.user_id, (uset = new Set()));
      uset.add(Math.round(Date.parse(r.puzzle_date + 'T00:00:00Z') / 86400000));
      if (r.scope_id) {
        const fs = firstSeenScope.get(r.scope_id);
        if (!fs || r.puzzle_date < fs) firstSeenScope.set(r.scope_id, r.puzzle_date);
      }
    }

    if (r.scope_id) {
      const s = byScope.get(r.scope_id) ?? { games: 0, players: new Set(), wins: 0, last: '' };
      s.games++;
      s.players.add(r.user_id);
      if (r.solved) s.wins++;
      if ((r.puzzle_date ?? '') > s.last) s.last = r.puzzle_date ?? '';
      byScope.set(r.scope_id, s);
    }

    const u = byUser.get(r.user_id);
    if (!u) {
      byUser.set(r.user_id, {
        name: r.name, avatar: r.avatar, total: r.score ?? 0, plays: 1,
        wins: r.solved ? 1 : 0, mistakes: r.mistakes ?? 0,
      });
    } else {
      u.total += r.score ?? 0;
      u.plays++;
      if (r.solved) u.wins++;
      u.mistakes += r.mistakes ?? 0;
    }
  }

  // new players / new servers per day, from first-appearance maps
  const newUsersByDate = new Map();
  for (const d of firstSeenUser.values()) newUsersByDate.set(d, (newUsersByDate.get(d) ?? 0) + 1);
  const newScopesByDate = new Map();
  for (const d of firstSeenScope.values()) newScopesByDate.set(d, (newScopesByDate.get(d) ?? 0) + 1);

  // full daily series with running (cumulative) reach
  let cumPlayers = 0;
  let cumServers = 0;
  const series = allDates.map((date) => {
    const e = byDate.get(date);
    const newp = newUsersByDate.get(date) ?? 0;
    const news = newScopesByDate.get(date) ?? 0;
    cumPlayers += newp;
    cumServers += news;
    return {
      date,
      players: e.players.size,
      activeServers: e.scopes.size,
      newPlayers: newp,
      newServers: news,
      cumPlayers,
      cumServers,
      solveRate: e.players.size ? e.wins / e.players.size : 0,
    };
  });

  // popularity KPIs
  const weekAgo = latestDate ? isoMinusDays(latestDate, 7) : null;
  let newPlayers7 = 0;
  if (weekAgo) for (const d of firstSeenUser.values()) if (d > weekAgo) newPlayers7++;
  const wau = new Set(); // weekly active users
  if (weekAgo) for (const r of rows) if (r.puzzle_date && r.puzzle_date > weekAgo) wau.add(r.user_id);
  let peak = { date: null, players: 0 };
  for (const d of series) if (d.players > peak.players) peak = { date: d.date, players: d.players };

  // ── retention ──────────────────────────────────────────────────────────────
  // Classic day-N retention for a daily game: of players who first played on day D,
  // how many also played on day D+N. Only offsets that have elapsed (D+N ≤ latest)
  // count, so a fresh cohort never reads as "0% retained" for days that haven't happened.
  const dn = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
  const latestDayNum = latestDate ? dn(latestDate) : 0;
  const datedPlayers = userDayNums.size;

  const cohorts = new Map(); // first-play day -> { dayNum, date, members:[user] }
  for (const [u, firstIso] of firstSeenUser) {
    const c = dn(firstIso);
    const e = cohorts.get(c) ?? { dayNum: c, date: firstIso, members: [] };
    e.members.push(u);
    cohorts.set(c, e);
  }

  const earliestCohort = cohorts.size ? Math.min(...cohorts.keys()) : latestDayNum;
  const maxOffset = Math.min(30, latestDayNum - earliestCohort);
  const elig = new Array(maxOffset + 1).fill(0);
  const retd = new Array(maxOffset + 1).fill(0);
  for (const [u, firstIso] of firstSeenUser) {
    const f = dn(firstIso);
    const set = userDayNums.get(u);
    const top = Math.min(maxOffset, latestDayNum - f);
    for (let N = 0; N <= top; N++) {
      elig[N]++;
      if (set.has(f + N)) retd[N]++;
    }
  }
  const curveAll = elig.map((e, N) => ({ n: N, eligible: e, pct: e ? retd[N] / e : 0 }));
  const minElig = Math.max(8, Math.round(datedPlayers * 0.02)); // trim the noisy small-sample tail
  let lastN = 1;
  for (let N = 0; N < curveAll.length; N++) if (curveAll[N].eligible >= minElig) lastN = N;
  const curve = curveAll.slice(0, Math.max(2, lastN + 1));
  const atN = (N) => (curveAll[N] && curveAll[N].eligible >= 8 ? curveAll[N].pct : null);

  let multiDay = 0;
  let activeDaysSum = 0;
  for (const set of userDayNums.values()) {
    activeDaysSum += set.size;
    if (set.size >= 2) multiDay++;
  }

  const gridMaxOffset = Math.min(maxOffset, 14);
  const cohortList = [...cohorts.values()].sort((a, b) => a.dayNum - b.dayNum);
  // Hide tiny cohorts (n<5) — their 100%/0% cells are noise, not signal. The aggregate
  // curve and D1/D3 above still count every player, so headline numbers are unaffected.
  const meaningful = cohortList.filter((c) => c.members.length >= 5);
  const gridSource = meaningful.length ? meaningful : cohortList;
  const grid = (gridSource.length > 12 ? gridSource.slice(-12) : gridSource).map((c) => {
    const obs = latestDayNum - c.dayNum;
    const cells = [];
    for (let N = 0; N <= gridMaxOffset; N++) {
      if (N > obs) { cells.push(null); continue; } // hasn't elapsed yet
      let r = 0;
      for (const u of c.members) if (userDayNums.get(u).has(c.dayNum + N)) r++;
      cells.push({ pct: c.members.length ? r / c.members.length : 0, retained: r });
    }
    return { date: c.date, size: c.members.length, cells };
  });

  const retention = {
    curve, d1: atN(1), d3: atN(3), d7: atN(7),
    returningPct: datedPlayers ? multiDay / datedPlayers : 0,
    multiDay, avgDays: datedPlayers ? activeDaysSum / datedPlayers : 0,
    grid, gridMaxOffset,
  };

  // Bot install timeline: current guilds bucketed by the day the bot joined, with a
  // running total. Continuous from the first install through today so removal-free
  // stretches show as flat line, not missing days.
  const installSeries = [];
  if (installs && installs.joins.length) {
    const byDay = new Map();
    for (const d of installs.joins) byDay.set(d, (byDay.get(d) ?? 0) + 1);
    const today = new Date(now).toISOString().slice(0, 10);
    let cum = 0;
    for (let d = [...byDay.keys()].sort()[0]; d <= today; d = isoMinusDays(d, -1)) {
      const add = byDay.get(d) ?? 0;
      cum += add;
      installSeries.push({ date: d, newInstalls: add, cumInstalls: cum });
    }
  }

  const rooms = [...byScope.entries()]
    .map(([scope, e]) => ({
      scope, kind: scope.startsWith('g:') ? 'server' : scope.startsWith('c:') ? 'dm' : 'other',
      games: e.games, players: e.players.size,
      solveRate: e.games ? e.wins / e.games : 0, last: e.last,
    }))
    .sort((a, b) => b.players - a.players || b.games - a.games)
    .slice(0, 12);

  const topPlayers = [...byUser.values()]
    .map((e) => ({
      name: e.name, avatar: e.avatar, total: e.total, plays: e.plays, wins: e.wins,
      winPct: e.plays ? Math.round((100 * e.wins) / e.plays) : 0,
    }))
    .sort((a, b) => b.plays - a.plays || b.total - a.total)
    .slice(0, 15);

  const recent = rows.slice(0, 25).map((r) => ({
    name: r.name, avatar: r.avatar, scope: r.scope_id, score: r.score, mistakes: r.mistakes,
    solved: r.solved, groups: r.groups_solved, puzzle: r.puzzle_id, at: r.created_at, durationMs: r.duration_ms,
  }));

  const latestRows = latestDate ? rows.filter((r) => r.puzzle_date === latestDate) : [];
  const onlineNow = (presence ?? []).filter((p) => now - Date.parse(p.last_seen) < ONLINE_TTL_MS).length;
  const active5m = (presence ?? []).filter((p) => now - Date.parse(p.last_seen) < 5 * 60_000).length;
  // Servers that ever had a live card posted — reach, not installs (includes user-install
  // servers and ones that later removed the bot). botInstalls above is the real count.
  const cardServers = new Set(
    (cards ?? []).filter((c) => c.message_id && String(c.scope_id).startsWith('g:')).map((c) => c.scope_id),
  ).size;

  return {
    generatedAt: now,
    totals: {
      games: rows.length,
      players: players.size,
      servers: [...scopes].filter((s) => s.startsWith('g:')).length,
      rooms: scopes.size,
      botInstalls: installs?.count ?? null,
      cardServers,
      newPlayers7,
      wau: wau.size,
      peak,
      solveRate: rows.length ? solved / rows.length : 0,
      avgMistakes: rows.length ? mistakesSum / rows.length : 0,
      avgScore: rows.length ? scoreSum / rows.length : 0,
      puzzlesCached: puzzlesCached ?? 0,
    },
    latest: {
      date: latestDate,
      puzzle: latestRows[0]?.puzzle_id ?? null,
      players: new Set(latestRows.map((r) => r.user_id)).size,
      onlineNow,
      active5m,
    },
    series,
    installSeries,
    retention,
    rooms,
    topPlayers,
    recent,
  };
}

// ── render helpers ────────────────────────────────────────────────────────────

const C = {
  bg: '#0c0c0c', panel: '#141417', panel2: '#1a1a1f', border: '#26262c',
  text: '#efefe6', muted: '#8a8a93', faint: '#5a5a62',
  yellow: '#f9df6d', green: '#a0c35a', blue: '#b0c4ef', purple: '#ba81c5',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const pct = (x) => Math.round((x ?? 0) * 100) + '%';
const one = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const compact = (n) => {
  n = Math.round(n);
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n);
};
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return MON[+m] + ' ' + +d;
}
function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function dur(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function scopeLabel(scope) {
  if (!scope) return 'unknown';
  const tail = scope.slice(-4);
  if (scope.startsWith('g:')) return 'Server ·' + tail;
  if (scope.startsWith('c:')) return 'DM/Group ·' + tail;
  return scope;
}
function avatarHtml(url, name, size = 22) {
  const initial = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  if (url)
    return `<img src="${esc(url)}" width="${size}" height="${size}" class="av" loading="lazy"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'av av-fb',textContent:'${initial}'}))">`;
  return `<span class="av av-fb" style="width:${size}px;height:${size}px">${initial}</span>`;
}
function kpi(label, value, sub, accent) {
  return `<div class="kpi"><div class="kpi-v"${accent ? ` style="color:${accent}"` : ''}>${value}</div>
    <div class="kpi-l">${esc(label)}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;
}
function retStat(label, value, sub, accent) {
  return `<div class="ret-stat"><div class="v"${accent ? ` style="color:${accent}"` : ''}>${value}</div>
    <div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}

// Multi-series SVG line chart. dates = x labels; series = [{name,color,values[],axis?,fill?}].
// Right-axis series get an independent scale (for mixing players ~1000s with servers ~100s).
function lineChart(dates, series, opts = {}) {
  const n = dates.length;
  if (!n) return '<div class="empty">No data yet.</div>';
  const W = 920;
  const H = opts.h ?? 200;
  const hasR = series.some((s) => s.axis === 'right');
  const pad = { l: 40, r: hasR ? 40 : 12, t: 12, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const lMax = niceMax(Math.max(1, ...series.filter((s) => s.axis !== 'right').flatMap((s) => s.values)));
  const rMax = niceMax(Math.max(1, ...series.filter((s) => s.axis === 'right').flatMap((s) => s.values)));
  const X = (i) => (n <= 1 ? pad.l + iw / 2 : pad.l + (iw * i) / (n - 1));
  const Yl = (v) => pad.t + ih - (ih * v) / lMax;
  const Yr = (v) => pad.t + ih - (ih * v) / rMax;
  const xfmt = opts.xfmt || shortDate;
  const yfmt = opts.yfmt || compact;

  let grid = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const gy = pad.t + (ih * t) / ticks;
    grid += `<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}" class="gl"/>`;
    grid += `<text x="${pad.l - 6}" y="${(gy + 3).toFixed(1)}" class="yl">${yfmt((lMax * (ticks - t)) / ticks)}</text>`;
    if (hasR)
      grid += `<text x="${W - pad.r + 6}" y="${(gy + 3).toFixed(1)}" class="yr">${compact((rMax * (ticks - t)) / ticks)}</text>`;
  }

  let defs = '';
  let body = '';
  for (let k = 0; k < series.length; k++) {
    const s = series[k];
    const Y = s.axis === 'right' ? Yr : Yl;
    const pts = s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    if (s.fill) {
      const gid = 'g' + k;
      defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
      body += `<path d="M ${X(0).toFixed(1)},${Yl(0).toFixed(1)} L ${pts.join(' L ')} L ${X(n - 1).toFixed(1)},${Yl(0).toFixed(1)} Z" fill="url(#${gid})"/>`;
    }
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
    body += `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(s.values[n - 1]).toFixed(1)}" r="3" fill="${s.color}"/>`;
  }

  let xl = '';
  const step = Math.max(1, Math.ceil(n / 7));
  for (let i = 0; i < n - 1; i += step)
    xl += `<text x="${X(i).toFixed(1)}" y="${H - 6}" class="xl" text-anchor="middle">${xfmt(dates[i])}</text>`;
  xl += `<text x="${X(n - 1).toFixed(1)}" y="${H - 6}" class="xl" text-anchor="end">${xfmt(dates[n - 1])}</text>`;

  let hov = '';
  const bw = n > 1 ? iw / (n - 1) : iw;
  for (let i = 0; i < n; i++) {
    const t = opts.tip ? opts.tip(i) : dates[i];
    hov += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${pad.t}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"><title>${esc(t)}</title></rect>`;
  }

  const legend =
    `<div class="legend">` +
    series.map((s) => `<span class="lg"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}${s.axis === 'right' ? ' <i>(right)</i>' : ''}</span>`).join('') +
    `</div>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="lc" role="img"><defs>${defs}</defs>${grid}${body}${xl}${hov}</svg>${legend}`;
}

// ── page ──────────────────────────────────────────────────────────────────────

function renderPage(s) {
  const t = s.totals;
  const l = s.latest;
  const full = s.series;
  const recentWin = full.length > 30 ? full.slice(-30) : full;
  const dates30 = recentWin.map((d) => d.date);
  const datesAll = full.map((d) => d.date);

  const activeChart = lineChart(
    dates30,
    [{ name: 'Active players / day', color: C.green, fill: true, values: recentWin.map((d) => d.players) }],
    {
      h: 200,
      tip: (i) => `${recentWin[i].date} · ${recentWin[i].players} players · ${recentWin[i].activeServers} servers active`,
    }
  );

  const acqChart = lineChart(
    dates30,
    [
      { name: 'New players', color: C.blue, fill: true, values: recentWin.map((d) => d.newPlayers) },
      { name: 'New servers', color: C.purple, axis: 'right', values: recentWin.map((d) => d.newServers) },
    ],
    {
      h: 200,
      tip: (i) => `${recentWin[i].date} · +${recentWin[i].newPlayers} players · +${recentWin[i].newServers} servers`,
    }
  );

  const growthChart = lineChart(
    datesAll,
    [
      { name: 'Total players', color: C.green, fill: true, values: full.map((d) => d.cumPlayers) },
      { name: 'Total servers', color: C.purple, axis: 'right', values: full.map((d) => d.cumServers) },
    ],
    {
      h: 210,
      tip: (i) => `${full[i].date} · ${full[i].cumPlayers} players · ${full[i].cumServers} servers reached`,
    }
  );

  const inst = s.installSeries;
  const installChart = inst.length
    ? lineChart(
        inst.map((d) => d.date),
        [
          { name: 'Bot installs (total)', color: C.yellow, fill: true, values: inst.map((d) => d.cumInstalls) },
          { name: 'New installs', color: C.purple, axis: 'right', values: inst.map((d) => d.newInstalls) },
        ],
        {
          h: 200,
          tip: (i) => `${inst[i].date} · ${inst[i].cumInstalls} installed · +${inst[i].newInstalls} new`,
        }
      )
    : '<div class="empty">No install data — needs DISCORD_BOT_TOKEN in .env.</div>';

  // retention
  const R = s.retention;
  const dash = (x) => (x == null ? '<span class="muted">—</span>' : pct(x));
  const retStrip = `<div class="ret-strip">
    ${retStat('Next-day · D1', dash(R.d1), 'play again the next day', C.green)}
    ${retStat('Day 3 · D3', dash(R.d3), 'still active at +3d')}
    ${retStat('Day 7 · D7', dash(R.d7), 'still active at +7d')}
    ${retStat('Returning players', pct(R.returningPct), `${num(R.multiDay)} played 2+ days`, C.blue)}
    ${retStat('Avg active days', one(R.avgDays), 'per player')}
  </div>`;
  const retCurve = R.curve.length
    ? lineChart(
        R.curve.map((c) => 'D' + c.n),
        [{ name: '% of new players still active', color: C.green, fill: true, values: R.curve.map((c) => c.pct * 100) }],
        {
          h: 190, xfmt: (x) => x, yfmt: (v) => Math.round(v) + '%',
          tip: (i) => `Day ${R.curve[i].n} · ${pct(R.curve[i].pct)} retained · ${R.curve[i].eligible} players measured`,
        }
      )
    : '<div class="empty">Not enough history yet.</div>';

  let cohortHtml = '<div class="empty">No cohorts yet.</div>';
  if (R.grid.length) {
    const head = [];
    for (let N = 0; N <= R.gridMaxOffset; N++) head.push(`<th class="r">D${N}</th>`);
    const body = R.grid
      .map((row) => {
        const cells = row.cells
          .map((cell) => {
            if (!cell) return `<td class="cell empty-cell"></td>`;
            const a = (0.06 + 0.72 * cell.pct).toFixed(3);
            const fg = cell.pct >= 0.45 ? '#0c0c0c' : C.muted;
            return `<td class="cell" style="background:rgba(160,195,90,${a});color:${fg}" title="${cell.retained}/${row.size} came back">${Math.round(cell.pct * 100)}</td>`;
          })
          .join('');
        return `<tr><td class="mono">${esc(shortDate(row.date))}</td><td class="r muted">${num(row.size)}</td>${cells}</tr>`;
      })
      .join('');
    cohortHtml = `<table class="cohort"><thead><tr><th>Cohort</th><th class="r">New</th>${head.join('')}</tr></thead><tbody>${body}</tbody></table>
      <div class="legend"><span>lower</span><span class="heat"></span><span>higher</span>
      <span style="margin-left:6px">· each cell = % of that day's new players active N days later</span></div>`;
  }

  const topPlayers = s.topPlayers
    .map(
      (p, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="who">${avatarHtml(p.avatar, p.name)}<span>${esc(p.name)}</span></td>
      <td class="r">${num(p.plays)}</td>
      <td class="r muted">${num(p.total)}</td>
      <td class="r muted">${p.winPct}%</td>
    </tr>`
    )
    .join('');

  const rooms = s.rooms
    .map(
      (r) => `<tr>
      <td class="who"><span class="tag ${r.kind}">${r.kind === 'server' ? 'SERVER' : r.kind === 'dm' ? 'DM' : '—'}</span>
        <span class="mono">${esc(scopeLabel(r.scope))}</span></td>
      <td class="r">${num(r.players)}</td>
      <td class="r">${num(r.games)}</td>
      <td class="r muted">${esc(r.last || '—')}</td>
    </tr>`
    )
    .join('');

  const recent = s.recent
    .map((r) => {
      const outcome = r.solved ? `<span class="ok">won</span>` : `<span class="bad">${r.groups ?? 0}/4</span>`;
      return `<div class="feed-row">
        ${avatarHtml(r.avatar, r.name, 20)}
        <span class="feed-name">${esc(r.name)}</span>
        <span class="feed-out">${outcome}</span>
        <span class="feed-score">${num(r.score)} pts</span>
        <span class="feed-meta">${r.mistakes}✗ · ${dur(r.durationMs)} · #${r.puzzle ?? '?'} · ${esc(scopeLabel(r.scope))}</span>
        <span class="feed-ago">${esc(ago(r.at))}</span>
      </div>`;
    })
    .join('');

  const updated = new Date(s.generatedAt).toLocaleTimeString('en-US');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Connections · Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${C.bg};color:${C.text};font:14px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased;padding:28px;max-width:1180px;margin:0 auto}
  h1{font-size:20px;font-weight:700;letter-spacing:-.01em}
  h2{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin-bottom:14px}
  .muted{color:${C.muted}}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:6px;flex-wrap:wrap}
  .sub{color:${C.faint};font-size:12px;margin-bottom:24px}
  .sub b{color:${C.green};font-weight:600}
  .live{display:inline-flex;align-items:center;gap:6px;color:${C.green};font-size:12px;font-weight:600}
  .live .pulse{width:8px;height:8px;border-radius:50%;background:${C.green};animation:p 1.8s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(160,195,90,.5)}70%{box-shadow:0 0 0 7px rgba(160,195,90,0)}100%{box-shadow:0 0 0 0 rgba(160,195,90,0)}}
  .grid{display:grid;gap:12px}
  .kpis{grid-template-columns:repeat(6,1fr);margin-bottom:14px}
  .kpi{background:${C.panel};border:1px solid ${C.border};border-radius:12px;padding:14px 16px}
  .kpi-v{font-size:24px;font-weight:700;letter-spacing:-.02em}
  .kpi-l{font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
  .kpi-s{font-size:11px;color:${C.faint};margin-top:4px}
  .panel{background:${C.panel};border:1px solid ${C.border};border-radius:14px;padding:18px;margin-bottom:12px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .cols .panel{margin:0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11px;color:${C.faint};text-transform:uppercase;letter-spacing:.06em;font-weight:600;padding:0 8px 8px}
  th.r,td.r{text-align:right}
  td{padding:7px 8px;border-top:1px solid ${C.border};vertical-align:middle}
  tr:hover td{background:${C.panel2}}
  .rank{color:${C.faint};width:24px}
  .who{display:flex;align-items:center;gap:8px}
  .who span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}
  .av{border-radius:50%;object-fit:cover;flex:none;background:${C.panel2}}
  .av-fb{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;
    background:${C.panel2};color:${C.muted};font-size:11px;font-weight:700}
  .tag{font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 5px;border-radius:5px;flex:none}
  .tag.server{background:rgba(176,196,239,.16);color:${C.blue}}
  .tag.dm{background:rgba(186,129,197,.16);color:${C.purple}}
  .lc{width:100%;height:auto;display:block;overflow:visible}
  .lc .gl{stroke:${C.border};stroke-width:1}
  .lc text{font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif}
  .lc .yl{fill:${C.faint};text-anchor:end}
  .lc .yr{fill:${C.purple};opacity:.8;text-anchor:start}
  .lc .xl{fill:${C.faint}}
  .legend{display:flex;gap:16px;flex-wrap:wrap;color:${C.muted};font-size:12px;margin-top:10px}
  .legend .lg{display:inline-flex;align-items:center;gap:6px}
  .legend i{color:${C.faint};font-style:normal}
  .dot{width:9px;height:9px;border-radius:2px;display:inline-block}
  .feed-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid ${C.border};font-size:13px}
  .feed-row:first-child{border-top:0}
  .feed-name{font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .feed-out .ok{color:${C.green};font-weight:700}.feed-out .bad{color:${C.muted}}
  .feed-meta{color:${C.faint};font-size:11px;margin-left:auto;text-align:right}
  .feed-ago{color:${C.faint};font-size:11px;width:62px;text-align:right;flex:none}
  .empty{color:${C.faint};padding:24px;text-align:center}
  .hsub{font-weight:400;text-transform:none;letter-spacing:0;color:${C.faint}}
  .ret-strip{display:flex;gap:30px;flex-wrap:wrap;margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid ${C.border}}
  .ret-stat .v{font-size:22px;font-weight:700;letter-spacing:-.02em}
  .ret-stat .l{font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
  .ret-stat .s{font-size:11px;color:${C.faint};margin-top:2px}
  table.cohort{font-size:12px}
  table.cohort th,table.cohort td{padding:5px 7px}
  table.cohort .cell{text-align:center;font-weight:600;min-width:34px}
  table.cohort .empty-cell{background:transparent}
  .heat{display:inline-block;width:80px;height:9px;border-radius:5px;vertical-align:middle;
    background:linear-gradient(90deg,rgba(160,195,90,.07),rgba(160,195,90,.78))}
  @media(max-width:880px){.kpis{grid-template-columns:repeat(3,1fr)}.cols{grid-template-columns:1fr}}
</style></head><body>

<header>
  <h1>🧩 Connections · Admin</h1>
  <span class="live"><span class="pulse"></span>${l.onlineNow} online${
    l.active5m > l.onlineNow ? ` · ${l.active5m} active (5m)` : ''
  }</span>
</header>
<div class="sub">
  Local dashboard · binds <b>127.0.0.1</b> only · service-role read · auto-refreshes 30s · updated ${esc(updated)}
  ${l.date ? `· current puzzle <b>#${esc(l.puzzle)}</b> (${esc(l.date)})` : ''}
</div>

<div class="grid kpis">
  ${kpi('Players reached', num(t.players), `+${num(t.newPlayers7)} this week`, C.green)}
  ${kpi('Active this week', num(t.wau), `${num(l.players)} on today's puzzle`, C.blue)}
  ${kpi('Servers', num(t.servers), `${t.botInstalls == null ? '—' : num(t.botInstalls)} bot installs · ${num(t.cardServers)} reached · ${num(t.rooms)} rooms`, C.purple)}
  ${kpi('Games played', num(t.games))}
  ${kpi('Peak day', num(t.peak.players), t.peak.date ? `players · ${esc(shortDate(t.peak.date))}` : '—')}
  ${kpi('Solve rate', pct(t.solveRate), `avg ${one(t.avgMistakes)} mistakes`)}
</div>

<div class="panel">
  <h2>Daily active players <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">· one game per player per day (last ${recentWin.length}d)</span></h2>
  ${activeChart}
</div>

<div class="panel">
  <h2>Acquisition · new players &amp; servers per day</h2>
  ${acqChart}
</div>

<div class="panel">
  <h2>Cumulative reach · total players &amp; servers over time</h2>
  ${growthChart}
</div>

<div class="panel">
  <h2>Bot installs over time <span class="hsub">· current servers by the day the bot joined — removals drop out of history</span></h2>
  ${installChart}
</div>

<div class="panel">
  <h2>Retention <span class="hsub">· do new players come back?</span></h2>
  ${retStrip}
  ${retCurve}
</div>

<div class="panel">
  <h2>Cohort retention <span class="hsub">· daily acquisition cohorts, % active N days later</span></h2>
  ${cohortHtml}
</div>

<div class="cols">
  <div class="panel">
    <h2>Most active players</h2>
    ${
      s.topPlayers.length
        ? `<table><thead><tr><th></th><th>Player</th><th class="r">Plays</th><th class="r">Score</th><th class="r">Win%</th></tr></thead><tbody>${topPlayers}</tbody></table>`
        : '<div class="empty">No players yet.</div>'
    }
  </div>
  <div class="panel">
    <h2>Top rooms</h2>
    ${
      s.rooms.length
        ? `<table><thead><tr><th>Room</th><th class="r">Players</th><th class="r">Games</th><th class="r">Last</th></tr></thead><tbody>${rooms}</tbody></table>`
        : '<div class="empty">No rooms yet.</div>'
    }
  </div>
</div>

<div class="panel">
  <h2>Recent games</h2>
  ${recent || '<div class="empty">No games yet.</div>'}
</div>

</body></html>`;
}

// ── server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  try {
    const stats = await loadStats();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPage(stats));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Dashboard error: ' + (e?.message ?? String(e)) + '\n\nCheck SUPABASE_* keys in .env.');
    console.error(e);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Connections admin dashboard → ${url}`);
  console.log('  (local only — bound to 127.0.0.1; Ctrl-C to stop)\n');
  if (process.platform === 'darwin' && process.env.DASHBOARD_NO_OPEN !== '1') exec(`open ${url}`);
});
