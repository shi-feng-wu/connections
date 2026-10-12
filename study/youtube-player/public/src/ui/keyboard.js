// Keyboard shortcuts, following the bindings YouTube lists in its public help
// pages (k/space, j/l, arrows, m, f, t, c, i, 0-9, Home/End, < and >).
export function bindKeyboard(root, actions) {
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLInputElement || target.closest?.('.vp-settings')) return;

    const k = e.key;
    const map = {
      ' ': actions.togglePlay,
      k: actions.togglePlay,
      j: () => actions.seekBy(-10),
      l: () => actions.seekBy(10),
      ArrowLeft: () => actions.seekBy(-5),
      ArrowRight: () => actions.seekBy(5),
      ArrowUp: () => actions.volumeBy(5),
      ArrowDown: () => actions.volumeBy(-5),
      m: actions.toggleMute,
      f: actions.toggleFullscreen,
      t: actions.toggleTheater,
      i: actions.toggleMiniplayer,
      c: actions.toggleCaptions,
      Home: () => actions.seekToFraction(0),
      End: () => actions.seekToFraction(1),
      '<': () => actions.rateStep(-1),
      '>': () => actions.rateStep(1),
      ',': () => actions.frameStep(-1),
      '.': () => actions.frameStep(1),
      Escape: actions.closeMenus,
    };
    const fn = /^[0-9]$/.test(k) ? () => actions.seekToFraction(Number(k) / 10) : map[k];
    if (!fn) return;
    // Space on a focused button should click it, not toggle playback.
    if (k === ' ' && target instanceof HTMLButtonElement) return;
    e.preventDefault();
    fn();
  });
}
