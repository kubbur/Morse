import { sanitizeShack, items, equipment, cost, equip, purchase, sellBadge, assembled, installed, receiving, minimumStation, qualified, canTransmit, alphabet, coverage, frequency, validFrequency, validRhythm, hunt, SHACK_UNLOCK_XP, SLOW_CW_CALLING_KHZ, speedGroups, speedGroup, limitWpm, paceLabel, needsQualification } from './shack-model.mjs';
import { timeline } from './morse.mjs';
import { decodeSending } from './sending.mjs';
import { BandRadio, Receiver } from './shack-radio.mjs';
import { drawGear } from './shack-gear.mjs';
import { heading, air, bench, shop, logbook, checkPanel, activity, button, tabs, esc, paddleControls } from './shack-views.mjs';

const hissPreference = 'morse.shack.hiss';

function rhythm(text,settings) {
  const {tones}=timeline(text,settings);
  return tones.map((t,i)=>[Math.max(8,Math.round(t.duration*1000)),tones[i+1]?Math.max(0,Math.round((tones[i+1].start-t.start-t.duration)*1000)):0]);
}
function captured(edges) {
  const pairs=[];
  for (let i=0;i+1<edges.length;i+=2) pairs.push([Math.max(8,Math.round(edges[i+1].at-edges[i].at)),edges[i+2]?Math.round(edges[i+2].at-edges[i+1].at):0]);
  return pairs;
}

