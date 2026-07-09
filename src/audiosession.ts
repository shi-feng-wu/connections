// Keep the user's other audio (Spotify, podcasts) playing while the Activity is open.
//
// Symptom: opening the Activity on the Discord *mobile* client pauses the user's background
// music/podcasts — and it RE-pauses every time the Activity is brought back to the foreground
// (background it and music resumes; foreground it and music stops again).
//
// This is NOT our code. The shipped bundle contains zero audio: no AudioContext, no <audio>/<video>,
// no getUserMedia, no WebRTC — so nothing here can hold an audio session. The re-pause-on-refocus
// signature points at the host: Discord's activity WKWebView carries a non-mixable iOS AVAudioSession
// (a "playback"/voice-style category, so activities that DO play sound work without an unlock tap),
// and iOS reactivates that one process-wide session whenever the webview becomes the foreground view
// — interrupting every other app. Backgrounding deactivates it, so music resumes; hence the loop.
//
// The one page-reachable opt-out is the W3C Audio Session API. Declaring our session `ambient` tells
// WebKit "this page's audio mixes with other apps and obeys the ringer switch" — the correct category
// for a (near-)silent puzzle game, and the most likely reason the first-party Wordle Activity doesn't
// pause music. WebKit maps `ambient` onto a mixable AVAudioSession category, so if the session is
// WebKit-managed this stops the interruption. If pausing persists even with this set, the session is
// held purely by Discord's native layer that the page can't reach — which is itself the answer
// (escalate to Discord), not a defect in this file.
//
// Everything is feature-detected and wrapped, so it's a silent no-op where the API is absent (older
// WebKit, desktop, the standalone dev build). Re-asserted on every foreground because the interruption
// re-triggers on refocus, not just at launch.

type AudioSessionType =
  | 'auto'
  | 'ambient'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'play-and-record';

interface AudioSessionLike {
  type: AudioSessionType;
}

function audioSession(): AudioSessionLike | undefined {
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
}

function goAmbient(): void {
  try {
    const s = audioSession();
    if (s) s.type = 'ambient';
  } catch {
    /* the setter can throw on an unsupported / locked session — ignore */
  }
}

// Snapshot of the session type BEFORE we override it, captured once for the launch beacon.
let supported = false;
let defaultType: AudioSessionType | null = null;

let wired = false;

/**
 * Declare the Activity's audio session `ambient` so it mixes with the user's music/podcasts instead
 * of interrupting them, and keep it that way across foreground/background cycles. Idempotent.
 */
export function keepAudioMixable(): void {
  if (wired) return;
  wired = true;

  try {
    const s = audioSession();
    supported = !!s;
    defaultType = s ? s.type : null;
  } catch {
    /* ignore — leaves supported=false */
  }

  goAmbient(); // assert as early as possible

  // The host reactivates its non-mixable session each time the webview returns to the foreground,
  // so a one-shot set at launch isn't enough — re-assert on every path back to visible/focused.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') goAmbient();
  });
  window.addEventListener('focus', goAmbient);
  window.addEventListener('pageshow', goAmbient);
}

/**
 * Compact diagnostic for the launch beacon. `"n"` = the Audio Session API is absent (older WebKit /
 * desktop / dev). Otherwise the session type observed BEFORE we forced `ambient` — e.g. `"playback"`
 * confirms the webview shipped a non-mixable default (the smoking gun), while `"ambient"` means it was
 * already mixable and the pause lives elsewhere. Lets a persistent pause be triaged as "API missing"
 * vs "API present but can't move the native session" without another round trip.
 */
export function audioSessionDiag(): string {
  return supported ? (defaultType ?? 'unknown') : 'n';
}
