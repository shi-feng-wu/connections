// The scrubber: played / buffered / hover layers, chapter gaps, a scrub handle,
// and a hover preview fed by the storyboard sprite sheet (one image holding a
// grid of thumbnails; we show one cell by offsetting background-position).
import { formatTime, clamp } from '../core/format.js';

export class ProgressBar {
  constructor(player, root) {
    this.player = player;
    this.el = document.createElement('div');
    this.el.className = 'vp-progress';
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', 'Seek slider');
    this.el.tabIndex = 0;
    this.el.innerHTML = `
      <div class="vp-progress-chapters"></div>
      <div class="vp-progress-handle"></div>
      <div class="vp-preview" hidden>
        <div class="vp-preview-thumb"></div>
        <div class="vp-preview-chapter"></div>
        <div class="vp-preview-time"></div>
      </div>`;
    root.append(this.el);

    this.chaptersEl = this.el.querySelector('.vp-progress-chapters');
    this.handle = this.el.querySelector('.vp-progress-handle');
    this.preview = this.el.querySelector('.vp-preview');
    this.scrubbing = false;
    this.hoverFraction = null;

    player.on('loaded', () => this.#buildChapters());
    for (const ev of ['timeupdate', 'progress', 'durationchange', 'seeking']) player.on(ev, () => this.render());

    this.el.addEventListener('pointerdown', (e) => this.#startScrub(e));
    this.el.addEventListener('pointermove', (e) => this.#hover(e));
    this.el.addEventListener('pointerleave', () => !this.scrubbing && this.#endHover());
  }

  #buildChapters() {
    const duration = this.player.getDuration();
    const chapters = this.player.manifest?.chapters?.length ? this.player.manifest.chapters : [{ start: 0, title: '' }];
    this.chapters = chapters.map((c, i) => ({ ...c, end: chapters[i + 1]?.start ?? duration }));
    this.chaptersEl.replaceChildren(
      ...this.chapters.map((c) => {
        const seg = document.createElement('div');
        seg.className = 'vp-chapter';
        seg.style.flexGrow = String(c.end - c.start);
        seg.innerHTML = '<div class="vp-load"></div><div class="vp-hover"></div><div class="vp-play"></div>';
        return seg;
      }),
    );
    this.render();
  }

  chapterAt(time) {
    return this.chapters?.findLast((c) => time >= c.start) ?? null;
  }

  render() {
    if (!this.chapters) return;
    const duration = this.player.getDuration() || 1;
    const played = this.scrubbing ? this.hoverFraction * duration : this.player.getCurrentTime();
    const loaded = this.player.getBufferedRanges().find(([s, e]) => played >= s - 0.5 && played <= e)?.[1] ?? played;
    const hover = this.hoverFraction == null ? 0 : this.hoverFraction * duration;

    const fill = (c, t) => clamp((t - c.start) / (c.end - c.start), 0, 1);
    this.chapters.forEach((c, i) => {
      const seg = this.chaptersEl.children[i];
      seg.children[0].style.transform = `scaleX(${fill(c, loaded)})`;
      seg.children[1].style.transform = `scaleX(${fill(c, hover)})`;
      seg.children[2].style.transform = `scaleX(${fill(c, played)})`;
    });
    this.handle.style.left = `${(played / duration) * 100}%`;
    this.el.setAttribute('aria-valuenow', String(Math.round(played)));
    this.el.setAttribute('aria-valuemax', String(Math.round(duration)));
    this.el.setAttribute('aria-valuetext', `${formatTime(played)} of ${formatTime(duration)}`);
  }

  #fractionAt(e) {
    const r = this.el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  #hover(e) {
    this.hoverFraction = this.#fractionAt(e);
    if (this.scrubbing) this.player.seekTo(this.hoverFraction * this.player.getDuration());
    this.#showPreview();
    this.render();
  }

  #endHover() {
    this.hoverFraction = null;
    this.preview.hidden = true;
    this.render();
  }

  #startScrub(e) {
    if (e.button !== 0) return;
    this.el.setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.wasPlaying = this.player.isPlaying();
    this.player.pauseVideo();
    this.el.classList.add('vp-scrubbing');
    this.#hover(e);
    const end = () => {
      this.scrubbing = false;
      this.el.classList.remove('vp-scrubbing');
      if (this.wasPlaying) this.player.playVideo();
      this.#endHover();
    };
    this.el.addEventListener('pointerup', end, { once: true });
    this.el.addEventListener('pointercancel', end, { once: true });
  }

  #showPreview() {
    const duration = this.player.getDuration();
    const t = this.hoverFraction * duration;
    const sb = this.player.manifest?.storyboard;
    const thumb = this.preview.querySelector('.vp-preview-thumb');
    if (sb) {
      const i = clamp(Math.floor(t / sb.interval), 0, sb.count - 1);
      const url = new URL(sb.url, this.player.manifest.baseUrl).href;
      Object.assign(thumb.style, {
        width: `${sb.width}px`,
        height: `${sb.height}px`,
        backgroundImage: `url("${url}")`,
        backgroundPosition: `-${(i % sb.columns) * sb.width}px -${Math.floor(i / sb.columns) * sb.height}px`,
      });
    }
    thumb.hidden = !sb;
    this.preview.querySelector('.vp-preview-chapter').textContent = this.chapterAt(t)?.title ?? '';
    this.preview.querySelector('.vp-preview-time').textContent = formatTime(t);
    this.preview.hidden = false;

    // Keep the preview inside the player horizontally.
    const barW = this.el.clientWidth;
    const w = this.preview.offsetWidth;
    this.preview.style.left = `${clamp(this.hoverFraction * barW - w / 2, 0, barW - w)}px`;
  }
}
