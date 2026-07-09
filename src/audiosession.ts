// Keep the user's other audio (Spotify, podcasts) playing while the Activity is open, on mobile.
//
// Symptom: opening the Activity on Discord mobile pauses the user's background audio, and RE-pauses
// every time the Activity returns to the foreground. Our bundle plays no sound (verified) — the
// interruption comes from a non-mixable iOS audio session the host holds while our WebView is foreground.
//
// The only page-reachable lever is the W3C Audio Session API (`navigator.audioSession.type`). Setting it
// to `'ambient'` asks WebKit to make our audio mix instead of interrupt. On-device beacons proved: the
// API EXISTS on iOS (default `auto`) and is ABSENT on Android/desktop web. But a passive `type='ambient'`
// set read back as `auto` — which is ambiguous, because `type` is an ENUM attribute: assigning a value
// the WebKit build doesn't recognize throws a TypeError. Earlier code swallowed that error, so we never
// learned whether `'ambient'` is even a member of this build's enum.
//
// This version PROBES first: it tries a control value (`'playback'`, supported on every build) and
// `'ambient'`, capturing each outcome (stuck / TypeError / NotAllowedError / …). That single beacon is
// decisive:
//   • `'ambient'` throws TypeError  → this WebKit build's enum lacks the only mixable type → dead end.
//   • both throw / stay auto        → the setter is gated in our cross-origin iframe → dead end.
//   • `'ambient'` is settable       → worth actually HOLDING a session (below) to see if it mixes.
//
// Only when `'ambient'` is settable do we activate a session: set `type='ambient'` synchronously in the
// first user gesture right before `resume()`, play a silent zero-gain source so WebKit instantiates the
// session, then re-read the type. SELF-TEARDOWN: if it didn't come up `ambient`, suspend immediately —
// a *running* AudioContext holds the session regardless of gain, so we must not sustain a non-mixable one
// (that would newly interrupt iOS users who currently mix fine). We never touch audio on Android/web.
//
// The post-activation beacon (`type`/`state`/`ctx.state`) is the final signal: `ambient`+`active` and
// music keeps playing = we won; anything else = the session is native-owned and no in-page code moves it.

type AudioSessionType =
  | 'auto'
  | 'ambient'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'play-and-record';

interface AudioSessionLike {
  type: AudioSessionType;
  readonly state?: string; // "active" | "inactive" | "interrupted"
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

// --- probe + diagnostics, reported to the launch beacon via audioSessionDiag() ---
let apiPresent = false;
let probeStr = 'n'; // enum-probe result for the beacon
let ambientSettable = false; // did assigning 'ambient' NOT throw?
let postType: string | null = null; // audioSession.type after we activate a real session
let postState: string | null = null; // audioSession.state after activation
let ctxState: string | null = null; // AudioContext.state after resume()
let setErr: string | null = null; // exception name from the gesture-time ambient set

// Try to assign a type; report "ok(<readback>)" or the thrown error's name. Does not restore.
function trySet(v: AudioSessionType): string {
  const s = audioSession();
  if (!s) return '-';
  try {
    s.type = v;
    return `ok(${s.type})`;
  } catch (e) {
    return (e as { name?: string })?.name ?? 'err';
  }
}

// Probe support BEFORE activating anything. 'playback' is the control (every build supports it); if it
// sticks and 'ambient' throws, we've proven 'ambient' isn't in this build's enum — no active session needed.
function runProbe(): void {
  const s = audioSession();
  apiPresent = !!s;
  if (!s) {
    probeStr = 'n';
    return;
  }
  const def = s.type;
  const pb = trySet('playback');
  const am = trySet('ambient');
  ambientSettable = am.startsWith('ok');
  try {
    s.type = 'auto'; // restore to the default so the probe leaves no lasting category
  } catch {
    /* ignore */
  }
  probeStr = `${def}|pb=${pb}|am=${am}`;
}

let ctx: AudioContext | null = null;
let held = false;

// Activate a silent ambient hold — ONLY if the probe showed 'ambient' is settable (else we'd risk a
// non-mixable hold that interrupts users who currently mix fine). Must run inside a user gesture.
function activateHold(): void {
  if (!ambientSettable) return;
  const s = audioSession();
  if (!s) return;
  try {
    s.type = 'ambient'; // set synchronously in the gesture, right before resume() — when the category binds
  } catch (e) {
    setErr = (e as { name?: string })?.name ?? 'err';
  }
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!ctx) {
      ctx = new Ctor();
      const gain = ctx.createGain();
      gain.gain.value = 0; // inaudible — holds the session without producing any sound
      const osc = ctx.createOscillator();
      osc.connect(gain).connect(ctx.destination);
      osc.start();
    }
    try {
      s.type = 'ambient';
    } catch {
      /* re-assert post-construct */
    }
    ctx.resume().then(
      () => {
        try {
          s.type = 'ambient';
        } catch {
          /* re-assert post-activation */
        }
        postType = s.type ?? null;
        postState = typeof s.state === 'string' ? s.state : null;
        ctxState = ctx?.state ?? null;
        held = true;
        // Self-teardown: a running context holds the session regardless of gain, so if it didn't come up
        // ambient, don't sustain a non-mixable session that would interrupt a mixing-fine user.
        if (s.type !== 'ambient' && ctx) {
          try {
            void ctx.suspend();
          } catch {
            /* ignore */
          }
        }
        beaconHold();
      },
      (e) => {
        setErr = (e as { name?: string })?.name ?? 'err';
        ctxState = ctx?.state ?? null;
        beaconHold();
      },
    );
  } catch (e) {
    setErr = (e as { name?: string })?.name ?? 'err';
    beaconHold();
  }
}

// Re-hold on every foreground (the host re-grabs its non-mixable session on each refocus). Only resumes
// an already-unlocked context; the first activation must come from a gesture via activateHold().
function reHold(): void {
  if (!ambientSettable || !ctx) return;
  const s = audioSession();
  if (s) {
    try {
      s.type = 'ambient';
    } catch {
      /* best-effort */
    }
  }
  void ctx.resume();
}

// One-shot beacon of the post-activation outcome, so we can read on-device whether the ambient hold
// actually took — the datapoint that says whether the pause is native-owned.
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
 * Probes Audio Session API support immediately (for the mounted beacon), then — only if 'ambient' is
 * settable — holds a silent ambient session unlocked on the first user gesture and re-held on refocus.
 */
export function keepAudioMixable(): void {
  if (wired) return;
  wired = true;

  runProbe(); // decisive support check; surfaced in the mounted beacon (no gesture needed)

  window.addEventListener('pointerdown', activateHold);
  window.addEventListener('touchstart', activateHold);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reHold();
  });
  window.addEventListener('focus', reHold);
  window.addEventListener('pageshow', reHold);
}

/**
 * Compact diagnostic for the launch beacon. `"n"` = Audio Session API absent (Android/web). Otherwise
 * `"<default>|pb=<...>|am=<...>"` from the probe — e.g. `"auto|pb=ok(playback)|am=TypeError"` means
 * `'ambient'` isn't in this build's enum (dead end). Once the hold runs, appends
 * `" post=<type>/<state>/<ctx>"` — `post=ambient/active/running` = we won.
 */
export function audioSessionDiag(): string {
  if (!apiPresent) return 'n';
  const post = held
    ? ` post=${postType ?? '?'}/${postState ?? '?'}/${ctxState ?? '?'}`
    : setErr
      ? ` e=${setErr}`
      : '';
  return probeStr + post;
}
