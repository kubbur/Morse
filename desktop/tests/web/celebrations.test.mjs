import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSalute, saluteForId, SALUTES } from '../../website/public/js/celebrations.mjs';
import { alphabetFor, COURSE_LEVELS, courseStage, EAR_COURSE_END } from '../../website/public/js/lessons.mjs';
import { DEFAULT_SETTINGS, sanitizeSettings, newState, startRound, importState } from '../../website/public/js/progress.mjs';

test('level salutes rotate within the learned alphabet through all 400 course levels', () => {
  let previous = '';
  const heard = new Set();
  for (let courseLevel = 1; courseLevel <= COURSE_LEVELS; courseLevel++) {
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, courseLevel });
    const salute = chooseSalute(settings, previous);
    assert.ok([...salute.text].every(c => c === ' ' || alphabetFor(settings).includes(c)));
    const choices = SALUTES.filter(s => !s.finale && [...s.text].every(c => c === ' ' || alphabetFor(settings).includes(c)));
    if (choices.length > 1) assert.notEqual(salute.id, previous);
    if (courseStage(courseLevel).legacyLevel !== 100 && courseLevel !== EAR_COURSE_END && courseLevel < COURSE_LEVELS) assert.notEqual(salute.id, 'congrats');
    heard.add(salute.id);
    previous = salute.id;
  }
  assert.equal(previous, 'congrats');
  assert.ok(heard.has('tu') && heard.has('fb') && heard.has('ufb'));
  assert.equal(chooseSalute(DEFAULT_SETTINGS).text, 'NEAT');
  assert.equal(chooseSalute({ ...DEFAULT_SETTINGS, courseLevel: 2 }, 'neat').text, 'E E');
});

test('numbers use real radio wishes and custom sets use only their own sounds', () => {
  const numbers = sanitizeSettings({ lesson: 'numbers' });
  let previous = '';
  const heard = new Set();
  for (let level = 1; level <= 10; level++) {
    const salute = chooseSalute({ ...numbers, level }, previous);
    assert.match(salute.text, /^[0-9 ]+$/);
    heard.add(salute.text);
    previous = salute.id;
  }
  assert.deepEqual([...heard].sort(), ['55', '73', '77']);
  const custom = sanitizeSettings({ lesson: 'custom', custom: 'KM' });
  assert.match(chooseSalute(custom).text, /^[KM ]+$/);
  assert.equal(chooseSalute(custom).meaning, 'Practice signal');
  assert.notEqual(saluteForId('fb', DEFAULT_SETTINGS).text, 'FB', 'saved IDs cannot introduce unlearned letters');
  assert.ok(SALUTES.every(salute => salute.text && salute.meaning));
});

test('salute history stays with each learner and imports discard unknown message IDs', () => {
  const state = newState();
  const p = state.profiles[0];
  p.stats.lastSalute = 'tu';
  startRound(p, 'E');
  p.round.saluteId = 'neat';
  let restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.stats.lastSalute, 'tu');
  assert.equal(restored.round.saluteId, 'neat');
  p.stats.lastSalute = '<img src=x onerror=alert(1)>';
  p.round.saluteId = 'not-a-message';
  restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.stats.lastSalute, '');
  assert.equal(restored.round.saluteId, '');
});
