import { randomBytes, randomUUID } from 'node:crypto';
import { SyncStore, SyncError } from './sync-store.mjs';
import { digest } from './score-store.mjs';
import { syncProfile, mergeProgress } from '../public/js/sync-data.mjs';
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
  request(action, token, body) {
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
    if (action==='identity' || action==='leaderboard' || action==='erase') throw new SyncError(404,'This action is separate from private sync.');
    this.initialFoundation=body.foundation;
    try { return super.request(action,token,body); } finally { this.initialFoundation=null; }
  }
}
