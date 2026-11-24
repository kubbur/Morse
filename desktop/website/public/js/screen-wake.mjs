export class ScreenWake {
  constructor({ api = globalThis.navigator?.wakeLock, timers = globalThis, onState = () => {} } = {}) {
    Object.assign(this, { api, timers, onState });
    this.enabled = false; this.version = 0; this.state = 'off';
  }
  report(state) { if (this.state !== state) { this.state = state; this.onState(state); } }
  setActive(active) {
    if (this.enabled === !!active) return;
    this.enabled = !!active; this.version++;
    this.timers.clearTimeout(this.retry); this.retry = null;
    if (this.enabled) this.acquire();
    else {
      const lock = this.lock; this.lock = null;
      if (lock) Promise.resolve().then(() => lock.release()).catch(() => {});
      this.report('off');
    }
  }
  refresh() {
    if (!this.enabled) return;
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.acquire();
  }
  acquire() {
    if (!this.enabled || this.lock || this.pending) return;
    if (!this.api?.request) { this.report('unsupported'); return; }
    const version = this.version;
    this.report('requesting');
    const pending = Promise.resolve().then(() => this.api.request('screen')).then(async lock => {
      if (!this.enabled || version !== this.version) { await lock.release(); return; }
      if (lock.released) { this.report('blocked'); return; }
      this.lock = lock;
      lock.addEventListener('release', () => {
        if (this.lock !== lock) return;
        this.lock = null; this.report('released');
        if (this.enabled) this.retry = this.timers.setTimeout(() => { this.retry = null; this.acquire(); }, 1000);
      }, { once: true });
      this.report('held');
    }).catch(() => {
      if (this.enabled && version === this.version) this.report('blocked');
    }).finally(() => {
      this.pending = null;
      if (this.enabled && version !== this.version) this.acquire();
    });
    this.pending = pending;
  }
}
