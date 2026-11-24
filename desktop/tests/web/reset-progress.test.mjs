import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, newState, newProfile, sanitizeSettings, emptyStats, resetLearnerProgress, loadState, saveState, startRound, finishRound } from '../../website/public/js/progress.mjs';
import { emptyGuidance, acknowledgeGuidance } from '../../website/public/js/guidance.mjs';

function learnedProfile() {
  const learner = newProfile('Sam');
  learner.settings = sanitizeSettings({ ...learner.settings, courseLevel: 8, wpm: 40, farnsworth: 12, tone: 740, volume: 48, rise: 9, fall: 11, curve: 'linear', recallSeconds: 2.4, showMorse: false, goal: 25 });
  startRound(learner, 'E');
  Object.assign(learner.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'E', lastGuess: 'E', draft: 'E', responseTimes: [250] });
  finishRound(learner, { solved: true });
  acknowledgeGuidance(learner);
  return learner;
}

test('resetting a learner returns to the first sound lesson and keeps identity and personal preferences', () => {
  const learner = learnedProfile();
  const before = structuredClone(learner);
  const reset = resetLearnerProgress(learner);
  assert.ok(before.stats.xp > 0);
  assert.deepEqual(learner, before, 'prepare the reset without mutating the live learner');
  assert.equal(reset.id, learner.id);
  assert.equal(reset.name, learner.name);
  assert.deepEqual(reset.stats, { ...before.stats, mastery: {} });
  assert.equal(reset.stats.xp, before.stats.xp);
  assert.deepEqual(reset.guidance, emptyGuidance());
  assert.equal(reset.round, null);
  assert.deepEqual(reset.settings, { ...learner.settings, lesson: 'starter', content: 'groups', level: 1, courseLevel: 1, courseCount: 4 });
});

test('resetting a free-practice learner preserves other learners and the selected identity', () => {
  const state = newState();
  state.theme = 'light';
  state.profiles.push(learnedProfile());
  const learner = state.profiles[1];
  state.activeId = learner.id;
  learner.settings = sanitizeSettings({ ...learner.settings, lesson: 'custom', content: 'callsigns', custom: 'KMRS', kochCount: 7, level: 6 });
  const before = structuredClone(state);
  const reset = { ...state, profiles: state.profiles.map(p => p.id === state.activeId ? resetLearnerProgress(p) : p) };
  assert.deepEqual(state, before);
  assert.deepEqual(reset.profiles[0], before.profiles[0]);
  assert.equal(reset.activeId, before.activeId);
  assert.equal(reset.theme, 'light');
  assert.equal(reset.profiles[1].settings.lesson, 'starter');
  assert.equal(reset.profiles[1].settings.content, 'groups');
  assert.equal(reset.profiles[1].settings.level, 1);
  assert.equal(reset.profiles[1].settings.custom, 'KMRS');
  assert.equal(reset.profiles[1].settings.kochCount, 7);
});

test('a reset must save before replacing live progress; failed saves preserve data and a retry keeps the learner cookie valid', () => {
  const state = newState();
  state.profiles.push(learnedProfile());
  state.activeId = state.profiles[1].id;
  const old = JSON.stringify(state);
  const entries = new Map([[STORAGE_KEY, old], [`${STORAGE_KEY}.backup`, 'backup'], [`${STORAGE_KEY}.recovery`, 'recovery'], ['unrelated.preference', 'keep']]);
  const before = new Map(entries);
  let blocked = true;
  const storage = { getItem: key => entries.get(key) ?? null, setItem(key, value) { if (blocked) throw new Error('blocked'); entries.set(key, value); } };
  const reset = { ...state, profiles: state.profiles.map(p => p.id === state.activeId ? resetLearnerProgress(p) : p) };
  assert.equal(saveState(storage, reset), false);
  assert.deepEqual(entries, before);
  assert.ok(state.profiles[1].stats.xp > 0);
  blocked = false;
  assert.equal(saveState(storage, reset), true);
  const reloaded = loadState(storage, `morse_learner=${state.activeId}`).state;
  assert.equal(reloaded.activeId, state.activeId);
  assert.deepEqual(reloaded.profiles[0], state.profiles[0]);
  assert.deepEqual(reloaded.profiles[1].stats, { ...state.profiles[1].stats, mastery: {} });
  assert.equal(entries.get(`${STORAGE_KEY}.backup`), 'backup');
  assert.equal(entries.get(`${STORAGE_KEY}.recovery`), 'recovery');
  assert.equal(entries.get('unrelated.preference'), 'keep');
});
