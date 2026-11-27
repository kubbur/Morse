import { MorseAudio } from './audio.mjs';
import { validRhythm } from './shack-model.mjs';
import { ArrivalTiming, LiveKeySender, LiveKeyReceiver } from './shack-live.mjs';

// A separate token lives only as long as the tuned receiver. Never replay a transmission into another room.
export class BandRadio {
  constructor(exchange, changed, received) {
    Object.assign(this,{exchange,changed,received});
    this.epoch=0; this.activity={}; this.state='off'; this.queue=[];
    this.returns=new Map();
  }
  close() {
    ++this.epoch;
    clearTimeout(this.timer); clearTimeout(this.retry); clearTimeout(this.flushTimer);
    const old=this.room;
    clearTimeout(old?.probeTimer);
    this.transmitter?.close(); this.transmitter=null; this.legacyDown=null;
    this.room=null; this.queue=[]; this.pending=[]; this.stream=null; this.sending=false;
    this.activity={}; this.state='off'; this.key=''; this.heard=null; this.delayMs=null;
    if (old) {
      this.received({type:'silence',f:old.f});
      void this.exchange('leave',{f:old.f,token:old.token}).catch(()=>{});
    }
  }
  async tune(station) {
    const key=JSON.stringify(station);
    if (key===this.key) return;
    this.close();
    this.key=key;
    const epoch=this.epoch;
    this.state='connecting'; this.changed();
    try {
      const sent=performance.now();
      const opened=await this.exchange('open',{...station,live:true,probes:true});
      if (!opened.token) throw Error('Unavailable');
      if (epoch!==this.epoch) { void this.exchange('leave',{token:opened.token,f:station.f}).catch(()=>{}); return; }
      const room=this.room={f:station.f,token:opened.token,cursor:opened.cursor,seq:0,id:opened.id,live:opened.live===true,joined:performance.now()};
      this.delayMs=Math.round(room.joined-sent);
      if (room.live && opened.probes===true) {
        room.paths=new Map();
        room.stations=0;
      }
      if (Number.isFinite(opened.serverTime)) room.serverOffset=performance.now()-opened.serverTime;
      if (room.live) this.transmitter=new LiveKeySender(
        packet=>this.exchange('edges',{...packet,token:room.token,f:room.f,replyTo:this.heard}),
        ()=>{if (this.room===room) this.offline(station);}, ()=>performance.now()-room.joined);
      this.activity=opened.activity; this.state=room.live?'connecting':'live'; this.changed();
      if (room.live) void this.poll(epoch,station);
      else this.timer=setTimeout(()=>this.poll(epoch,station),250);
    } catch { if (epoch===this.epoch) this.offline(station); }
  }
  offline(station) {
    this.close();
    this.key=JSON.stringify(station); this.state='offline'; this.changed();
    const delay=this.retryDelay || 1000;
    this.retryDelay=Math.min(12000,delay*2);
    this.retry=setTimeout(()=>{this.key=''; void this.tune(station);},delay);
  }
  updateProbes(room,stations) {
    if (!room.paths || stations===room.stations) return;
    const previous=room.stations;
    room.stations=stations;
    if (stations<2) {
      clearTimeout(room.probeTimer); room.burst=0;
      if (!room.probing) room.probeTimer=setTimeout(()=>void this.probe(room),15000);
      return;
    }
    if (stations>previous && !room.burst) {
      room.burst=4;
      clearTimeout(room.probeTimer);
      if (!room.probing) room.probeTimer=setTimeout(()=>void this.probe(room),Math.random()*200);
    }
  }
  async probe(room) {
    if (room!==this.room) return;
    room.probing=true;
    const start=performance.now(), sent=Math.round(start-room.joined);
    try {
      await this.exchange('probe',{token:room.token,f:room.f,sent});
      if (room!==this.room) return;
      this.delayMs=Math.round(performance.now()-start);
      this.changed();
    }
    catch { /* The next sample is independent. Keying never waits for a probe. */ }
    room.probing=false;
    if (room===this.room) {
      room.burst=Math.max(0,room.burst-1);
      // Stagger stations sharing a busy frequency so probes do not all hit the relay together.
      const interval=room.stations<2 ? 15000 : room.burst ? 400 : 4000;
      room.probeTimer=setTimeout(()=>void this.probe(room),interval*(1+.2*Math.random()));
    }
  }
  async poll(epoch,station) {
    const room=this.room;
    if (!room || epoch!==this.epoch) return;
    try {
      const start=performance.now();
      const data=await this.exchange('poll',{token:room.token,f:room.f,cursor:room.cursor,...(room.live ? {live:true} : {})});
      if (epoch!==this.epoch) return;
      room.cursor=data.cursor;
      const arrived=performance.now();
      const delay=room.live ? this.delayMs : Math.round(arrived-start);
      if (room.live && Number.isFinite(data.serverTime)) {
        const offset=arrived-data.serverTime;
        room.serverOffset=data.serverTime<room.lastServerTime ? offset : Math.min(room.serverOffset ?? offset,offset);
        room.lastServerTime=data.serverTime;
      }
      for (const event of data.events || []) {
        if (event.type==='contact' && event.card) {
          if (this.returns.size>=80) this.returns.delete(this.returns.keys().next().value);
          this.returns.set(event.card,{token:room.token,f:room.f,until:Date.now()+3600000});
        } else if (event.type==='signature') {
          const receipt=this.returns.get(event.card);
          if (receipt) receipt.received=true;
        }
        // Audio buffered through a suspended tab or broken connection belongs in the past.
        const stale=room.live && arrived-(event.at+room.serverOffset)>1000;
        if (event.type==='probe') {
          if (!room.paths || stale || !Number.isSafeInteger(event.sent) || event.sent<0) continue;
          let path=room.paths.get(event.peer);
          if (!path) {
            if (room.paths.size>=256) room.paths.delete(room.paths.keys().next().value);
            path=new ArrivalTiming();
            room.paths.set(event.peer,path);
          }
          path.observe(arrived/1000,event.sent/1000);
        } else if (stale && (event.type==='key' || event.type==='signal')) {
          this.received({...event,type:'key',edge:'cancel'});
        } else if (event.type==='key' && event.edge==='down' && Number.isSafeInteger(event.sent) && room.paths?.has(event.peer)) {
          this.received({...event,pathAge:room.paths.get(event.peer).age(arrived/1000,event.sent/1000)});
        } else this.received(event);
      }
      this.updateProbes(room,data.activity[room.f] || 0);
      const changed=this.state!=='live' || delay!==this.delayMs || JSON.stringify(this.activity)!==JSON.stringify(data.activity);
      this.delayMs=delay;
      this.state='live'; this.retryDelay=0;
      this.activity=data.activity;
      if (changed) this.changed();
      if (room.live) void this.poll(epoch,station);
      else this.timer=setTimeout(()=>this.poll(epoch,station), (data.activity[room.f] || 0)>1 ? 300 : 850);
    } catch { if (epoch===this.epoch) this.offline(station); }
  }
  edge(down,at,wpm,duration) {
    if (!this.room) return;
    if (this.transmitter) {this.transmitter.edge(down,at,wpm,duration); return;}
    if (down) this.legacyDown=at;
    else {
      if (this.legacyDown!=null) this.mark(this.legacyDown,at);
      this.legacyDown=null;
    }
  }
  cancelKey() {
    this.legacyDown=null;
    this.transmitter?.cancel();
  }
  mark(start,end) {
    if (!this.room) return;
    if (!this.stream || start<this.last || start-this.last>6000 || end-this.origin>115000) {
      this.flush();
      this.stream=crypto.randomUUID(); this.origin=start;
    }
    if (!this.pending.length) this.offset=Math.round(start-this.origin);
    else this.pending.at(-1)[1]=Math.round(start-this.last);
    this.pending.push([Math.max(8,Math.round(end-start)),0]); this.last=end;
    if (this.pending.length===1) this.flushTimer=setTimeout(()=>this.flush(),140);
    if (this.pending.length>=32) this.flush();
  }
  flush() {
    clearTimeout(this.flushTimer);
    if (!this.room || !this.pending?.length) return;
    this.queue.push({audio:this.pending,offset:this.offset,stream:this.stream,replyTo:this.heard}); this.pending=[];
    if (this.queue.length>90) { this.offline(JSON.parse(this.key)); return; }
    void this.drain();
  }
  async drain() {
    if (this.sending || !this.room) return;
    this.sending=true;
    const epoch=this.epoch, room=this.room;
    while (epoch===this.epoch && this.queue.length) {
      const frame=this.queue[0], command={...frame,token:room.token,f:room.f,seq:room.seq+1};
      try {
        let ack;
        try { ack=await this.exchange('send',command); }
        catch { if (epoch!==this.epoch) return; ack=await this.exchange('send',command); }
        if (epoch!==this.epoch) return;
        if (ack.ack!==command.seq) throw Error('Lost transmission');
        room.seq=ack.ack; this.queue.shift();
      } catch { if (epoch===this.epoch) this.offline(JSON.parse(this.key)); return; }
    }
    if (epoch===this.epoch) this.sending=false;
  }
  async sign(card,audio) {
    const station=this.returns.get(card) || this.room;
    if (!station) return false;
    try { await this.exchange('sign',{token:station.token,f:station.f,card,audio}); return true; }
    catch { return false; }
  }
  pendingReturns() {
    const cards=[];
    for (const [card,receipt] of this.returns) {
      if (receipt.until<=Date.now()) this.returns.delete(card);
      else if (!receipt.received) cards.push({card,token:receipt.token});
    }
    return cards;
  }
}

