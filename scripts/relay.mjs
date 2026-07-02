// Live-roster relay — the universal realtime path. A Discord Activity's client can't reliably
// hold a WebSocket (the proxy/filters/web break the WS upgrade — confirmed: it dies on web and on
// filtered networks), but it CAN hold a long-lived SSE stream (plain HTTP, no upgrade — confirmed
// streaming through Discord's proxy even on the client where WS failed). So instead of every
// client talking realtime to Supabase, they each hold ONE SSE stream to this tiny relay, and the
// relay fans out deltas. Supabase sees zero realtime traffic; the metered egress collapses.
//
// Zero npm dependencies (node:http + node:crypto only), so it ships in the same lean Dockerfile as
// the status worker — which this process also keeps alive as a child (see the bottom), so one
// Railway service covers both.
//
// Endpoints:
//   GET  /sub?room=<scope>&ct=<ticket>   SSE stream of the room's deltas. Ticket in the QUERY
//                                        because EventSource can't set headers. verifyAuth gates it.
//                                        `room` may repeat — one stream can hold several rooms
//                                        (the game room plus the caller's personal u:<uid> room,
//                                        where feedback-chat pokes land). A u:<uid> room is only
//                                        subscribable by its owner (uid must match the ticket).
//   POST /pub  {room,event,payload}      Fan a delta out to a room.
//                                          • header x-relay-secret == RELAY_SECRET  → trusted server
//                                            push (progress/join from the Vercel API), payload trusted.
//                                          • header x-ct == valid ticket            → client push,
//                                            ONLY event:"tiles", and userId is forced to the ticket's
//                                            uid (you can't broadcast as someone else).
//   GET  /health                         liveness + room/connection counts.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const SECRET = process.env.SESSION_SECRET ?? ''; // same secret that mints the x-ct auth ticket
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''; // server→relay shared secret (Vercel pushes)
const PORT = Number(process.env.PORT ?? 8080);
const AUTH_MAX_AGE = 24 * 60 * 60 * 1000; // mirrors api/_session.ts

// Trailing flush for the "who's playing" card. /api/guess edits the card on the leading edge (once
// per 30s window), which DROPS the last guess of a burst. Since this relay already receives every
// progress/join event, it owns the TRAILING edge: ~30s after a room goes quiet it calls Vercel's
// /api/refresh-card (flush:true bypasses the 30s throttle) so the final state always lands. The
// render itself stays on Vercel (bot token + canvas); we only hold the cheap timer here. Skipped
// unless both env vars are set (graceful: the leading-edge edits still work without it).
const APP_ORIGIN = process.env.APP_ORIGIN ?? ''; // public Vercel origin, e.g. https://<prod-domain>
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? ''; // shared secret /api/refresh-card checks
const CARD_SETTLE_MS = 30_000; // fire the trailing flush this long after the last room event

