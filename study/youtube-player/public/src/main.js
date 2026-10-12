// The watch page: mounts the player and owns the page-level layout modes.
//  - default: player in the primary column, side column on the right
//  - theater: player spans the full width above both columns
//  - miniplayer: player docks to the corner while the page is "browsed"
import { Player } from './core/player.js';
import { mountControls } from './ui/controls.js';
import { savePrefs } from './core/prefs.js';

const page = document.querySelector('.watch');
const host = document.querySelector('#player');
const video = host.querySelector('video');
const player = new Player(video);

const ui = mountControls(player, host, {
  toggleTheater() {
    setTheater(!page.classList.contains('theater'));
  },
  toggleMiniplayer() {
    if (page.classList.contains('theater')) setTheater(false); // the miniplayer docks from the primary slot
    page.classList.toggle('miniplayer');
  },
});

// Theater mode moves the same player node between two slots, so playback state
// (and the MediaSource) survive the move.
function setTheater(on) {
  const hadFocus = host.contains(document.activeElement);
  page.classList.toggle('theater', on);
  (on ? document.querySelector('#full-slot') : document.querySelector('#primary-slot')).append(host);
  if (hadFocus) host.focus(); // moving a node drops focus, which would eat the next shortcut
  ui.setTheater(on);
  player.prefs = savePrefs({ theater: on });
}
setTheater(player.prefs.theater);

document.querySelector('.mini-expand')?.addEventListener('click', () => page.classList.remove('miniplayer'));

const params = new URLSearchParams(location.search);
const manifestUrl = params.get('manifest') ?? 'media/manifest.json';
player
  .load(manifestUrl, { forceProgressive: params.has('progressive') })
  .then(() => {
    document.querySelector('.title').textContent = player.manifest.title;
    if (params.has('autoplay')) player.playVideo();
  })
  .catch((err) => {
    console.error(err);
    host.classList.add('vp-error');
    host.dataset.error = `Couldn't load ${manifestUrl} — run \`npm run media\` first. (${err.message})`;
  });

// Expose for poking at from DevTools while studying.
window.player = player;
