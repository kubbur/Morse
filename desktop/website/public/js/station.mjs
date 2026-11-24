import { DeviceSync } from './device-sync.mjs';
import { newProfile } from './progress.mjs';
import { syncProfile, syncChanged } from './sync-data.mjs';

export class Station extends DeviceSync {
  constructor(options) {
    super(options);
    this.mac=options.mac;
    this.requestImpl=options.transport;
    this.privateEnabled=false;
  }
  async exchange(action, body={}) {
    const scope=this.getProfile().id;
    let result;
    if (this.requestImpl) return this.requestImpl(action,{scope,body});
    if (this.mac) result=await this.mac.exchange(action,{scope,body});
    else {
      const response=await fetch('/api/v2/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json','X-Morse-Sync':'2'},body:JSON.stringify({scope,body}),signal:AbortSignal.timeout(10000)});
      const data=await response.json().catch(()=>({error:'Service unavailable. Practice is saved here.'}));
      result={status:response.status,...data};
    }
    if (scope!==this.getProfile().id) throw new Error('Learner changed.');
    if (result.status>=400) throw Object.assign(new Error(result.error || 'Saved locally. Waiting to reconnect.'),{status:result.status});
    return result;
  }
  request(action,body={}) {
    if (action==='leaderboard') return this.exchange('scores/leaderboard');
    if (action==='start' || action==='join') body={...body,foundation:this.storage.row().foundation || syncProfile(newProfile())};
    return this.exchange('private/'+action,body);
  }
  changed() {
    super.changed();
    const row=this.storage.row();
    if (row.needsConsent || row.scores.length || row.history?.decision==='queued') this.queueScores();
  }
  queueScores(delay=200) {
    if (this.scoreTimer || this.disposed) return;
    this.scoreTimer=setTimeout(()=>{ this.scoreTimer=null; void this.flushScores(); },delay);
  }
  consentChanged() {
    const row=this.storage.row(), p=this.getProfile();
    if (this.publishing && !p.leaderboard && !this.storage.failed) {
      // Fence a submit that has left this process. The server rejects its old generation.
      void this.exchange('scores/consent',{generation:row.generation,callsign:p.callsign,enabled:false}).catch(()=>{});
    }
    this.changed();
  }
  async flush() {
    if (this.storage.failed) throw new Error('Local storage must be available before syncing.');
    return super.flush();
  }
  async flushScores() {
    if (this.publishing || this.disposed || this.storage.failed) return;
    this.publishing=true;
    try {
      const profile=this.getProfile(), owner=profile.id, row=this.storage.row(owner);
      if (!(row.needsConsent || row.scores.length || row.history?.decision==='queued')) return;
      const generation=row.generation, current=()=>!this.storage.failed && this.getProfile().id===owner && this.storage.row(owner).generation===generation;
      await this.exchange('scores/session');
      if (!current()) return;
      await this.exchange('scores/consent',{generation,callsign:profile.callsign,enabled:profile.leaderboard});
      if (!current()) return;
      this.storage.atomic(()=>{ this.storage.row(owner).needsConsent=false; });
      if (!profile.leaderboard) return;
      const pending=this.storage.row(owner).scores.slice(0,25);
      if (pending.length) {
        const body={generation,results:pending};
        await this.exchange('scores/prepare',body);
        if (!current()) return;
        const receipt=await this.exchange('scores/submit',body);
        if (!current()) return;
        const accepted=new Set(receipt.acknowledged);
        this.storage.atomic(()=>{ const now=this.storage.row(owner); now.scores=now.scores.filter(r=>!accepted.has(r.id)); });
      }
      const history=this.storage.row(owner).history;
      if (current() && history?.decision==='queued') {
        await this.exchange('scores/history',{generation,id:history.id,xp:history.xp});
        if (current()) this.storage.atomic(()=>{ this.storage.row(owner).history.decision='published'; });
      }
      this.scoreError=null;
    } catch(error) { this.scoreError=error.message; }
    finally {
      this.publishing=false;
      const row=this.storage.row();
      if (row.needsConsent || row.scores.length || row.history?.decision==='queued') this.queueScores(this.scoreError?15000:50);
      this.onStatus(this.status);
    }
  }
  async tick() {
    // Only an explicit link or restore starts private network traffic.
    if (this.meta()) await super.tick();
    this.changedScoresOnReconnect();
  }
  changedScoresOnReconnect() {
    const row=this.storage.row();
    if (row.needsConsent || row.scores.length || row.history?.decision==='queued') this.queueScores();
  }
  apply(meta) {
    if (!meta?.remote || meta.pending || meta.replacement || !this.ready()) return meta;
    if (meta.force && meta.previous && syncChanged(meta.previous.base,syncProfile(this.getProfile()))) {
      const retry={version:1,...meta.previous};
      this.save(retry);this.schedule(0);return retry;
    }
    delete meta.previous;
    const applied=this.storage.atomic(()=>super.apply(meta));
    if (!applied?.pending && applied?.base && !syncChanged(applied.base,syncProfile(this.getProfile()))) super.report({message:'Synced',error:false});
    return applied;
  }
  report(changes) {
    super.report(changes);
    if (this.status.connected && this.status.message==='Synced') {
      const m=this.meta();
      if (m?.pending || m?.replacement || m?.force || m?.remote || m?.base && syncChanged(m.base,syncProfile(this.getProfile()))) {
        this.status.message='Saved here · waiting to sync'; this.onStatus(this.status);
      }
    }
  }
  receive(result,meta) {
    if (result.connected && !this.status.connected && this.getProfile().leaderboard) {
      this.storage.atomic(() => { this.storage.row().needsConsent = true; });
      this.queueScores();
    }
    if (meta && result.connected && meta.epoch!==result.epoch && !meta.pending) {
      if (syncChanged(meta.base,syncProfile(this.getProfile()))) {
        this.schedule(0); return meta;
      }
      const previous={base:meta.base,epoch:meta.epoch,seq:meta.seq,revision:meta.revision};
      const received=super.receive(result,meta);
      if (received?.force) {received.previous=previous;this.save(received);}
      return received;
    }
    return super.receive(result,meta);
  }
  async recover(code,replaceDevice) {
    const p=this.getProfile();
    if (p.stats.total || p.stats.xp || p.sending.attempts || p.settings.courseLevel>1 || p.sending.level>1) throw new Error('This device already has progress. Use a pairing link to combine the two saves, or use the recovery code on a fresh installation.');
    if (this.meta()) throw new Error('Disconnect this device before restoring another profile.');
    this.backup();
    const response=await this.request('recover',{code,replaceDevice});
    if (response.chooseDevice) return response.devices;
    this.storage.atomic(()=>this.apply(this.receive(response,null)));
    this.schedule(0);
  }
  dispose() { clearTimeout(this.scoreTimer); super.dispose(); }
}
