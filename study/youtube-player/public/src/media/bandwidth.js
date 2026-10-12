// Throughput estimator: two exponentially-weighted moving averages with
// different half-lives, reporting the lower one. The fast average reacts to a
// sudden drop; the slow one keeps a single fast download from over-promising.
// (A standard technique in open-source adaptive players.)
export class BandwidthEstimator {
  constructor({ fastHalfLife = 2, slowHalfLife = 6, defaultBps = 1_000_000, minBytes = 16_000 } = {}) {
    this.fast = new Ewma(fastHalfLife);
    this.slow = new Ewma(slowHalfLife);
    this.defaultBps = defaultBps;
    this.minBytes = minBytes;
    this.samples = 0;
  }

  /** Record one download: `bytes` received in `ms` milliseconds. */
  sample(bytes, ms) {
    if (bytes < this.minBytes || ms <= 0) return; // tiny responses are all latency
    const bps = (bytes * 8 * 1000) / ms;
    const weight = ms / 1000;
    this.fast.add(weight, bps);
    this.slow.add(weight, bps);
    this.samples++;
  }

  estimate() {
    return this.samples < 1 ? this.defaultBps : Math.min(this.fast.value(), this.slow.value());
  }
}

class Ewma {
  constructor(halfLife) {
    this.alpha = Math.exp(Math.log(0.5) / halfLife);
    this.estimate = 0;
    this.totalWeight = 0;
  }
  add(weight, value) {
    const a = this.alpha ** weight;
    this.estimate = value * (1 - a) + a * this.estimate;
    this.totalWeight += weight;
  }
  value() {
    return this.estimate / (1 - this.alpha ** this.totalWeight); // zero-bias correction
  }
}
