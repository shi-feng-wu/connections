// Feedback layered over the video: the buffering spinner, the centre "bezel"
// that flashes the action you just took (play, pause, volume...), and the
// double-tap seek ripple.
import { PlayerState } from '../core/state.js';

export class Overlays {
  constructor(player, root) {
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="vp-spinner" hidden></div>
       <div class="vp-bezel" hidden><div class="vp-bezel-icon"></div><div class="vp-bezel-text"></div></div>
       <div class="vp-ripple vp-ripple-left" hidden></div>
       <div class="vp-ripple vp-ripple-right" hidden></div>
       <div class="vp-big-play"></div>`,
    );
    this.root = root;
    this.spinner = root.querySelector('.vp-spinner');
    this.bezel = root.querySelector('.vp-bezel');

    let spinnerDelay;
    player.on('statechange', (s) => {
      clearTimeout(spinnerDelay);
      // Short stalls shouldn't flash a spinner.
      if (s === PlayerState.BUFFERING) spinnerDelay = setTimeout(() => (this.spinner.hidden = false), 400);
      else this.spinner.hidden = true;
      root.classList.toggle('vp-unstarted', s === PlayerState.UNSTARTED || s === PlayerState.CUED);
    });
  }

  flash(iconSvg, text = '') {
    this.bezel.querySelector('.vp-bezel-icon').innerHTML = iconSvg;
    this.bezel.querySelector('.vp-bezel-text').textContent = text;
    this.bezel.hidden = false;
    this.bezel.classList.remove('vp-bezel-anim');
    void this.bezel.offsetWidth; // restart the CSS animation
    this.bezel.classList.add('vp-bezel-anim');
    clearTimeout(this.bezelTimer);
    this.bezelTimer = setTimeout(() => (this.bezel.hidden = true), 600);
  }

  ripple(side, seconds) {
    const el = this.root.querySelector(`.vp-ripple-${side}`);
    el.textContent = `${seconds > 0 ? '+' : ''}${seconds} seconds`;
    el.hidden = false;
    clearTimeout(el.timer);
    el.timer = setTimeout(() => (el.hidden = true), 700);
  }
}
