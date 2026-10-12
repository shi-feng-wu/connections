// One SourceBuffer's worth of streaming: audio or video. Knows its renditions'
// playlists, which rendition is active, and which segment comes next. The engine
// drives it by calling `pump()`; the loader never decides *when* to load, only
// *how*.
import { parseMediaPlaylist, segmentIndexAt } from './hls-playlist.js';
import { fetchBytes } from './fetcher.js';

export class TrackLoader {
  constructor({ kind, mediaSource, renditions, baseUrl, onSample }) {
    this.kind = kind;
    this.renditions = renditions;
    this.baseUrl = baseUrl;
    this.onSample = onSample;
    this.playlists = new Map(); // rendition index -> parsed playlist
    this.active = 0; // rendition used for the *next* segment
    this.initFor = -1; // rendition whose init segment the SourceBuffer last saw
    this.next = 0; // next segment index to fetch
    this.busy = false;
    this.done = false;
    this.abort = null;
    this.sb = mediaSource.addSourceBuffer(renditions[0].mime);
    this.sb.mode = 'segments';
    this.appended = { segments: 0, bytes: 0 };
  }

  async playlist(i) {
    if (!this.playlists.has(i)) {
      const url = new URL(this.renditions[i].playlist, this.baseUrl);
      const text = await (await fetch(url)).text();
      this.playlists.set(i, parseMediaPlaylist(text, url.href));
    }
    return this.playlists.get(i);
  }

  bufferedAhead(time) {
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (time >= b.start(i) - 0.1 && time <= b.end(i)) return b.end(i) - time;
    }
    return 0;
  }

  /** Fetch and append the next segment. Resolves when appended (or skipped). */
  async pump() {
    if (this.busy || this.done) return;
    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const rendition = this.active;
      const pl = await this.playlist(rendition);
      if (this.next >= pl.segments.length) {
        this.done = true;
        return;
      }
      if (this.initFor !== rendition) {
        const init = await fetchBytes(pl.initUrl, { signal });
        await this.#append(init);
        this.initFor = rendition;
      }
      const seg = pl.segments[this.next];
      const data = await fetchBytes(seg.url, { signal, onSample: this.onSample });
      await this.#append(data);
      this.appended.segments++;
      this.appended.bytes += data.byteLength;
      this.next++;
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /** Reposition for a seek: drop in-flight work, restart at the segment covering `time`. */
  async seek(time) {
    this.abort?.abort();
    await this.#idle();
    const pl = await this.playlist(this.active);
    // If `time` is already buffered, keep filling from the end of that range.
    const ahead = this.bufferedAhead(time);
    this.next = segmentIndexAt(pl.segments, time + ahead);
    if (ahead > 0 && time + ahead >= pl.duration - 0.05) this.next = pl.segments.length;
    this.done = this.next >= pl.segments.length;
  }

  /** Switch rendition. `flush` drops buffered media after `time` so the switch is visible now. */
  async switchTo(index, { flush = false, time = 0 } = {}) {
    if (index === this.active && !flush) return;
    this.active = index;
    if (flush) {
      this.abort?.abort();
      await this.#idle();
      const keepUntil = time + 1; // keep a sliver so playback doesn't stall
      if (this.#bufferedEnd() > keepUntil) await this.#remove(keepUntil, Infinity);
      await this.seek(time);
    }
  }

  /** Free memory behind the playhead. */
  async evictBefore(time) {
    const b = this.sb.buffered;
    if (b.length && b.start(0) < time - 1 && !this.busy) await this.#remove(0, time);
  }

  #bufferedEnd() {
    const b = this.sb.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  async #append(data) {
    await this.#idle();
    this.sb.appendBuffer(data);
    await this.#idle();
  }

  async #remove(start, end) {
    await this.#idle();
    this.sb.remove(start, end);
    await this.#idle();
  }

  #idle() {
    return this.sb.updating ? new Promise((r) => this.sb.addEventListener('updateend', r, { once: true })) : Promise.resolve();
  }
}
