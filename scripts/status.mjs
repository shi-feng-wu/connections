// Keeps the bot showing a custom status — the speech-bubble line with no "Playing"
// prefix — that always reads "/connections", nudging people toward the launch command.
//
// WHY THIS IS A LONG-LIVED PROCESS: a bot's custom status is part of its presence, and
// Discord ONLY lets you set presence over the Gateway (a persistent WebSocket) — there
// is no REST/set-once endpoint, and the status clears within seconds of the connection
// dropping. So "always /connections" means a process that stays connected. The rest of
// this app is serverless (Vercel can't hold a socket open), which is why this lives on
// its own.
//
// HOSTING: run always-on somewhere that allows a long-lived process — your machine, a
// Raspberry Pi, Railway/Fly/Render, a small VPS. NOT Vercel (functions time out). If it
// stops, the status just disappears; nothing else in the app breaks.
//
// Run:
//   pnpm status
// Needs DISCORD_BOT_TOKEN in .env (loaded via --env-file).

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN. Set it in .env.');
  process.exit(1);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('No global WebSocket. Use Node >= 22.4 (or run with --experimental-websocket).');
  process.exit(1);
}

// Hardcoded custom status. type 4 = Custom: Discord renders `state` with the speech
// bubble and no verb prefix (`name` is required but ignored for this type).
const STATUS_TEXT = '/connections';
const presence = {
  activities: [{ name: 'Custom Status', type: 4, state: STATUS_TEXT }],
  status: 'online',
  afk: false,
  since: null,
};

// Gateway opcodes we handle. https://discord.com/developers/docs/topics/gateway
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Resume state survives a reconnect so we can replay (op 6) instead of re-identifying:
// a fresh IDENTIFY re-announces presence but is rate-limited and drops missed events.
let sessionId = null;
let resumeUrl = null;
let seq = null; // last sequence number seen, sent in heartbeats and on resume

let ws = null;
let heartbeatTimer = null;
let acked = true; // did the server ACK our last heartbeat? false => zombie connection
let reconnectDelay = 1000; // backoff, capped below

function send(op, d) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
}

function startHeartbeat(intervalMs) {
  clearInterval(heartbeatTimer);
  acked = true;
  // Jitter the first beat per the gateway docs so reconnecting fleets don't sync up.
  heartbeatTimer = setTimeout(() => {
    beat();
    heartbeatTimer = setInterval(beat, intervalMs);
  }, intervalMs * Math.random());
}

function beat() {
  if (!acked) {
    // No ACK since the last beat: the connection is dead. Drop it and reconnect (resume).
    console.warn('No heartbeat ACK — reconnecting.');
    ws?.close(4000);
    return;
  }
  acked = false;
  send(OP.HEARTBEAT, seq);
}

function identify() {
  send(OP.IDENTIFY, {
    token: TOKEN,
    intents: 0, // we send presence and consume nothing; no privileged intents needed
    properties: { os: process.platform, browser: 'connections', device: 'connections' },
    presence,
  });
}

function connect() {
  const url = resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : DEFAULT_GATEWAY;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    reconnectDelay = 1000; // a clean open resets backoff
  });

  ws.addEventListener('message', (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.s !== null && payload.s !== undefined) seq = payload.s;

    switch (payload.op) {
      case OP.HELLO:
        startHeartbeat(payload.d.heartbeat_interval);
        if (sessionId && resumeUrl) {
          send(OP.RESUME, { token: TOKEN, session_id: sessionId, seq });
        } else {
          identify();
        }
        break;
      case OP.HEARTBEAT: // server asked for one out of band
        beat();
        break;
      case OP.HEARTBEAT_ACK:
        acked = true;
        break;
      case OP.RECONNECT: // server asking us to reconnect & resume
        ws.close(4000);
        break;
      case OP.INVALID_SESSION:
        // d === true means the session is resumable; otherwise start fresh.
        if (!payload.d) {
          sessionId = null;
          resumeUrl = null;
        }
        setTimeout(() => ws.close(4000), 1000 + Math.random() * 4000);
        break;
      case OP.DISPATCH:
        if (payload.t === 'READY') {
          sessionId = payload.d.session_id;
          resumeUrl = payload.d.resume_gateway_url;
          console.log(`Custom status set to "${STATUS_TEXT}" — keeping the connection alive.`);
        } else if (payload.t === 'RESUMED') {
          console.log('Resumed.');
        }
        break;
    }
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(heartbeatTimer);
    // 4004 auth failed / 4010-4014 are fatal config errors — no point reconnecting.
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code)) {
      console.error(`Fatal gateway close ${ev.code}: ${ev.reason || 'see Discord docs'}.`);
      process.exit(1);
    }
    console.warn(`Gateway closed (${ev.code}). Reconnecting in ${reconnectDelay}ms.`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.addEventListener('error', () => {
    // 'close' fires after 'error' and owns reconnect; just surface it here.
    console.warn('Gateway socket error.');
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nClosing gateway connection.');
    ws?.close(1000);
    process.exit(0);
  });
}

console.log('Connecting to Discord gateway to set custom status "/connections" …');
connect();
