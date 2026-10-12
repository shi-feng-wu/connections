// The Player facade: the one object page code talks to. It owns the <video>
// element, picks a playback engine (MSE adaptive vs. progressive), and exposes
// an IFrame-API-shaped surface (playVideo, seekTo, getPlayerState, ...) plus
// events. UI modules only ever see this facade, never the engine.
import { Emitter } from './emitter.js';
import { PlayerState, trackState } from './state.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { clamp } from './format.js';
import { MseEngine } from '../media/mse-engine.js';
import { ProgressiveEngine } from '../media/progressive-engine.js';

export class Player extends Emitter {
  constructor(video) {
    super();
    this.video = video;
    this.engine = null;
    this.manifest = null;
    this.prefs = loadPrefs();

    video.volume = this.prefs.volume;
    video.muted = this.prefs.muted;

    this.state = trackState(video, (s) => this.emit('statechange', s));
    for (const ev of ['timeupdate', 'progress', 'durationchange', 'volumechange', 'ratechange', 'seeking', 'seeked', 'ended', 'error']) {
      video.addEventListener(ev, () => this.emit(ev));
    }
  }

  async load(manifestUrl, { forceProgressive = false } = {}) {
    this.engine?.destroy();
    this.state.reset();
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    this.manifest = { ...(await res.json()), baseUrl: new URL('.', res.url).href };

    const useMse = !forceProgressive && MseEngine.isSupported(this.manifest);
    this.engine = useMse ? new MseEngine(this.video, this.manifest) : new ProgressiveEngine(this.video, this.manifest);
    this.engine.on('qualitychange', (q) => this.emit('qualitychange', q));
    this.engine.on('stats', (s) => this.emit('stats', s));
    await this.engine.start({ quality: this.prefs.quality });
    this.video.playbackRate = this.prefs.rate;
    this.emit('loaded', this.manifest);
  }

  // --- IFrame-API-shaped surface -------------------------------------------
  playVideo() {
    return this.video.play().catch(() => {
      // Autoplay with sound is blocked until a user gesture; retry muted.
      this.video.muted = true;
      return this.video.play();
    });
  }
  pauseVideo() {
    this.video.pause();
  }
  togglePlay() {
    return this.video.paused || this.video.ended ? this.playVideo() : this.pauseVideo();
  }
  seekTo(seconds) {
    this.video.currentTime = clamp(seconds, 0, this.getDuration() || 0);
  }
  seekBy(delta) {
    this.seekTo(this.getCurrentTime() + delta);
  }
  getCurrentTime() {
    return this.video.currentTime;
  }
  getDuration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : (this.manifest?.duration ?? 0);
  }
  getPlayerState() {
    return this.state.current;
  }
  isPlaying() {
    return this.state.current === PlayerState.PLAYING || this.state.current === PlayerState.BUFFERING;
  }

  getVolume() {
    return Math.round(this.video.volume * 100);
  }
  setVolume(pct) {
    this.video.volume = clamp(pct / 100, 0, 1);
    if (this.video.volume > 0) this.video.muted = false;
    this.prefs = savePrefs({ volume: this.video.volume, muted: this.video.muted });
  }
  isMuted() {
    return this.video.muted || this.video.volume === 0;
  }
  toggleMute() {
    this.video.muted = !this.video.muted;
    this.prefs = savePrefs({ muted: this.video.muted });
  }

  getAvailablePlaybackRates() {
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }
  setPlaybackRate(rate) {
    this.video.playbackRate = rate;
    this.prefs = savePrefs({ rate });
  }

  getAvailableQualityLevels() {
    return ['auto', ...(this.engine?.qualities() ?? [])];
  }
  getPlaybackQuality() {
    return this.engine?.currentQuality() ?? 'auto';
  }
  getQualitySetting() {
    return this.prefs.quality;
  }
  setPlaybackQuality(label) {
    this.engine?.setQuality(label);
    this.prefs = savePrefs({ quality: label });
    this.emit('qualitychange', this.getPlaybackQuality());
  }

  /** Buffered ranges as [start, end] pairs, for the progress bar. */
  getBufferedRanges() {
    const b = this.video.buffered;
    return Array.from({ length: b.length }, (_, i) => [b.start(i), b.end(i)]);
  }

  getStats() {
    return this.engine?.stats() ?? {};
  }
}
