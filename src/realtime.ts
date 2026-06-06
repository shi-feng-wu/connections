import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Live roster via Supabase Realtime Presence. Everyone in the same activity
// session joins a channel keyed by the Discord instance ID and tracks progress.
//
// Reliability: the presence socket runs through a proxied WebSocket inside the
// Discord Activity (see supabase.ts), and the Activity backgrounds aggressively
// (PiP, tab switch, phone sleep) — which drops the socket and freezes the timers
// Supabase's own reconnect relies on. A channel that dies that way never recovers
// on its own, so the roster froze until the user closed and reopened the Activity
// (a reload is the only thing that rebuilt the channel). This module supervises the
// channel instead: it recreates a dead channel with backoff, re-tracks on a
// heartbeat, and rejoins the moment the Activity regains focus — no reopen needed.

export type PlayerState = {
  userId: string;
  name: string;
  // Discord avatar URL. Absent for guests / no custom avatar; roster then shows
  // a color+initial placeholder.
  avatar?: string;
  mistakesLeft: number;
  solvedCount: number;
  // Solved difficulty levels (0-3); roster paints each mini-board row its color.
  solvedLevels: number[];
  // Tiles selected but not yet submitted. Still broadcast, but the roster ring now
  // reflects presence (see `online`), not this.
  picking: boolean;
  done: 'won' | 'lost' | null;
  // Epoch ms. `startedAt` drives a local elapsed timer; `finishedAt` freezes it.
  startedAt: number;
  finishedAt: number | null;
  // Derived client-side (not part of the broadcast): true while this player is in the live
  // presence set — i.e. currently in the Activity. Drives the green "online" ring. A player
  // who joined and then left stays in the roster with this unset/false.
  online?: boolean;
};

type JoinOpts = {
  private?: boolean;
  // Pull the CURRENT self at (re)connect / heartbeat time — never a captured snapshot,
  // so a rejoin hours later still broadcasts up-to-date progress.
  getSelf: () => PlayerState;
  // Re-mint the Realtime JWT and re-auth (App re-fetches /api/realtime-token). Lets a long
  // session recover the *private* channel after its token expires instead of degrading to
  // public. Resolves true on success. Absent → straight to the public fallback.
  reauth?: () => Promise<boolean>;
};

// Backoff for socket/channel rejoin: 0 → 1s → 2s → 4s → 8s → 15s (capped). Exported pure
// so the schedule is unit-testable without driving a socket.
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
export function nextBackoff(prev: number): number {
  return prev ? Math.min(prev * 2, MAX_BACKOFF_MS) : MIN_BACKOFF_MS;
}

// Which privacy a reconnect should use: once the private→public fallback has fired we stay
// public (re-attempting the broken private config just loops). Exported pure for testing.
export function reconnectPrivacy(wantPrivate: boolean, publicFallbackUsed: boolean): boolean {
  return publicFallbackUsed ? false : wantPrivate;
}

// Re-track this often: keeps presence state fresh, exercises the socket between syncs, and
// surfaces a silently-dead socket (a backgrounded tab fires no status callback). Kept under
// the backoff cap so detection never lags a rejoin.
const HEARTBEAT_MS = 12_000;

// ── Supervisor state (single channel per Activity session) ───────────────────
let channel: RealtimeChannel | null = null;
let roomId = '';
let getSelf: () => PlayerState = () => {
  throw new Error('realtime: getSelf called before joinRoom');
};
let onSync: (players: PlayerState[]) => void = () => {};
let reauth: (() => Promise<boolean>) | undefined;
let wantPrivate = false;
// Sticky for the session: the private→public fallback happens at most once, so a later
// socket drop rejoins as the working (public) config rather than re-trying the broken one.
let publicFallbackUsed = false;
// Caps reauth to one attempt per connection window (reset on SUBSCRIBED): a second private
// CHANNEL_ERROR with no intervening success skips reauth and takes the public fallback,
// so an expired token can't drive a tight error→reauth→error loop.
let reauthedThisWindow = false;
let backoffMs = 0;
let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Set by leaveRoom; gates every async/timer callback so nothing resurrects the channel.
let disposed = false;

// Authorize Realtime with a server-minted Supabase JWT (from a verified Discord
// identity). Call before joinRoom so private channels authorize; without it the
// room falls back to a public channel (local/dev).
export function setRealtimeAuth(token: string): void {
  supabase?.realtime.setAuth(token);
}

function teardownChannel(): void {
  const ch = channel;
  channel = null;
  // removeChannel (not bare unsubscribe) so the client's internal registry doesn't
  // accumulate dead `room:*` entries across reconnects.
  if (ch) void supabase?.removeChannel(ch);
}

