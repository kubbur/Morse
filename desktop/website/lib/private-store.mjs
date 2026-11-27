import { randomBytes, randomUUID } from 'node:crypto';
import { SyncStore, SyncError } from './sync-store.mjs';
import { digest } from './score-store.mjs';
import { syncProfile, mergeProgress } from '../public/js/sync-data.mjs';
import { mergeShack } from '../public/js/shack-model.mjs';
import { resetLearnerProgress, resetListeningProgress, resetSendingProgress } from '../public/js/progress.mjs';
import { pairedProgress } from '../public/js/initial-merge.mjs';

export class PrivateStore extends SyncStore {
  constructor(path, options) {
    super(path, options);
    this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_devices(key TEXT PRIMARY KEY, device TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revoked_publishers(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS foundations(save_id TEXT PRIMARY KEY, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_codes(hash TEXT PRIMARY KEY, save_id TEXT UNIQUE REFERENCES saves(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY, save_id TEXT NOT NULL, created INTEGER NOT NULL, reason TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS save_revision BEFORE UPDATE OF profile ON saves WHEN OLD.profile!=NEW.profile
        BEGIN INSERT INTO revisions(save_id, created, reason, raw) VALUES(OLD.id, unixepoch(), 'update', OLD.profile); END;
      CREATE TRIGGER IF NOT EXISTS keep_removed_save BEFORE DELETE ON saves
        BEGIN INSERT INTO revisions(save_id, created, reason, raw) VALUES(OLD.id, unixepoch(), 'removed', OLD.profile); END;`);
  }
  listing() { /* Private writes never modify public standings. */ }
  ensure(token, profile, label) {
    const result = super.ensure(token, profile, label);
    this.run('INSERT OR IGNORE INTO foundations VALUES(?,?)',result.device.save_id,JSON.stringify(syncProfile(this.initialFoundation || profile)));
    return result;
  }
  pairedProfile(left,right) {
    const foundation = row => JSON.parse(this.get('SELECT raw FROM foundations WHERE save_id=?',row.id)?.raw || JSON.stringify(row.profile));
    for (const [reason,row] of [['paired-owner',left],['paired-joining',right]]) {
      this.run('INSERT INTO revisions(save_id,created,reason,raw) VALUES(?,?,?,?)',left.id,Math.floor(this.now()/1000),reason,JSON.stringify(row.profile));
    }
    const merged = pairedProgress(left.profile,right.profile,foundation(left),foundation(right));
    this.run('INSERT OR REPLACE INTO foundations VALUES(?,?)',left.id,JSON.stringify(merged.foundation));
    this.run('DELETE FROM foundations WHERE save_id=?',right.id);
    this.run('UPDATE stations SET owner=? WHERE owner=?',left.id,right.id);
    return merged.profile;
  }
  adopt(token, legacyToken) {
    return this.transaction(()=>{
      const existing=this.device(token);
      if (existing) return this.snapshot(existing);
      const owner=this.device(legacyToken);
      if (!owner) throw new SyncError(403,'Open this in the browser that owns the existing website profile.');
      // The same browser already owns this device. Keep its sequence and revocation identity.
      return {...this.snapshot(owner),setToken:legacyToken};
    });
  }
  push(token, body) {
    return this.transaction(()=>{
      const device=this.device(token);
      if (!device) throw new SyncError(401,'This device is no longer paired.');
      const save=this.save(device), remote=JSON.parse(save.profile);
      if (!Number.isSafeInteger(body.seq) || body.seq<1 || body.seq>device.seq+1) throw new SyncError(409,'Invalid device sequence.');
      if (body.seq<=device.seq) return {...this.snapshot(device),rebased:true};
      const base=syncProfile(body.base), local=syncProfile(body.profile);
      let next=mergeProgress(base,local,remote), epoch=save.epoch;
      if (body.epoch!==save.epoch) {
        // Old progress is a baseline only. Carry forward newly earned counts.
        // Preserve the reset course cursor and avoid reintroducing old marks.
        const reset=this.courseResetScope(save.id,body.epoch,save.epoch);
        if (reset) {
          if (reset!=='send') next={...remote,credits:next.credits,stats:{...next.stats,mastery:remote.stats.mastery},review:next.review,sending:next.sending};
          if (reset!=='listen') next.sending={...next.sending,level:remote.sending.level,pendingLevel:remote.sending.pendingLevel,records:remote.sending.records,settings:remote.sending.settings};
        }
      }
      if (body.replace) {
        // Preserve work that reached the server after this device's baseline.
        if (body.reason==='import') next=mergeProgress(base,remote,local);
        else if (body.reason==='reset-send') next=resetSendingProgress(next);
        else if (body.reason==='reset-listen') next=resetListeningProgress(next);
        else if (body.reason==='reset') next=resetLearnerProgress(next);
        else throw new SyncError(400,'Unknown replacement operation.');
        epoch=randomUUID();
        this.run('INSERT INTO epochs VALUES(?,?,?,?)',save.id,save.epoch,epoch,body.reason);
      }
      this.run('UPDATE saves SET profile=?,epoch=?,revision=revision+1,updated=? WHERE id=?',JSON.stringify(next),epoch,this.now(),save.id);
      this.run('UPDATE devices SET seq=?,updated=? WHERE id=?',body.seq,this.now(),device.id);
      return {...this.snapshot(this.device(token)),rebased:true};
    });
  }
  revoke(saveId,deviceId) {
    if (!this.get('SELECT id FROM devices WHERE id=? AND save_id=?',deviceId,saveId)) throw new SyncError(404,'Device not found.');
    this.run('INSERT OR IGNORE INTO revoked_publishers SELECT key FROM publisher_devices WHERE device=?',deviceId);
    this.run('DELETE FROM devices WHERE id=?',deviceId);
  }
  associatePublisher(privateToken, publisherToken) {
    const device = this.device(privateToken), key = publisherToken && digest(publisherToken);
    if (!device || !key || !this.get('SELECT 1 FROM publishers WHERE key=?',key) ||
        this.get('SELECT 1 FROM revoked_publishers WHERE key=?',key)) return;
    const linked = this.get('SELECT save_id FROM publisher_devices JOIN devices ON devices.id=publisher_devices.device WHERE key=?',key);
    if (linked && linked.save_id !== device.save_id) return;
    if (this.get('SELECT 1 FROM publisher_devices WHERE key=? AND device=?',key,device.id) &&
        !this.get('SELECT 1 FROM stations WHERE creator=? AND owner IS NULL',key)) return;
    this.transaction(() => {
      this.run('INSERT OR IGNORE INTO publisher_devices VALUES(?,?)',key,device.id);
      this.run('UPDATE stations SET owner=? WHERE creator=? AND owner IS NULL',device.save_id,key);
    });
  }
  erase(token, publisherToken, body, legacyToken) {
    return this.transaction(() => {
      this.prune();
      if (!token && body.legacyEpoch) {
        const legacy = this.device(legacyToken);
        if (legacy && this.save(legacy).epoch === body.legacyEpoch) token = legacyToken;
        else if (legacyToken && this.get('SELECT 1 FROM erasures WHERE token=?',digest(legacyToken))) token = legacyToken;
      }
      const device = this.device(token);
      const erased = token && this.get('SELECT 1 FROM erasures WHERE token=?',digest(token));
      if (body.requirePrivate && !device && !erased)
        throw new SyncError(403,'Restore access to the private backup on a linked device before deleting it.');
      const owner = device?.save_id ?? null;
      const publisher = publisherToken ? digest(publisherToken) : null;
      const priorPublisherErase = publisher && this.get('SELECT 1 FROM erasures WHERE token=?',publisher);
      const publisherOwner = publisher && (this.get('SELECT save_id AS owner FROM publisher_devices JOIN devices ON devices.id=publisher_devices.device WHERE key=?',publisher) ||
        this.get('SELECT owner FROM stations WHERE creator=? AND owner IS NOT NULL',publisher))?.owner;
      if (publisherOwner && publisherOwner !== owner && !erased)
        throw new SyncError(403,'Use a device linked to this private backup to delete it.');
      if (body.requirePublisher && !owner && !erased && !priorPublisherErase &&
          (!publisher || !this.get('SELECT 1 FROM publishers WHERE key=?',publisher) || this.get('SELECT 1 FROM revoked_publishers WHERE key=?',publisher)))
        throw new SyncError(403,'Use the device that shared this leaderboard entry to delete it.');
      const keys = new Set();
      if (publisher && !this.get('SELECT 1 FROM revoked_publishers WHERE key=?',publisher)) keys.add(publisher);
      if (owner) {
        for (const row of this.all('SELECT key FROM publisher_devices JOIN devices ON devices.id=publisher_devices.device WHERE save_id=?',owner)) keys.add(row.key);
      }
      const calls = new Set(this.all('SELECT call FROM stations WHERE owner=?',owner).map(row=>row.call));
      for (const key of keys) {
        for (const row of this.all('SELECT call FROM stations WHERE creator=? AND owner IS NULL',key)) calls.add(row.call);
      }
      for (const call of calls) {
        const {creator} = this.get('SELECT creator FROM stations WHERE call=?',call);
        if (!creator.startsWith('legacy:')) keys.add(creator);
        for (const row of this.all('SELECT key FROM publishers WHERE call=? AND enabled=1',call)) keys.add(row.key);
        for (const table of ['score_results','score_listings','score_counters','historical_receipts','original_days','legacy_score_grants','visibility_receipts'])
          this.run('DELETE FROM ' + table + ' WHERE call=?',call);
        this.run('DELETE FROM stations WHERE call=?',call);
      }
      for (const key of keys) {
        this.run('INSERT OR IGNORE INTO revoked_publishers VALUES(?)',key);
        this.run('INSERT OR REPLACE INTO erasures VALUES(?,?)',key,this.now()+366*86400000);
        this.run('DELETE FROM publishers WHERE key=?',key);
        this.run('DELETE FROM publisher_devices WHERE key=?',key);
        this.run('DELETE FROM visibility_receipts WHERE publisher=?',key);
        this.run('DELETE FROM legacy_score_grants WHERE publisher=?',key);
      }
      if (owner) {
        // Older pairings archived the joining save under its original ID. In the
        // same transaction its removal follows the paired snapshot, with at most
        // the owner's update in between. Never infer ownership from a callsign.
        const archives = this.all(`WITH RECURSIVE family(id) AS (
          SELECT ? UNION SELECT r.save_id FROM family
          JOIN revisions p ON p.save_id=family.id AND p.reason='paired-joining'
          JOIN revisions r ON r.reason='removed' AND r.raw=p.raw AND
            (r.id=p.id+1 OR (r.id=p.id+2 AND EXISTS
              (SELECT 1 FROM revisions u WHERE u.id=p.id+1 AND u.save_id=p.save_id AND u.reason='update')))
        ) SELECT id FROM family`,owner);
        this.run('INSERT OR REPLACE INTO erasures SELECT token,? FROM devices WHERE save_id=?',this.now()+366*86400000,owner);
        this.run('DELETE FROM devices WHERE save_id=?',owner);
        this.run('DELETE FROM saves WHERE id=?',owner);
        // The removal trigger also writes a backup. Clear revisions after it fires.
        for (const {id} of archives) {
          this.run('DELETE FROM revisions WHERE save_id=?',id);
          this.run('DELETE FROM foundations WHERE save_id=?',id);
        }
      }
      return {connected:false, erased:true};
    });
  }
  request(action, token, body, publisherToken) {
    if (action==='erase') return this.erase(token,publisherToken,body);
    if (token && this.get('SELECT 1 FROM erasures WHERE token=? AND expires>?',digest(token),this.now()))
      return {connected:false, erased:true};
    if (action==='push') return this.push(token,body);
    if (action==='disconnect') return this.transaction(()=>{
      const me=this.device(token);
      if (!me) throw new SyncError(401,'This device is no longer paired.');
      const id=body.device || me.id;
      this.revoke(me.save_id,id);
      return id===me.id ? {connected:false,setToken:''} : this.snapshot(me);
    });
    if (action === 'recovery-code' || action === 'recover') return this.transaction(() => {
      const device = this.device(token);
      if (action === 'recovery-code') {
        if (!device) throw new SyncError(401,'Link this device first.');
        const code = randomBytes(24).toString('base64url');
        this.run('INSERT OR REPLACE INTO recovery_codes VALUES(?,?)',digest(code),device.save_id);
        return { code };
      }
      const record = typeof body.code === 'string' && body.code.length === 32 && this.get('SELECT save_id FROM recovery_codes WHERE hash=?',digest(body.code));
      if (!record) throw new SyncError(403,'Recovery code not accepted.');
      if (device) {
        if (device.save_id===record.save_id) return this.snapshot(device);
        throw new SyncError(409,'This device already has a private connection.');
      }
      const devices=this.all('SELECT id,label FROM devices WHERE save_id=? ORDER BY updated,id',record.save_id);
      if (devices.length>=8) {
        if (!body.replaceDevice) return { chooseDevice:true,devices };
        this.revoke(record.save_id,body.replaceDevice);
      }
      const next = randomBytes(32).toString('base64url');
      this.run('INSERT INTO devices VALUES(?,?,?,?,0,?)',randomUUID(),record.save_id,digest(next),'Recovered device',this.now());
      return { ...this.snapshot(this.device(next)), setToken: next };
    });
    if (action==='identity' || action==='leaderboard') throw new SyncError(404,'This action is separate from private sync.');
    // Joining replaces the unpaired device's current save with its submitted
    // snapshot. Stable can only submit the portion it received.
    if (action === 'join' && body.profileVersion !== 2 && body.profile?.settings) {
      const device = this.device(token);
      if (device) {
        const saved = JSON.parse(this.save(device).profile);
        const profile = {...body.profile, settings:{...body.profile.settings}};
        if (saved.settings.sendWpm !== undefined) profile.settings.sendWpm = saved.settings.sendWpm;
        if (saved.shack) profile.shack = mergeShack(saved.shack, profile.shack);
        body = {...body, profile};
      }
    }
    this.initialFoundation=body.foundation;
    try { return super.request(action,token,body); } finally { this.initialFoundation=null; }
  }
}
