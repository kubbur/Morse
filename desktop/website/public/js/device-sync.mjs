import { syncProfile, mergeProgress, syncChanged, playbackOnDevice, spacingOnDevice, hasLocalChanges } from './sync-data.mjs';
import { parseProgressJson } from './import-validation.mjs';
import { mergeSendingSessions } from './sessions.mjs';

export const SYNC_KEY = 'morse.devices.v1';
const uuid = () => crypto.randomUUID();

function rememberReceipt(meta, submitted, received) {
  const { wpm, farnsworth } = submitted.settings;
  const preference = { wpm, farnsworth };
  if (spacingOnDevice(received, preference) !== received) meta.spacingPreference = preference;
  else delete meta.spacingPreference;
  meta.legacySendingSessions = !!submitted.sending.sessionHistory && !received.sending?.sessionHistory;
}
export class DeviceSync {
  constructor({ storage, getProfile, applyProfile, ready, backup, onStatus, onErased = () => {}, fetcher = globalThis.fetch.bind(globalThis), locks = navigator.locks }) {
    Object.assign(this, { storage, getProfile, applyProfile, ready, backup, onStatus, onErased, fetcher, locks });
    this.status = { connected: false, message: 'Saved on this device' };
    this.timer = null;
    this.dueAt = 0;
    this.running = false;
    this.disposed = false;
  }
  meta() {
    try {
      const raw = this.storage.getItem(SYNC_KEY);
      if (!raw) return null;
      const value = parseProgressJson(raw, { maxBytes: 4_000_000, maxNodes: 1_500_000 });
      return value?.version === 1 && typeof value.epoch === 'string' && Number.isSafeInteger(value.seq) && value.base ? value : null;
    } catch { return null; }
  }
  save(value) {
    try { if (value) this.storage.setItem(SYNC_KEY, JSON.stringify(value)); else this.storage.removeItem(SYNC_KEY); }
    catch { throw new Error('Private sync paused because the save could not be written. Use Export progress to keep a copy.'); }
  }
  report(changes) { Object.assign(this.status, changes); this.onStatus(this.status); }
  async request(action, body = {}) {
    const response = await this.fetcher(`/api/sync/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Morse-Sync': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 250);
      const error = new Error(message || 'Sync will retry when you reconnect.'); error.status = response.status; throw error;
    }
    return response.json();
  }
  async exclusive(action) {
    if (!this.locks) throw new Error('Device pairing needs an updated browser with secure storage support.');
    return this.locks.request('morse-device-sync', action);
  }
  schedule(delay = 700) {
    const dueAt = Date.now() + delay;
    // Continuous fast typing must not postpone every upload indefinitely.
    if (this.timer !== null && this.dueAt <= dueAt) return;
    clearTimeout(this.timer);
    if (!this.disposed) {
      this.dueAt = dueAt;
      this.timer = setTimeout(() => { this.timer = null; this.dueAt = 0; this.tick(); }, delay);
    }
  }
  changed() {
    // The learning save runs on every key. Parse the bounded sync journal only
    // in the background tick, rather than walking a large history per keystroke.
    try { if (this.storage.getItem(SYNC_KEY)) this.schedule(); } catch { /* The primary save reports unavailable storage. */ }
  }
  replace(reason = 'reset') {
    const meta = this.meta();
    if (!meta) return;
    // Coalesce local resets that have not yet been sent. An in-flight request
    // already has its own immutable sequence and snapshot.
    if (meta.replacement && meta.replacement !== meta.pending?.replacement && reason !== 'import') {
      const previous = meta.replacementReason;
      if (previous === 'import' || previous === 'reset') reason = previous;
      else if (previous && previous !== reason) reason = 'reset';
    }
    meta.replacement = uuid();
    meta.replacementReason = reason;
    meta.force = false;
    meta.remote = null;
    this.save(meta);
    this.schedule(0);
  }
  receive(result, meta) {
    if (result.erased) { this.save(null); this.onErased(); this.report({ connected: false, devices: [], invite: null, waiting: null, message: 'Your data was deleted', error: false }); return null; }
    if (meta && result.epoch === meta.epoch && result.revision < meta.revision) return meta;
    if (!result.connected) {
      this.save(null);
      this.report({ invite: null, waiting: null, ...result, profile: undefined, message: meta ? 'Disconnected · progress is saved here' : 'Saved on this device', error: false });
      return null;
    }
    if (!meta) {
      // A remembered HttpOnly cookie can outlive a removed local-storage item.
      // Treat this as reconnection, not a brand-new additive upload.
      this.backup();
      meta = { version: 1, epoch: result.epoch, seq: result.seq, base: result.profile, revision: result.revision, force: true, remote: result.profile };
    } else if (result.epoch !== meta.epoch || result.conflict) {
      this.backup();
      meta = { version: 1, epoch: result.epoch, seq: result.seq, base: result.profile, revision: result.revision, force: true, remote: result.profile };
    } else if (result.profile) {
      if (meta.force || meta.remote || syncChanged(meta.base, result.profile)) meta.remote = result.profile;
      meta.revision = result.revision;
    }
    this.save(meta);
    this.report({ invite: null, waiting: null, ...result, profile: undefined, message: 'Synced', error: false }, meta);
    return meta;
  }
  apply(meta) {
    if (!meta?.remote || meta.pending || meta.replacement || !this.ready()) return meta;
    const replace = meta.force;
    const local = syncProfile(this.getProfile());
    const remote = playbackOnDevice(meta.remote, local.sending.settings);
    const preferred = spacingOnDevice(remote, meta.spacingPreference);
    const base = spacingOnDevice(meta.base, meta.spacingPreference);
    let merged = replace ? preferred : mergeProgress(base, local, preferred);
    if (replace && !preferred.sending.sessionHistory && local.sending.sessionHistory &&
        preferred.sending.results?.some(r => local.sending.sessionHistory.recorded[r.id])) {
      const history = mergeSendingSessions(local.sending.sessionHistory, null, preferred.sending.results);
      merged = { ...preferred, sending: { ...preferred.sending, sessionHistory: history } };
      meta.legacySendingSessions = true;
    }
    if (preferred === remote) delete meta.spacingPreference;
    if (remote !== meta.remote) {
      // A push may have been followed by another edit while in flight. Remember
      // the attempted values, so the newer edit still gets its own request.
      const { continueMode, pauseSeconds } = replace ? local.sending.settings : playbackOnDevice(meta.base, meta.localPlayback).sending.settings;
      meta.localPlayback = { continueMode, pauseSeconds };
    } else delete meta.localPlayback;
    // Save the baseline before applying. The app's normal persistence may queue
    // another tick, but can never upload the downloaded counters as fresh work.
    meta.base = meta.remote;
    meta.remote = null;
    meta.force = false;
    this.save(meta);
    if (replace || syncChanged(local, merged)) this.applyProfile(merged, { replace });
    return meta;
  }
  async flush() {
    return this.exclusive(async () => {
      let meta = this.meta();
      if (!meta) return;
      if (meta.force) { this.apply(meta); return; }
      const local = syncProfile(this.getProfile());
      if (!meta.pending && (meta.replacement || hasLocalChanges(meta, local))) {
        meta.pending = { seq: meta.seq + 1, epoch: meta.epoch, base: meta.base, profile: local, replace: !!meta.replacement, reason: meta.replacementReason || 'import', replacement: meta.replacement || null };
        this.save(meta); // persist the exact request before any network operation
      }
      if (!meta.pending) {
        const result = await this.request('status');
        this.apply(this.receive(result, meta));
        return;
      }
      const pending = meta.pending;
      this.report({ message: 'Syncing…', error: false });
      const result = await this.request('push', pending);
      if (result.erased) { this.receive(result, meta); return; }
      // A reset/import may happen while this request is in flight.
      meta = this.meta() || meta;
      if (!result.conflict && (result.epoch === meta.epoch || pending.replace || result.rebased)) {
        meta.seq = result.seq;
        meta.epoch = result.epoch;
        meta.revision = result.revision;
        meta.base = pending.profile;
        meta.remote = result.profile;
        rememberReceipt(meta, pending.profile, result.profile);
        meta.pending = null;
        if (pending.replacement === meta.replacement) meta.replacement = null;
        this.save(meta);
        this.report({ invite: null, waiting: null, ...result, profile: undefined, message: 'Synced', error: false }, meta);
        this.apply(meta);
      } else this.apply(this.receive(result, meta));
    });
  }
  async tick() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      if (!this.meta()) {
        // The first poll shares the tab lock too: a delayed startup response
        // cannot replace another tab's newer pairing/reset baseline.
        await this.exclusive(async () => {
          if (this.meta()) return;
          const result = await this.request('status');
          if (result.connected) this.apply(this.receive(result, null));
          else if (result.erased) this.receive(result, null);
          else this.report({ connected: false, message: 'Saved on this device', error: false });
        });
      } else await this.flush();
    } catch (error) {
      if (error.status === 401) { this.save(null); this.report({ connected: false, message: 'Disconnected · progress is saved here', error: false }); }
      else this.report({ error: true, message: navigator.onLine === false ? 'Offline · saved here, syncs when you reconnect' : error.message || 'Saved here · waiting to sync' });
    } finally {
      this.running = false;
      if (this.meta() && !this.disposed) this.schedule(document.hidden ? 30000 : 5000);
    }
  }
  async start(label, { invite = true } = {}) {
    await this.flush();
    return this.exclusive(async () => {
      this.backup();
      const before=syncProfile(this.getProfile());
      const result = await this.request('start', { profile: before, label, invite });
      let meta = this.meta();
      if (!meta) {
        meta = { version: 1, base: before, epoch: result.epoch, seq: result.seq, revision: result.revision };
        rememberReceipt(meta, before, result.profile);
      }
      this.receive(result, meta);
      this.schedule(500);
      return result;
    });
  }
  async join(invitation, label) {
    return this.exclusive(async () => {
      this.backup();
      const local = syncProfile(this.getProfile());
      const result = await this.request('join', { invitation, profile: local, label });
      this.save({ version: 1, base: local, epoch: result.epoch, seq: result.seq, revision: result.revision });
      this.report({ ...result, profile: undefined, message: 'Waiting for approval', error: false });
      this.schedule(500);
      return result;
    });
  }
  async approve(claim) {
    await this.flush();
    return this.exclusive(async () => {
      const result = await this.request('approve', { claim });
      this.apply(this.receive(result, this.meta()));
      this.schedule(500);
      return result;
    });
  }
  async cancel() {
    return this.exclusive(async () => {
      const result = await this.request('cancel');
      this.report({ invite: null, waiting: null });
      this.receive(result, this.meta());
    });
  }
  async identity(callsign, listed, label) {
    await this.flush();
    return this.exclusive(async () => {
      const result = await this.request('identity', { callsign, listed, label, profile: syncProfile(this.getProfile()) });
      this.apply(this.receive(result, this.meta()));
      this.schedule(500);
      return result;
    });
  }
  async erase() {
    return this.exclusive(async () => {
      // Do not discard the only local copy until shared erasure succeeds.
      const result = await this.request('erase');
      this.receive(result, this.meta());
    });
  }
  async disconnect(device) {
    await this.flush();
    return this.exclusive(async () => {
      const result = await this.request('disconnect', { device });
      this.receive(result, this.meta());
      this.report({ invite: null, waiting: null });
    });
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
