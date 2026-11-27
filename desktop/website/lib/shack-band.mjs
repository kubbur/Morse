import { randomUUID, randomBytes } from 'node:crypto';
import { SyncError } from './sync-store.mjs';
import { validFrequency, canTransmit, validRhythm, equipment, shackUnlocked, SHACK_UNLOCK_XP, maxStationPrice } from '../public/js/shack-model.mjs';

const fail = (code, message) => { throw new SyncError(code,message); };
const lease = 45000;
export class ShackBand {
  constructor(clock = Date.now) {
    this.now = clock;
    this.sessions = new Map();
    this.events = [];
    this.contacts = new Map();
    this.feeds = new Map();
    this.serial = 0;
  }
  sweep(now) {
    for (const [token,s] of this.sessions) if (now-s.seen > lease) this.leave(token,s);
    for (const [id,c] of this.contacts) if (now-c.at > 3600000) this.contacts.delete(id);
    while (this.events.length && (now-this.events[0].at > 60000 || this.events.length > 4096)) this.events.shift();
  }
  event(f, data, now) {
    const event = {...data, f, at:now, seq:++this.serial};
    this.events.push(event);
    for (const feed of this.feeds.values()) {
      if (this.visible(feed.station,event)) feed.wake();
    }
  }
  visible(s,e) {
    return e.f===s.f && e.peer!==s.id && (!e.to || e.to===s.id) &&
      (e.type!=='key' || s.live) && (e.type!=='probe' || s.probes) && (!e.legacy || !s.live);
  }
  leave(token,s) {
    this.sessions.delete(token);
    this.feeds.get(token)?.close();
    if (s.held) this.event(s.f,{type:'key',edge:'cancel',stream:s.held.stream,offset:s.held.offset,peer:s.id},this.now());
    for (const feed of this.feeds.values()) feed.wake();
  }
  subscribe(body,write,end) {
    this.request('poll',body);
    const station=this.sessions.get(body.token);
    if (!station.live || this.feeds.has(body.token)) fail(409,'The live receiver is already open or unavailable.');
    let cursor=Number.isSafeInteger(body.cursor) ? body.cursor : this.serial, pending=false;
    const feed={
      station,
      pulse:()=>{
        if (this.feeds.get(body.token)!==feed) return;
        station.seen=this.now();
        do {
          const batch=this.snapshot(station,cursor);
          cursor=batch.cursor;
          write(batch);
        } while (cursor<this.serial && this.feeds.get(body.token)===feed);
      },
      wake:()=>{
        if (pending) return;
        pending=true;
        queueMicrotask(()=>{pending=false; feed.pulse();});
      },
      close:()=>{
        if (this.feeds.get(body.token)!==feed) return;
        this.feeds.delete(body.token);
        end();
      },
      disconnected:()=>{
        if (this.feeds.get(body.token)===feed) this.leave(body.token,station);
      },
    };
    this.feeds.set(body.token,feed);
    return feed;
  }
  activity() {
    const counts = {};
    for (const s of this.sessions.values()) counts[s.f] = (counts[s.f] || 0)+1;
    return counts;
  }
  snapshot(s, cursor) {
    const events=[];
    const first=this.events[0]?.seq ?? this.serial+1;
    let next=this.serial;
    for (let i=Math.max(0,cursor-first+1); i<this.events.length; i++) {
      const event=this.events[i];
      if (!this.visible(s,event)) continue;
      if (events.length===100) {next=events.at(-1).seq; break;}
      events.push(event);
    }
    const heard = events.findLast(e => e.type==='signal' || e.type==='key' && e.edge==='up');
    if (heard) s.heard = {peer:heard.peer,at:heard.at};
    return {cursor:next,serverTime:this.now(),activity:this.activity(),events};
  }
  request(action, body = {}) {
    const now = this.now();
    this.sweep(now);
    if (!body || typeof body !== 'object') fail(400,'Invalid station.');
    if (action === 'open') {
      if (!shackUnlocked(body.lifetimeXP)) fail(403,`The Shack unlocks at ${SHACK_UNLOCK_XP.toLocaleString()} lifetime XP.`);
      let value=body.invested, keyed=true;
      if (body.equipped!==undefined) {
        const gear=body.equipped;
        if (!Array.isArray(gear) || gear.length!==3 || !gear[1] || !gear[2] ||
            gear.some((id,slot)=>!(slot===0 && id===null) && equipment(id)?.slot!==slot))
          fail(400,'Equip a radio and antenna to receive.');
        value=gear.reduce((sum,id)=>sum+(equipment(id)?.price || 0),0);
        keyed=!!gear[0];
      }
      const minimum = keyed ? SHACK_UNLOCK_XP : SHACK_UNLOCK_XP - equipment('0-0').price;
      if (!validFrequency(body.f) || !/^[A-Z0-9/]{2,16}$/.test(body.call || '') || !Number.isSafeInteger(value) || value<minimum || value>maxStationPrice)
        fail(400,'Invalid station.');
      if (this.sessions.size >= 120) fail(503,'The band is full. Try again shortly.');
      const token = randomBytes(32).toString('base64url'), id = randomUUID();
      const s = { id, call:body.call, f:body.f, value, keyed, live:body.live===true, keySeq:0, passed:body.qualified === true, seen:now, seq:0, last:null, window:now, count:0 };
      s.probes=s.live && body.probes===true;
      this.sessions.set(token,s);
      for (const feed of this.feeds.values()) feed.wake();
      return {token, id, live:s.live, probes:s.probes, cursor:this.serial, serverTime:now, activity:this.activity()};
    }
    const s = this.sessions.get(body.token);
    if (!s) fail(410,'The radio session expired. Rejoin the frequency.');
    s.seen = now;
    if (action === 'leave') { this.leave(body.token,s); return {}; }
    if (body.f !== s.f) fail(409,'The station changed frequency.');
    if (action === 'poll') return this.snapshot(s, Number.isSafeInteger(body.cursor) ? body.cursor : this.serial);
    if (action === 'probe') {
      if (!s.probes || !Number.isSafeInteger(body.sent) || body.sent<0) fail(400,'Invalid timing probe.');
      if (s.lastProbe===undefined || now-s.lastProbe>=250) {
        s.lastProbe=now;
        this.event(s.f,{type:'probe',peer:s.id,sent:body.sent},now);
      }
      return {};
    }
    if (s.keyed===false || !canTransmit(s.f,s.value,s.passed)) fail(403,'Receive only on this frequency.');
    if (action === 'edges') return this.edges(s,body,now);
    if (action === 'sign') {
      const contact = this.contacts.get(body.card);
      if (!contact || !contact.peers.includes(s.id) || contact.f !== s.f || !validRhythm(body.audio)) fail(400,'Invalid return QSL.');
      if (!contact.signed.has(s.id)) {
        contact.signed.add(s.id);
        this.event(s.f,{type:'signature',to:contact.peers.find(p=>p!==s.id),peer:s.id,card:body.card,audio:body.audio},now);
      }
      return {};
    }
    if (action !== 'send' || !Number.isSafeInteger(body.seq) || body.seq < 1 || !validRhythm(body.audio) || body.audio.length>32 ||
        !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset>120000 || !/^[\w-]{1,50}$/.test(body.stream || '')) fail(400,'Invalid key timing.');
    if (body.seq <= s.seq) return {ack:s.seq};
    if (body.seq !== s.seq+1) fail(409,'Missing transmission.');
    if (now-s.window >= 1000) { s.window=now; s.count=0; }
    if (++s.count > 12) fail(429,'Release the key and try again.');
    s.seq=body.seq;
    const audio = body.audio.map(([d,g])=>[d,g]);
    this.event(s.f,{type:'signal',peer:s.id,call:s.call,offset:body.offset,stream:body.stream,audio},now);
    this.contact(s,body.replyTo,audio,now);
    return {ack:s.seq};
  }
  edges(s,body,now) {
    const {first,edges}=body;
    if (!s.live || !Number.isSafeInteger(first) || first<1 || !Array.isArray(edges) || !edges.length || edges.length>96 ||
        !Number.isSafeInteger(first+edges.length) || edges.some(e=>!e || typeof e.stream!=='string' || !/^[\w-]{1,50}$/.test(e.stream) ||
          !Number.isInteger(e.offset) || e.offset<0 || e.offset>130000 || !['down','up','hold','cancel'].includes(e.edge) ||
          (e.gap!==undefined && (e.edge!=='down' || e.offset!==0 || !Number.isInteger(e.gap) || e.gap<0 || e.gap>6000))))
      fail(400,'Invalid live key timing.');
    if (first>s.keySeq+1) fail(409,'Missing key transition.');
    const fresh=edges.slice(Math.max(0,s.keySeq-first+1));
    if (!fresh.length) return {ack:s.keySeq};
    // Overlapping requests can beat an earlier POST. Validate the entire new suffix before publishing it once.
    let held=s.held, last=s.lastKey;
    for (const e of fresh) {
      if (e.edge==='down') {
        if (held || last?.stream===e.stream && e.offset<last.offset) fail(409,'Unexpected key down.');
        if (e.gap!==undefined && (last?.edge!=='up' || e.previous!==last.stream || e.stream===last.stream))
          fail(409,'Unexpected stream continuation.');
        held=e;
      } else {
        if (!held || held.stream!==e.stream || (e.edge==='up' ? e.offset<held.offset || e.offset-held.offset>10000 : e.offset!==held.offset))
          fail(409,'Unexpected key transition.');
        if (e.edge!=='hold') held=null;
      }
      if (e.edge!=='hold') last=e;
    }
    if (now-s.window>=1000) {s.window=now; s.count=0;}
    if (s.count+fresh.length>180) fail(429,'Too many key transitions.');
    s.count+=fresh.length;
    for (const {edge,stream,offset,previous,gap} of fresh) {
      this.event(s.f,{type:'key',peer:s.id,call:s.call,edge,stream,offset,...(gap===undefined ? {} : {previous,gap})},now);
      if (edge==='down') s.held={stream,offset};
      if (edge==='up') {
        const audio=[[Math.max(8,offset-s.held.offset),0]];
        this.event(s.f,{type:'signal',legacy:true,peer:s.id,call:s.call,stream,offset:s.held.offset,audio},now);
        this.contact(s,body.replyTo,audio,now);
      }
      if (edge==='up' || edge==='cancel') s.held=null;
    }
    s.lastKey=last;
    s.keySeq+=fresh.length;
    return {ack:s.keySeq};
  }
  contact(s,replyTo,audio,now) {
    // A contact starts with an exchange. Simply sharing a frequency never creates a card.
    for (const other of this.sessions.values()) {
      if (other.id!==replyTo || other.id!==s.heard?.peer || now-s.heard.at>90000 || other.f!==s.f || !other.last) continue;
      const peers=[s.id,other.id].sort(), id=peers.join('-');
      if (this.contacts.has(id)) continue;
      this.contacts.set(id,{peers,f:s.f,at:now,signed:new Set()});
      this.event(s.f,{type:'contact',to:s.id,peer:other.id,call:other.call,card:id,audio:other.last.audio},now);
      this.event(s.f,{type:'contact',to:other.id,peer:s.id,call:s.call,card:id,audio},now);
    }
    s.last={at:now,audio};
  }
}
