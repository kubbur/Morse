import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyListening, listeningCheckpoint, checkpointSettings, sanitizeListening, queueListening, beginListening, activeListening, listeningPrompt, validListeningTarget, leaveListening, LISTENING_GOAL, LISTENING_COOLDOWN } from '../../website/public/js/by-ear.mjs';
import { newProfile, newState, sanitizeSettings, startRound, finishRound, importState, resetLearnerProgress, nextPracticeStep, recordTypedMistakes } from '../../website/public/js/progress.mjs';
import { alphabetFor, courseStage, practiceKey, COURSE_LEVELS, expandedCourseLevel, legacyCourseLevel } from '../../website/public/js/lessons.mjs';
import { emptyReview, observeReview, visualHelpPhase } from '../../website/public/js/review.mjs';
import { timeline } from '../../website/public/js/morse.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

function learner(after = 1, options = {}) {
  const p = newProfile(); p.settings = sanitizeSettings({ ...p.settings, courseLevel: after === 196 ? 393 : expandedCourseLevel(after) + 1, ...options });
  assert.equal(queueListening(p, expandedCourseLevel(after)), true); return p;
}
function answer(p, { target = listeningPrompt(p), solved = true, ms = 9000, ...extra } = {}) {
  startRound(p, target, { byEar: true });
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, draft: target, firstGuess: solved ? target : 'X', responseTimes: Array(target.replaceAll(' ', '').length).fill(ms), ...extra });
  return finishRound(p, { solved });
}

test('checkpoints cover applicable alphabet, phrase, digit, number, punctuation and radio milestones', () => {
  const levels = Array.from({ length: COURSE_LEVELS }, (_, i) => i + 1).filter(level => listeningCheckpoint(level) && !listeningCheckpoint(level).maintenance).map(legacyCourseLevel);
  assert.deepEqual(levels.filter(level => level <= 93), [1, ...Array.from({ length: 23 }, (_, i) => (i + 1) * 4), 93]);
  assert.deepEqual(levels.filter(level => level >= 94 && level <= 100), [94, 95, 96, 97, 98, 99, 100]);
  assert.deepEqual(levels.filter(level => level >= 101 && level <= 140), [101, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140]);
  assert.deepEqual(levels.filter(level => level >= 141 && level <= 152), [142, 144, 146, 148, 150, 152]);
  assert.deepEqual(levels.filter(level => level >= 153 && level <= 172), [156, 160, 164, 168, 172]);
  assert.deepEqual(levels.filter(level => level >= 173), [176, 180, 184, 188, 192, 196, 197, 198, 199]);
  for (const value of [0, 400, 401, 193, 392, -1, NaN, Infinity, '4', 4.5]) assert.equal(listeningCheckpoint(value), null);
});

test('every checkpoint produces only previously taught bounded material, including joined signals', () => {
  for (let level = 1; level < 200; level++) {
    const checkpoint = listeningCheckpoint(expandedCourseLevel(level)); if (!checkpoint) continue;
    const p = learner(level), taught = checkpointSettings(p.settings, expandedCourseLevel(level)), allowed = alphabetFor(taught);
    let previous = '';
    for (let i = 0; i < 20; i++) {
      const target = listeningPrompt(p, previous, () => (i * .173) % 1);
      assert.ok(target && target.length <= 20, `${level}: bounded nonempty prompt`);
      assert.equal(validListeningTarget(p, target), true, `${level}: ${target}`);
      assert.ok([...target].every(c => c === ' ' || allowed.includes(c)), `${level}: no future characters`);
      if (checkpoint.kind === 'groups') assert.ok(target.length <= checkpoint.length);
      if (checkpoint.kind === 'prosigns') assert.ok(courseStage(expandedCourseLevel(level)).prosigns.includes(target));
      previous = target;
    }
  }
  assert.equal(validListeningTarget(learner(4), 'K'), false, 'Next level K stays in its own introduction');
  assert.equal(validListeningTarget(learner(100), '5'), false, 'The first digit is introduced after the phrase checkpoint');
});

test('six letters are six singles, three pairs or two triples, with no typing-speed gate', () => {
  for (const [level, count] of [[1, 6], [4, 3], [8, 2]]) {
    const p = learner(level), key = practiceKey(p.settings), pacing = structuredClone(p.pacing);
    const id = p.listening.active.id;
    let result;
    for (let i = 0; i < count; i++) {
      result = answer(p);
      assert.equal(result.byEarComplete, i === count - 1);
      assert.equal(result.quick, false);
    }
    assert.equal(p.listening.records[id].letters, LISTENING_GOAL);
    assert.equal(p.stats.mastery[key], undefined, 'Checkpoint guesses never replace normal course evidence');
    assert.deepEqual(p.pacing, pacing, 'Short checkpoints never tighten normal response timing');
    assert.equal(nextPracticeStep(p), null);
    assert.equal(p.stats.xp, 20 * count);
    assert.equal(finishRound(p, { solved: true }), null, 'Completion cannot count twice');
    leaveListening(p); assert.equal(p.settings.courseLevel, level + 1);
    assert.equal(p.listening.records[id].letters, 6);
  }
});

