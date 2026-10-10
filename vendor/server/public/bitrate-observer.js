(() => {
  // Observation only: no encoder acknowledgement and no retry/instance side effects.
  class BitrateObserver {
    constructor(target, sentAt = Date.now()) { this.target = target; this.sentAt = sentAt; this.samples = []; this.excessSince = null; }
    sample(mbps, intervalMs, now = Date.now()) {
      if (!Number.isFinite(mbps) || mbps < 0 || intervalMs <= 0 || intervalMs > 5000) {
        this.samples = []; this.excessSince = null; return null;
      }
      if (now - this.sentAt < 5000) return null;
      const previous = this.samples.at(-1);
      if (previous && (now <= previous.time || now - previous.time > 5000)) { this.samples = []; this.excessSince = null; }
      this.samples.push({ time: now, mbps, intervalMs });
      this.samples = this.samples.filter(s => s.time > now - 10000);
      const duration = this.samples.reduce((n, s) => n + Math.min(s.intervalMs, s.time - (now - 10000)), 0);
      const average = this.samples.reduce((n, s) => n + s.mbps * Math.min(s.intervalMs, s.time - (now - 10000)), 0) / duration;
      const peak = Math.max(...this.samples.map(s => s.mbps));
      const excess = Math.max(0, (average / this.target - 1) * 100);
      if (duration >= 9000 && average > this.target * 1.05) this.excessSince ??= now;
      else this.excessSince = null;
      const excessSeconds = this.excessSince === null ? 0 : (now - this.excessSince) / 1000;
      return { average, peak, excess, excessSeconds, duration, status: duration < 9000 ? 'sampling' : this.excessSince === null ? 'within' : excessSeconds >= 10 ? 'over' : 'burst' };
    }
  }
  globalThis.PeerStreamBitrateObserver = BitrateObserver;
})();
