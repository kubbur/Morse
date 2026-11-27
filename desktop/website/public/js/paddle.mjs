// The Mac companion reports contacts, not decoded Morse or keyer-generated
// marks. Keep its timestamp clock separate from browser arrival time.
export const PADDLE_URL = 'http://127.0.0.1:17373/events';

export function paddleSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid paddle event.');
  const data = JSON.parse(raw);
  if (!data || data.v !== 1 || !Number.isSafeInteger(data.seq) || data.seq < 0 ||
      typeof data.dit !== 'boolean' || typeof data.dah !== 'boolean' ||
      typeof data.status !== 'string' || data.status.length > 40 ||
      !Number.isFinite(data.timeMs) || data.timeMs < 0 || data.timeMs > 1e12) throw new Error('Invalid paddle event.');
  return { v: 1, seq: data.seq, status: data.status, dit: data.status === 'ready' && data.dit, dah: data.status === 'ready' && data.dah, timeMs: data.timeMs };
}

export class PaddleKeyer {
  constructor({ wpm = 30, mode = 'a', onEdge = () => {}, onReplay = null } = {}) {
    this.unit = 1200 / Math.max(5, Math.min(80, wpm));
    this.mode = mode === 'b' ? 'b' : 'a';
    this.onEdge = onEdge;
    this.onReplay = typeof onReplay === 'function' ? onReplay : null;
    this.reset();
  }
  reset() {
    this.dit = this.dah = false;
    this.memory = { dit: false, dah: false };
    this.slides = [];
    this.contactHistory = []; this.contactAt = -1;
    this.phase = 'idle'; this.due = Infinity; this.last = 'dah'; this.extra = ''; this.squeezed = false; this.clock = -1;
  }
  choose() {
    if (this.slides.length) return this.slides.shift();
    const dit = this.dit || this.memory.dit, dah = this.dah || this.memory.dah;
    if (dit && dah) return this.last === 'dit' ? 'dah' : 'dit';
    if (dit || dah) return dit ? 'dit' : 'dah';
    const extra = this.extra; this.extra = ''; return extra;
  }
  start(at) {
    const symbol = this.choose();
    if (!symbol) { this.phase = 'idle'; this.due = Infinity; this.last = 'dah'; return; }
    this.memory[symbol] = false;
    this.extra = '';
    this.last = symbol; this.phase = 'mark'; this.due = at + this.unit * (symbol === 'dit' ? 1 : 3);
    this.onEdge({ down: true, at }, this.due - at);
  }
  advance(to) {
    if (!Number.isFinite(to) || to < this.clock) return;
    let steps = 0;
    while (this.due <= to && ++steps < 5000) {
      const at = this.due;
      if (this.phase === 'mark') {
        this.onEdge({ down: false, at }); this.phase = 'gap'; this.due = at + this.unit;
      } else this.start(at);
    }
    this.clock = to;
  }
  contacts(dit, dah, at, slide = false) {
    if (typeof dit !== 'boolean' || typeof dah !== 'boolean' || !Number.isFinite(at) || at < (this.onReplay ? this.contactAt : this.clock)) return false;
    if (this.onReplay) {
      const previous = this.contactHistory.at(-1);
      if (!previous || previous.dit !== dit || previous.dah !== dah) {
        if (this.contactHistory.length >= 4096) return false;
        if (at < this.clock) return this.replayContact({ dit, dah, at });
        this.contactHistory.push({ dit, dah, at });
      }
      this.contactAt = at;
      if (at < this.clock) return true; // A late unchanged snapshot needs no correction.
    }
    this.advance(at);
    if (slide) {
      // A finger can cross several times during one dah. Play each crossing once in order.
      if (this.slides.length >= 64) return false;
      this.slides.push(dit ? 'dit' : 'dah');
    } else {
      if (dit && dah) this.slides.length = 0;
      if (dit && !this.dit) this.memory.dit = true;
      if (dah && !this.dah) this.memory.dah = true;
    }
    this.dit = dit; this.dah = dah;
    if (dit && dah) this.squeezed = true;
    if (!dit && !dah && this.squeezed) {
      this.memory = { dit: false, dah: false };
      if (this.mode === 'b' && this.phase !== 'idle') this.extra = this.last === 'dit' ? 'dah' : 'dit';
      this.squeezed = false;
    }
    if (this.phase === 'idle') this.start(at);
    return true;
  }
  replayContact(contact) {
    // Browser ticks predict held elements ahead of the latest SSE contact.
    // Rebuild that prediction when a contact arrives slightly behind the tick,
    // preserving the source timestamps rather than dropping or retiming it.
    const history = [...this.contactHistory, contact], until = this.clock;
    const onEdge = this.onEdge, edges = [];
    this.onEdge = edge => edges.push(edge);
    try {
      this.reset();
      for (const row of history) this.contacts(row.dit, row.dah, row.at);
      this.advance(until);
    } finally { this.onEdge = onEdge; }
    this.onReplay(edges);
    return true;
  }
  get busy() { return this.phase !== 'idle'; }
}

