// Persisted viewer preferences (volume, mute, speed, captions, quality lock).
// Storage can be unavailable (private mode, blocked site data), so every access
// is guarded and the player works without it.
const KEY = 'vp-study-prefs';
const DEFAULTS = { volume: 1, muted: false, rate: 1, captions: null, quality: 'auto', theater: false };

export function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // non-fatal
  }
  return next;
}
