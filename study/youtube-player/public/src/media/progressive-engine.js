// Fallback engine: a single muxed file handed straight to the <video> element.
// The browser does its own buffering; there is no quality switching.
import { Emitter } from '../core/emitter.js';

export class ProgressiveEngine extends Emitter {
  constructor(video, manifest) {
    super();
    this.video = video;
    this.manifest = manifest;
  }

  async start() {
    this.video.src = new URL(this.manifest.progressive, this.manifest.baseUrl).href;
    this.timer = setInterval(() => this.emit('stats', this.stats()), 500);
  }

  destroy() {
    clearInterval(this.timer);
    this.video.removeAttribute('src');
    this.video.load();
  }

  qualities() {
    return [];
  }
  currentQuality() {
    return `${this.video.videoHeight}p`;
  }
  setQuality() {}

  stats() {
    return {
      engine: 'progressive',
      src: this.manifest.progressive,
      resolution: `${this.video.videoWidth}x${this.video.videoHeight}`,
      readyState: this.video.readyState,
    };
  }
}
