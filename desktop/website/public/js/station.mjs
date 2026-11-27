import { equipmentSnapshot, mergeShack } from './shack-model.mjs';
import { DeviceSync } from './device-sync.mjs';
import { ShackFeed } from './shack-feed.mjs';
import { newProfile, STORAGE_KEY } from './progress.mjs';
import { publicSnapshot, scoreSnapshot } from './practice-storage.mjs';
import { syncProfile, syncChanged, hasLocalChanges, playbackOnDevice } from './sync-data.mjs';

export class Station extends DeviceSync {
  constructor(options) {
    super(options);
    this.mac=options.mac;
    this.canPublish=options.canPublish || (() => true);
    this.canSync=options.canSync || (() => true);
    this.requestImpl=options.transport;
    this.onScoresPublished = options.onScoresPublished;
    this.privateEnabled=false;
  }
  async exchange(action, body={}) {
    const learner=this.getProfile().id;
    const scope=action.startsWith('shack/') ? 'band' : learner;
    let result;
    if (this.requestImpl) return this.requestImpl(action,{scope,body});
    if (!this.mac && action==='shack/leave') this.shackFeed?.close(body.token);
    if (this.mac) result=await this.mac.exchange(action,{scope,body});
    else if (action==='shack/poll' && body.live) result=await (this.shackFeed ??= new ShackFeed()).next(body);
    else {
      const response=await fetch('/api/v2/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json','X-Morse-Sync':'2'},body:JSON.stringify({scope,body}),signal:AbortSignal.timeout(10000)});
      const data=await response.json().catch(()=>({error:'Service unavailable. Practice is saved here.'}));
      result={status:response.status,...data};
    }
    if (learner!==this.getProfile().id) throw new Error('Learner changed.');
    if (result.status>=400) throw Object.assign(new Error(result.error || 'Saved locally. Waiting to reconnect.'),{status:result.status});
    return result;
  }
  request(action,body={}) {
    if (action==='leaderboard') return this.exchange('scores/leaderboard');
    if (action==='start' || action==='join') body={...body,foundation:this.storage.row().foundation || syncProfile(newProfile())};
    return this.exchange('private/'+action,{...body, profileVersion:2});
  }
  changed() {
    super.changed();
    const row=this.storage.row();
    if (this.hasScores(row)) this.queueScores();
  }
  equipmentChange(row) {
    const p=this.getProfile(), listing=row.listings?.[p.callsign];
    if (!p.leaderboard || !p.callsign || (row.listings && !listing?.visible) || row.visibilityQueue?.length) return null;
    const station=equipmentSnapshot(p.shack);
    if (!station) return null;
    const body={callsign:p.callsign,generation:row.generation,revision:listing?.revision || 0,station};
    return JSON.stringify(body)===row.postedEquipment ? null : body;
  }
  acceptEquipment(remote) {
    if (!remote) return;
    const p=this.getProfile(), merged=mergeShack(p.shack,remote);
    if (JSON.stringify(equipmentSnapshot(p.shack))===JSON.stringify(equipmentSnapshot(merged))) return;
    const state=JSON.parse(this.storage.getItem(STORAGE_KEY));
    const saved=state.profiles.find(learner=>learner.id===p.id);
    if (!saved) return;
    saved.shack=merged;
    this.storage.setItem(STORAGE_KEY,JSON.stringify(state));
    p.shack=merged;
  }
  async publishEquipment() {
    const row=this.storage.row(), body=this.equipmentChange(row);
    if (!body || (this.gearRetryAt || 0)>Date.now()) return;
    let receipt;
    try { receipt=await this.exchange('scores/station',body); }
    catch(error) {
      if (error.status!==404) throw error;
      this.gearRetryAt=Date.now()+60000;
      return;
    }
    const p=this.getProfile();
    if (!p.leaderboard || p.callsign!==body.callsign || row.generation!==body.generation || this.storage.failed) return;
    if (!receipt.station) throw Error('The website did not acknowledge the station.');
    this.storage.atomic(()=>{
      this.acceptEquipment(receipt.station);
      row.postedEquipment=JSON.stringify(body);
    });
    this.onScoresPublished?.();
  }
  hasScores(row) {
    if (row.visibilityQueue?.length || (this.gearRetryAt || 0)<=Date.now() && this.equipmentChange(row)) return true;
    if (!row.listings) return row.needsConsent || row.scores.length || row.history?.decision === 'queued';
    const p = this.getProfile(), listing = row.listings[p.callsign];
    if (!p.leaderboard || !listing?.visible) return false;
    return row.scores.length || JSON.stringify(scoreSnapshot(p,row)) !== JSON.stringify(listing.local);
  }
  rememberListing(call, receipt, snapshot, intent, keys = {}, accepted) {
    const row = this.storage.row(), p = this.getProfile();
    if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !Number.isSafeInteger(receipt.xp) || receipt.xp < 0 || ![true,false,null].includes(receipt.visible))
      throw Error('The website returned an invalid listing.');
    if (receipt.covered !== undefined && (!receipt.covered || typeof receipt.covered !== 'object' || Array.isArray(receipt.covered) ||
        Object.entries(receipt.covered).some(([id,n]) => !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(n) || n < 0 || n > 1e9)))
      throw Error('The website returned invalid score counters.');
    let updateChoice = false;
    this.storage.atomic(() => {
      const last = row.listings[call] || {};
      if (receipt.revision < (last.revision || 0)) return;
      row.listings[call] = { ...last, revision:receipt.revision, visible:receipt.visible === true,
        xp:Math.max(last.xp || 0,receipt.xp), ...(snapshot && (receipt.visible || last.sentEarned == null) ? {sentEarned:snapshot.earned || 0} : {}),
        ...(receipt.absoluteOnly ? {absoluteOnly:true} : {}), ...(snapshot ? {local:snapshot,ackXP:Math.max(receipt.xp,snapshot.xp),
          covered:Object.fromEntries(Object.entries(snapshot.marks).map(([id,n])=>[id,receipt.covered?.[keys[id]] ?? n]))} : {}) };
      if (accepted) row.scores = row.scores.filter(r=>!accepted.has(r.id));
      if (intent) row.visibilityQueue = row.visibilityQueue.filter(i => i.call !== call || i.generation !== intent.generation);
      if (p.callsign === call && !row.visibilityQueue?.some(i => i.call === call) && receipt.visible !== null && p.leaderboard !== receipt.visible) {
        updateChoice = true;
        if (!receipt.visible) row.scores = [];
        const state = JSON.parse(this.storage.getItem(STORAGE_KEY));
        const saved = state.profiles.find(p => p.id === this.getProfile().id);
        if (saved) saved.leaderboard = receipt.visible;
        this.storage.setItem(STORAGE_KEY,JSON.stringify(state));
      }
    });
    if (updateChoice) p.leaderboard = receipt.visible;
  }
  async observeListing() {
    const p = this.getProfile(), row = this.storage.row(), call = p.callsign;
    if (!this.canPublish() || this.publishing || !call || !row.listings?.[call] || row.visibilityQueue?.length || this.storage.failed) return;
    const generation = row.generation;
    const receipt = await this.exchange('scores/listing',{callsign:call});
    if (this.getProfile().callsign !== call || this.storage.row().generation !== generation || this.storage.failed) return;
    const last = this.storage.row().listings[call];
    if (receipt.revision < last.revision) return;
    if (receipt.visible && p.leaderboard && receipt.station) this.acceptEquipment(receipt.station);
    if (receipt.revision === last.revision && receipt.xp <= last.xp) return;
    this.rememberListing(call,receipt,null);
    this.changedScoresOnReconnect();
    this.onStatus(this.status);
  }
  async flushListing() {
    const p = this.getProfile(), row = this.storage.row(), generation = row.generation;
    const current = () => this.getProfile().id === p.id && this.storage.row().generation === generation && !this.storage.failed;
    await this.exchange('scores/session');
    if (!current()) return;
    const intent = row.visibilityQueue?.[0];
    if (intent) {
      const callsign = intent.call;
      const keys = {};
      let receipt;
      try {
        if (intent.revision === null) {
          const state = await this.exchange('scores/listing',{callsign});
          if (!current()) return;
          if (intent.visible && state.visible === false) {
            // An offline device without a previously observed revision cannot
            // tell whether someone hid the callsign after it queued this show.
            this.rememberListing(callsign,state,null,intent);
            this.storage.atomic(() => { row.listingError = 'This callsign is hidden. Check the box again to show it on the leaderboard.'; });
            this.onScoresPublished?.();
            return;
          }
          this.storage.atomic(() => { intent.revision = state.revision; });
        }
        const body = {callsign,generation:intent.generation,revision:intent.revision,visible:intent.visible};
        if (intent.visible) Object.assign(body,await publicSnapshot(callsign,intent.snapshot,keys,row));
        if (!current()) return;
        receipt = await this.exchange('scores/visibility',body);
      } catch (error) {
        if (!current()) return;
        if (error.status === 404 && intent.legacyFence) {
          await this.exchange('scores/consent',{callsign,generation:intent.generation,enabled:false});
          if (current()) this.storage.atomic(() => { intent.legacyFence=false; });
        }
        if (error.status === 403 && !intent.visible && callsign !== p.callsign && current()) {
          this.storage.atomic(() => { row.visibilityQueue = row.visibilityQueue.filter(i => i !== intent); });
          return;
        }
        if (error.status !== 409 || !current()) throw error;
        receipt = await this.exchange('scores/listing',{callsign});
        if (!current()) return;
        this.rememberListing(callsign,receipt,null,intent);
        this.storage.atomic(() => { this.storage.row().listingError = 'Visibility changed on another device. Its choice is shown here.'; });
        this.onScoresPublished?.();
        return;
      }
      if (!current()) return;
      // The snapshot on a hide stays on this installation. It anchors XP
      // earned privately if the owner later chooses to show the total again.
      this.rememberListing(callsign,receipt,intent.visible === receipt.visible ? intent.snapshot : null,intent,keys);
      this.onScoresPublished?.();
      return;
    }
    const callsign = p.callsign, listing = row.listings[callsign];
    if (!p.leaderboard || !listing?.visible) return;
    const snapshot = scoreSnapshot(p,row), results = row.scores.slice(0,25);
    const keys = {};
    const total = { ...snapshot, xp:this.storage.scoreTotal(p) };
    const body = {callsign,generation,revision:listing.revision,results,...await publicSnapshot(callsign,total,keys,row)};
    if (!current()) return;
    let receipt;
    try { receipt = await this.exchange('scores/total',body); }
    catch (error) {
      if (error.status !== 409 || !current()) throw error;
      const actual = await this.exchange('scores/listing',{callsign});
      if (!current()) return;
      if (actual.revision === listing.revision) throw error;
      this.rememberListing(callsign,actual,null);
      if (actual.visible) {
        // A hide and re-show on another device fences older score batches. Its
        // new public baseline already includes the lifetime total.
        this.storage.atomic(() => { this.storage.row().scores = []; });
      }
      this.onScoresPublished?.();
      return;
    }
    if (!current()) return;
    const accepted = new Set(Array.isArray(receipt.acknowledged) ? receipt.acknowledged : []);
    if (!Array.isArray(receipt.acknowledged) || accepted.size !== results.length || results.some(r=>!accepted.has(r.id))) throw Error('The website did not acknowledge this score batch.');
    this.rememberListing(callsign,receipt,snapshot,null,keys,accepted);
    this.onScoresPublished?.();
  }
  queueScores(delay=200) {
    if (!this.canPublish() || this.scoreTimer || this.disposed) return;
    this.scoreTimer=setTimeout(()=>{ this.scoreTimer=null; void this.flushScores(); },delay);
  }
  consentChanged() {
    const row=this.storage.row(), p=this.getProfile();
    if (this.publishing && row.listings && row.visibilityQueue?.some(i => !i.visible) && !this.storage.failed) {
      // Apply an explicit hide promptly even with an earlier request in flight.
      void this.flushListing().catch(() => {});
    } else if (this.publishing && !row.listings && !p.leaderboard && !this.storage.failed) {
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
    if (!this.canPublish() || this.publishing || this.disposed || this.storage.failed) return;
    this.publishing=true;
    try {
      const profile=this.getProfile(), owner=profile.id, row=this.storage.row(owner);
      if (!this.hasScores(row)) return;
      if (row.listings) {
        await this.flushListing();
        await this.publishEquipment();
        this.scoreError = null;
        return;
      }
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
        if (pending.some(r => accepted.has(r.id))) this.onScoresPublished?.();
      }
      const history=this.storage.row(owner).history;
      if (current() && history?.decision==='queued') {
        await this.exchange('scores/history',{generation,id:history.id,xp:history.xp});
        if (current()) {
          this.storage.atomic(()=>{ this.storage.row(owner).history.decision='published'; });
          this.onScoresPublished?.();
        }
      }
      if (current()) await this.publishEquipment();
      this.scoreError=null;
    } catch(error) {
      this.scoreError = error.status === 404 && this.storage.row().listings
        ? 'Waiting for the website leaderboard update. Your visibility change or score is saved here.' : error.message;
    }
    finally {
      this.publishing=false;
      const row=this.storage.row();
      if (this.hasScores(row)) this.queueScores(this.scoreError?15000:50);
      this.onStatus(this.status);
    }
  }
  async tick() {
    // Only an explicit link or restore starts private network traffic.
    if (this.canSync() && this.meta()) await super.tick();
    this.changedScoresOnReconnect();
  }
  changedScoresOnReconnect() {
    const row=this.storage.row();
    if (this.hasScores(row)) this.queueScores();
  }
  apply(meta) {
    if (!meta?.remote || meta.pending || meta.replacement || !this.ready()) return meta;
    if (meta.force && meta.previous && hasLocalChanges(meta.previous,syncProfile(this.getProfile()))) {
      const retry={version:1,...meta.previous};
      this.save(retry);this.schedule(0);return retry;
    }
    delete meta.previous;
    const applied=this.storage.atomic(()=>super.apply(meta));
    this.report({message:'Synced',error:false}, applied);
    return applied;
  }
  report(changes, meta) {
    if (changes.message === 'Synced' && meta?.base) {
      const local = syncProfile(this.getProfile());
      const remote = meta.remote || meta.base;
      const settings = remote.sending?.settings || {};
      changes.localPlaybackOnly = !Object.hasOwn(settings,'continueMode') || !Object.hasOwn(settings,'pauseSeconds');
      if (changes.waiting || (changes.waiting === undefined && this.status.waiting)) changes.message = 'Waiting for approval';
      else if (meta.pending || meta.replacement) changes.message = 'Changes waiting to upload';
      else if (meta.force || (meta.remote && syncChanged(playbackOnDevice(meta.base, local.sending.settings), playbackOnDevice(meta.remote, local.sending.settings)))) changes.message = 'Applying website progress';
      else changes.message = hasLocalChanges(meta, local) ? 'Changes waiting to upload' : 'Progress synced';
    }
    super.report(changes);
  }
  receive(result,meta) {
    if (result.connected && !this.status.connected && this.getProfile().leaderboard && !this.storage.row().listings) {
      this.storage.atomic(() => { this.storage.row().needsConsent = true; });
      this.queueScores();
    }
    if (meta && result.connected && meta.epoch!==result.epoch && !meta.pending) {
      if (hasLocalChanges(meta,syncProfile(this.getProfile()))) {
        this.schedule(0); return meta;
      }
      const previous={base:meta.base,epoch:meta.epoch,seq:meta.seq,revision:meta.revision,localPlayback:meta.localPlayback,spacingPreference:meta.spacingPreference,localSendWpm:meta.localSendWpm,legacySendingSessions:meta.legacySendingSessions,legacySendActivity:meta.legacySendActivity,legacyShack:meta.legacyShack};
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
