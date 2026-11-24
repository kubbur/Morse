import { createHash } from 'node:crypto';
import { sanitizeCallsign, dayStreak } from '../public/js/progress.mjs';
import { SyncError } from './sync-store.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw new SyncError(status, message); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const exact = (body, fields) => Object.keys(body).every(k => fields.includes(k));
export class ScoreStore {
  constructor(privateStore) {
    this.store = privateStore;
    privateStore.db.exec(`CREATE TABLE IF NOT EXISTS stations(call TEXT PRIMARY KEY, creator TEXT NOT NULL, owner TEXT, historical INTEGER NOT NULL DEFAULT 0, import_id TEXT);
      CREATE TABLE IF NOT EXISTS historical_receipts(id TEXT PRIMARY KEY, call TEXT UNIQUE NOT NULL, xp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS original_days(call TEXT PRIMARY KEY, days TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publishers(key TEXT PRIMARY KEY, gen INTEGER NOT NULL, enabled INTEGER NOT NULL, call TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS score_results(id TEXT PRIMARY KEY, call TEXT NOT NULL REFERENCES stations(call), xp INTEGER NOT NULL, day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scores_by_call ON score_results(call);
      INSERT OR IGNORE INTO stations(call,creator,owner,historical) SELECT callsign,'legacy:'||save_id,save_id,xp FROM leaderboard;
      INSERT OR IGNORE INTO original_days SELECT callsign,days FROM leaderboard;`);
  }
  request(action, token, privateToken, body) {
    const s = this.store;
    return s.transaction(() => {
      const key = token && digest(token), publisher = key && s.get('SELECT * FROM publishers WHERE key=?', key);
      if (action === 'leaderboard') {
        const rows = s.all(`SELECT s.call AS callsign, s.historical+coalesce(sum(r.xp),0) AS xp FROM stations s LEFT JOIN score_results r ON r.call=s.call GROUP BY s.call ORDER BY xp DESC,s.call`);
        const entries = rows.map((row, i) => {
          const days = Object.fromEntries(s.all('SELECT DISTINCT day FROM score_results WHERE call=? ORDER BY day DESC LIMIT 366', row.callsign).map(r => [r.day,1]));
          const legacy=s.get('SELECT days FROM original_days WHERE call=?',row.callsign);
          return { ...row, rank: i + 1, streak: dayStreak({ days:{...(legacy?JSON.parse(legacy.days):{}),...days} }, new Date(s.now())) };
        });
        return { entries: entries.slice(0,50), me: entries.find(e => e.callsign === publisher?.call) || null };
      }
      if (!key) fail(401, 'Publisher credential required.');
      if (s.get('SELECT key FROM revoked_publishers WHERE key=?',key)) fail(403,'This device was revoked.');
      const gen = body.generation;
      if (!Number.isSafeInteger(gen) || gen < 0) fail(400, 'Invalid sharing generation.');
      if (action === 'consent') {
        if (!exact(body,['generation','callsign','enabled']) || typeof body.enabled !== 'boolean') fail(400,'Invalid sharing choice.');
        const call = sanitizeCallsign(body.callsign);
        if (body.enabled && !call) fail(400,'A callsign is required for public scores.');
        if (publisher && (gen < publisher.gen || gen === publisher.gen && (body.enabled !== Boolean(publisher.enabled) || call !== publisher.call))) fail(409,'A newer sharing choice is saved.');
        if (body.enabled) {
          const device=s.device(privateToken), owner=device?.save_id || null;
          if (device) s.run('INSERT OR REPLACE INTO publisher_devices VALUES(?,?)',key,device.id);
          const station = s.get('SELECT * FROM stations WHERE call=?', call);
          const legacy = s.get('SELECT * FROM leaderboard WHERE callsign=?', call);
          if ((station && station.creator !== key && (!owner || station.owner !== owner)) || (legacy && legacy.save_id !== owner && !station)) fail(403,'This callsign is claimed. Link an authorized device first.');
          if (!station) s.run('INSERT INTO stations(call,creator,owner,historical) VALUES(?,?,?,?)', call,key,owner,legacy?.xp || 0);
          else if (owner && station.creator === key && !station.owner) s.run('UPDATE stations SET owner=? WHERE call=?', owner,call);
        }
        s.run('INSERT INTO publishers VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET gen=excluded.gen,enabled=excluded.enabled,call=excluded.call', key,gen,+body.enabled,call);
        return { acknowledged: gen };
      }
      if (!publisher?.enabled || publisher.gen !== gen) fail(409,'Sharing changed. Discard this submission.');
      const call = publisher.call;
      if (action === 'history') {
        if (!exact(body,['generation','xp','id']) || !uuid(body.id) || !Number.isInteger(body.xp) || body.xp<0 || body.xp>1e9) fail(400,'Invalid historical score.');
        const row = s.get('SELECT historical,import_id FROM stations WHERE call=?',call);
        if (row.import_id && row.import_id !== body.id) fail(409,'Historical scores were already imported.');
        const receipt=s.get('SELECT * FROM historical_receipts WHERE id=?',body.id);
        if (receipt && (receipt.call!==call || receipt.xp!==body.xp)) fail(409,'Historical receipt does not match.');
        s.run('INSERT OR IGNORE INTO historical_receipts VALUES(?,?,?)',body.id,call,body.xp);
        s.run('UPDATE stations SET historical=max(historical,?),import_id=? WHERE call=?', body.xp,body.id,call);
        return { acknowledged: body.id };
      }
      if (action === 'history-preview') {
        const row=s.get('SELECT historical,import_id FROM stations WHERE call=?',call);
        return { previous: row.historical, imported: !!row.import_id };
      }
      if (!['prepare','submit'].includes(action) || !exact(body,['generation','results']) || !Array.isArray(body.results) || !body.results.length || body.results.length>25) fail(400,'Invalid score batch.');
      for (const r of body.results) {
        if (!r || !exact(r,['id','kind','xp','day']) || !uuid(r.id) || !['listen','send'].includes(r.kind) ||
            !Number.isInteger(r.xp) || (r.kind === 'send' ? ![10,40].includes(r.xp) : !(r.xp===8 || r.xp>=20 && r.xp<=220 && r.xp%2===0)) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)) ||
            new Date(r.day).toISOString().slice(0,10)!==r.day || Date.parse(r.day)>s.now()+86400000) fail(400,'Invalid practice result.');
        const old=s.get('SELECT * FROM score_results WHERE id=?',r.id);
        if (old && (old.call!==call || old.xp!==r.xp || old.day!==r.day)) fail(409,'Result identifier already used.');
        if (action==='submit' && !old) s.run('INSERT INTO score_results VALUES(?,?,?,?)',r.id,call,r.xp,r.day);
      }
      return { acknowledged: body.results.map(r=>r.id) };
    });
  }
}
