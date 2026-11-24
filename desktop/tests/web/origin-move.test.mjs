import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, STORAGE_KEY } from '../../website/public/js/progress.mjs';
import { SYNC_KEY } from '../../website/public/js/device-sync.mjs';
import { BACKUP_KEY, RECEIPT_KEY, JOURNAL_KEY,
  validMessage, readProgress, fingerprint, commitMove, recoverJournal, applyShared } from '../../website/public/js/origin-move.mjs';
import { syncProfile } from '../../website/public/js/sync-data.mjs';

const OLD_ORIGIN = 'https://previous.example';
const NEW_ORIGIN = 'https://trainer.example';
const nonce = '44000abc-0000-4000-8000-000000000001';
class Storage {
  constructor(values = {}) { this.values = new Map(Object.entries(values));this.fail = null; }
  getItem(k) { return this.values.get(k) ?? null; }
  setItem(k, v) { if (this.fail === k) { this.fail = null;throw new Error('quota'); }this.values.set(k, String(v)); }
  removeItem(k) { this.values.delete(k); }
}
function state(xp) {
  const s = newState();s.profiles[0].stats.xp = xp;s.profiles[0].sending.level = 14;
  return JSON.stringify(s);
}
test('progress handoff authenticates the exact window, origin, nonce, version and message type', () => {
  const peer = {}, e = { source: peer, origin: OLD_ORIGIN, data: { version: 1, nonce, type: 'progress' } };
  assert.equal(validMessage(e, peer, OLD_ORIGIN, nonce, 'progress'), true);
  for (const bad of [{ ...e, source: {} }, { ...e, origin: NEW_ORIGIN }, { ...e, data: { ...e.data, nonce: nonce.replace('abc', 'def') } },
    { ...e, data: { ...e.data, version: 2 } }, { ...e, data: null }]) assert.equal(validMessage(bad, peer, OLD_ORIGIN, nonce, 'progress'), false);
  assert.equal(validMessage(e, peer, OLD_ORIGIN, '*', 'progress'), false);
});
test('copies all learners, sending progress and settings with a verified destination backup', async () => {
  const original = state(5), incoming = JSON.parse(state(400));
  incoming.profiles.push(JSON.parse(state(71)).profiles[0]);incoming.theme = 'light';
  const raw = JSON.stringify(incoming), store = new Storage({ [STORAGE_KEY]: original });
  commitMove(store, { raw, digest: await fingerprint(raw), expectedRaw: original, sync: { connected: false }, nonce });
  assert.equal(readProgress(store.getItem(STORAGE_KEY)).profiles[0].stats.xp, 400);
  assert.equal(readProgress(store.getItem(STORAGE_KEY)).profiles.length, 2);
  assert.equal(readProgress(store.getItem(STORAGE_KEY)).profiles[0].sending.level, 14);
  assert.equal(JSON.parse(store.getItem(BACKUP_KEY)).values[STORAGE_KEY], original);
  assert.equal(store.getItem(SYNC_KEY), null);assert.equal(store.getItem(JOURNAL_KEY), null);
});
test('paired destination receives its own sequence and import epoch journal, never a foreign journal', async () => {
  const raw = state(99), store = new Storage({ [STORAGE_KEY]: state(10) });
  const sync = { connected: true, epoch: 'current-epoch', revision: 12, seq: 8, profile: syncProfile(JSON.parse(state(10)).profiles[0]) };
  commitMove(store, { raw, digest: await fingerprint(raw), expectedRaw: store.getItem(STORAGE_KEY), sync, nonce });
  const meta = JSON.parse(store.getItem(SYNC_KEY));
  assert.equal(meta.epoch, sync.epoch);assert.equal(meta.seq, 8);assert.equal(meta.replacement, nonce);assert.equal(meta.force, false);
});
test('freshly linked device uses an aligned baseline without re-importing paired scores', async () => {
  const raw = state(99), store = new Storage();
  const sync = { connected: true, epoch: 'paired', revision: 2, seq: 0, profile: syncProfile(JSON.parse(raw).profiles[0]) };
  commitMove(store, { raw, digest: await fingerprint(raw), expectedRaw: null, sync, aligned: true, nonce });
  assert.equal(JSON.parse(store.getItem(SYNC_KEY)).replacement, undefined);
});
test('keeping current progress preserves the original save and sync journal', async () => {
  const original = state(900), meta = '{"version":1}', raw = state(12);
  const store = new Storage({ [STORAGE_KEY]: original, [SYNC_KEY]: meta });
  commitMove(store, { raw, digest: await fingerprint(raw), expectedRaw: original, decision: 'kept-current', nonce });
  assert.equal(store.getItem(STORAGE_KEY), original);assert.equal(store.getItem(SYNC_KEY), meta);
});
test('quota failure rolls back all modified keys and keeps the backup and original progress', async () => {
  const original = state(23), raw = state(100), store = new Storage({ [STORAGE_KEY]: original, [SYNC_KEY]: '{"version":1}' });
  store.fail = 'morse.callsign-intro.v1';
  assert.throws(() => commitMove(store, { raw, digest: 'a'.repeat(64), expectedRaw: original, sync: { connected: false }, nonce }), /quota/);
  assert.equal(store.getItem(STORAGE_KEY), original);assert.equal(store.getItem(SYNC_KEY), '{"version":1}');
  assert.equal(store.getItem(JOURNAL_KEY), null);assert.equal(JSON.parse(store.getItem(BACKUP_KEY)).values[STORAGE_KEY], original);
});
test('concurrent-tab and malformed-input failures do not replace progress', () => {
  const original = state(37), store = new Storage({ [STORAGE_KEY]: original });
  assert.throws(() => commitMove(store, { raw: state(60), digest: 'a'.repeat(64), expectedRaw: null, nonce }), /Another Morse tab/);
  assert.throws(() => commitMove(store, { raw: '{"__proto__":{}}', digest: 'a'.repeat(64), expectedRaw: original, nonce }));
  assert.equal(store.getItem(STORAGE_KEY), original);assert.equal(store.getItem(BACKUP_KEY), null);
});
test('interrupted multi-key commit recovers only its own writes and rejects later work', () => {
  const before = { [STORAGE_KEY]: state(1), [SYNC_KEY]: null, 'morse.callsign-intro.v1': null, [RECEIPT_KEY]: null };
  const after = { ...before, [STORAGE_KEY]: state(2), [SYNC_KEY]: '{"version":1}' };
  const store = new Storage({ ...before, [STORAGE_KEY]: after[STORAGE_KEY], [JOURNAL_KEY]: JSON.stringify({ version: 1, before, after }) });
  recoverJournal(store);assert.equal(store.getItem(STORAGE_KEY), before[STORAGE_KEY]);
  store.setItem(JOURNAL_KEY, JSON.stringify({ version: 1, before, after }));store.setItem(STORAGE_KEY, state(50));
  assert.throws(() => recoverJournal(store), /Another Morse tab/);
});
test('shared handoff keeps every learner and per-device settings while applying the paired account', () => {
  const original = JSON.parse(state(15));original.profiles[0].settings.volume = 31;
  original.profiles.push(JSON.parse(state(65)).profiles[0]);
  const remote = syncProfile(JSON.parse(state(200)).profiles[0]);
  const result = applyShared(original, remote);
  assert.equal(result.profiles[0].stats.xp, 200);assert.equal(result.profiles[0].settings.volume, 31);
  assert.equal(result.profiles[1].stats.xp, 65);
});
