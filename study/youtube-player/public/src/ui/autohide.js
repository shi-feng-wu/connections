// Controls fade out after a few seconds of inactivity while playing, and come
// back on pointer movement, focus, or pause.
export function autohide(player, root, { delay = 3000, keepVisible = () => false } = {}) {
  let timer;
  const show = () => {
    root.classList.remove('vp-autohide');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (player.isPlaying() && !keepVisible()) root.classList.add('vp-autohide');
    }, delay);
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerdown', show);
  root.addEventListener('focusin', show);
  root.addEventListener('pointerleave', () => player.isPlaying() && !keepVisible() && root.classList.add('vp-autohide'));
  player.on('statechange', show);
  return show;
}
