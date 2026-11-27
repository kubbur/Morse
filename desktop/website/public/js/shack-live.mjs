const audioLead = .004;
const ramp = .003;

const validDuration = ms => Number.isInteger(ms) && ms >= 1 && ms <= 10000;
const validWpm = wpm => Number.isInteger(wpm) && wpm >= 5 && wpm <= 80;

// Probes and mark timestamps use the same sender clock. Subtract its fastest
// recent transit to measure how much of this mark's playout delay is already spent.
export class ArrivalTiming {
  constructor() { this.buckets = []; }
  observe(arrival, source) {
    const slot = Math.floor(arrival / 5), transit = arrival - source;
    let bucket = this.buckets.at(-1);
    if (bucket?.slot !== slot) {
      this.buckets = this.buckets.filter(b => b.slot > slot - 12);
      bucket = {slot, low:transit};
      this.buckets.push(bucket);
    }
    bucket.low = Math.min(bucket.low, transit);
  }
  age(arrival, source) {
    const oldest = Math.floor(arrival / 5) - 11;
    let fastest = Infinity;
    for (const bucket of this.buckets) if (bucket.slot >= oldest) fastest = Math.min(fastest, bucket.low);
    return Math.max(0, arrival - source - fastest);
  }
}

export class LiveKeySender {
  constructor(send, disconnect, sinceJoin = () => 0) {
    Object.assign(this,{send,disconnect,sinceJoin});
    this.pending=[];
    this.sequence=0;
    this.ack=0;
    this.sent=0;
    this.inflight=0;
  }
  edge(down, at, wpm = 30, duration) {
    if (this.closed || !Number.isFinite(at)) return;
    if (down) {
      if (this.held || !validWpm(wpm)) return;
      const planned = Number.isFinite(duration) && duration > 0 && duration <= 10000;
      this.held = {at, wpm, sent:Math.max(0, Math.round(this.sinceJoin())), planned};
      if (this.held.planned) this.publish(this.held, at + duration, false);
    } else if (this.held) {
      const held = this.held;
      this.held = null;
      if (!held.planned) this.publish(held, at, true);
    }
  }
  cancel() { this.held = null; }
  publish(mark, endAt, measured) {
    const {at, wpm, sent} = mark;
    if (endAt <= at || endAt - at > 10000) return;
    let continuation;
    if (!this.stream || at < this.last || at - this.last > 6000 || at - this.origin > 115000 || wpm !== this.wpm) {
      if (this.stream && at >= this.last && at - this.last <= 6000)
        continuation = {previous:this.stream, gap:Math.round(at - this.last)};
      this.stream = crypto.randomUUID();
      this.origin = at;
      this.endOffset = 0;
      this.wpm = wpm;
    }
    const stream = this.stream, offset = Math.max(this.endOffset, Math.round(at - this.origin));
    // Round both ends against one origin to avoid accumulating fractional dit times.
    const end = Math.max(offset + 1, Math.round(endAt - this.origin));
    this.endOffset = end;
    this.last = endAt;
    // A single upload also works with relays that only understand key edges.
    this.pending.push({edge:'down', stream, offset, duration:end-offset, wpm, sent, measured, ...continuation},
      {edge:'up', stream, offset:end});
    this.sequence += 2;
    if (this.pending.length > 96) { this.disconnect(); return; }
    void this.flush();
  }
  async flush() {
    if (this.closed || this.inflight>=3 || this.sent===this.sequence) return;
    const end=this.sequence, first=this.ack+1;
    const packet={first,edges:this.pending.slice()};
    this.sent=end;
    this.inflight++;
    const deadline=setTimeout(()=>{if (!this.closed && this.ack<end) this.disconnect();},1800);
    try {
      let response;
      try { response=await this.send(packet); }
      catch {
        if (this.closed || this.sent>end || this.ack>=end) return;
        response=await this.send(packet);
      }
      if (this.closed) return;
      if (!Number.isSafeInteger(response.ack) || response.ack<end || response.ack>this.sequence)
        throw Error('Incomplete key acknowledgement.');
      if (response.ack>this.ack) {
        this.pending.splice(0,response.ack-this.ack);
        this.ack=response.ack;
      }
    } catch {
      if (!this.closed && this.sent===end && this.ack<end) this.disconnect();
    } finally {
      clearTimeout(deadline);
      this.inflight--;
      if (!this.closed) void this.flush();
    }
  }
  close() {
    this.closed=true;
    this.held=null;
    this.pending.length=0;
  }
}

