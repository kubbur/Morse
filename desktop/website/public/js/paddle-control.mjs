export const PADDLE_SIDETONE_URLS = Object.freeze({
  mute: 'http://127.0.0.1:17373/sidetone/mute',
  unmute: 'http://127.0.0.1:17373/sidetone/unmute',
});

// Commands are empty PUTs, ordered through the acknowledgement and disconnect
// cleanup. A new connection waits for the previous connection's unmute.
export class PaddleSidetone {
  constructor({ fetchImpl = (...args) => fetch(...args), timers = globalThis, onState = () => {} } = {}) {
    Object.assign(this, { fetchImpl, timers, onState });
    this.generation = 0; this.attempted = false; this.supported = false;
    this.desired = false; this.confirmed = null; this.cleanup = Promise.resolve();
  }

  enable() {
    if (this.attempted) return;
    this.attempted = this.supported = true;
    this.setMuted(this.desired);
  }

  setMuted(muted) {
    this.desired = muted === true;
    if (!this.supported) return Promise.resolve(false);
    if (!this.pending && this.confirmed === this.desired) return Promise.resolve(true);
    const generation = this.generation;
    if (!this.pending) {
      this.pending = this.flush(generation).finally(() => {
        if (generation !== this.generation) return;
        this.pending = null;
        // Apply a phase changed just after acknowledgement without another tap.
        if (this.supported && this.confirmed !== this.desired && !this.retry) this.setMuted(this.desired);
      });
    }
    return this.pending.then(() => {
      if (!this.supported || generation !== this.generation) return false;
      if (this.confirmed === muted) return true;
      if (this.desired === muted && !this.retry) return this.setMuted(muted);
      return false;
    });
  }

  async request(muted, keepalive = false) {
    const controller = new AbortController();
    const deadline = this.timers.setTimeout(() => controller.abort(), 2000);
    try {
      const response = await this.fetchImpl(muted ? PADDLE_SIDETONE_URLS.mute : PADDLE_SIDETONE_URLS.unmute, {
        method: 'PUT', mode: 'cors', credentials: 'omit', cache: 'no-store', keepalive, signal: controller.signal,
      });
      if (response.status !== 204) {
        const error = new Error('Morse Paddle did not acknowledge the sidetone command.');
        error.unsupported = [404, 405].includes(response.status);
        throw error;
      }
    } finally { this.timers.clearTimeout(deadline); }
  }

  async flush(generation) {
    this.timers.clearTimeout(this.retry); this.retry = null;
    await this.cleanup;
    while (this.supported && generation === this.generation && this.confirmed !== this.desired) {
      const muted = this.desired;
      try {
        await this.request(muted);
        if (generation !== this.generation) return;
        this.confirmed = muted;
        this.onState(muted ? 'muted' : 'sending');
      } catch (error) {
        if (generation !== this.generation) return;
        this.confirmed = null;
        if (error.unsupported) {
          this.supported = false;
          this.onState('unsupported');
        } else {
          this.onState('error');
          this.retry = this.timers.setTimeout(() => this.setMuted(this.desired), 1000);
        }
        return;
      }
    }
  }

  release() {
    const supported = this.supported, pending = this.pending;
    this.supported = this.attempted = this.desired = false; this.confirmed = null;
    this.generation++; this.pending = null;
    this.timers.clearTimeout(this.retry); this.retry = null;
    if (supported) {
      this.cleanup = (pending || this.cleanup).catch(() => {}).then(() => this.request(false, true)).catch(() => {});
    }
    this.onState('off');
    return this.cleanup;
  }
}
