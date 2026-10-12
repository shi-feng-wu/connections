import { savePrefs } from '../core/prefs.js';

// Captions: fetch WebVTT, parse cues, and render them in our own overlay
// rather than the browser's native ::cue rendering, so position/styling are
// under the player's control (and move up when the controls are visible).
export class Captions {
  constructor(player, root) {
    this.player = player;
    this.tracks = [];
    this.cues = new Map(); // lang -> cue[]
    this.active = null;
    this.el = document.createElement('div');
    this.el.className = 'vp-captions';
    this.el.setAttribute('aria-live', 'off');
    root.append(this.el);
    player.on('timeupdate', () => this.render());
    player.on('seeked', () => this.render());
  }

  setTracks(tracks, baseUrl) {
    this.tracks = (tracks ?? []).map((t) => ({ ...t, url: new URL(t.url, baseUrl).href }));
    this.cues.clear();
    const pref = this.player.prefs.captions;
    if (pref && this.tracks.some((t) => t.lang === pref)) this.select(pref, { persist: false });
    else this.select(null, { persist: false });
  }

  activeLabel() {
    return this.tracks.find((t) => t.lang === this.active)?.label ?? null;
  }

  async select(lang, { persist = true } = {}) {
    this.active = lang;
    if (persist) this.player.prefs = savePrefs({ captions: lang });
    this.player.emit('captionschange', lang);
    if (lang && !this.cues.has(lang)) {
      const track = this.tracks.find((t) => t.lang === lang);
      this.cues.set(lang, parseVtt(await (await fetch(track.url)).text()));
    }
    this.render();
  }

  toggle() {
    return this.select(this.active ? null : (this.lastLang ?? this.tracks[0]?.lang ?? null)).then(() => {
      if (this.active) this.lastLang = this.active;
    });
  }

  render() {
    const t = this.player.getCurrentTime();
    const cues = (this.active && this.cues.get(this.active)) || [];
    const text = cues
      .filter((c) => t >= c.start && t < c.end)
      .map((c) => c.text)
      .join('\n');
    if (text === this.lastText) return;
    this.lastText = text;
    this.el.replaceChildren(
      ...text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const span = document.createElement('span');
          span.className = 'vp-caption-line';
          span.textContent = line;
          return span;
        }),
    );
  }
}

// Minimal WebVTT parser: timings + text; ignores settings, styles and regions.
export function parseVtt(text) {
  const toSec = (ts) => {
    const parts = ts.split(':').map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;
    const [start, end] = lines[i].split('-->').map((s) => toSec(s.trim().split(/\s+/)[0]));
    cues.push({ start, end, text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '') });
  }
  return cues;
}