export class LiveKeyReceiver {
  constructor() {
    this.peers = new Map();
    this.voices = new Set();
  }
  stop(peer) {
    for (const voice of this.voices) {
      if (peer !== undefined && voice.peer !== peer) continue;
      voice.osc.stop();
      this.voices.delete(voice);
    }
    if (peer === undefined) this.peers.clear();
    else this.peers.delete(peer);
  }
  key(ctx, settings, event) {
    const {peer, stream, edge, offset, duration} = event;
    if (edge === 'cancel') { this.stop(peer); return; }
    if (!ctx || ctx.state !== 'running' || typeof stream !== 'string' || !Number.isInteger(offset) || offset < 0) return;
    let state = this.peers.get(peer);
    if (edge === 'up') {
      // Older transmitters reveal the length only on release. Until then the
      // mark stays silent, even if the release is delayed or lost entirely.
      if (state?.stream === stream && state.pending != null) {
        const start = state.pending;
        state.pending = null;
        if (validDuration(offset - start)) this.play(ctx, settings, peer, state, start, offset - start);
      }
      return;
    }
    if (edge !== 'down') return;
    if (!state || state.stream !== stream) {
      const {previous, gap} = event;
      const wpm = validWpm(event.wpm) ? event.wpm : validWpm(settings.wpm) ? settings.wpm : 30;
      const age = Math.max(event.pathAge || 0, event.measured && validDuration(duration) ? duration / 1000 : 0);
      let origin = ctx.currentTime + 3.6 / wpm - age - offset / 1000;
      if (state && state.end != null) {
        const previousEnd = state.origin + state.end / 1000;
        const linked = state.stream === previous && offset === 0 && Number.isInteger(gap) && gap >= 0 && gap <= 6000;
        if (linked && wpm === state.wpm) origin = previousEnd + gap / 1000;
        else if (previousEnd > ctx.currentTime)
          origin = Math.max(origin, previousEnd + (linked ? gap / 1000 : 1.2 / wpm) - offset / 1000);
      }
      if (!state && this.peers.size >= 256) this.stop(this.peers.keys().next().value);
      state = {stream, wpm, origin, end:null, pending:null};
      this.peers.set(peer,state);
    }
    if (state.end != null && offset < state.end) return;
    if (validDuration(duration)) this.play(ctx, settings, peer, state, offset, duration);
    else state.pending = offset;
  }
  play(ctx, settings, peer, state, offset, duration) {
    const due = state.origin + offset / 1000;
    const start = Math.max(due, ctx.currentTime + audioLead);
    // A late complete note moves the rest of this over just enough to retain
    // the sender's gaps. It never extends the preceding note or overlaps it.
    state.origin += start - due;
    state.end = offset + duration;
    state.pending = null;
    const end = start + duration / 1000, fade = Math.min(ramp, (end - start) / 3);
    const osc = ctx.createOscillator(), env = ctx.createGain();
    const level = Math.max(0, Math.min(100, settings.volume)) / 100 * .2;
    osc.frequency.value = settings.tone;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(level, start + fade);
    env.gain.setValueAtTime(level, end - fade);
    env.gain.linearRampToValueAtTime(0, end);
    osc.connect(env).connect(ctx.destination);
    const voice = {peer, osc};
    this.voices.add(voice);
    osc.onended = () => { this.voices.delete(voice); osc.disconnect(); env.disconnect(); };
    osc.start(start);
    osc.stop(end + .002);
  }
}