// --- ticket verification: a byte-for-byte port of verifyAuth() in api/_session.ts ---
function macOf(body) {
  return createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verifyAuth(token) {
  if (!SECRET || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(macOf(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let a;
  try {
    a = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (!a || typeof a.uid !== 'string' || typeof a.iat !== 'number') return null;
  const age = Date.now() - a.iat;
  if (age < 0 || age > AUTH_MAX_AGE) return null;
  return a;
}

// --- room registry: scope -> Set<ServerResponse> (the live SSE connections) ---
const rooms = new Map();
function roomSet(scope) {
  let s = rooms.get(scope);
  if (!s) {
    s = new Set();
    rooms.set(scope, s);
  }
  return s;
}
function fanout(scope, event, payload) {
  const s = rooms.get(scope);
  if (!s || s.size === 0) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let n = 0;
  for (const res of s) {
    try {
      res.write(frame);
      n += 1;
    } catch {
      /* dead conn; the 'close' handler will reap it */
    }
  }
  return n;
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(obj ? JSON.stringify(obj) : '');
}

// --- trailing card flush: one debounced timer per card, re-armed on each room event ---
const cardTimers = new Map(); // `${guildId}|${channelId}` -> Timeout

// Debounce a card refresh for the room this event belongs to: re-arm a CARD_SETTLE_MS timer so the
// flush fires once, ~30s after the room's LAST progress/join. The card is per-channel: a guild room
// (g:<guild>) carries the channel in the delta payload; a DM room (c:<channel>) IS that channel.
function scheduleCardFlush(room, payload) {
  if (!APP_ORIGIN || !INTERNAL_SECRET) return; // not configured → leading-edge edits only
  let guildId = null;
  let channelId = null;
  if (room.startsWith('g:')) {
    guildId = room.slice(2);
    channelId = payload && typeof payload.channelId === 'string' ? payload.channelId : null;
  } else if (room.startsWith('c:')) {
    channelId = room.slice(2);
  }
  if (!channelId) return; // can't locate the card without a channel
  const key = `${guildId ?? ''}|${channelId}`;
  const existing = cardTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cardTimers.delete(key);
    flushCard(guildId, channelId);
  }, CARD_SETTLE_MS);
  if (typeof t.unref === 'function') t.unref(); // never keep the process alive just for a flush
  cardTimers.set(key, t);
}

// Tell Vercel to re-render the card with the latest state. flush:true bypasses the 30s throttle so
// the trailing edit can't be dropped; tense is decided server-side (unchanged here). Best-effort —
// a failed call just means the next room event re-arms the timer.
async function flushCard(guildId, channelId) {
  try {
    await fetch(`${APP_ORIGIN}/api/refresh-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_SECRET}` },
      body: JSON.stringify({ guildId, channelId, finished: false, flush: true }),
    });
  } catch {
    /* best-effort trailing flush */
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-ct,x-relay-secret',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    let conns = 0;
    for (const s of rooms.values()) conns += s.size;
    json(res, 200, { ok: true, rooms: rooms.size, conns });
    return;
  }

  // SSE subscribe — the long-lived stream each client holds open (possibly for several rooms).
  if (req.method === 'GET' && url.pathname === '/sub') {
    const scopes = [...new Set(url.searchParams.getAll('room'))];
    const a = verifyAuth(url.searchParams.get('ct'));
    if (scopes.length === 0 || !a) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    // A personal room (u:<uid>) carries that user's private pokes — only its owner may hold it.
    if (scopes.some((s) => s.startsWith('u:') && s.slice(2) !== a.uid)) {
      json(res, 403, { error: 'forbidden room' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // tell any intermediary proxy not to buffer the stream
      'access-control-allow-origin': '*',
    });
    res.write('retry: 3000\n\n'); // EventSource auto-reconnect backoff if the stream drops
    res.write(': connected\n\n');
    const sets = scopes.map((s) => roomSet(s));
    for (const set of sets) set.add(res);
    // Heartbeat comment keeps idle intermediaries from closing the connection.
    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        /* ignore */
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      sets.forEach((set, i) => {
        set.delete(res);
        if (set.size === 0) rooms.delete(scopes[i]);
      });
    });
    return;
  }

  // Publish a delta into a room.
  if (req.method === 'POST' && url.pathname === '/pub') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy(); // hard cap; deltas are a few hundred bytes
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'bad json' });
        return;
      }
      const room = body?.room;
      const event = body?.event;
      const payload = body?.payload;
      if (typeof room !== 'string' || typeof event !== 'string' || !payload) {
        json(res, 400, { error: 'missing fields' });
        return;
      }
      // Trusted server push (the Vercel API on a counted guess / a join).
      const provided = req.headers['x-relay-secret'];
      if (RELAY_SECRET && provided === RELAY_SECRET) {
        const n = fanout(room, event, payload);
        // A committed-guess or join changed the card's state → (re)arm its trailing flush.
        if (event === 'progress' || event === 'join') scheduleCardFlush(room, payload);
        json(res, 200, { ok: true, delivered: n });
        return;
      }
      // Client push: tiles only, and we stamp the userId from the ticket so nobody can
      // broadcast a selection as someone else.
      const a = verifyAuth(req.headers['x-ct']);
      if (!a) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (event !== 'tiles') {
        json(res, 403, { error: 'forbidden event' });
        return;
      }
      const n = fanout(room, 'tiles', { ...payload, userId: a.uid });
      json(res, 200, { ok: true, delivered: n });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));

// Keep the bot's "/connections" custom status alive in the SAME service, as an isolated child
// process — status.mjs stays untouched, and its self-exit (e.g. bad token) can't take the relay
// down. Only spawned when a bot token is present, so the relay runs fine without one.
if (process.env.DISCORD_BOT_TOKEN) {
  const child = spawn(process.execPath, ['scripts/status.mjs'], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => console.warn(`[relay] status worker exited (${code ?? 'signal'})`));
}