test('only accurate first-listen letters count; help and replays cannot inflate listening or course mastery', () => {
  const p = learner(4), key = practiceKey(p.settings);
  p.stats.mastery[key] = { unit: 'letters', history: [true], recognition: [100], mastered: false };
  const before = structuredClone(p.stats.mastery);
  for (const extra of [{ assisted: true }, { visualUsed: true }, { plays: 2 }, { mistakes: [{ expected: 'E', actual: 'T' }] }]) {
    answer(p, { target: 'ET', ...extra });
    assert.equal(activeListening(p).letters, extra.mistakes ? 1 : 0);
  }
  assert.deepEqual(p.stats.mastery, before);
  assert.equal(p.review.sounds.E.earAccuracy || 0, 0, 'Assisted/corrected first letters create no independent-listening evidence');
});

test('partial groups keep each correct letter while a final clean answer completes the checkpoint', () => {
  const p = learner(8);
  answer(p, { target: 'ETA' });
  answer(p, { target: 'NET', solved: false, firstGuess: 'NEA' });
  assert.equal(activeListening(p).letters, 5);
  answer(p, { target: 'ANE', solved: false, firstGuess: 'ANX' });
  assert.equal(activeListening(p).letters, 6); assert.equal(p.round.byEarComplete, false);
  assert.equal(p.round.byEarDeferred, true);
  leaveListening(p); p.listening.cooldown = 0; assert.equal(beginListening(p), true);
  assert.equal(listeningPrompt(p).length, 1);
  assert.equal(answer(p).byEarComplete, true);
  const signal = learner(176);
  answer(signal, { target: 'BT', solved: false, firstGuess: 'BE' });
  assert.equal(activeListening(signal).letters, 0, 'A joined signal is a single sound and requires its complete typed answer');
});

test('two mistakes defer a checkpoint, preserve earned letters, and retry after eight normal clean letters', () => {
  const p = learner(); answer(p, { target: 'E' }); answer(p, { target: 'T', solved: false });
  assert.equal(p.round.byEarDeferred, false); answer(p, { target: 'A', solved: false });
  assert.equal(p.round.byEarDeferred, true); assert.equal(activeListening(p).letters, 1);
  leaveListening(p); assert.equal(beginListening(p), false);
  for (let i = 0; i < LISTENING_COOLDOWN / 2; i++) {
    startRound(p, 'ET'); Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'ET', responseTimes: [9000, 9000] }); finishRound(p, { solved: true });
    if (i < 3) assert.equal(beginListening(p), false);
  }
  assert.equal(beginListening(p), true); assert.equal(activeListening(p).letters, 1); assert.equal(activeListening(p).misses, 0);
});

test('a reviewed wrong sample is followed by fresh groups and the focus sound remains taught', () => {
  const p = learner(8), first = listeningPrompt(p, '', () => 0);
  assert.ok(first.includes('K'));
  assert.notEqual(listeningPrompt(p, first, () => 0), first);
  const q = learner(1); assert.notEqual(listeningPrompt(q, 'E', () => 0), 'E');
});

test('gradual visual help follows each sound’s accuracy, including slow and unmeasured listening', () => {
  const r = emptyReview();
  assert.equal(visualHelpPhase(r, 'E'), 'live');
  for (let i = 0; i < 3; i++) observeReview(r, { target: 'E', guess: 'E', responses: [9000] });
  assert.equal(visualHelpPhase(r, 'E'), 'review'); assert.equal(visualHelpPhase(r, 'ET'), 'live');
  for (let i = 0; i < 3; i++) observeReview(r, { target: 'E', guess: 'E', responses: [null], byEar: true });
  assert.equal(visualHelpPhase(r, 'E'), 'request'); assert.equal(r.sounds.E.earWins, 0);
  observeReview(r, { target: 'E', guess: 'T', byEar: true });
  assert.equal(visualHelpPhase(r, 'E'), 'review');
  observeReview(r, { target: 'E', guess: 'T', byEar: true });
  assert.equal(visualHelpPhase(r, 'E'), 'live');
  assert.equal(visualHelpPhase(r, 'K'), 'live', 'A new letter does not inherit other letters’ confidence');
});

test('feedback after an answer does not retroactively mark the first listen assisted', () => {
  const p = learner();
  for (let i = 0; i < 3; i++) {
    answer(p, { target: 'E' });
    p.round.visualRevealed = true;
    assert.equal(p.round.visualUsed, false);
  }
  assert.equal(p.review.sounds.E.earAccuracy, 3); assert.equal(activeListening(p).letters, 3);
  assert.equal(visualHelpPhase(p.review, 'E'), 'request');
});

