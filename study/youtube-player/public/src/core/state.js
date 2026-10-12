// Player states. The numeric values match the ones YouTube documents publicly for
// its IFrame Player API (onStateChange), so code written against that API reads
// the same here.
export const PlayerState = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

export const stateName = (s) => Object.keys(PlayerState).find((k) => PlayerState[k] === s) ?? String(s);

// Derives the high-level state from raw HTMLMediaElement events, so the UI never
// has to reason about `waiting` vs `stalled` vs `seeking` itself.
export function trackState(video, onChange) {
  let state = PlayerState.UNSTARTED;
  const set = (next) => {
    if (next !== state) onChange((state = next));
  };
  const evaluate = () => {
    if (video.ended) return set(PlayerState.ENDED);
    if (video.paused) return set(state === PlayerState.UNSTARTED && video.currentTime === 0 ? PlayerState.CUED : PlayerState.PAUSED);
    // readyState < HAVE_FUTURE_DATA while playing means we are starved.
    if (video.seeking || video.readyState < 3) return set(PlayerState.BUFFERING);
    set(PlayerState.PLAYING);
  };
  for (const ev of ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'canplay', 'loadedmetadata']) {
    video.addEventListener(ev, evaluate);
  }
  return {
    get current() {
      return state;
    },
    reset() {
      set(PlayerState.UNSTARTED);
    },
  };
}
