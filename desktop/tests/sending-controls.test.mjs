import test from 'node:test';
import assert from 'node:assert/strict';
import { keyLabel, loadKeyboardPaddles, paddleCharacter, saveKeyboardPaddles } from '../website/public/js/keyboard-paddles.mjs';
import { SendingUI } from '../website/public/js/send-ui.mjs';
import { importState, newState } from '../website/public/js/progress.mjs';
import { sanitizeSendingSettings } from '../website/public/js/sending.mjs';
import { mergeProgress, syncProfile } from '../website/public/js/sync-data.mjs';

test('the sending pause and mode migrate, export and merge as independent learning preferences', () => {
  const state = newState(), profile = state.profiles[0], base = syncProfile(profile);
  delete profile.sending.settings.continueMode;
  delete profile.sending.settings.pauseSeconds;
  const old = importState(JSON.stringify(state)).profiles[0].sending.settings;
  assert.equal(old.continueMode, 'timed'); assert.equal(old.pauseSeconds, 2);
  for (const [value, expected] of [[-2, 0.5], [0.5, 0.5], [3.76, 3.8], [100, 15], [NaN, 2], ['5', 2]]) {
    assert.equal(sanitizeSendingSettings({ pauseSeconds: value }).pauseSeconds, expected);
  }
  assert.equal(sanitizeSendingSettings({ continueMode: 'other' }).continueMode, 'timed');
  profile.sending.settings.pauseSeconds = 4.5;
  const remote = structuredClone(base); remote.sending.settings.continueMode = 'manual';
  const merged = mergeProgress(base, profile, remote);
  assert.equal(merged.sending.settings.continueMode, 'manual');
  assert.equal(merged.sending.settings.pauseSeconds, 4.5);
  state.profiles[0] = merged;
  const restored = importState(JSON.stringify(state));
  assert.deepEqual(restored.profiles[0].sending.settings, merged.sending.settings);
});

test('paddle characters follow the keyboard layout and the button choice stays on the device', t => {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  assert.deepEqual(loadKeyboardPaddles(), { dit: 'z', dah: 'x', showButtons: true });
  for (const [input, expected] of [['Ö', 'ö'], ['o\u0308', 'ö'], ['?', '?'], ['7', '7'], [' ', ' '], ['Control', ''], ['Dead', ''], ['\n', '']]) {
    assert.equal(paddleCharacter(input), expected);
  }
  assert.equal(keyLabel('ö'), 'Ö'); assert.equal(keyLabel(' '), 'Space');
  const chosen = { dit: 'ö', dah: '?', showButtons: false };
  saveKeyboardPaddles(chosen);
  assert.deepEqual(loadKeyboardPaddles(), chosen);
  assert.doesNotMatch(JSON.stringify(syncProfile(newState().profiles[0])), /showButtons|keyboard-paddles/);
  saveKeyboardPaddles({ dit: 'a', dah: 'A', showButtons: false });
  assert.deepEqual(loadKeyboardPaddles(), { dit: 'z', dah: 'x', showButtons: false });
});

test('timed playback measures from the last key-up and never cuts through a Farnsworth word gap', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = newState(), profile = state.profiles[0];
  Object.assign(profile.settings, { wpm: 30, farnsworth: 30 });
  Object.assign(profile.sending.settings, { pauseSeconds: 3 });
  const document = { classList: { toggle() {} }, removeAttribute() {}, dataset: {} };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => document } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const ui = Object.assign(Object.create(SendingUI.prototype), { getProfile: () => profile, source: 'straight',
    item: { target: 'E E' }, edges: [], down: false, ready: () => true, paintTrace() {}, paintCapture() {}, showReleasedMatch() {} });
  let completions = 0;
  ui.finish = () => { completions++; };
  ui.edge({ down: true, at: 0 }); ui.edge({ down: false, at: 40 });
  t.mock.timers.tick(2700); ui.edge({ down: true, at: 2740 });
  t.mock.timers.tick(400); assert.equal(completions, 0);
  ui.edge({ down: false, at: 3140 });
  t.mock.timers.tick(2999); assert.equal(completions, 0);
  t.mock.timers.tick(1); assert.equal(completions, 1);
  profile.sending.settings.pauseSeconds = 0.5; profile.settings.farnsworth = 3;
  assert.ok(ui.idleDelay() > 3000);
  profile.sending.settings.continueMode = 'manual'; profile.sending.settings.pauseSeconds = 15;
  assert.equal(ui.idleDelay(), ui.inputPause());
  profile.settings.wpm = 25; profile.settings.farnsworth = 5;
  profile.sending.settings.continueMode = 'timed'; profile.sending.settings.pauseSeconds = 0.8;
  assert.ok(ui.idleDelay() > 3000, 'Allow the full gap while a spaced word is outstanding');
  ui.item.target = 'P';
  assert.equal(ui.idleDelay(), 800, 'A single letter never needs a Farnsworth word gap');
  ui.item.target = 'E E'; ui.patternComplete = true;
  assert.equal(ui.idleDelay(), 800, 'The selected pause applies after the complete answer');
});