export class Receiver {
  constructor(settings) { this.settings=settings; this.audio=new MorseAudio(); this.voices=new Set(); this.clocks=new Map(); this.live=new LiveKeyReceiver(); }
  unlock() { return this.audio.unlock(); }
  key(event) {this.live.key(this.audio.context,this.settings(),event);}
  setHiss(enabled) {
    const ctx=this.audio.context;
    const level=enabled && ctx ? Math.max(0,Math.min(100,this.settings().volume)) / 100 * .055 : 0;
    if (!level || ctx.state==='closed') {
      if (this.hissVoice) {
        const {source,gain}=this.hissVoice;
        this.hissVoice=null;
        const now=ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0,now,.003);
        source.stop(now+.016);
      }
      return;
    }
    if (!this.hissVoice) {
      // A looping, band-limited noise bed shares only the receiver's output.
      if (!this.noiseBuffer || this.noiseBuffer.sampleRate!==ctx.sampleRate) {
        this.noiseBuffer=ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate);
        const samples=this.noiseBuffer.getChannelData(0);
        for (let i=0;i<samples.length;i++) samples[i]=Math.random()*2-1;
      }
      const source=ctx.createBufferSource(), filter=ctx.createBiquadFilter(), gain=ctx.createGain();
      source.buffer=this.noiseBuffer; source.loop=true;
      filter.type='bandpass'; filter.frequency.value=1350; filter.Q.value=.7;
      gain.gain.value=0;
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
      source.start();
      this.hissVoice={source,gain,level:0};
    }
    if (this.hissVoice.level!==level) {
      this.hissVoice.gain.gain.setTargetAtTime(level,ctx.currentTime,.008);
      this.hissVoice.level=level;
    }
  }
  stop() {
    this.setHiss(false);
    this.live.stop();
    for (const voice of this.voices) { try { voice.stop(); } catch {} }
    this.voices.clear(); this.clocks.clear(); this.audio.stop();
  }
  play(pairs,stream,offset=0) {
    const ctx=this.audio.context;
    if (!ctx || ctx.state!=='running' || !validRhythm(pairs)) return;
    let t=ctx.currentTime+.025;
    if (stream) {
      // Older transmitters send completed marks. Allow for their polling cycle once,
      // then play a late mark as soon as possible instead of inserting another buffer.
      const now=ctx.currentTime, scheduled=(this.clocks.get(stream) ?? NaN)+offset/1000;
      t=Number.isFinite(scheduled) && scheduled<=now+3 ? Math.max(scheduled,now+.004) : now+.60;
      if (!this.clocks.has(stream) && this.clocks.size>=256) this.clocks.delete(this.clocks.keys().next().value);
      this.clocks.set(stream,t-offset/1000);
    }
    const settings=this.settings();
    const gain=Math.max(0,Math.min(100,settings.volume))/100*.20;
    for (const [duration,gap] of pairs) {
      const osc=ctx.createOscillator(), env=ctx.createGain(), length=duration/1000, ramp=Math.min(.005,length/3);
      osc.frequency.value=settings.tone;
      env.gain.setValueAtTime(0,t); env.gain.linearRampToValueAtTime(gain,t+ramp);
      env.gain.setValueAtTime(gain,t+length-ramp); env.gain.linearRampToValueAtTime(0,t+length);
      osc.connect(env).connect(ctx.destination); osc.start(t); osc.stop(t+length+.002);
      this.voices.add(osc); osc.onended=()=>{this.voices.delete(osc); osc.disconnect(); env.disconnect();};
      t+=length+gap/1000;
    }
  }
}
