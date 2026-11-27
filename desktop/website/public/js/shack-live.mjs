const holdRefreshMs = 350;
const holdLease = 1.15; // Audio seconds. A lost release cannot leave the receiver sounding indefinitely.
const initialBuffer = .055;
const steadyBuffer = .025;
const maximumBuffer = .180;
const audioLead = .004;
const ramp = .003;

// Transit includes the difference between two unrelated clock origins. Its range
// measures jitter without a clock sync. Keep one minute of samples in 5 s buckets.
export class ArrivalTiming {
  constructor() { this.buckets=[]; }
  observe(arrival,source) {
    const slot=Math.floor(arrival/5), transit=arrival-source;
    let bucket=this.buckets.at(-1);
    if (bucket?.slot!==slot) {
      this.buckets=this.buckets.filter(b=>b.slot>slot-12);
      bucket={slot,low:transit,high:transit,count:0};
      this.buckets.push(bucket);
    }
    bucket.low=Math.min(bucket.low,transit);
    bucket.high=Math.max(bucket.high,transit);
    bucket.count++;
  }
  buffer(now,provisional=initialBuffer) {
    const oldest=Math.floor(now/5)-11;
    let low=Infinity, high=-Infinity, count=0;
    for (const bucket of this.buckets) {
      if (bucket.slot<oldest) continue;
      low=Math.min(low,bucket.low);
      high=Math.max(high,bucket.high);
      count+=bucket.count;
    }
    if (count<2) return 0;
    return Math.min(maximumBuffer,Math.max(count<4 ? provisional : steadyBuffer,high-low+.015));
  }
}

export class LiveKeySender {
  constructor(send,disconnect) {
    this.send=send;
    this.disconnect=disconnect;
    this.pending=[];
    this.sequence=0;
    this.ack=0;
    this.sent=0;
    this.inflight=0;
  }
  edge(down,at) {
    if (this.closed || !Number.isFinite(at)) return;
    if (down) {
      if (this.held) return;
      let continuation;
      if (!this.stream || at<this.last || at-this.last>6000 || at-this.origin>115000) {
        // The wire offset rolls over during a long over. Preserve the actual
        // gap from the previous release so the listener can keep its clock.
        if (this.stream && at>=this.last && at-this.last<=6000)
          continuation={previous:this.stream,gap:Math.round(at-this.last)};
        this.stream=crypto.randomUUID();
        this.origin=at;
      }
      this.held={stream:this.stream,offset:Math.round(at-this.origin)};
      this.refresh=setInterval(()=>this.enqueue('hold',this.held),holdRefreshMs);
      this.enqueue('down',{...this.held,...continuation});
    } else if (this.held) {
      const offset=Math.round(at-this.origin);
      if (offset<this.held.offset || offset-this.held.offset>10000) { this.cancel(); return; }
      this.last=at;
      const release={stream:this.stream,offset};
      this.held=null;
      clearInterval(this.refresh);
      this.enqueue('up',release);
    }
  }
  cancel() {
    if (!this.held) return;
    const held=this.held;
    this.held=null;
    this.stream=null;
    clearInterval(this.refresh);
    this.enqueue('cancel',held);
  }
  enqueue(edge,mark) {
    if (!mark || this.closed) return;
    this.pending.push({...mark,edge});
    this.sequence++;
    if (this.pending.length>96) { this.disconnect(); return; }
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
    clearInterval(this.refresh);
    this.held=null;
    this.pending.length=0;
  }
}

function fadeAt(voice,end,now) {
  const fall=Math.max(now,voice.start+ramp,end-ramp);
  voice.gain.cancelScheduledValues(voice.deadline-ramp);
  voice.gain.setValueAtTime(voice.level,fall);
  voice.gain.linearRampToValueAtTime(0,Math.max(fall+.001,end));
  voice.osc.stop(Math.max(fall+.001,end)+.002);
  voice.deadline=end;
}

export class LiveKeyReceiver {
  constructor() {
    this.peers=new Map();
    this.voices=new Set();
  }
  stop(peer) {
    for (const voice of this.voices) {
      if (peer!==undefined && voice.peer!==peer) continue;
      voice.osc.stop();
      this.voices.delete(voice);
    }
    if (peer===undefined) this.peers.clear(); else this.peers.delete(peer);
  }
  key(ctx,settings,{peer,stream,edge,offset,previous,gap,receiveBuffer}) {
    if (edge==='cancel') { this.stop(peer); return; }
    if (!ctx || ctx.state!=='running' || !Number.isInteger(offset) || offset<0) return;
    const now=ctx.currentTime;
    let state=this.peers.get(peer);
    if (edge==='hold') {
      const v=state?.voice;
      if (v && state.stream===stream && v.offset===offset && now<v.deadline-ramp)
        fadeAt(v,Math.min(v.start+10.1,Math.max(v.deadline,now+holdLease)),now);
      return;
    }
    if (edge!=='down' && edge!=='up') return;
    if (!state || state.stream!==stream) {
      if (edge!=='down') return; // A listener can tune in halfway through a mark.
      if (state && state.stream===previous && !state.voice && state.lastUp!=null && offset===0 && Number.isInteger(gap) && gap>=0 && gap<=6000) {
        state.stream=stream;
        state.segment=state.lastUp+gap/1000;
      } else {
        const learned=Math.max(receiveBuffer || 0,state?.timing.buffer(now,receiveBuffer || initialBuffer) || 0);
        const buffer=learned ? Math.min(maximumBuffer,Math.max(steadyBuffer,learned)) : initialBuffer;
        if (state?.voice) this.stop(peer);
        if (!state && this.peers.size>=256) this.stop(this.peers.keys().next().value);
        state={stream,segment:0,origin:now-offset/1000+buffer,timing:new ArrivalTiming()};
        this.peers.set(peer,state);
      }
    }
    if (edge==='down' ? state.voice : !state.voice) return;
    const source=state.segment+offset/1000;
    state.timing.observe(now,source);
    // Keep this over on one clock, even if an individual edge misses its deadline.
    const due=state.origin+source;
    const time=Math.max(due,now+audioLead);
    if (edge==='up') {
      const voice=state.voice;
      state.voice=null;
      state.lastUp=source;
      if (due<=voice.start && now<voice.start && now+audioLead>=due) voice.osc.stop(voice.start);
      else if (now<voice.deadline) fadeAt(voice,Math.max(voice.start+.008,time),now);
      return;
    }
    const osc=ctx.createOscillator(), env=ctx.createGain();
    const level=Math.max(0,Math.min(100,settings.volume))/100*.2;
    const voice={peer,offset,osc,gain:env.gain,level,start:time,deadline:time+holdLease};
    state.voice=voice;
    this.voices.add(voice);
    osc.frequency.value=settings.tone;
    env.gain.setValueAtTime(0,time);
    env.gain.linearRampToValueAtTime(level,time+ramp);
    osc.connect(env).connect(ctx.destination);
    osc.onended=()=>{
      this.voices.delete(voice);
      if (state.voice===voice) state.voice=null;
      osc.disconnect(); env.disconnect();
    };
    osc.start(time);
    fadeAt(voice,voice.deadline,now);
  }
}
