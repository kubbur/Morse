import { createHash } from 'node:crypto';
import { sanitizeCallsign, dayStreak } from '../public/js/progress.mjs';
import { balances, equipmentSnapshot, mergeShack, sanitizeShack } from '../public/js/shack-model.mjs';
import { SyncError } from './sync-store.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw new SyncError(status, message); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const exact = (body, fields) => Object.keys(body).every(k => fields.includes(k));
function validateSnapshot({xp, marks, activity, absoluteOnly}) {
  if (!Number.isSafeInteger(xp) || xp < 0 || xp > 1e9 || !marks || typeof marks !== 'object' || Array.isArray(marks))
    fail(400,'Invalid score total.');
  const entries = Object.entries(marks);
  if (activity !== undefined && (!activity || typeof activity !== 'object' || !exact(activity,['stream','xp']) ||
      typeof activity.stream !== 'string' || !Object.hasOwn(marks,activity.stream) || !Number.isSafeInteger(activity.xp) || activity.xp <= 0 || activity.xp > marks[activity.stream]))
    fail(400,'Invalid new practice total.');
  if ((absoluteOnly !== undefined && (absoluteOnly !== true || entries.length)) || entries.length > 128 || entries.some(([id,n]) => !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(n) || n < 0 || n > 1e9) ||
      Math.min(1e9,entries.reduce((sum,[,n])=>sum+n,0)) > xp) fail(400,'Invalid score counters.');
}
export class ScoreStore {
  constructor(privateStore) {
    this.store = privateStore;
    privateStore.db.exec(`CREATE TABLE IF NOT EXISTS stations(call TEXT PRIMARY KEY, creator TEXT NOT NULL, owner TEXT, historical INTEGER NOT NULL DEFAULT 0, import_id TEXT);
      CREATE TABLE IF NOT EXISTS shack_stations(call TEXT PRIMARY KEY REFERENCES stations(call) ON DELETE CASCADE, receipts TEXT NOT NULL, spent INTEGER NOT NULL, equipped TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS historical_receipts(id TEXT PRIMARY KEY, call TEXT UNIQUE NOT NULL, xp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS original_days(call TEXT PRIMARY KEY, days TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publishers(key TEXT PRIMARY KEY, gen INTEGER NOT NULL, enabled INTEGER NOT NULL, call TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS score_results(id TEXT PRIMARY KEY, call TEXT NOT NULL REFERENCES stations(call), xp INTEGER NOT NULL, day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scores_by_call ON score_results(call);
      CREATE TABLE IF NOT EXISTS score_listings(call TEXT PRIMARY KEY REFERENCES stations(call),visible INTEGER NOT NULL,revision INTEGER NOT NULL,best INTEGER NOT NULL,writer TEXT NOT NULL,generation INTEGER NOT NULL,absolute_only INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS score_counters(call TEXT NOT NULL REFERENCES stations(call),stream TEXT NOT NULL,amount INTEGER NOT NULL,PRIMARY KEY(call,stream));
      CREATE TABLE IF NOT EXISTS legacy_score_grants(publisher TEXT NOT NULL,call TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(publisher,call));
      CREATE TABLE IF NOT EXISTS visibility_receipts(publisher TEXT NOT NULL,gen INTEGER NOT NULL,call TEXT NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(publisher,gen,call));
      INSERT OR IGNORE INTO stations(call,creator,owner,historical) SELECT callsign,'legacy:'||save_id,save_id,xp FROM leaderboard;
      INSERT OR IGNORE INTO original_days SELECT callsign,days FROM leaderboard;`);
    if (!privateStore.all('PRAGMA table_info(score_listings)').some(column => column.name === 'absolute_only'))
      privateStore.run('ALTER TABLE score_listings ADD COLUMN absolute_only INTEGER NOT NULL DEFAULT 0');
  }
  results(call, results, commit) {
    const s = this.store;
    let newXP = 0;
    for (const r of results) {
      if (!r || !exact(r,['id','kind','xp','day']) || !uuid(r.id) || !['listen','send'].includes(r.kind) ||
          !Number.isInteger(r.xp) || (r.kind === 'send' ? ![10,40].includes(r.xp) : !(r.xp===8 || r.xp>=20 && r.xp<=220 && r.xp%2===0)) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)) ||
          new Date(r.day).toISOString().slice(0,10)!==r.day || Date.parse(r.day)>s.now()+86400000) fail(400,'Invalid practice result.');
      const old=s.get('SELECT * FROM score_results WHERE id=?',r.id);
      if (old && (old.call!==call || old.xp!==r.xp || old.day!==r.day)) fail(409,'Result identifier already used.');
      if (commit && !old) {
        s.run('INSERT INTO score_results VALUES(?,?,?,?)',r.id,call,r.xp,r.day);
        newXP += r.xp;
      }
    }
    return newXP;
  }

  // A callsign is public. Only its original publisher or a device belonging
  // to the linked save can inspect or change the owner's listing.
  listing(action, key, privateToken, body, publisher) {
    const s = this.store, call = sanitizeCallsign(body.callsign);
    if (!call || call !== body.callsign) fail(400, 'Invalid callsign.');
    const device = s.device(privateToken);
    const station = s.get('SELECT * FROM stations WHERE call=?', call);
    if (station && station.creator !== key && (!device || station.owner !== device.save_id))
      fail(403, 'This callsign is claimed. Link an authorized device first.');
    const listing = s.get('SELECT * FROM score_listings WHERE call=?', call);
    const revision = listing?.revision || 0;
    const ledger = () => station ? s.get('SELECT historical + (SELECT coalesce(sum(xp),0) FROM score_results WHERE call=?) AS xp FROM stations WHERE call=?', call, call).xp : 0;
    const covered = () => Object.fromEntries(Object.keys(body.marks || {}).map(id =>
      [id,s.get('SELECT amount FROM score_counters WHERE call=? AND stream=?',call,id)?.amount || 0]));
    const status = () => ({ revision, visible: listing ? !!listing.visible : null, xp: Math.max(listing?.best || 0, ledger()), ...(listing?.absolute_only ? {absoluteOnly:true} : {}) });
    if (action === 'listing') {
      if (!exact(body,['callsign'])) fail(400, 'Invalid listing request.');
      const saved=s.get('SELECT receipts FROM shack_stations WHERE call=?',call);
      return {...status(),...(saved ? {station:JSON.parse(saved.receipts)} : {})};
    }
    const gen = body.generation;
    if (!Number.isSafeInteger(gen) || gen < 0 || !Number.isSafeInteger(body.revision) || body.revision < 0) fail(400,'Invalid listing change.');
    if (publisher && gen < publisher.gen) fail(409, 'A newer sharing choice is saved.');
    const toggle = action === 'visibility', visible = toggle ? body.visible : true;
    if (typeof visible !== 'boolean' || !exact(body, toggle
      ? ['callsign','generation','revision','visible',...(visible ? ['xp','marks','activity','absoluteOnly'] : [])]
      : ['callsign','generation','revision','xp','marks','results','activity','absoluteOnly'])) fail(400,'Invalid listing request.');
    if (toggle) {
      const done = s.get('SELECT visible FROM visibility_receipts WHERE publisher=? AND gen=? AND call=?', key, gen, call);
      if (done) {
        if (!!done.visible !== visible) fail(409,'A newer sharing choice is saved.');
        if (visible) validateSnapshot(body);
        return { ...status(), ...(!station && !visible ? {visible:false} : {}), ...(visible && listing?.visible ? {covered:covered()} : {}) };
      }
    }
    if (body.revision !== revision && !(toggle && listing?.writer === key && gen > listing.generation))
      fail(409,'Leaderboard visibility changed on another device.');
    if (!toggle && (!listing?.visible || !publisher || publisher.gen !== gen || publisher.call !== call))
      fail(409,'Leaderboard visibility changed. Check the current listing.');
    if (visible) {
      validateSnapshot(body);
      if (!toggle && (!Array.isArray(body.results) || body.results.length > 25)) fail(400,'Invalid score batch.');
    }
    if (!station && !visible) {
      s.run('INSERT OR REPLACE INTO publishers VALUES(?,?,0,?)',key,gen,call);
      s.run('INSERT INTO visibility_receipts VALUES(?,?,?,0)',key,gen,call);
      return { revision:0, visible:false, xp:0 };
    }
    if (!station) s.run('INSERT INTO stations(call,creator,owner) VALUES(?,?,?)', call,key,device?.save_id || null);
    else if (!station.owner && device && station.creator === key) s.run('UPDATE stations SET owner=? WHERE call=?',device.save_id,call);
    if (device) s.run('INSERT OR REPLACE INTO publisher_devices VALUES(?,?)',key,device.id);
    const nextRevision = toggle && (!listing || !!listing.visible !== visible) ? revision + 1 : revision;
    let newXP = 0;
    if (toggle) {
      if (nextRevision !== revision) s.run(`INSERT INTO score_listings(call,visible,revision,best,writer,generation) VALUES(?,?,?,?,?,?) ON CONFLICT(call) DO UPDATE SET visible=excluded.visible,
        revision=excluded.revision,writer=excluded.writer,generation=excluded.generation`,call,+visible,nextRevision,0,key,gen);
      if (!listing && visible) {
        // Carry the previously authorized result-only publishers into the first
        // visible revision. A later hide fences all of those grants.
        s.run('INSERT OR REPLACE INTO legacy_score_grants SELECT key,call,? FROM publishers WHERE enabled=1 AND call=?',nextRevision,call);
      }
      s.run('INSERT INTO visibility_receipts VALUES(?,?,?,?)',key,gen,call,+visible);
      s.run('INSERT OR REPLACE INTO publishers VALUES(?,?,?,?)',key,gen,+visible,call);
    } else newXP = this.results(call,body.results,true);
    let best = listing?.best || 0;
    // An import with more sources than fit in the bounded score request has
    // an ambiguous overlap with later device snapshots. Keep comparing whole
    // totals for that callsign, even if it subsequently uses fewer sources.
    const absoluteOnly = !!(listing?.absolute_only || body.absoluteOnly);
    if (visible) {
      const marks = new Map(Object.entries(body.marks));
      let total = body.xp;
      // A linked owner's higher website total can be included only when this
      // dedicated public-score operation has verified ownership and visibility.
      if (device && (!station?.owner || station.owner === device.save_id)) {
        const saved = JSON.parse(s.save(device).profile);
        if (saved.callsign === call) {
          total = Math.max(total, saved.stats.xp);
          for (const [id, amount] of Object.entries(saved.credits || {})) {
            const stream = digest('morse-score/' + call + '/' + id);
            marks.set(stream, Math.max(marks.get(stream) || 0, amount));
          }
        }
      }
      let earned = 0, newPractice = 0;
      for (const [id, amount] of marks) {
        const old = s.get('SELECT amount FROM score_counters WHERE call=? AND stream=?',call,id);
        // An unfamiliar stream may contain previously imported work. Its first
        // snapshot establishes a baseline. Only later advances are additive.
        if (old) {
          const delta = Math.max(0,amount-old.amount);
          earned += delta;
          if (id === body.activity?.stream) newPractice = Math.min(body.activity.xp,Math.max(0,body.marks[id]-old.amount));
        }
        if (!old || amount > old.amount)
          s.run('INSERT OR REPLACE INTO score_counters VALUES(?,?,?)',call,id,amount);
      }
      best = Math.min(1e9,Math.max(best + (absoluteOnly ? 0 : body.activity ? newPractice : Math.min(earned,newXP)), total, ledger()));
      s.run('UPDATE score_listings SET best=?,absolute_only=? WHERE call=?',best,+absoluteOnly,call);
    }
    return { revision:nextRevision, visible, xp:Math.max(best,ledger()), ...(absoluteOnly ? {absoluteOnly:true} : {}), ...(visible ? {covered:covered()} : {}),
      ...(!toggle ? {acknowledged:body.results.map(r=>r.id)} : {}) };
  }
  request(action, token, privateToken, body) {
    const s = this.store;
    return s.transaction(() => {
      const key = token && digest(token), publisher = key && s.get('SELECT * FROM publishers WHERE key=?', key);
      if (action === 'leaderboard') {
        const rows = s.all(`SELECT scores.callsign, scores.earned, g.equipped,
          max(0,scores.earned-coalesce(g.spent,0)) AS xp FROM (
            SELECT s.call AS callsign, max(coalesce(l.best,0),s.historical+coalesce(sum(r.xp),0)) AS earned
            FROM stations s LEFT JOIN score_listings l ON l.call=s.call LEFT JOIN score_results r ON r.call=s.call
            WHERE coalesce(l.visible,1)=1 GROUP BY s.call
          ) scores LEFT JOIN shack_stations g ON g.call=scores.callsign ORDER BY xp DESC,scores.callsign`);
        const entries = rows.map(({callsign,xp,equipped,earned}, i) => {
          const row={callsign,xp,...(equipped ? {lifetimeXP:earned,equipped:JSON.parse(equipped)} : {})};
          const days = Object.fromEntries(s.all('SELECT DISTINCT day FROM score_results WHERE call=? ORDER BY day DESC LIMIT 366', row.callsign).map(r => [r.day,1]));
          const legacy=s.get('SELECT days FROM original_days WHERE call=?',row.callsign);
          return { ...row, rank: i + 1, streak: dayStreak({ days:{...(legacy?JSON.parse(legacy.days):{}),...days} }, new Date(s.now())) };
        });
        return { entries: entries.slice(0,50), me: entries.find(e => e.callsign === publisher?.call) || null };
      }
      if (!key) fail(401, 'Publisher credential required.');
      if (s.get('SELECT key FROM revoked_publishers WHERE key=?',key)) fail(403,'This device was revoked.');
      if (action === 'station') {
        const {callsign,generation,revision,station}=body;
        if (!exact(body,['callsign','generation','revision','station']) || !station || !exact(station,['converted','orders','equipped','sold','soldAt']))
          fail(400,'Invalid station equipment.');
        const owner=s.get('SELECT creator,owner FROM stations WHERE call=?',callsign);
        if (!owner || (owner.creator!==key && (!owner.owner || s.device(privateToken)?.save_id!==owner.owner)))
          fail(403,'This publisher cannot update the station.');
        const listing=s.get('SELECT visible,revision FROM score_listings WHERE call=?',callsign);
        if (!publisher?.enabled || publisher.gen!==generation || publisher.call!==callsign ||
            revision!==(listing?.revision || 0) || listing && !listing.visible)
          fail(409,'Leaderboard visibility changed.');
        const incoming=equipmentSnapshot(sanitizeShack(station));
        if (!incoming) fail(400,'Missing equipment receipts.');
        const previous=s.get('SELECT receipts FROM shack_stations WHERE call=?',callsign);
        const merged=previous ? mergeShack(JSON.parse(previous.receipts),incoming) : sanitizeShack(incoming);
        const snapshot=equipmentSnapshot(merged), ids=merged.equipped.map(slot=>slot?.id || null);
        s.run(`INSERT INTO shack_stations(call,receipts,spent,equipped) VALUES(?,?,?,?)
          ON CONFLICT(call) DO UPDATE SET receipts=excluded.receipts, spent=excluded.spent, equipped=excluded.equipped`,
          callsign,JSON.stringify(snapshot),balances(merged,0).spent,JSON.stringify(ids));
        return {station:snapshot};
      }
      if (['listing','visibility','total'].includes(action)) return this.listing(action,key,privateToken,body,publisher);
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
          const listing = s.get('SELECT visible,revision FROM score_listings WHERE call=?',call);
          if (listing?.visible && (!publisher || gen > publisher.gen))
            s.run('INSERT OR REPLACE INTO legacy_score_grants VALUES(?,?,?)',key,call,listing.revision);
          if (!station) s.run('INSERT INTO stations(call,creator,owner,historical) VALUES(?,?,?,?)', call,key,owner,legacy?.xp || 0);
          else if (owner && station.creator === key && !station.owner) s.run('UPDATE stations SET owner=? WHERE call=?', owner,call);
        }
        s.run('INSERT INTO publishers VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET gen=excluded.gen,enabled=excluded.enabled,call=excluded.call', key,gen,+body.enabled,call);
        return { acknowledged: gen };
      }
      if (!publisher?.enabled || publisher.gen !== gen) fail(409,'Sharing changed. Discard this submission.');
      const call = publisher.call;
      const listing = s.get('SELECT visible,revision FROM score_listings WHERE call=?',call);
      if (listing) {
        const grant = s.get('SELECT revision FROM legacy_score_grants WHERE publisher=? AND call=?',key,call);
        if (!listing.visible || grant?.revision !== listing.revision) fail(409,'Leaderboard visibility changed. Review your sharing choice.');
        if (action.startsWith('history')) fail(409,'This callsign already uses total XP.');
      }
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
      this.results(call,body.results,action==='submit');
      return { acknowledged: body.results.map(r=>r.id) };
    });
  }
}
