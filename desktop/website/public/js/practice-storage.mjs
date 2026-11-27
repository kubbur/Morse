import { STORAGE_KEY, sanitizeState } from './progress.mjs';
import { syncProfile } from './sync-data.mjs';
import { SYNC_KEY } from './device-sync.mjs';
import { qslCount, QSL_XP } from './shack-model.mjs';

const clone = value => structuredClone(value);
const newRow = () => ({ generation: 0, scores: [], private: null });
export function removeLearnerFromBackup(raw, id) {
  let backup;
  try { backup = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(backup?.profiles)) return null;
  if (!backup.profiles.some(p => p?.id === id) && !backup.delivery?.learners?.[id]) return raw;
  backup.profiles = backup.profiles.filter(p => p?.id !== id);
  if (!backup.profiles.length) return null;
  if (backup.activeId === id) backup.activeId = backup.profiles[0].id;
  if (backup.delivery?.learners) delete backup.delivery.learners[id];
  return JSON.stringify(backup);
}
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
      practiceScore: profile => store.practiceScore(profile),
      scoreTotal: profile => store.scoreTotal(profile),
      getItem: key => key === SYNC_KEY ? store.row(id).private : store.getItem(key),
      setItem(key, value) {
        if (key !== SYNC_KEY) return store.setItem(key, value);
        store.atomic(() => { store.row(id).private = value; });
      },
      removeItem(key) {
        if (key !== SYNC_KEY) return store.removeItem(key);
        store.atomic(() => {
          const row = store.row(id);
          if (row.private) row.hadPrivateBackup = true;
          row.private = null;
        });
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
  eraseLearner(id, next) {
    const otherLearners = JSON.parse(this.raw).profiles.some(p => p.id !== id);
    if (!this.mac && this.storage.getItem(STORAGE_KEY) !== this.committed)
      throw Error('Another tab updated progress. Reload and try again.');
    const delivery = clone(this.delivery);
    delete delivery.learners[id];
    const raw = JSON.stringify({...next,delivery});
    if (this.mac) {
      const saved = this.mac.eraseLearner(id,raw,this.revision);
      if (saved.error) throw Error(saved.error);
      this.revision = saved.revision;
    }
    const keys = Array.from({length:this.storage.length}, (_, i) => this.storage.key(i));
    for (const key of keys) {
      if (!key?.startsWith('morse.') || key === STORAGE_KEY) continue;
      if (otherLearners && key.startsWith(STORAGE_KEY+'.')) {
        const kept = removeLearnerFromBackup(this.storage.getItem(key), id);
        if (kept) { this.storage.setItem(key, kept); continue; }
      } else if (otherLearners && (id !== this.owner || !key.startsWith('morse.origin-') && key !== SYNC_KEY)) continue;
      this.storage.removeItem(key);
    }
    if (this.mac) {
      const local = this.storage.getItem(STORAGE_KEY);
      if (local) {
        const kept = otherLearners && removeLearnerFromBackup(local,id);
        if (kept) this.storage.setItem(STORAGE_KEY,kept); else this.storage.removeItem(STORAGE_KEY);
      }
    } else this.storage.setItem(STORAGE_KEY,raw);
    this.external(raw);
    this.beforeSound = null;
    this.failed = false;
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
  chooseListing(profile, callsign, visible) {
    const row = this.row(profile.id), old = profile.callsign, wasSharing = profile.leaderboard;
    const previousGen = row.generation, priorTotal = this.practiceScore(profile), wasLegacy = !row.listings;
    this.consent(profile, callsign, visible);
    if (!callsign && !old) return;
    row.stream ||= crypto.randomUUID();
    row.listings ||= {};
    row.visibilityQueue ||= [];
    if (row.generation === previousGen) row.generation++;
    const queue = (call, show) => {
      if (!call) return;
      row.visibilityQueue = row.visibilityQueue.filter(intent => intent.call !== call);
      const snapshot = scoreSnapshot(profile,row);
      if (call === old) snapshot.xp = Math.max(snapshot.xp,priorTotal);
      row.visibilityQueue.push({ call, visible:show, generation:row.generation, revision:row.listings[call]?.revision ?? null, snapshot, legacyFence:!show && wasLegacy && wasSharing });
    };
    if (old && old !== callsign && (wasSharing || row.listings[old]?.visible)) queue(old,false);
    if (visible || callsign && (old === callsign && wasSharing || row.listings[callsign])) queue(callsign, visible);
    row.needsConsent = false;
    row.scores = [];
    delete row.previousScores;
    delete row.listingError;
    if (row.history?.decision === 'queued') row.history.decision = 'pending';
  }
  scoreTotal(profile) {
    return Math.min(1e9,this.practiceScore(profile) + this.qslCards(profile) * QSL_XP);
  }
  qslCards(profile) {
    const listing = this.row(profile.id).listings?.[profile.callsign];
    return Math.max(qslCount(profile.shack),listing?.qslCards || 0);
  }
  practiceScore(profile) {
    const row = this.row(profile.id), listing = row.listings?.[profile.callsign];
    if (!listing) return profile.stats.xp;
    if (listing.absoluteOnly) return Math.max(profile.stats.xp,listing.xp || 0);
    const movement = Object.entries(listing.covered || listing.local?.marks || {}).reduce((sum,[key,n]) =>
      sum + Math.max(0,(profile.credits?.[key] || 0) - n),0);
    // A restored or imported credit counter can move forward without this
    // installation playing anything. Only actual new practice advances a
    // higher public baseline. A larger restored lifetime total still wins.
    const earned = Math.max(0,(row.earned || 0) - (listing.local?.earned || 0));
    return Math.min(1e9,Math.max(profile.stats.xp,listing.xp || 0,(listing.ackXP || 0) + Math.min(movement,earned)));
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
      row.earned = Math.min(1e9,(row.earned || 0) + xp);
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

export function scoreSnapshot(profile, row) {
  // Keep the request below the score endpoint's 16 KiB limit even after
  // repeated imports from many installations. The total always covers all XP.
  const entries = Object.entries(profile.credits || {});
  const earned = row.earned || 0;
  if (entries.length > 100) return { xp:profile.stats.xp, marks:{}, earned, absoluteOnly:true };
  const marks = Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));
  if (row.stream) marks[row.stream] = profile.credits?.[row.stream] || 0;
  return { xp:profile.stats.xp, marks, earned };
}

export async function publicReceiptKey(namespace, call, id) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(namespace + '/' + call + '/' + id));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2,'0')).join('');
}
export async function publicSnapshot(call, snapshot, keys = {}, row) {
  const marks = {};
  for (const [id, amount] of Object.entries(snapshot.marks)) {
    // Only the public counters for this callsign leave the score path.
    const key = await publicReceiptKey('morse-score',call,id);
    marks[key] = amount; keys[id] = key;
  }
  const anchor = row?.listings?.[call]?.sentEarned, stream = keys[row?.stream];
  const xp = Number.isSafeInteger(anchor) ? Math.max(0,snapshot.earned-anchor) : 0;
  const activity = stream && xp ? { stream, xp:Math.min(xp,marks[stream]) } : null;
  return { xp:snapshot.xp, marks, ...(activity?.xp ? {activity} : {}), ...(snapshot.absoluteOnly ? {absoluteOnly:true} : {}) };
}