// Build + subscribe a fresh presence channel. Always recreates (Supabase can't cleanly
// resubscribe a CLOSED channel). Every reconnect path funnels through here.
function connect(asPrivate: boolean): void {
  if (!supabase || disposed) return;
  teardownChannel();

  const self = getSelf();
  const ch = supabase.channel(`room:${roomId}`, {
    // Private channels enforce realtime.messages RLS: only verified users (a
    // server-minted JWT) can join/broadcast presence in production.
    config: { private: asPrivate, presence: { key: self.userId } },
  });
  channel = ch;

  ch.on('presence', { event: 'sync' }, () => {
    // A superseded channel (rapid rejoin / StrictMode double-mount) goes inert.
    if (channel !== ch) return;
    const state = ch.presenceState<PlayerState>();
    // Each key holds an array of presences; take the latest per player.
    // Presence<PlayerState> is assignable to PlayerState.
    const players: PlayerState[] = Object.values(state).map((entries) => entries[0]).filter(Boolean);
    onSync(players);
  }).subscribe((status, err) => {
    if (channel !== ch) return;
    if (status === 'SUBSCRIBED') {
      backoffMs = 0;
      reauthedThisWindow = false;
      void ch.track(getSelf());
      return;
    }
    if (status === 'CHANNEL_ERROR') {
      // A private join only errors here when Realtime auth is misconfigured or the JWT
      // didn't validate (commonly an expired token mid-session). handleChannelError tries
      // a token re-mint first, then the public fallback, then a backoff rejoin.
      console.warn('[realtime] presence CHANNEL_ERROR', { private: asPrivate, room: roomId }, err?.message ?? '');
      void handleChannelError(asPrivate);
      return;
    }
    if (status === 'TIMED_OUT' || status === 'CLOSED') {
      console.warn(`[realtime] presence ${status}`, { room: roomId });
      scheduleRejoin();
    }
  });
}

async function handleChannelError(asPrivate: boolean): Promise<void> {
  if (disposed) return;
  // Private error → most likely an expired Realtime JWT. Re-mint once per window and retry
  // private before giving up the verified gating.
  if (asPrivate && wantPrivate && reauth && !reauthedThisWindow) {
    reauthedThisWindow = true;
    let ok = false;
    try {
      ok = await reauth();
    } catch {
      ok = false;
    }
    if (disposed) return;
    if (ok) {
      connect(true);
      return;
    }
  }
  // Reauth absent/failed/exhausted → one-time private→public fallback. LESS secure
  // (presence no longer gated to verified users), so fix the JWT to restore private.
  if (asPrivate && wantPrivate && !publicFallbackUsed) {
    publicFallbackUsed = true;
    connect(false);
    return;
  }
  // Public channel error, or fallback already spent → back off and rejoin.
  scheduleRejoin();
}

function scheduleRejoin(): void {
  // Single-flight: CLOSED + TIMED_OUT firing together still schedule exactly one rejoin.
  if (disposed || rejoinTimer) return;
  backoffMs = nextBackoff(backoffMs);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (disposed) return;
    connect(reconnectPrivacy(wantPrivate, publicFallbackUsed));
  }, backoffMs);
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (disposed || !supabase) return;
    const ch = channel;
    if (ch && ch.state === 'joined') {
      // Re-track current self: keeps presence fresh and exercises the socket.
      void ch.track(getSelf());
    } else if (!supabase.realtime.isConnected()) {
      // Socket is down but no status callback fired (background-throttled) → force recovery.
      scheduleRejoin();
    }
  }, HEARTBEAT_MS);
}

// The Activity regained focus/visibility. Discord Activities background and throttle timers,
// so this is the fast path back: rebuild a dead channel immediately (no waiting out a
// backoff), or just push fresh state if it's still healthy. Replaces the manual close/reopen.
function onWake(): void {
  if (disposed || !supabase) return;
  const ch = channel;
  const dead = !supabase.realtime.isConnected() || !ch || ch.state === 'closed' || ch.state === 'errored';
  if (dead) {
    backoffMs = 0;
    if (rejoinTimer) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
    connect(reconnectPrivacy(wantPrivate, publicFallbackUsed));
  } else {
    void ch.track(getSelf());
  }
}

function handleVisibility(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') onWake();
}

export function joinRoom(
  roomIdArg: string,
  onSyncArg: (players: PlayerState[]) => void,
  opts: JoinOpts,
): void {
  // Idempotent: already joined or mid-rejoin → no-op (defends the dev double-effect too).
  if (!supabase || channel || rejoinTimer) return;
  disposed = false;
  roomId = roomIdArg;
  onSync = onSyncArg;
  getSelf = opts.getSelf;
  reauth = opts.reauth;
  wantPrivate = opts.private ?? false;
  publicFallbackUsed = false;
  reauthedThisWindow = false;
  backoffMs = 0;

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);
  if (typeof window !== 'undefined') window.addEventListener('focus', onWake);
  startHeartbeat();
  connect(wantPrivate);
}

export async function updatePresence(self: PlayerState): Promise<void> {
  // Per-tap fast path. Only track a live channel; a dead one is healed by the heartbeat /
  // onWake, whose rejoin re-tracks the latest self on SUBSCRIBED.
  if (channel && channel.state === 'joined') await channel.track(self);
}

export function leaveRoom(): void {
  disposed = true;
  if (rejoinTimer) {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
  if (typeof window !== 'undefined') window.removeEventListener('focus', onWake);
  teardownChannel();
}
