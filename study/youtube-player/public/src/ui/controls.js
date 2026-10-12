// Assembles the player chrome around a <video>: bottom gradient, progress bar,
// left/right control clusters, menus and overlays, and wires them to the
// Player facade. Page-level modes (theater, miniplayer) are delegated to the
// host page via `hooks`, since they change layout outside the player box.
import { icons } from './icons.js';
import { ProgressBar } from './progress-bar.js';
import { SettingsMenu } from './settings-menu.js';
import { Overlays } from './overlays.js';
import { autohide } from './autohide.js';
import { bindKeyboard } from './keyboard.js';
import { Captions } from '../features/captions.js';
import { StatsPanel } from '../features/stats.js';
import { PlayerState } from '../core/state.js';
import { formatTime, clamp } from '../core/format.js';

export function mountControls(player, root, hooks = {}) {
  root.classList.add('vp-player', 'vp-unstarted');
  root.tabIndex = 0;

  const captions = new Captions(player, root);
  const overlays = new Overlays(player, root);

  root.insertAdjacentHTML(
    'beforeend',
    `<div class="vp-gradient-bottom"></div>
     <div class="vp-chrome-bottom">
       <div class="vp-progress-slot"></div>
       <div class="vp-controls">
         <div class="vp-left">
           <button type="button" class="vp-btn" data-action="play" data-tip="Play (k)" aria-label="Play (k)">${icons.play}</button>
           <button type="button" class="vp-btn" data-action="next" data-tip="Next (SHIFT+n)" aria-label="Next (SHIFT+n)" disabled>${icons.next}</button>
           <span class="vp-volume-area">
             <button type="button" class="vp-btn" data-action="mute" data-tip="Mute (m)" aria-label="Mute (m)">${icons.volumeHigh}</button>
             <input class="vp-volume" type="range" min="0" max="100" step="1" aria-label="Volume">
           </span>
           <span class="vp-time"><span class="vp-time-current">0:00</span> / <span class="vp-time-duration">0:00</span></span>
           <span class="vp-chapter-title"></span>
         </div>
         <div class="vp-right">
           <button type="button" class="vp-btn" data-action="captions" data-tip="Subtitles/closed captions (c)" aria-label="Subtitles/closed captions (c)" aria-pressed="false">${icons.captions}</button>
           <button type="button" class="vp-btn" data-action="settings" data-tip="Settings" aria-label="Settings">${icons.settings}</button>
           <button type="button" class="vp-btn" data-action="miniplayer" data-tip="Miniplayer (i)" aria-label="Miniplayer (i)">${icons.miniplayer}</button>
           <button type="button" class="vp-btn" data-action="theater" data-tip="Theater mode (t)" aria-label="Theater mode (t)">${icons.theater}</button>
           <button type="button" class="vp-btn" data-action="fullscreen" data-tip="Full screen (f)" aria-label="Full screen (f)">${icons.fullscreen}</button>
         </div>
       </div>
     </div>
     <div class="vp-tooltip" hidden></div>`,
  );

  const q = (sel) => root.querySelector(sel);
  const btn = (a) => q(`[data-action="${a}"]`);
  const progress = new ProgressBar(player, q('.vp-progress-slot'));
  const settings = new SettingsMenu(player, root, { captions });
  const stats = new StatsPanel(player, root);
  const volume = q('.vp-volume');

  // --- actions (shared by buttons, keyboard and gestures) -------------------
  const actions = {
    togglePlay() {
      player.togglePlay();
      overlays.flash(player.video.paused ? icons.play : icons.pause);
    },
    seekBy(s) {
      player.seekBy(s);
      overlays.ripple(s < 0 ? 'left' : 'right', s);
    },
    seekToFraction(f) {
      player.seekTo(f * player.getDuration());
    },
    volumeBy(d) {
      player.setVolume(player.getVolume() + d);
      overlays.flash(volumeIcon(), `${player.getVolume()}%`);
    },
    toggleMute() {
      player.toggleMute();
      overlays.flash(volumeIcon());
    },
    rateStep(dir) {
      const rates = player.getAvailablePlaybackRates();
      const i = clamp(rates.indexOf(player.video.playbackRate) + dir, 0, rates.length - 1);
      player.setPlaybackRate(rates[i]);
      overlays.flash('', `${rates[i]}x`);
    },
    frameStep(dir) {
      if (!player.video.paused) return;
      player.seekBy(dir / 30);
    },
    toggleCaptions() {
      captions.toggle();
    },
    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen?.();
    },
    toggleTheater() {
      hooks.toggleTheater?.();
    },
    toggleMiniplayer() {
      hooks.toggleMiniplayer?.();
    },
    closeMenus() {
      settings.close();
      stats.toggle(false);
    },
  };

  const volumeIcon = () => (player.isMuted() ? icons.volumeMuted : player.getVolume() < 50 ? icons.volumeLow : icons.volumeHigh);

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.action;
    if (a === 'play') player.togglePlay();
    else if (a === 'mute') player.toggleMute();
    else if (a === 'captions') actions.toggleCaptions();
    else if (a === 'settings') settings.toggle();
    else if (a === 'fullscreen') actions.toggleFullscreen();
    else if (a === 'theater') actions.toggleTheater();
    else if (a === 'miniplayer') actions.toggleMiniplayer();
  });
  volume.addEventListener('input', () => player.setVolume(Number(volume.value)));
  volume.addEventListener('pointerdown', (e) => e.stopPropagation());

  // Click on the video toggles play; double-click toggles fullscreen. The single
  // click is delayed briefly so a double-click doesn't also pause.
  let clickTimer = null;
  player.video.addEventListener('click', () => {
    if (settings.open) return settings.close();
    if (clickTimer) return;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      actions.togglePlay();
    }, 220);
  });
  player.video.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    clickTimer = null;
    actions.toggleFullscreen();
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    stats.toggle();
  });
  q('.vp-big-play').addEventListener('click', () => player.playVideo());

  // Tooltips above buttons.
  const tip = q('.vp-tooltip');
  root.addEventListener('pointerover', (e) => {
    const b = e.target.closest('[data-tip]');
    if (!b) return void (tip.hidden = true);
    tip.textContent = b.dataset.tip;
    tip.hidden = false;
    const rb = b.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    tip.style.left = `${clamp(rb.left - rr.left + rb.width / 2 - tip.offsetWidth / 2, 8, rr.width - tip.offsetWidth - 8)}px`;
  });

  // --- state -> view --------------------------------------------------------
  const syncPlay = () => {
    const s = player.getPlayerState();
    const ended = s === PlayerState.ENDED;
    const playing = player.isPlaying();
    btn('play').innerHTML = ended ? icons.replay : playing ? icons.pause : icons.play;
    btn('play').dataset.tip = ended ? 'Replay' : playing ? 'Pause (k)' : 'Play (k)';
    btn('play').setAttribute('aria-label', btn('play').dataset.tip);
    root.classList.toggle('vp-paused', !playing);
    root.classList.toggle('vp-ended', ended);
  };
  const syncTime = () => {
    q('.vp-time-current').textContent = formatTime(player.getCurrentTime());
    q('.vp-time-duration').textContent = formatTime(player.getDuration());
    const ch = progress.chapterAt(player.getCurrentTime());
    q('.vp-chapter-title').textContent = ch?.title ? `• ${ch.title}` : '';
  };
  const syncVolume = () => {
    btn('mute').innerHTML = volumeIcon();
    btn('mute').dataset.tip = player.isMuted() ? 'Unmute (m)' : 'Mute (m)';
    btn('mute').setAttribute('aria-label', btn('mute').dataset.tip);
    volume.value = player.isMuted() ? 0 : player.getVolume();
    volume.style.setProperty('--fill', `${volume.value}%`);
  };
  const syncCaptions = () => btn('captions').setAttribute('aria-pressed', String(!!captions.active));
  const syncFullscreen = () => {
    const fs = document.fullscreenElement === root;
    btn('fullscreen').innerHTML = fs ? icons.fullscreenExit : icons.fullscreen;
    btn('fullscreen').dataset.tip = fs ? 'Exit full screen (f)' : 'Full screen (f)';
    btn('fullscreen').setAttribute('aria-label', btn('fullscreen').dataset.tip);
    root.classList.toggle('vp-fullscreen', fs);
  };

  player.on('statechange', syncPlay);
  player.on('timeupdate', syncTime);
  player.on('durationchange', syncTime);
  player.on('volumechange', syncVolume);
  player.on('captionschange', syncCaptions);
  player.on('loaded', (m) => {
    captions.setTracks(m.captions, m.baseUrl);
    btn('captions').hidden = !m.captions?.length;
    syncTime();
  });
  document.addEventListener('fullscreenchange', syncFullscreen);

  autohide(player, root, { keepVisible: () => settings.open || progress.scrubbing });
  bindKeyboard(root, actions);
  syncPlay();
  syncVolume();

  return { actions, captions, settings, stats, setTheater: (on) => (btn('theater').innerHTML = on ? icons.theaterExit : icons.theater) };
}
