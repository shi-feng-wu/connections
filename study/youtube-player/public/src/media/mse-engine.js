// Adaptive streaming engine on Media Source Extensions. Like YouTube's player
// (and DASH in general), audio and video are separate streams in separate
// SourceBuffers, so video quality can change without touching audio.
//
// The engine runs a scheduler tick that, for each track:
//   - keeps `bufferGoal` seconds buffered ahead of the playhead,
//   - asks the ABR policy which video rendition the next segment should use,
//   - evicts media far behind the playhead,
// and closes the MediaSource once both tracks have appended everything.
import { Emitter } from '../core/emitter.js';
import { TrackLoader } from './track-loader.js';
import { BandwidthEstimator } from './bandwidth.js';
import { chooseRendition } from './abr.js';

const BUFFER_GOAL = 30; // seconds ahead
const BACK_BUFFER = 30; // seconds kept behind the playhead
const TICK_MS = 250;

export class MseEngine extends Emitter {
  static isSupported(manifest) {
    return (
      'MediaSource' in window &&
      manifest.video?.length > 0 &&
      [...manifest.video, ...(manifest.audio ?? [])].every((r) => MediaSource.isTypeSupported(r.mime))
    );
  }

  constructor(video, manifest) {
    super();
    this.video = video;
    this.manifest = manifest;
    this.bandwidth = new BandwidthEstimator();
    this.lockedQuality = null; // null = auto
    this.switches = 0;
    this.timer = null;
    this.onSeeking = () => this.#onSeeking();
  }

  async start({ quality = 'auto' } = {}) {
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    await new Promise((r) => this.mediaSource.addEventListener('sourceopen', r, { once: true }));
    URL.revokeObjectURL(this.video.src);
    this.mediaSource.duration = this.manifest.duration;

    const common = { mediaSource: this.mediaSource, baseUrl: this.manifest.baseUrl };
    const onSample = (bytes, ms) => this.bandwidth.sample(bytes, ms);
    this.videoTrack = new TrackLoader({ kind: 'video', renditions: this.manifest.video, onSample, ...common });
    this.audioTrack = this.manifest.audio?.length
      ? new TrackLoader({ kind: 'audio', renditions: this.manifest.audio, onSample, ...common })
      : null;

    if (quality !== 'auto') this.setQuality(quality);
    this.video.addEventListener('seeking', this.onSeeking);
    this.timer = setInterval(() => this.#tick(), TICK_MS);
    this.#tick();
  }

  destroy() {
    clearInterval(this.timer);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeAttribute('src');
    this.video.load();
  }

  tracks() {
    return [this.videoTrack, this.audioTrack].filter(Boolean);
  }

  #tick() {
    // 'ended' still ticks: a seek back into evicted media must append again,
    // and any appendBuffer() re-opens an ended MediaSource.
    if (this.mediaSource.readyState === 'closed') return;
    const t = this.video.currentTime;

    if (this.lockedQuality == null) {
      const next = chooseRendition(this.manifest.video, {
        bandwidthBps: this.bandwidth.estimate(),
        bufferAhead: this.videoTrack.bufferedAhead(t),
        viewportHeight: this.video.clientHeight * devicePixelRatio,
        current: this.videoTrack.active,
      });
      if (next !== this.videoTrack.active) {
        this.videoTrack.switchTo(next); // takes effect at the next segment boundary
        this.switches++;
      }
    }

    for (const track of this.tracks()) {
      if (track.bufferedAhead(t) < BUFFER_GOAL) {
        track.pump().catch((err) => this.#fail(err));
      }
      track.evictBefore(t - BACK_BUFFER).catch(() => {});
    }

    if (this.mediaSource.readyState === 'open' && this.tracks().every((tr) => tr.done && !tr.busy && !tr.sb.updating)) {
      this.mediaSource.endOfStream();
    }
    this.emit('stats', this.stats());
    this.#emitQualityIfChanged();
  }

  async #onSeeking() {
    const t = this.video.currentTime;
    await Promise.all(this.tracks().map((tr) => tr.seek(t)));
    this.#tick();
  }

  #fail(err) {
    console.error('[mse-engine]', err);
    this.emit('error', err);
  }

  // --- quality API ----------------------------------------------------------
  qualities() {
    return this.manifest.video.map((r) => r.label);
  }

  /** Label of the rendition currently *on screen* (not the one being fetched). */
  currentQuality() {
    const h = this.video.videoHeight;
    const r = this.manifest.video.find((v) => v.height === h);
    return r?.label ?? this.manifest.video[this.videoTrack?.active ?? 0].label;
  }

  setQuality(label) {
    if (label === 'auto') {
      this.lockedQuality = null;
      return;
    }
    const i = this.manifest.video.findIndex((r) => r.label === label);
    if (i === -1) return;
    this.lockedQuality = i;
    // A manual pick should be visible immediately, so flush the forward buffer.
    this.videoTrack.switchTo(i, { flush: true, time: this.video.currentTime }).then(() => this.#tick());
    this.switches++;
  }

  #lastQuality = null;
  #emitQualityIfChanged() {
    const q = this.currentQuality();
    if (q !== this.#lastQuality) this.emit('qualitychange', (this.#lastQuality = q));
  }

  stats() {
    const t = this.video.currentTime;
    const q = this.video.getVideoPlaybackQuality?.();
    return {
      engine: 'mse',
      mime: this.manifest.video[this.videoTrack.active].mime,
      fetching: this.manifest.video[this.videoTrack.active].label,
      showing: this.currentQuality(),
      resolution: `${this.video.videoWidth}x${this.video.videoHeight}`,
      viewport: `${this.video.clientWidth}x${this.video.clientHeight}@${devicePixelRatio}x`,
      bandwidthKbps: Math.round(this.bandwidth.estimate() / 1000),
      videoBufferAhead: +this.videoTrack.bufferedAhead(t).toFixed(1),
      audioBufferAhead: this.audioTrack ? +this.audioTrack.bufferedAhead(t).toFixed(1) : null,
      segments: this.tracks().map((tr) => `${tr.kind}:${tr.appended.segments}`).join(' '),
      switches: this.switches,
      droppedFrames: q ? `${q.droppedVideoFrames}/${q.totalVideoFrames}` : 'n/a',
      mode: this.lockedQuality == null ? 'auto' : 'locked',
    };
  }
}
