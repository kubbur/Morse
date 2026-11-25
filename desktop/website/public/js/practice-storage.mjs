import { STORAGE_KEY, sanitizeState } from './progress.mjs';
import { syncProfile } from './sync-data.mjs';
import { SYNC_KEY } from './device-sync.mjs';

const clone = value => structuredClone(value);
const newRow = () => ({ generation: 0, scores: [], private: null });
export class PracticeStorage {
  constructor(storage, mac = null) {
    this.storage = storage; this.mac = mac; this.revision = 0; this.hold = 0;
    const old = storage.getItem(STORAGE_KEY);
    const load = mac ? mac.loadSave(old) : { raw: old };
    if (load.error) throw new Error(load.error);
    this.raw = load.raw; this.revision = load.revision || 0;
    const existing = this.raw && JSON.parse(this.raw);
    this.delivery = existing?.delivery || { version: 1, learners: {} };
    if (this.delivery.version !== 1) throw new Error('Unknown save version. The previous save was kept.');
    if (existing && !existing.delivery) {
      const original = STORAGE_KEY + '.before-unified-v1';
      if (!storage.getItem(original)) storage.setItem(original, this.raw);
      const validated = sanitizeState(existing);
      for (const p of validated.profiles) {
        const row = this.row(p.id);
        row.foundation = syncProfile(p);
        if (mac && p.stats.xp) row.history = { xp: p.stats.xp, decision: 'pending' };
      }
    }
    if (mac?.syncMode === 'website' && !this.delivery.website) {
      for (const row of Object.values(this.delivery.learners)) {
        if (row.scores.length) row.previousScores = row.scores;
        row.scores = [];
        if (row.history?.decision === 'queued') row.history.decision = 'pending';
        // Earlier private connections and credentials belonged to the local test service.
        row.private = null;
      }
      this.delivery.website = 1;
    }
    this.owner = existing?.activeId; this.committed = this.raw;
    if (existing) {
      delete existing.delivery; this.raw=JSON.stringify(existing);
      if (existing.profiles?.some(p=>p.soundVersion!==1)) this.beforeSound=this.raw;
    }
  }
  row(id = this.owner) {
    if (!id || ['constructor','prototype','__proto__'].includes(id)) throw new Error('Invalid learner identifier.');
    if (!Object.hasOwn(this.delivery.learners,id)) this.delivery.learners[id]=newRow();
    return this.delivery.learners[id];
  }
  forLearner(id) {
    const store = this;
    return {
      get failed() { return store.failed; },
      row: () => store.row(id),
      getItem: key => key === SYNC_KEY ? store.row(id).private : store.getItem(key),
      setItem(key, value) {
        if (key !== SYNC_KEY) return store.setItem(key, value);
        store.atomic(() => { store.row(id).private = value; });
      },
      removeItem(key) {
        if (key !== SYNC_KEY) return store.removeItem(key);
        store.atomic(() => { store.row(id).private = null; });
      },
      atomic: fn => store.atomic(fn),
    };
  }
  get length() { return this.storage.length; }
  key(i) { return this.storage.key(i); }
  getItem(key) {
    if (key === STORAGE_KEY) return this.raw;
    if (key === SYNC_KEY) return this.owner && this.row().private || null;
    return this.storage.getItem(key);
  }
  setItem(key, value) {
    if (key === STORAGE_KEY) { const parsed = JSON.parse(value); this.owner = parsed.activeId; this.raw = value; }
    else if (key === SYNC_KEY) this.row().private = value;
    else { this.storage.setItem(key, value); return; }
    if (!this.hold) this.commit();
  }
  removeItem(key) {
    if (key === SYNC_KEY) { this.row().private = null; if (!this.hold) this.commit(); }
    else if (key !== STORAGE_KEY) this.storage.removeItem(key);
  }
  commit() {
    try { this.write(); this.failed=false; }
    catch(error) { this.failed=true; throw error; }
  }
  write() {
    if (!this.raw) return;
    if (this.beforeSound) {
      const key = STORAGE_KEY + '.before-shared-sound';
      if (!this.storage.getItem(key)) this.storage.setItem(key,this.beforeSound);
      this.beforeSound = null;
    }
    const state = JSON.parse(this.raw);
    const raw = JSON.stringify({ ...state, delivery: this.delivery });
    if (raw===this.committed) return;
    if (this.mac) {
      const saved = this.mac.save(raw, this.revision);
      if (saved.error) throw new Error(saved.error);
      this.revision = saved.revision;
    } else {
      // A second tab must reload its newer profile and consent before writing.
      const prior = this.storage.getItem(STORAGE_KEY);
      if (prior !== this.committed && this.committed !== undefined) throw new Error('Another tab saved progress. Reload before continuing.');
      this.storage.setItem(STORAGE_KEY, raw);
    }
    this.committed = raw;
    // The working state and exported progress do not carry the private upload journal.
    delete state.delivery;
    this.raw = JSON.stringify(state);
  }
  atomic(fn) {
    const before = { raw: this.raw, owner: this.owner, delivery: clone(this.delivery) };
    this.hold++;
    try {
      const result = fn();
      if (this.hold === 1) this.commit();
      return result;
    } catch (err) { Object.assign(this, before); throw err; }
    finally { this.hold--; }
  }
  external(raw) {
    const state = JSON.parse(raw);
    this.delivery = state.delivery || { version: 1, learners: {} };
    this.owner = state.activeId; this.committed = raw;
    delete state.delivery; this.raw = JSON.stringify(state);
    return this.raw;
  }
  consent(profile, callsign, sharing) {
    const row = this.row(profile.id);
    row.choiceSet=true;
    if (callsign !== profile.callsign || sharing !== profile.leaderboard) {
      row.generation++; row.scores = []; delete row.previousScores; row.needsConsent = !!(sharing || profile.leaderboard || row.needsConsent);
      if (row.history?.decision==='queued') row.history.decision='pending';
    }
    Object.assign(profile, { callsign, leaderboard: sharing });
  }
  decidePreviousScores(profile, publish) {
    this.atomic(() => {
      const row=this.row(profile.id);
      if (publish && (!profile.leaderboard || !profile.callsign)) throw Error('Enable score sharing for your callsign first.');
      if (publish) row.scores = row.scores.concat(row.previousScores || []);
      delete row.previousScores;
    });
  }
  result(profile, kind, xp, id = crypto.randomUUID()) {
    if (xp>0) {
      const row=this.row(profile.id);
      row.stream ||= crypto.randomUUID();
      profile.credits ||= {};
      profile.credits[row.stream]=Math.min(1e9,(profile.credits[row.stream] || 0)+xp);
    }
    if (profile.callsign && profile.leaderboard && xp > 0) {
      this.row(profile.id).scores.push({ id, kind, xp, day: new Date().toISOString().slice(0,10) });
    }
    return id;
  }
}
