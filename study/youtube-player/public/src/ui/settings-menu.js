// Gear menu: a stack of panels (main -> submenu -> back), each a list of
// items. Panel contents are rebuilt on open so they always reflect live state.
import { icons } from './icons.js';

export class SettingsMenu {
  constructor(player, root, { captions }) {
    this.player = player;
    this.captions = captions;
    this.el = document.createElement('div');
    this.el.className = 'vp-settings';
    this.el.hidden = true;
    this.el.setAttribute('role', 'menu');
    root.append(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get open() {
    return !this.el.hidden;
  }

  toggle() {
    this.open ? this.close() : this.show('main');
  }

  close() {
    this.el.hidden = true;
  }

  show(panel) {
    this.el.hidden = false;
    const p = this.player;
    const panels = {
      main: () => [
        { label: 'Playback speed', value: p.video.playbackRate === 1 ? 'Normal' : `${p.video.playbackRate}`, go: 'speed' },
        this.captions.tracks.length && { label: 'Subtitles/CC', value: this.captions.activeLabel() ?? 'Off', go: 'captions' },
        p.getAvailableQualityLevels().length > 1 && {
          label: 'Quality',
          value: p.getQualitySetting() === 'auto' ? `Auto (${p.getPlaybackQuality()})` : p.getQualitySetting(),
          go: 'quality',
        },
      ],
      speed: () =>
        p.getAvailablePlaybackRates().map((r) => ({
          label: r === 1 ? 'Normal' : String(r),
          checked: p.video.playbackRate === r,
          act: () => p.setPlaybackRate(r),
        })),
      quality: () =>
        p
          .getAvailableQualityLevels()
          .slice()
          .reverse()
          .map((q) => ({ label: q === 'auto' ? 'Auto' : q, checked: p.getQualitySetting() === q, act: () => p.setPlaybackQuality(q) })),
      captions: () => [
        { label: 'Off', checked: this.captions.active == null, act: () => this.captions.select(null) },
        ...this.captions.tracks.map((t) => ({ label: t.label, checked: this.captions.active === t.lang, act: () => this.captions.select(t.lang) })),
      ],
    };
    const titles = { speed: 'Playback speed', quality: 'Quality', captions: 'Subtitles/CC' };

    const items = panels[panel]().filter(Boolean);
    this.el.replaceChildren();
    if (panel !== 'main') {
      const header = button(`${icons.back}<span>${titles[panel]}</span>`, 'vp-menu-header');
      header.onclick = () => this.show('main');
      this.el.append(header);
    }
    for (const it of items) {
      const b = button(
        it.go
          ? `<span class="vp-menu-label">${it.label}</span><span class="vp-menu-value">${it.value}</span>${icons.chevron}`
          : `<span class="vp-menu-check">${it.checked ? icons.check : ''}</span><span class="vp-menu-label">${it.label}</span>`,
        'vp-menu-item',
      );
      b.setAttribute('role', it.go ? 'menuitem' : 'menuitemradio');
      if (!it.go) b.setAttribute('aria-checked', String(!!it.checked));
      b.onclick = () => {
        if (it.go) return this.show(it.go);
        it.act();
        this.show('main');
      };
      this.el.append(b);
    }
  }
}

function button(html, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = html;
  return b;
}