export class PaddleConnection {
  constructor({ onContacts = () => {}, onStatus = () => {}, onReset = () => {}, onIntent = () => {}, enabled = true, wanted = false, EventSourceClass = globalThis.EventSource, now = () => performance.now(), timers = globalThis } = {}) {
    Object.assign(this, { onContacts, onStatus, onReset, onIntent, enabled, wanted, EventSourceClass, now, timers });
    this.source = null; this.interval = null; this.queue = []; this.lastSeq = -1; this.lastRemote = -1;
    this.attempt = 0; this.connected = false;
  }
  connect() {
    this.wanted = true; this.attempt = 0; this.onIntent(true);
    this.open();
  }
  setActive(active) {
    if (this.enabled === !!active) return;
    this.enabled = !!active;
    if (this.enabled && this.wanted) this.open();
    else if (!this.enabled) { this.close(); this.onStatus('off', 'Morse Paddle paused outside Send'); }
  }
  setLiveKeying(enabled) {
    if (!!this.liveKeying===enabled) return;
    this.liveKeying=enabled;
    this.queue=[]; this.anchor=null; this.heldSince=null;
  }
  open() {
    this.close();
    if (!this.enabled || !this.wanted) return;
    this.onStatus('connecting', 'Connecting to Morse Paddle…');
    try {
      const source = this.source = new this.EventSourceClass(PADDLE_URL, { withCredentials: false });
      source.addEventListener('paddle', event => { if (this.source === source) this.receive(event.data); });
      source.onerror = () => { if (this.source === source) this.fail('Connection lost.'); };
      this.interval = this.timers.setInterval(() => this.tick(), 16);
    } catch { this.fail('Could not connect. Open Morse Paddle and allow this site.'); }
  }
  receive(raw) {
    let row;
    try { row = paddleSnapshot(raw); }
    catch { this.fail('Invalid paddle data. Reconnect Morse Paddle.'); return; }
    if (row.seq <= this.lastSeq) return;
    if (this.lastSeq >= 0 && (row.seq !== this.lastSeq + 1 || row.timeMs < this.lastRemote)) {
      this.fail('Paddle events were interrupted. Reconnect before trying again.'); return;
    }
    this.lastSeq = row.seq; this.lastRemote = row.timeMs;
    this.connected = true;
    if (!this.stableTimer) this.stableTimer = this.timers.setTimeout(() => { this.attempt = 0; this.stableTimer = null; }, 10000);
    if (row.status !== 'ready') {
      this.queue = []; this.anchor = null; this.heldSince = null; this.onReset();
      this.onStatus('waiting', 'Morse Paddle is not ready. Check its audio input and Link setting.'); return;
    }
    // A bounded playout buffer lets close contact changes retain their native
    // timestamps rather than stretching marks with event-loop/network jitter.
    const arrived = this.now();
    if (!this.anchor || this.liveKeying) this.anchor = { remote: row.timeMs, local: arrived };
    const cursor = this.remoteNow();
    if (row.timeMs < cursor - 5 || this.queue.length > 512) {
      this.queue = []; this.anchor = { remote: row.timeMs, local: arrived }; this.onReset();
      this.onStatus('ready', 'Paddle timing paused. Try that answer again.');
    } else this.onStatus('ready', 'Morse Paddle connected · Mac sidetone');
    if (this.liveKeying) this.onContacts(row.dit,row.dah,row.timeMs);
    else this.queue.push(row);
    this.lastArrival = arrived;
    if (row.dit || row.dah) this.heldSince ??= arrived;
    else this.heldSince = null;
  }
  remoteNow() { return this.anchor ? this.anchor.remote + this.now() - this.anchor.local - (this.liveKeying ? 16 : 100) : -Infinity; }
  tick() {
    if (!this.anchor) return;
    if (this.heldSince != null && this.now() - this.heldSince > 10000) { this.fail('Paddle held too long. Release both contacts and reconnect.'); return; }
    const until = this.remoteNow();
    while (this.queue.length && this.queue[0].timeMs <= until) {
      const row = this.queue.shift();
      this.onContacts(row.dit, row.dah, row.timeMs);
    }
    this.onContacts(null, null, until);
  }
  fail(message) {
    this.close();
    if (!this.enabled || !this.wanted) { this.onStatus('error', message); return; }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.onStatus('reconnecting', `${message} Reconnecting in ${delay / 1000}s…`);
    this.retry = this.timers.setTimeout(() => { this.retry = null; if (this.enabled && this.wanted) this.open(); }, delay);
  }
  close() {
    const source = this.source; this.source = null; source?.close();
    this.timers.clearInterval(this.interval); this.interval = null;
    this.timers.clearTimeout(this.retry); this.retry = null;
    this.timers.clearTimeout(this.stableTimer); this.stableTimer = null;
    this.connected = false;
    this.queue = []; this.anchor = null; this.lastSeq = this.lastRemote = -1; this.heldSince = null;
    this.onReset();
  }
  disconnect() {
    this.wanted = false; this.attempt = 0; this.onIntent(false);
    this.close(); this.onStatus('off', 'Morse Paddle disconnected');
  }
}