test('checkpoint progress and full response arrays survive reload/import at the next stage’s single-letter level', () => {
  const state = newState(), p = learner(100); state.profiles = [p]; state.activeId = p.id;
  answer(p, { target: 'VY TU', ms: 100 });
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.deepEqual(q.listening, p.listening); assert.deepEqual(q.round, p.round);
  assert.equal(q.settings.level, 1); assert.equal(q.round.responseTimes.length, 4);
  assert.equal(q.round.quickCharacters, 4); assert.equal(q.round.speedBonus, 8);
});

test('untrusted checkpoint metadata is bounded and cannot authorize future or arbitrary targets', () => {
  const p = learner(4), key = practiceKey(p.settings);
  const input = { records: { 'flexible:4': { letters: 1e9, covered: ['E', 'K', '<script>'] }, 'flexible:004': { letters: 6, passed: true }, 'head:199': { letters: 2 }, 'flexible:200': { letters: 6 }, constructor: {} }, active: { id: 'flexible:4', ownerKey: key, misses: 1e9, extra: 'evil' }, cooldown: -1 };
  const safe = sanitizeListening(input, p.settings);
  assert.equal(Object.keys(safe.records).length, 2); assert.deepEqual(safe.records['flexible:4'], { letters: 6, passed: false, covered: ['E'] });
  assert.equal(safe.active.misses, 2); assert.equal(safe.active.extra, undefined); assert.equal(safe.cooldown, 0);
  assert.equal(sanitizeListening(input, sanitizeSettings({ ...p.settings, courseLevel: 4 })).active, null);
  assert.equal(sanitizeListening(input, sanitizeSettings({ ...p.settings, visualSupport: 'always' })).active, null);
  const state = newState(); state.profiles[0] = p; state.activeId = p.id;
  startRound(p, 'K', { byEar: true });
  assert.equal(importState(JSON.stringify(state)).profiles[0].round, null);
});

test('paired completion and confidence merge once while unfinished checkpoints stay local to each device', () => {
  const p = learner(4), base = syncProfile(p), local = structuredClone(p), remote = structuredClone(base);
  answer(local, { target: 'ET' }); answer(local, { target: 'AN' });
  remote.listening.records['flexible:4'].letters = 2;
  const merged = mergeProgress(base, local, remote);
  assert.equal(merged.listening.active, null); assert.equal(merged.listening.records['flexible:4'].letters, 4);
  assert.equal(local.listening.active.id, 'flexible:4');
  const repeated = mergeProgress(local, local, merged);
  assert.equal(repeated.listening.records['flexible:4'].letters, 4); assert.equal(repeated.stats.xp, merged.stats.xp);
  assert.equal(repeated.review.sounds.E.earAccuracy, merged.review.sounds.E.earAccuracy);
});

test('reset repeats course checkpoints with XP retained; legacy saves create no invented listening achievements', () => {
  const p = learner(); for (let i = 0; i < 6; i++) answer(p);
  const reset = resetLearnerProgress(p); assert.deepEqual(reset.listening, emptyListening()); assert.equal(reset.stats.xp, p.stats.xp);
  const state = newState(); delete state.profiles[0].listening;
  assert.deepEqual(importState(JSON.stringify(state)).profiles[0].listening, emptyListening());
  const q = newProfile(); q.settings = sanitizeSettings({ ...q.settings, courseLevel: 100 });
  assert.equal(beginListening(q), false, 'Existing learners do not get a backlog of missed checkpoints');
});

test('head-copy checkpoints are independent and explicit visual preferences remain available', () => {
  const p = learner(4, { copyMode: 'head' }); assert.equal(p.listening.active.id, 'head:4');
  answer(p, { target: 'ET', headCopyMs: 5000 }); assert.equal(activeListening(p).letters, 2);
  const q = newProfile(); q.settings = sanitizeSettings({ ...q.settings, courseLevel: 5, visualSupport: 'always' });
  assert.equal(queueListening(q, 4), false);
  q.settings = sanitizeSettings({ ...q.settings, visualSupport: 'off' }); assert.equal(queueListening(q, 4), false);
});

test('restored focus practice has priority over a conflicting unfinished listening checkpoint', () => {
  const state = newState(), p = learner(4); state.profiles = [p]; state.activeId = p.id;
  p.focus = { key: practiceKey(p.settings), cooldown: 0, active: { sounds: 'ET', maxLength: 1, singles: { E: 0, T: 0 }, pairs: 0, triples: 0, acknowledged: false } };
  startRound(p, 'ET', { byEar: true });
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.equal(q.listening.active, null); assert.ok(q.focus.active);
  assert.equal(q.round, null); assert.equal(q.listening.records['flexible:4'].letters, 0);
});
