import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMPORT_BYTES, parseProgressJson, decodeProgressFile } from '../../website/public/js/import-validation.mjs';
import { STORAGE_KEY, newState, newProfile, importState, loadState, sanitizeSettings, mirrorSendingSpeed, startRound } from '../../website/public/js/progress.mjs';
import { practiceKey } from '../../website/public/js/lessons.mjs';

test('renaming HTML, SVG, script or an archive to JSON never makes it a progress file', () => {
  for (const raw of ['<svg onload="alert(1)"></svg>', '<!doctype html><script>alert(1)</script>', 'globalThis.compromised=true', 'PK\u0003\u0004zip', 'null', '[]', '{}']) {
    assert.throws(() => importState(raw));
  }
  assert.equal(globalThis.compromised, undefined);
});

test('prototype-altering keys are rejected at every depth, including escaped JSON keys', () => {
  for (const raw of [
    '{"__proto__":{"morsePolluted":true}}',
    '{"version":1,"profiles":[{"settings":{"constructor":{"prototype":{"morsePolluted":true}}}}]}',
    '{"version":1,"profiles":[{"stats":{"characters":{"\\u005f\\u005fproto__":{"morsePolluted":true}}}}]}',
    '{"ignored":[{"prototype":{}}]}',
  ]) assert.throws(() => importState(raw), /unsupported/);
  assert.equal({}.morsePolluted, undefined);
  assert.equal(Object.prototype.morsePolluted, undefined);
});

test('JSON has bounded depth and complexity while quoted brackets and escapes remain ordinary data', () => {
  assert.throws(() => parseProgressJson('['.repeat(5000) + '0' + ']'.repeat(5000)), /complex/);
  assert.throws(() => parseProgressJson(JSON.stringify({ ignored: Array(500_000).fill(0) })), /complex/);
  assert.throws(() => parseProgressJson('{"ignored":1e999}'), /unsupported/);
  assert.throws(() => parseProgressJson('{"ignored":-1e999}'), /unsupported/);
  const state = newState();
  state.profiles[0].name = '[{\\\"quoted\"\\}]';
  assert.equal(importState(JSON.stringify(state)).profiles[0].name, state.profiles[0].name);
  for (const malformed of ['{"a":}', '[1,]', '{"a":"unterminated\\"}']) assert.throws(() => parseProgressJson(malformed), /JSON/);
});

test('file limits count actual UTF-8 bytes and malformed UTF-8 is rejected', () => {
  assert.throws(() => parseProgressJson(' '.repeat(MAX_IMPORT_BYTES + 1)), /smaller/);
  const multibyte = JSON.stringify({ ignored: 'é'.repeat(1_000_000) });
  assert.ok(multibyte.length < MAX_IMPORT_BYTES);
  assert.throws(() => parseProgressJson(multibyte), /smaller/);
  assert.throws(() => decodeProgressFile(new Uint8Array([0x7b, 0xc0, 0xaf, 0x7d]).buffer), /UTF-8/);
  assert.throws(() => decodeProgressFile(new ArrayBuffer(MAX_IMPORT_BYTES + 1)), /smaller/);
  const state = newState();
  const bytes = new TextEncoder().encode('\ufeff' + JSON.stringify(state));
  assert.equal(importState(decodeProgressFile(bytes.buffer)).profiles[0].id, state.profiles[0].id);
});

test('unexpected scalar types and embedded mastery JSON cannot coerce objects or escape the state allowlist', () => {
  const state = newState();
  const p = state.profiles[0];
  p.name = { toString: 'not a function' };
  p.id = '<img src=x onerror=alert(1)>';
  p.settings = { content: { toString: [] }, wpm: { valueOf: [] }, custom: [], recallSeconds: [], tone: '999999999999999999999999999999999' };
  p.stats.xp = { valueOf: 'not a function' };
  p.stats.mastery['['.repeat(5000) + '0' + ']'.repeat(5000)] = { mastered: true };
  p.extra = '<script>globalThis.compromised=true</script>';
  const clean = importState(JSON.stringify(state)).profiles[0];
  assert.equal(clean.name, 'Listener 1');
  assert.match(clean.id, /^[a-zA-Z0-9-]{1,80}$/);
  assert.equal(clean.settings.content, 'groups');
  assert.equal(clean.settings.wpm, 30);
  assert.equal(clean.settings.tone, 600);
  assert.equal(clean.settings.custom, 'ETAN');
  assert.equal(clean.stats.xp, 0);
  assert.deepEqual(clean.stats.mastery, {});
  assert.equal(clean.extra, undefined);
  for (const bad of [null, [], 1, 'learner']) assert.throws(() => importState(JSON.stringify({ version: 1, profiles: [bad] })), /invalid learner/);
});

test('validated imports preserve all twelve learners, timing, course state, draft, XP and salute history', () => {
  const state = newState();
  for (let i = 1; i < 12; i++) state.profiles.push(newProfile(`Learner ${i + 1}`));
  state.activeId = state.profiles[11].id;
  const p = state.profiles[11];
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 27, wpm: 40, rise: 11, showMorse: false });
  mirrorSendingSpeed(p);
  startRound(p, 'ETN');
  Object.assign(p.round, { draft: 'ET', heard: true, plays: 1, responseTimes: [230, 180], firstResponseTimes: [230, 180, null] });
  p.stats.xp = 12345;
  p.stats.lastSalute = 'tu';
  p.stats.mastery[practiceKey(p.settings)] = { unit: 'letters', recognition: [100, 200, null], history: [true, true, false], mastered: false, characterRecognition: { E: [100] } };
  assert.deepEqual(importState(JSON.stringify(state)), state);
});

test('existing browser saves larger than the import limit still reload without losing progress', () => {
  const state = newState();
  state.profiles[0].stats.xp = 54321;
  const raw = JSON.stringify({ ...state, legacyPadding: 'x'.repeat(2_100_000) });
  const entries = new Map([[STORAGE_KEY, raw]]);
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  assert.throws(() => importState(raw), /smaller/);
  const restored = loadState(storage);
  assert.equal(restored.warning, '');
  assert.equal(restored.state.profiles[0].stats.xp, 54321);
  assert.equal(entries.has(`${STORAGE_KEY}.recovery`), false);
});
