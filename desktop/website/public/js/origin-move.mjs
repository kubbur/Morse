import { STORAGE_KEY, sanitizeState } from './progress.mjs';
import { parseProgressJson } from './import-validation.mjs';
import { SYNC_KEY } from './device-sync.mjs';
import { syncProfile } from './sync-data.mjs';

export const MOVED_KEY = 'morse.origin-moved.v1';
export const RECEIPT_KEY = 'morse.origin-move-receipts.v1';
export const BACKUP_KEY = `${STORAGE_KEY}.before-origin-move`;
export const JOURNAL_KEY = 'morse.origin-move-journal.v1';
export const INTRO_KEY = 'morse.callsign-intro.v1';
const LIMITS = { maxBytes: 10_000_000, maxNodes: 2_500_000 };
const SYNC_LIMITS = { maxBytes: 4_000_000, maxNodes: 1_500_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function validMessage(event, peer, origin, nonce, type) {
  const d = event.data;
  return !!peer && event.source === peer && event.origin === origin && UUID.test(nonce) &&
    d !== null && typeof d === 'object' && !Array.isArray(d) && d.version === 1 && d.nonce === nonce && d.type === type;
}
export function readProgress(raw) {
  const state = sanitizeState(parseProgressJson(raw, LIMITS));
  for (const profile of state.profiles) profile.sessionId = '';
  return state;
}
export async function fingerprint(raw) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function summary(state) {
  const p = state.profiles.find(p => p.id === state.activeId);
  return `Listening level ${p.settings.courseLevel} · Sending level ${p.sending.level} · ${p.stats.xp.toLocaleString()} XP`;
}
export function applyShared(state, shared) {
  const current = state.profiles.find(p => p.id === state.activeId);
  const next = { ...shared, id: current.id, name: current.name,
    settings: { ...shared.settings, volume: current.settings.volume }, pacing: current.pacing, headPacing: current.headPacing,
    round: null, sessionId: '' };
  return readProgress(JSON.stringify({ ...state, profiles: state.profiles.map(p => p.id === current.id ? next : p) }));
}
export function receipts(storage) {
  try {
    const value = parseProgressJson(storage.getItem(RECEIPT_KEY) || '[]', { maxBytes: 10000, maxNodes: 500 });
    return Array.isArray(value) ? value.filter(v => v && HASH.test(v.fingerprint) && ['copied', 'kept-current'].includes(v.decision)).slice(-10) : [];
  } catch { return []; }
}
function set(storage, key, value) {
  if (value === null) storage.removeItem(key); else storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('Browser storage could not verify the save. Your original progress is still at the old address.');
}
const stateKeys = [STORAGE_KEY, SYNC_KEY, INTRO_KEY, RECEIPT_KEY];
function snapshot(storage) { return Object.fromEntries(stateKeys.map(key => [key, storage.getItem(key)])); }
export function recoverJournal(storage) {
  const raw = storage.getItem(JOURNAL_KEY);
  if (!raw) return;
  const journal = parseProgressJson(raw, { maxBytes: 15_000_000, maxNodes: 4_000_000 });
  if (journal?.version !== 1 || !journal.before || !journal.after) throw new Error('The interrupted move needs recovery. Keep this tab open and download a backup.');
  // Never overwrite work made by a different tab after an interrupted move.
  for (const key of stateKeys) {
    const value = storage.getItem(key);
    if (value !== journal.before[key] && value !== journal.after[key]) throw new Error('Another Morse tab changed this save. Close other Morse tabs, then retry the move.');
  }
  for (const key of stateKeys) set(storage, key, journal.before[key]);
  storage.removeItem(JOURNAL_KEY);
}

// All writes are synchronous under the app's existing device-sync Web Lock.
// A persisted journal rolls back interrupted multi-key saves before retrying.
export function commitMove(storage, { raw, digest, expectedRaw, currentRaw = expectedRaw, sync, aligned = false, decision = 'copied', nonce }) {
  if (!HASH.test(digest) || !UUID.test(nonce)) throw new Error('Invalid move confirmation.');
  recoverJournal(storage);
  if (storage.getItem(STORAGE_KEY) !== expectedRaw) throw new Error('Another Morse tab changed your progress. Close other Morse tabs and retry.');
  const incoming = readProgress(raw);
  const before = snapshot(storage);
  if (before[SYNC_KEY]) parseProgressJson(before[SYNC_KEY], SYNC_LIMITS);
  let saved = decision === 'kept-current' ? currentRaw : JSON.stringify(incoming);
  if (!saved || !['copied', 'kept-current'].includes(decision)) throw new Error('No progress was selected.');
  readProgress(saved);
  const after = { ...before, [STORAGE_KEY]: saved };
  if (decision === 'copied') {
    // A new-origin HttpOnly cookie belongs to its own sync journal. Never copy
    // the old journal or reuse credentials from another origin.
    after[SYNC_KEY] = sync?.connected ? JSON.stringify({ version: 1, epoch: sync.epoch, seq: sync.seq, revision: sync.revision,
      base: syncProfile(sync.profile), remote: null, force: false, pending: null,
      ...(aligned ? {} : { replacement: nonce, replacementReason: 'import' }) }) : null;
    after[INTRO_KEY] = 'done';
  }
  const receipt = { fingerprint: digest, decision, at: new Date().toISOString() };
  after[RECEIPT_KEY] = JSON.stringify([...receipts(storage).filter(r => r.fingerprint !== digest), receipt].slice(-10));
  set(storage, BACKUP_KEY, JSON.stringify({ version: 1, at: receipt.at, origin: globalThis.location?.origin, values: before }));
  set(storage, JOURNAL_KEY, JSON.stringify({ version: 1, before, after }));
  try {
    for (const key of stateKeys) set(storage, key, after[key]);
    readProgress(storage.getItem(STORAGE_KEY));
    storage.removeItem(JOURNAL_KEY);
  } catch (error) {
    try { recoverJournal(storage); } catch { /* Journal and backup remain for recovery. */ }
    throw error;
  }
  return { receipt, state: readProgress(saved) };
}
