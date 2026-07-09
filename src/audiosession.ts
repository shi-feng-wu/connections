// Keep the user's other audio (Spotify, podcasts) playing while the Activity is open, on mobile.
//
// Symptom: opening the Activity on Discord mobile pauses the user's background audio, and RE-pauses
// every time the Activity returns to the foreground. Our shipped bundle has zero audio (verified),
// so nothing here plays sound — the interruption comes from a non-mixable iOS audio session that the
// host holds while our WebView is foreground.
//
// First attempt (v1): just set `navigator.audioSession.type = 'ambient'`. It did NOTHING, and here's
// why: `type` only declares which category to use WHEN OUR PAGE ACTIVATES A SESSION. A page that
// plays no audio never activates one, so the declaration governs a session that never exists — inert.
//
// This version (v2): actually HOLD a mixable session. We set `type='ambient'` and then play a silent,
// unmuted, zero-gain WebAudio source so WebKit instantiates a real *ambient* (mixable) AVAudioSession
// for our page — and we re-hold it on every foreground, since the host re-grabs its non-mixable
// session on each refocus. If WebKit's page session governs the process category, ours (ambient) wins
// and the user's music is no longer interrupted.
//
// SAFETY GATE (important): an unmuted source whose `ambient` request is NOT honored would fall back to
// the non-mixable `playback` category and make the interruption WORSE. So we only ever start audio
// when (a) `navigator.audioSession` exists AND (b) setting `type='ambient'` reads back as 'ambient'.
// On any WebView without honored support we do nothing at all. Audio activation also needs a user
// gesture on iOS, so the hold is unlocked on the first pointerdown/touchstart, then re-held on refocus.
//
// If an ambient session is provably held (beacon: state active, ctx running) and music STILL pauses,
// that is the definitive proof the non-mixable session is native-app-owned and unreachable in-page.

type AudioSessionType =
  | 'auto'
  | 'ambient'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'play-and-record';

interface AudioSessionLike {
  type: AudioSessionType;
  // W3C readonly attribute: "active" | "inactive" | "interrupted".
  readonly state?: string;
}

function audioSession(): AudioSessionLike | undefined {
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
}

function audioContextCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

// Declare our session mixable. Safe on a dormant (audio-free) session — it's a pure declaration, no
// sound. Returns whether 'ambient' was actually honored (read back), which gates the audio hold.
function setAmbient(): boolean {
  const s = audioSession();
  if (!s) return false;
  try {
    s.type = 'ambient';
  } catch {
    /* setter can throw on a locked/unsupported session */
  }
  return s.type === 'ambient';
}

// --- diagnostics, reported to the launch beacon via audioSessionDiag() ---
let supported = false;
let defaultType: string | null = null; // type before we touched anything
let appliedType: string | null = null; // type after a passive set — did 'ambient' stick?
let sessionState: string | null = null; // "active" | "interrupted" | ...
let holdState: string | null = null; // AudioContext.state after the hold attempt
let holdError: string | null = null; // exception name if the hold threw

let ctx: AudioContext | null = null;

// Hold a silent, unmuted, zero-gain ambient session. No-op unless the API exists AND 'ambient' is
// honored (see SAFETY GATE above). Must be reachable from a user gesture the first time; subsequent
// calls (on refocus) can resume() without a fresh gesture once it's been unlocked.
function ensureAmbientHold(): void {
  if (!('audioSession' in navigator)) return; // API absent — in-page opt-out impossible; do not risk audio
  if (!setAmbient()) return; // 'ambient' not honored — bail so we never fall back to 'playback'
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!ctx) {
      ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // inaudible — holds the session without producing any sound
      osc.connect(gain).connect(ctx.destination);
      osc.start();
    }
    void ctx.resume(); // needs a gesture the first time; re-holds the session on later foregrounds
    holdState = ctx.state;
  } catch (e) {
    holdError = String((e as { name?: string })?.name ?? e).slice(0, 24);
  }
  beaconHold();
}

// One-shot beacon of the hold outcome (after the first gesture), so we can see on-device whether the
// ambient session actually activated — the datapoint that says whether the pause is native-owned.
let beaconed = false;
function beaconHold(): void {
  if (beaconed) return;
  beaconed = true;
  try {
    const qp = new URLSearchParams(location.search);
    const plat = /Android/i.test(navigator.userAgent)
      ? 'android'
      : /iPhone|iPad|iPod/i.test(navigator.userAgent)
        ? 'ios'
        : 'web';
    navigator.sendBeacon?.(
      `/api/launch-beacon?stage=audiohold&plat=${plat}` +
        `&channel=${encodeURIComponent(qp.get('channel_id') ?? '')}` +
        `&as=${encodeURIComponent(audioSessionDiag())}`,
    );
  } catch {
    /* best-effort telemetry */
  }
}

let wired = false;

/**
 * Keep the Activity's audio session mixable so it doesn't pause the user's music/podcasts. Idempotent.
 * Captures the pre-gesture diagnostic immediately, then holds a silent ambient session unlocked on the
 * first user gesture and re-held on every foreground.
 */
export function keepAudioMixable(): void {
  if (wired) return;
  wired = true;

  // Pre-gesture snapshot: does the API exist, what's the default, does a passive 'ambient' set stick,
  // and what's the session state. Answers "which world are we in" even before any audio can activate.
  try {
    const s = audioSession();
    supported = !!s;
    defaultType = s ? s.type : null;
  } catch {
    /* leaves supported=false */
  }
  appliedType = setAmbient() ? 'ambient' : (audioSession()?.type ?? null);
  try {
    const s = audioSession();
    sessionState = s && typeof s.state === 'string' ? s.state : null;
  } catch {
    /* ignore */
  }

  // Unlock the hold on the first user gesture (iOS blocks audio activation otherwise), and re-hold on
  // every path back to the foreground — the host re-grabs its non-mixable session on each refocus.
  window.addEventListener('pointerdown', ensureAmbientHold);
  window.addEventListener('touchstart', ensureAmbientHold);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureAmbientHold();
  });
  window.addEventListener('focus', ensureAmbientHold);
  window.addEventListener('pageshow', ensureAmbientHold);
}

/**
 * Compact diagnostic for the launch beacon. `"n"` = the Audio Session API is absent in this WebView
 * (in-page opt-out impossible). Otherwise `"<default>><applied>:<state>|h=<ctxState>"` — whether a
 * passive `ambient` set stuck, the session state, and (once a gesture fires) whether the silent hold
 * reached `running`. Distinguishes API-missing vs set-rejected vs held-but-still-interrupted.
 */
export function audioSessionDiag(): string {
  if (!supported) return 'n';
  return (
    `${defaultType ?? '?'}>${appliedType ?? '?'}:${sessionState ?? '?'}` +
    `|h=${holdState ?? '-'}${holdError ? '!' + holdError : ''}`
  );
}