export class ShackUI {
  constructor(options) {
    Object.assign(this,options);
    this.tab='air'; this.slot=0; this.f=SLOW_CW_CALLING_KHZ; this.edges=[]; this.monitor=false;
    this.hiss=false; this.qslVisit=0;
    this.groupSpeeds=new Map();
    try {
      this.hiss=localStorage.getItem(hissPreference)==='1';
      for (const group of speedGroups) {
        const saved=Number(localStorage.getItem(group.preference));
        if (Number.isInteger(saved) && saved===limitWpm(group,saved)) this.groupSpeeds.set(group,saved);
      }
    } catch { /* Device storage is optional. */ }
    this.root.tabIndex=-1;
    this.receiver=new Receiver(()=>this.sender.settings);
    this.band=new BandRadio(this.exchange,()=>this.updateReceiver(),event=>this.receive(event));
    this.checkDialog=document.getElementById('shack-check-dialog');
    this.sinks=Object.fromEntries(['air','signature','check','locked'].map(mode=>[mode,{
      edge:event=>this.onKey(mode,event),reset:()=>this.clearCapture(),
    }]));
    this.sinks.check.dialog=this.checkDialog;
    this.sinks.air.live=true;
    this.sinks.air.limitWpm=wpm=>this.onAirWpm(wpm);
    for (const surface of [this.root,this.checkDialog]) {
      surface.addEventListener('click',e=>{const el=e.target.closest('button[data-act]'); if(el) void this.act(el);});
      surface.addEventListener('submit',e=>{e.preventDefault();this.submit(e.target);});
    }
    this.checkDialog.addEventListener('close',()=>{
      if (this.checkDialog.open) return;
      this.challenge=null; this.clearCapture(); this.receiver.stop();
      if (this.active) { this.updateReceiver(); this.scheduleBeacon(); this.focus(); }
    });
    this.root.addEventListener('input',e=>{if(e.target.matches('[data-dial]')) this.tune(Number(e.target.value));});
    this.bindDrag();
    this.bindKnob();
    // A deep link can open before Safari allows audio. Retry on the next station gesture.
    this.root.addEventListener('click',()=>{if (this.monitor && this.receiver.audio.context?.state!=='running') this.unlockReceiver();},true);
    document.addEventListener('visibilitychange',()=>{
      this.updateReceiver();
      if (!document.hidden && this.monitor && this.receiver.audio.context?.state!=='running') this.unlockReceiver();
    });
    window.addEventListener('pagehide',()=>this.leave());
    window.addEventListener('pageshow',()=>{if (!this.root.closest('[hidden]')) this.render();});
  }
  get p() { return this.profile(); }
  get group() { return speedGroup(this.f); }
  onAirWpm(preferred) {
    const group=this.group;
    return group ? this.groupSpeeds.get(group) ?? limitWpm(group,preferred) : preferred;
  }
  setGroupSpeed(value) {
    const group=this.group;
    if (!group || !Number.isInteger(value)) return;
    const wpm=limitWpm(group,value);
    this.groupSpeeds.set(group,wpm);
    try { localStorage.setItem(group.preference,String(wpm)); } catch { /* Session choice still applies. */ }
  }
  get s() { return this.p.shack ||= sanitizeShack(); }
  get call() {
    if (this.p.callsign) return this.p.callsign;
    let hash=0;
    for (const ch of this.p.id) hash=(Math.imul(31,hash)+ch.charCodeAt(0))>>>0;
    return 'CW'+hash.toString(36).toUpperCase().padStart(4,'0');
  }
  get capturing() { return this.start!=null || !!this.edges.length; }
  get transmit() { return assembled(this.s) && canTransmit(this.f,installed(this.s),qualified(this.p)); }
  get needsCheck() { return needsQualification(this.f) && assembled(this.s) && installed(this.s)>=minimumStation(this.f) && !qualified(this.p); }
  connectBand() {
    if (!receiving(this.s)) { this.band.close(); return; }
    const equipped=this.s.equipped.map(slot=>slot?.id || null);
    const lifetimeXP = Math.min(this.xp(this.p), SHACK_UNLOCK_XP);
    void this.band.tune({f:this.f, call:this.call, invested:installed(this.s), qualified:qualified(this.p), equipped, lifetimeXP});
  }
  openCheck() {
    if (!this.needsCheck || this.checkDialog.open) return;
    this.sender.setKeyTarget(null); this.receiver.stop(); clearTimeout(this.beaconTimer);
    this.fillPanel(this.checkDialog.querySelector('[data-check-content]'),checkPanel(this));
    this.checkDialog.querySelector('[data-check-status]').textContent='';
    this.checkDialog.showModal(); this.updateReceiver();
  }
  missing() {
    const known=coverage(this.p);
    return ['copied','sent'].flatMap(dir=>[...alphabet].filter(ch=>!known[dir].includes(ch)).map(ch=>({dir,ch})));
  }
  focus() { this.root.focus({preventScroll:true}); }
  message(value) {
    this.note=value;
    const el=this.checkDialog?.open ? this.checkDialog.querySelector('[data-check-status]') : this.root.querySelector('[data-status]');
    if(el) el.textContent=value;
  }
  clearCapture() {
    this.band?.cancelKey();
    clearTimeout(this.checkTimer); this.start=null; this.captureOrigin=null; this.edges=[];
    const lcd=this.root.querySelector('[data-face="mode"]'); if(lcd?.textContent==='TX') lcd.textContent='RX';
  }
  leave() {
    if (!this.active) return;
    this.active=false; this.sender.setShackRadio(false); if(this.checkDialog.open) this.checkDialog.close(); this.sender.setKeyTarget(null); this.clearCapture(); this.band.close();
    clearTimeout(this.qslTimer); this.qslVisit++;
    this.receiver.stop(); this.receiver.audio.setListening(false); void this.receiver.audio.release(); clearTimeout(this.beaconTimer);
    this.monitor=false; this.challenge=null; this.signing=null; this.hunting=false; this.note='';
  }
  mount(tab) {
    if (!tabs.has(tab)) return;
    this.sender.setKeyTarget(null); this.clearCapture(); this.receiver.stop();
    clearTimeout(this.qslTimer); this.qslVisit++;
    this.challenge=null; this.signing=null; this.hunting=false; this.note='';
    this.tab=tab; this.render(); this.focus();
  }
  fillPanel(panel, markup) {
    this.sender.releasePaddlesIn(panel);
    panel.innerHTML=markup;
    for (const key of panel.querySelectorAll('[data-shack-paddle]')) this.sender.bindPaddle(key,key.dataset.shackPaddle);
  }
  render() {
    if (this.owner && this.owner!==this.p.id) {this.leave();this.band.returns.clear();this.f=SLOW_CW_CALLING_KHZ;this.tab='air';}
    this.pitchPreview=null;
    this.owner=this.p.id; this.active=true;
    this.award();
    const screen=this.tab==='air'?air(this):this.tab==='bench'?bench(this):this.tab==='shop'?shop(this):logbook(this);
    let detail='';
    if (this.tab==='air') {
      if (this.hunting) {
        const h=hunt(), won=this.s.cards['RVK-'+h.day];
        detail=`<section class="card hunt"><div class="head"><h2>Reykjavík beacon</h2><span class="tiny">${h.day} UTC</span></div>
          <p class="panel-copy">${won?'Today’s QSL is in your logbook.':'Listen on the dial for RVK followed by three digits.'}</p>
          ${won?'':`<form data-hunt><label>Beacon code <input name="pin" inputmode="numeric" maxlength="3" pattern="[0-9]{3}" required autocomplete="off"></label><button type="submit" class="btn">Check code</button></form>`}</section>`;
      }
      if (this.checkDialog.open) {
        if (this.needsCheck) this.fillPanel(this.checkDialog.querySelector('[data-check-content]'),checkPanel(this));
        else {this.challenge=null; this.checkDialog.close();}
      }
    } else if (this.tab==='log' && this.signing) {
      detail=`<section class="card check"><h2>Sign your return QSL</h2><p class="panel-copy">Key <strong>${esc(this.call)}</strong> with your practice input.</p>${paddleControls}
        <div class="actions">${button('Save signature','save-sign')}${button('Start over','clear-sign','','textbtn')}${button('Cancel','cancel-sign','','textbtn')}</div></section>`;
    }
    this.fillPanel(this.root,heading(this)+screen+detail+'<p class="shack-status" data-status role="status"></p>');
    this.root.querySelector('[data-status]').textContent=this.note || '';
    for(const canvas of this.root.querySelectorAll('canvas[data-portrait]')) drawGear(canvas);
    if (this.tab==='air') this.connectBand();
    else if (this.band.key) this.band.close();
    this.updateReceiver();
    this.scheduleBeacon();
    if (this.tab==='log' && this.lastQslVisit!==this.qslVisit) {
      this.lastQslVisit=this.qslVisit;
      void this.checkSignatures(this.qslVisit);
    }
  }
  updateReceiver() {
    if (!this.active) return;
    let mode='';
    const modal=document.querySelector('dialog[open]');
    if (this.checkDialog.open) mode=this.challenge?.dir==='sent' ? 'check' : '';
    else if (!modal) {
      if (this.signing) mode='signature';
      else if (this.tab==='air' && !this.hunting) mode=this.transmit ? 'air' : this.needsCheck ? 'locked' : '';
    }
    this.sender.setKeyTarget(this.sinks[mode] || null);
    const {source:input,keyboardPaddles}=this.sender;
    const showPaddles=input==='keyboard' && keyboardPaddles.showButtons;
    const paddles=(this.checkDialog.open ? this.checkDialog : this.root).querySelector('.shack-paddles');
    if (paddles) {
      paddles.hidden=!showPaddles;
      for (const key of paddles.children) key.disabled=!mode;
    }
    const built=receiving(this.s);
    const listen=built && this.tab==='air' && !modal;
    this.sender.setShackRadio(listen);
    if (listen!==this.monitor) {
      this.monitor=listen;
      this.receiver.audio.setListening(listen);
      if (listen) this.unlockReceiver();
      else { this.receiver.stop(); void this.receiver.audio.release(); this.band.heard=null; }
    }
    this.receiver.setHiss(this.hiss && this.monitor && this.band.state==='live');
    if (this.tab!=='air') return;
    const q=s=>this.root.querySelector(s), face=n=>q('[data-face="'+n+'"]');
    if (!face('frequency')) return;
    face('frequency').textContent=frequency(this.f);
    const h=hunt(), beacon=this.f===h.f, group=this.group;
    const source={straight:'straight key (Space)',keyboard:'keyboard paddles ('+keyboardPaddles.dit+' / '+keyboardPaddles.dah+')',paddle:'paddle adapter',vband:'VBand adapter'}[input] || 'practice key';
    const needsConnection=(input==='paddle' || input==='vband' && this.sender.native) && !this.sender.connection.connected;
    face('mode').textContent=!built?'OFF':this.start!=null && mode==='air'?'TX':'RX';
    face('pace').textContent=group ? paceLabel(group) : beacon?'Beacon signal':'Virtual 40 m';
    face('room').textContent=group ? group.name+(this.f===group.calling?' calling frequency':' open channel') : beacon?'RVK beacon':'Open frequency';
    const reason=!built ? 'Equip a radio and an antenna in the Workbench to listen.' :
      !this.s.equipped[0]?.id ? 'Receive only · equip a Morse key to send.' :
      installed(this.s)<minimumStation(this.f) ? 'Receive only · this frequency needs a '+minimumStation(this.f).toLocaleString()+' XP station equipped.' :
      this.needsCheck ? 'Receive only · complete the on-air check to transmit here.' :
      needsConnection ? 'Connect your '+source+' in Input settings.' :
      this.band.state==='offline' ? 'Local sidetone · live rooms offline.' :
      this.band.state==='connecting' ? 'Connecting to the frequency…' : showPaddles ? 'Use Dot and Dash below, or your '+source+'.' : 'Ready to send with your '+source+'.';
    q('[data-act="open-check"]').hidden=!this.needsCheck;
    face('note').textContent=reason;
    const dial=q('[data-dial]'), knob=q('.knob'); dial.value=this.f;
    knob.style.setProperty('--rotation',(-135+(this.f-7020)*9)+'deg');
    knob.setAttribute('aria-valuenow',String(this.f));knob.setAttribute('aria-valuetext',frequency(this.f)+' MHz');
    this.showPitch(this.pitchPreview ?? this.sender.settings.tone);
    const ms=this.band.state==='live' ? this.band.delayMs : null;
    face('delay').textContent=ms==null ? '— ms' : ms+' ms';
    face('delay').setAttribute('aria-label',ms==null?'Relay delay unavailable':'Relay round trip '+ms+' milliseconds');
    let i=0;const bars=ms==null ? 0 : Math.max(1,11-Math.floor(ms/25));
    for(const bar of q('.meter').children){bar.style.height=(4+i)+'px';bar.classList.toggle('off',i++>=bars);}
    q('[data-act="hiss"]').setAttribute('aria-pressed',String(this.hiss));
    const list=q('[data-band]'), html=activity(this);
    if (html!==this.bandHTML || list!==this.bandNode) {this.bandHTML=html;this.bandNode=list;list.innerHTML=html;}
  }
  unlockReceiver() {
    void this.receiver.unlock().then(()=>{
      if (this.monitor) this.receiver.setHiss(this.hiss && this.band.state==='live');
    }).catch(()=>{if (this.monitor) this.message('Tap the radio to enable receiver audio.');});
  }
  async checkSignatures(visit) {
    if (!this.active || this.tab!=='log' || this.qslVisit!==visit) return;
    const cards=this.band.pendingReturns();
    if (!cards.length) return;
    try {
      const {signatures}=await this.exchange('signatures',{cards});
      if (!this.active || this.tab!=='log' || this.qslVisit!==visit) return;
      let changed=false;
      for (const {card,f,audio} of signatures || []) {
        const receipt=this.band.returns.get(card);
        if (receipt?.f!==f || this.s.cards[card]?.f!==f || !validRhythm(audio)) continue;
        receipt.received=true;
        this.s.cards[card].audio=audio;
        changed=true;
      }
      if (changed) {this.persist(); if (!this.signing) this.render();}
    } catch { /* A return card can be collected on the next check. */ }
    if (this.active && this.tab==='log' && this.qslVisit===visit && this.band.pendingReturns().length)
      this.qslTimer=setTimeout(()=>void this.checkSignatures(visit),10000);
  }
  tune(f) {
    if (!validFrequency(f) || f===this.f) return;
    this.sender.setShackRadio(false);
    this.sender.setKeyTarget(null);this.clearCapture();this.receiver.stop();this.band.close();
    this.f=f;this.note='';
    this.connectBand();
    this.updateReceiver();this.scheduleBeacon();
  }
  showPitch(tone) {
    const knob=this.root.querySelector('.pitch-knob');
    if (!knob) return;
    knob.style.setProperty('--rotation',(-135+(tone-200)*270/1800)+'deg');
    knob.setAttribute('aria-valuenow',String(tone));
    knob.setAttribute('aria-valuetext',tone+' Hz');
    this.root.querySelector('[data-face="pitch"]').textContent=tone+' Hz';
    this.root.querySelector('[data-act="pitch-step"][data-step="-50"]').disabled=tone<=200;
    this.root.querySelector('[data-act="pitch-step"][data-step="50"]').disabled=tone>=2000;
  }
  setPitch(tone) {
    const next=Math.max(200,Math.min(2000,50*Math.round(tone/50)));
    this.pitchPreview=null;
    this.showPitch(next);
    if (next===this.p.settings.tone) return;
    this.p.settings.tone=next;
    if (this.sender.native) this.sender.connection.configure(this.sender.settings);
    this.persist();
  }
  scheduleBeacon() {
    clearTimeout(this.beaconTimer);
    if (!this.active || this.tab!=='air' || !this.monitor || this.challenge || this.f!==hunt().f || !receiving(this.s) || document.querySelector('dialog[open]')) return;
    const play=()=>{
      const h=hunt();
      if (!this.active || !this.monitor || this.tab!=='air' || this.f!==h.f || this.challenge || !receiving(this.s) || document.querySelector('dialog[open]')) return;
      const audio=rhythm('RVK '+h.pin,{...this.sender.settings,wpm:10,farnsworth:10});
      this.receiver.play(audio);
      this.beaconTimer=setTimeout(play,audio.reduce((t,[d,g])=>t+d+g,0)+2500);
    };
    this.beaconTimer=setTimeout(play,300);
  }
  receive(event) {
    if (!this.active || event.f!==this.f) return;
    if (event.type==='silence') { this.receiver.live?.stop(); return; }
    if (event.type==='key' || event.type==='signal') {
      if (this.monitor && receiving(this.s) && this.tab==='air' && !document.querySelector('dialog[open]')) {
        if (event.type==='key') {
          this.receiver.key(event);
          if (event.edge==='up') this.band.heard=event.peer;
        } else {
          this.band.heard=event.peer;
          this.receiver.play(event.audio,event.peer+'/'+event.stream,event.offset);
        }
      }
      return;
    }
    if (!/^[\w-]{1,80}$/.test(event.card) || !validRhythm(event.audio)) return;
    if (event.type==='signature' && this.s.cards[event.card]) this.s.cards[event.card].audio=event.audio;
    else if (event.type==='contact' && /^[A-Z0-9/]{2,16}$/.test(event.call) && !this.s.cards[event.card]) {
      this.s.cards[event.card]={at:event.at,from:event.call,f:event.f,beacon:false,audio:event.audio};
      this.p.shack=sanitizeShack(this.s);
      this.message('Contact logged · '+event.call);
    } else return;
    this.persist();if (this.tab==='log' && !this.signing) this.render();
  }
  onKey(mode,event) {
    if (mode==='locked') { if (event.down) this.openCheck(); return; }
    if (event.down) {
      if (this.start!=null) return;
      this.start=event.at;
      if (mode!=='air') {
        clearTimeout(this.checkTimer);
        if (this.edges.length>=320 || this.captureOrigin!=null && event.at-this.captureOrigin>115000) this.edges=[];
        if (!this.edges.length) this.captureOrigin=event.at;
        this.edges.push({down:true,at:event.at-this.captureOrigin});
      } else {
        this.band.edge(true,event.at,this.sender.settings.wpm,event.duration);
        const lcd=this.root.querySelector('[data-face="mode"]'); if(lcd)lcd.textContent='TX';
      }
      return;
    }
    const start=this.start;this.start=null;
    if(start==null || event.at<=start || event.at-start>10000){this.clearCapture();return;}
    if(mode==='air') {this.band.edge(false,event.at);this.updateReceiver();return;}
    this.edges.push({down:false,at:event.at-this.captureOrigin});
    if(mode==='signature') {this.message(this.edges.length/2+' marks recorded.');return;}
    this.checkTimer=setTimeout(()=>{
      const result=decodeSending(this.edges,this.sender.settings);
      const ok=result.complete && result.decoded===this.challenge?.ch;
      if(ok)this.passChallenge();else {this.clearCapture();this.message('Try that character again.');}
    },Math.max(600,5*1200/this.sender.settings.farnsworth));
  }
  passChallenge() {
    const {dir,ch}=this.challenge;
    if(!this.s[dir].includes(ch)) this.s[dir]+=ch;
    this.clearCapture();this.persist();this.award();this.nextChallenge();
    this.message(this.challenge?'Correct. Continue with the next character.':'On-air check complete.');
  }
  nextChallenge() {
    const missing=this.missing(), pool=missing.filter(x=>x.dir===missing[0]?.dir);
    this.challenge=pool[Math.floor(Math.random()*pool.length)] || null;
    this.render();
    if (this.challenge?.dir==='copied') {
      this.checkDialog.querySelector('input[name="copy"]')?.focus();void this.prompt();
    } else if (this.challenge) {
      const target=this.checkDialog.querySelector('.challenge-char');
      target.tabIndex=-1; target.focus();
    } else this.focus();
  }
  async prompt() {
    if (!this.challenge) return;
    const settings = this.challenge.dir === 'copied' ? this.p.settings : this.sender.settings;
    try {await this.receiver.audio.play(this.challenge.ch,settings);}
    catch {this.message('Audio is paused. Select Hear again to listen.');}
  }
  submit(form) {
    if(form.matches('[data-check]') && this.challenge?.dir==='copied') {
      if(form.elements.copy.value.trim().toUpperCase()===this.challenge.ch) this.passChallenge();
      else {this.message('Try that character again.');form.elements.copy.select();}
    } else if(form.matches('[data-hunt]')) {
      const h=hunt(),id='RVK-'+h.day;
      if(!receiving(this.s) || this.f!==h.f || form.elements.pin.value!==h.pin) {this.message('Keep tuning and copy the code again.');return;}
      if(!this.s.cards[id]) this.s.cards[id]={beacon:true,at:Date.now(),f:this.f,from:'RVK',audio:rhythm('RVK '+h.pin,{...this.sender.settings,wpm:10,farnsworth:10})};
      this.p.shack=sanitizeShack(this.s);this.persist();this.render();this.message('Reykjavík QSL added to the logbook.');
    }
  }
  move(id,slot) {
    const item=equipment(id);if(!item || !this.s.orders[id]) return;
    if (slot===null && this.s.equipped[item.slot]?.id!==id) return;
    if (!equip(this.s,slot===null?'':id,slot===null?item.slot:slot)) {this.message('Choose the matching equipment slot.');return;}
    this.persist();this.render();this.message(`${item.name} ${slot===null?'returned to Inventory.':'equipped.'}`);
  }
  async act(el) {
    const {act,id}=el.dataset;
    if (act==='tab') {this.mount(id);return;}
    if (act==='settings' || act==='profile') {
      this.sender.setKeyTarget(null); this.receiver.stop(); clearTimeout(this.beaconTimer);
      if (act==='settings') this.openInputs(); else this.openProfile();
      this.updateReceiver();
      return;
    }
    if (act==='open-check') {this.openCheck();return;}
    if (act==='pitch-step') {this.setPitch(this.sender.settings.tone+Number(el.dataset.step));return;}
    if (act==='hiss') {
      this.hiss=!this.hiss;
      try { localStorage.setItem(hissPreference,this.hiss?'1':'0'); } catch { /* Keep the choice for this session. */ }
      this.updateReceiver();return;
    }
    if (['progress','listen-tab','send-tab'].includes(act)) {
      if (this.checkDialog.open) this.checkDialog.close();
      this.go({progress:'journey','listen-tab':'practice','send-tab':'send'}[act]);return;
    }
    if (act==='category') {this.slot=Number(el.dataset.slot);this.render();return;}
    if (act==='equip' || act==='unequip') {this.move(id,act==='equip'?equipment(id)?.slot:null);return;}
    if (act==='tune' || act==='step') {
      if (this.tab!=='air') this.mount('air');
      this.tune(act==='tune'?Number(el.dataset.f):this.f+Number(el.dataset.step));this.focus();return;
    }
    if (act==='buy' || act==='bundle') {
      const batch=act==='buy'?[id]:items.filter(i=>i.level===Number(el.dataset.tier) && !this.s.orders[i.id] && cost(this.s,i)>0).map(i=>i.id);
      const next=structuredClone(this.s);
      if (purchase(next,batch,Date.now(),this.xp(this.p))) {
        const previous=this.s; this.p.shack=next;
        if (this.persist()===false) {this.p.shack=previous;this.message('Purchase could not be saved. Your balance is unchanged.');return;}
        this.render();this.message('Added to Workbench inventory.');
      }
      return;
    }
    if(act==='sell') {
      if(this.badges(this.p).some(b=>b.id===id) && sellBadge(this.s,id)) {this.persist();this.render();}
      return;
    }
    if(act==='hunt') {this.hunting=!this.hunting;this.challenge=null;this.render();this.root.querySelector('[data-hunt]')?.scrollIntoView({block:'nearest'});return;}
    if(act==='check' && this.checkDialog.open && this.needsCheck) {this.hunting=false;this.receiver.stop();this.nextChallenge();return;}
    if(act==='cancel-check') {this.checkDialog.close();return;}
    if(act==='prompt') {await this.prompt();return;}
    if(act==='play' || act==='mine') {
      const c=this.s.cards[id];if(!c)return;
      try {await this.receiver.unlock();this.receiver.stop();this.receiver.play(act==='mine'?c.mine:c.audio);}
      catch {this.message('Audio could not start. Check your audio output.');}return;
    }
    if(act==='sign') {this.signing=id;this.render();this.focus();return;}
    if(act==='clear-sign') {this.clearCapture();this.message('Ready for your signature.');this.focus();return;}
    if(act==='cancel-sign') {this.signing=null;this.render();this.focus();return;}
    if(act==='save-sign') {
      const cardId=this.signing, owner=this.p.id, c=this.s.cards[cardId], audio=captured(this.edges);
      if(!c || this.start!=null || !validRhythm(audio) || decodeSending(this.edges,this.sender.settings).decoded.replaceAll(' ','')!==this.call) {
        this.message('Key your complete callsign before saving.');this.focus();return;
      }
      c.mine=audio;this.signing=null;this.persist();this.render();
      const sent=await this.band.sign(cardId,audio);
      if(this.active && this.p.id===owner) this.message(sent?'Signed QSL exchanged.':'Signature saved in your logbook. The contact is no longer on this frequency.');
    }
  }
  bindDrag() {
    const root=this.root;
    let touch=null;
    const dropZone=(x,y)=>document.elementFromPoint(x,y)?.closest('#shack-station [data-inventory],#shack-station .mount');
    root.addEventListener('pointerdown',e=>{
      const tile=e.target.closest('.portrait')?.closest('[data-gear]');
      if(e.pointerType!=='touch' || !tile) return;
      touch={pointer:e.pointerId,id:tile.dataset.gear,x:e.clientX,y:e.clientY,moved:false};
      tile.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove',e=>{
      if(!touch || e.pointerId!==touch.pointer) return;
      if(Math.hypot(e.clientX-touch.x,e.clientY-touch.y)<7 && !touch.moved) return;
      touch.moved=true;
      const target=dropZone(e.clientX,e.clientY);
      root.querySelectorAll('.over').forEach(el=>el.classList.remove('over'));
      if(target && (target.hasAttribute('data-inventory') || Number(target.dataset.slot)===equipment(touch.id).slot)) target.classList.add('over');
    });
    root.addEventListener('pointerup',e=>{
      if(!touch || e.pointerId!==touch.pointer) return;
      const {id,moved}=touch;touch=null;
      const target=dropZone(e.clientX,e.clientY);
      if(moved && target) this.move(id,target.matches('.mount')?Number(target.dataset.slot):null);
      root.querySelectorAll('.over').forEach(el=>el.classList.remove('over'));
    });
    root.addEventListener('pointercancel',()=>{touch=null;root.querySelectorAll('.over').forEach(el=>el.classList.remove('over'));});
    root.addEventListener('dragstart',e=>{
      const item=e.target.closest('[data-gear]');if(!item)return;
      this.dragged=item.dataset.gear;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',this.dragged);
    });
    root.addEventListener('dragover',e=>{
      const target=e.target.closest('[data-inventory],.mount');if(!target || !this.dragged)return;
      if (target.matches('.mount') && Number(target.dataset.slot)!==equipment(this.dragged)?.slot) return;
      e.preventDefault();e.dataTransfer.dropEffect='move';target.classList.add('over');
    });
    root.addEventListener('dragleave',e=>{const t=e.target.closest('.over');if(t && !t.contains(e.relatedTarget))t.classList.remove('over');});
    root.addEventListener('drop',e=>{
      e.preventDefault();const target=e.target.closest('[data-inventory],.mount');
      if(target && this.dragged) this.move(this.dragged,target.matches('.mount')?Number(target.dataset.slot):null);
      this.dragged=null;
    });
    root.addEventListener('dragend',()=>{this.dragged=null;root.querySelectorAll('.over').forEach(e=>e.classList.remove('over'));});
  }
  bindKnob() {
    let drag=null;
    this.root.addEventListener('pointerdown',e=>{
      const knob=e.target;
      if (!knob.matches('.knob') || e.button!==0 || (drag?.knob.isConnected && drag.knob.hasPointerCapture(drag.id))) return;
      const pitch=knob.matches('.pitch-knob');
      drag={knob,id:e.pointerId,x:e.clientX,pitch,start:pitch ? this.sender.settings.tone : this.f};
      knob.setPointerCapture(e.pointerId);
    });
    this.root.addEventListener('pointermove',e=>{
      if (!drag || e.pointerId!==drag.id || e.target!==drag.knob) return;
      const steps=Math.round((e.clientX-drag.x)/6);
      if (drag.pitch) {
        this.pitchPreview=Math.max(200,Math.min(2000,drag.start+50*steps));
        this.showPitch(this.pitchPreview);
      } else this.tune(Math.min(7050,Math.max(7020,drag.start+steps)));
    });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) this.root.addEventListener(type,e=>{
      if (!drag || e.pointerId!==drag.id || e.target!==drag.knob) return;
      const pitch=drag.pitch; drag=null;
      if (pitch) this.setPitch(type==='pointerup' ? this.pitchPreview ?? this.sender.settings.tone : this.sender.settings.tone);
    });
    this.root.addEventListener('keydown',e=>{
      if(!e.target.matches('.knob'))return;
      const pitch=e.target.matches('.pitch-knob'), value=pitch?this.sender.settings.tone:this.f, step=pitch?50:1;
      const next={ArrowLeft:value-step,ArrowDown:value-step,ArrowRight:value+step,ArrowUp:value+step,
        Home:Number(e.target.getAttribute('aria-valuemin')),End:Number(e.target.getAttribute('aria-valuemax'))}[e.key];
      if (next==null) return;
      e.preventDefault();
      if (pitch) this.setPitch(next); else this.tune(next);
    });
  }
}
