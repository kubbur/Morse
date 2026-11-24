import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyReview, sanitizeReview, observeReview, reviewTarget, listeningOnly, soundUnits, practiceNeeds, confusionPairs, recentReview, REVIEW_WINDOW } from '../../website/public/js/review.mjs';
import { newState, newProfile, sanitizeSettings, importState, startRound, finishRound, recordFirstReview, recordTypedMistakes, nextPracticeStep, resetLearnerProgress } from '../../website/public/js/progress.mjs';
import { alphabetFor, practiceKey, randomPrompt, transmissionText } from '../../website/public/js/lessons.mjs';
import { responseGoal } from '../../website/public/js/recognition.mjs';
import { guidanceKey, acknowledgeGuidance, lessonGuidance } from '../../website/public/js/guidance.mjs';
import { emptyEndless, sanitizeEndless, radioMission, nextRadioStep, rankGoal, awardRadio, courseCompleted } from '../../website/public/js/endless.mjs';
import { MORSE, timeline } from '../../website/public/js/morse.mjs';

const now = Date.UTC(2026, 10, 21, 21);
function attempt(p, target, guess = target, options = {}) {
  startRound(p, target);
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: guess, responseTimes: Array(guess.replaceAll(' ', '').length).fill(200), ...options });
  return finishRound(p, { solved: guess === target, now: new Date(now) });
}
function graduate(p) {
  p.settings = sanitizeSettings({ ...p.settings, track: 'course', courseLevel: 400 });
  p.stats.mastery[practiceKey(p.settings)] = { unit: 'letters', mastered: true, history: [], recognition: [] };
  p.endless.unlocked = true;
}

test('first-listen confusions are remembered immediately and cannot be counted again by retries or reload', () => {
  const state = newState(), p = state.profiles[0];
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 17 });
  startRound(p, 'K'); Object.assign(p.round, { heard: true, plays: 1, firstGuess: 'R', attempts: 1, firstResponseTimes: [null] });
  assert.equal(recordFirstReview(p, now), true);
  assert.equal(p.review.sounds.K.confusions.R, 1);
  assert.equal(recordFirstReview(p, now), false);
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.equal(q.review.sounds.K.confusions.R, 1);
  assert.equal(recordFirstReview(q, now), false);
  Object.assign(q.round, { plays: 2, assisted: true, responseTimes: [100], firstGuess: 'R' });
  finishRound(q, { solved: true });
  assert.equal(q.review.copies, 1);
  assert.equal(q.review.sounds.K.correct, 0);
});

test('practice needs use recent accuracy and clear recovered characters without changing lifetime totals', () => {
  const r = emptyReview();
  for (let i = 0; i < 1000; i++) observeReview(r, { target: 'F', guess: i % 5 ? 'F' : 'L' }, now);
  for (let i = 0; i < 6; i++) observeReview(r, { target: 'F', guess: 'L' }, now + 1);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(practiceNeeds(r), [['F', { seen: 6, correct: i }]]);
    // Even an accurate slow answer improves this accuracy card.
    observeReview(r, { target: 'F', guess: 'F', responses: [9000] }, now + 2 + i);
  }
  assert.deepEqual(practiceNeeds(r), [['F', { seen: 6, correct: 5 }]]);
  assert.deepEqual(confusionPairs(r), [{ sound: 'F', other: 'L', count: 1 }]);
  observeReview(r, { target: 'F', guess: 'F' }, now + 8);
  assert.deepEqual(practiceNeeds(r), []); assert.deepEqual(confusionPairs(r), []);
  assert.equal(r.sounds.F.confusions.L, 206);
  assert.equal(r.sounds.F.seen, 1012); assert.equal(r.sounds.F.correct, 806);
  observeReview(r, { target: 'F', guess: 'L' }, now + 9);
  assert.deepEqual(practiceNeeds(r), [['F', { seen: 6, correct: 5 }]]);
  assert.deepEqual(confusionPairs(r), [{ sound: 'F', other: 'L', count: 1 }]);
});

test('recent mix-ups expire independently and record a later wrong occurrence of a repeated character', () => {
  const r = emptyReview();
  observeReview(r, { target: 'FF', guess: 'FL' }, now);
  observeReview(r, { target: 'F', guess: 'G' }, now + 1);
  for (let i = 0; i < 4; i++) observeReview(r, { target: 'F', guess: 'F' }, now + 2 + i);
  assert.equal(r.sounds.F.seen, 6);
  assert.deepEqual(confusionPairs(r), [{ sound: 'F', other: 'L', count: 1 }, { sound: 'F', other: 'G', count: 1 }]);
  observeReview(r, { target: 'F', guess: 'F' }, now + 7);
  assert.deepEqual(confusionPairs(r), [{ sound: 'F', other: 'G', count: 1 }]);
  assert.equal(r.sounds.F.confusions.L, 1);
  observeReview(r, { target: 'F', guess: 'F' }, now + 8);
  assert.deepEqual(confusionPairs(r), []);
});

test('corrected typed mistakes flag practice immediately, survive import, and cannot turn into a success on submission', () => {
  const state = newState(), p = state.profiles[0];
  for (let i = 0; i < 6; i++) observeReview(p.review, { target: 'F', guess: 'F' }, now);
  startRound(p, 'F');
  Object.assign(p.round, { heard: true, plays: 1, mistakes: [{ expected: 'F', actual: 'L' }] });
  assert.equal(recordTypedMistakes(p, now + 1), true);
  assert.deepEqual(practiceNeeds(p.review), [['F', { seen: 6, correct: 5 }]]);
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.deepEqual(confusionPairs(q.review), [{ sound: 'F', other: 'L', count: 1 }]);
  assert.equal(recordTypedMistakes(q, now + 2), false);
  Object.assign(q.round, { draft: 'F', firstGuess: 'F', attempts: 1, firstResponseTimes: [100] });
  recordFirstReview(q, now + 3);
  assert.equal(q.review.sounds.F.seen, 7);
  assert.deepEqual(q.review.sounds.F.recent, [true, true, true, true, true, false]);
});

test('old review saves use their known recent outcomes and never invent recent mix-ups from lifetime counts', () => {
  const r = sanitizeReview({ copies: 100, sounds: {
    F: { seen: 1000, correct: 790, confusions: { L: 35 }, recent: [false, true, true, true, true, true] },
    G: { seen: 1000, correct: 830, confusions: { W: 12 }, recent: Array(6).fill(true) },
    Z: { seen: 500, correct: 300, confusions: { S: 200 } },
  } });
  assert.deepEqual(practiceNeeds(r), [['F', { seen: 6, correct: 5 }]]);
  assert.deepEqual(confusionPairs(r), []);
  observeReview(r, { target: 'F', guess: 'F' }, now);
  assert.deepEqual(practiceNeeds(r), []); assert.equal(r.sounds.F.confusions.L, 35);
  observeReview(r, { target: 'G', guess: 'W' }, now);
  assert.deepEqual(confusionPairs(r), [{ sound: 'G', other: 'W', count: 1 }]);
});

test('recent review histories are bounded and aligned and exclude invalid or successful confusion details', () => {
  const r = sanitizeReview({ sounds: { F: {
    seen: 1e9, recent: Array(10000).fill(false),
    recentConfusions: [...Array(9994).fill('L'), 'G', '<script>', 'F', {}, null, 'L'],
  }, K: { recent: [false, true, false], recentConfusions: ['R'] },
  E: { recent: [false, true], recentConfusions: ['T', 'T'] },
  T: { recent: [], recentConfusions: Array(10000).fill('E') },
  BT: { recent: [false], recentConfusions: ['AR'] }, EVIL: { recent: [false] } } });
  assert.equal(r.sounds.F.recent.length, REVIEW_WINDOW);
  assert.deepEqual(r.sounds.F.recentConfusions, ['G', '', '', '', '', 'L']);
  assert.deepEqual(r.sounds.K.recentConfusions, ['', '', 'R']);
  assert.deepEqual(r.sounds.E.recentConfusions, ['T', '']);
  assert.deepEqual(recentReview(r.sounds.T, 'T'), []);
  assert.ok(practiceNeeds(r).every(([sound]) => sound.length === 1 && sound !== 'EVIL'));
  assert.ok(confusionPairs(r).some(pair => pair.sound === 'BT' && pair.other === 'AR'));
});

test('review waits several copies after mistakes and returns in later sessions using only learned sounds', () => {
  const r = emptyReview();
  observeReview(r, { target: 'K', guess: 'R' }, now);
  assert.equal(reviewTarget(r, ['K', 'R'], now), null);
  for (let i = 0; i < 3; i++) observeReview(r, { target: 'E', guess: 'E', responses: [200] }, now + i);
  assert.equal(reviewTarget(r, ['K', 'R'], now).pair, 'R');
  assert.equal(reviewTarget(r, ['E', 'T'], now)?.sound === 'K', false);
  const restored = sanitizeReview(r);
  assert.equal(reviewTarget(restored, ['K'], now + 86400000).sound, 'K');
  assert.equal(reviewTarget(restored, ['K'], now + 86400000).pair, '');
});

test('targeted groups contrast a real confusion without introducing an untaught counterpart or starving new sounds', () => {
  const r = emptyReview(); observeReview(r, { target: 'K', guess: 'R' }, now);
  r.copies += 4;
  const settings = sanitizeSettings({ courseLevel: 18 });
  const text = randomPrompt(settings, {}, '', () => 0.1, '', { review: r, now });
  assert.equal(text.length, 2); assert.ok(text.includes('K') && text.includes('R'));
  const beginner = sanitizeSettings({ courseLevel: 2 });
  assert.ok([...randomPrompt(beginner, {}, '', () => 0.1, '', { review: r, now })].every(c => alphabetFor(beginner).includes(c)));
  const focused = randomPrompt(settings, {}, '', () => 0.1, 'R', { review: r, now });
  assert.equal(focused.length, 2);
});

test('repeated copies of the same character within one group are one memory observation, and joined signals stay whole', () => {
  const r = emptyReview();
  observeReview(r, { target: 'EEEE', guess: 'EEEE', responses: [100, 100, 100, 100], byEar: true }, now);
  assert.equal(r.sounds.E.streak, 1); assert.equal(r.sounds.E.earWins, 1);
  observeReview(r, { target: 'BT', guess: 'BT', responses: [100, 100], prosigns: ['BT'], byEar: true }, now);
  assert.equal(r.sounds.BT.earWins, 1); assert.equal(r.sounds.B, undefined); assert.equal(r.sounds.T, undefined);
  assert.deepEqual(soundUnits('NAME SAM BT', ['BT']).at(-1), { sound: 'BT', start: 7, end: 9 });
});

test('gradual visuals wait for accurate known sounds and no longer hide patterns randomly', () => {
  const r = emptyReview();
  for (let i = 0; i < 2; i++) observeReview(r, { target: 'E', guess: 'E', responses: [9000] }, now);
  assert.equal(listeningOnly(r, 'E', [], () => 0), false);
  observeReview(r, { target: 'E', guess: 'E', responses: [9000] }, now);
  assert.equal(listeningOnly(r, 'E', [], () => 0.2), true);
  assert.equal(listeningOnly(r, 'E', [], () => 0.99), true);
  assert.equal(listeningOnly(r, 'ET', [], () => 0), false);
  for (let i = 0; i < 3; i++) observeReview(r, { target: 'E', guess: 'E', responses: [100], byEar: true }, now);
  assert.equal(listeningOnly(r, 'E', [], () => 0.7), true);
  observeReview(r, { target: 'E', guess: 'T' }, now);
  assert.equal(listeningOnly(r, 'E'), true, 'One lapse returns a confident sound to after-answer review');
  observeReview(r, { target: 'E', guess: 'T' }, now);
  assert.equal(listeningOnly(r, 'E', [], () => 0), false);
});

test('visual help and assistance cannot create listening evidence; slow accurate listening earns accuracy without speed confidence', () => {
  const p = newProfile();
  attempt(p, 'E', 'E', { visualUsed: true });
  assert.equal(p.review.sounds.E.earWins, 0);
  const copies = p.review.copies;
  for (const options of [{ assisted: true }, { plays: 2 }, { introduction: true, assisted: true }]) attempt(p, 'E', 'E', options);
  assert.equal(p.review.copies, copies);
  attempt(p, 'E', 'E', { responseTimes: [null] });
  assert.equal(p.review.sounds.E.streak, 0);
  attempt(p, 'E', 'E', { responseTimes: [9000] });
  assert.equal(p.review.sounds.E.earWins, 0);
  assert.equal(p.review.sounds.E.earAccuracy, 2);
});

test('head-copy keeps separate course keys, timing calibration and progress while flexible mastery stays intact', () => {
  const state = newState(), p = state.profiles[0];
  p.settings.timingMode = 'fixed';
  const original = practiceKey(p.settings);
  for (let i = 0; i < 20; i++) attempt(p, 'E');
  const stats = structuredClone(p.stats.mastery[original]);
  p.settings = sanitizeSettings({ ...p.settings, copyMode: 'head', timingMode: 'adaptive' });
  assert.notEqual(practiceKey(p.settings), original); assert.notEqual(guidanceKey(p.settings), guidanceKey({ ...p.settings, copyMode: 'flexible' }));
  for (let i = 0; i < 4; i++) attempt(p, 'E', 'E', { responseTimes: [2400], headCopyMs: 2400 });
  assert.equal(responseGoal(p), 2.9); assert.equal(p.pacing.seconds, 1.5);
  assert.equal(p.stats.modes.head.total, 4); assert.equal(p.stats.modes.flexible.total, 20);
  assert.deepEqual(p.stats.mastery[original], stats);
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.equal(q.headPacing.seconds, 2.9); assert.deepEqual(q.stats.modes, p.stats.modes);
  q.settings.copyMode = 'flexible'; assert.equal(responseGoal(q), 1.5);
});

test('old saves keep earned progress and unknown visual use never creates ear-only evidence', () => {
  const state = newState(), p = state.profiles[0];
  attempt(p, 'E'); const xp = p.stats.xp;
  delete p.round.visualUsed; delete p.settings.copyMode; delete p.settings.visualSupport; delete p.review; delete p.headPacing; delete p.endless; delete p.stats.modes;
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.equal(q.stats.xp, xp); assert.equal(q.settings.copyMode, 'flexible'); assert.equal(q.settings.visualSupport, 'auto');
  assert.equal(q.round.visualUsed, true); assert.deepEqual(q.review, emptyReview());
});

test('review, mode and endless metadata are strictly bounded data, including numeric objects and unknown signals', () => {
  const r = sanitizeReview({ copies: {}, sounds: { K: { seen: 100, correct: 9000, streak: Infinity, dueAt: {}, confusions: { R: 1e20, X: {}, '<BT>': 5 } }, EVIL: { seen: 500 } } });
  assert.equal(r.copies, 0); assert.equal(r.sounds.K.correct, 100); assert.equal(r.sounds.K.streak, 0);
  assert.equal(r.sounds.K.dueAt, 0); assert.equal(r.sounds.K.confusions.R, 10000); assert.equal(r.sounds.EVIL, undefined);
  const state = newState(); state.profiles[0].settings.track = 'endless'; state.profiles[0].endless = { unlocked: true, rank: {}, seed: [], step: 500 };
  const p = importState(JSON.stringify(state)).profiles[0];
  assert.equal(p.settings.track, 'course'); assert.equal(p.endless.unlocked, false); assert.equal(p.endless.rank, 1);
});

test('mastering level 400 unlocks endless radio after the finale, without advancing to course 401', () => {
  const p = newProfile(); p.settings = sanitizeSettings({ ...p.settings, courseLevel: 400, timingMode: 'fixed' });
  const targets = ['CQ CQ DE W1AW', 'UR RST 599 BK', 'TNX QSO TU 73 SK'];
  for (let i = 0; i < 3; i++) attempt(p, targets[i]);
  assert.equal(courseCompleted(p.stats), true); assert.equal(p.endless.unlocked, true);
  const step = nextPracticeStep(p); assert.equal(step.track, 'endless'); assert.equal(step.courseLevel, 400);
  p.settings = sanitizeSettings({ ...p.settings, ...step });
  assert.equal(lessonGuidance({ ...p, guidance: { ...p.guidance, welcomed: true, alphabet: alphabetFor(p.settings), prosigns: ['BT','AS','AR','KN','SK','BK'] } }).title, 'Endless radio');
});

test('endless contacts are varied, deterministic, bounded and use only the taught Morse toolkit', () => {
  const e = emptyEndless(), calls = new Set();
  const settings = sanitizeSettings({ track: 'endless' });
  for (let contact = 0; contact < 100; contact++) {
    e.rank = contact + 1; e.missionRank = e.rank;
    const call = radioMission(e).call; calls.add(call);
    for (let step = 0; step < 5; step++) {
      const task = radioMission(e);
      assert.ok(task.text.length <= 100 && [...task.text].every(c => c === ' ' || Object.hasOwn(MORSE, c)));
      assert.equal(timeline(transmissionText(task.text, settings), settings).text, task.text);
      assert.equal(task.call, call); nextRadioStep(e);
    }
  }
  assert.ok(calls.size > 70);
});

test('Paragon XP and contacts survive reload, cannot be awarded twice, and preserve the current message across rank changes', () => {
  const state = newState(), p = state.profiles[0]; graduate(p);
  p.settings = sanitizeSettings({ ...p.settings, track: 'endless' });
  p.endless.rank = 14; p.endless.missionRank = 14; p.endless.xp = rankGoal(14) - 1; p.endless.step = 3; p.endless.solved = 3;
  const target = radioMission(p.endless).text;
  attempt(p, target);
  assert.equal(p.endless.rank, 15); assert.equal(radioMission(p.endless).text, target);
  const q = importState(JSON.stringify(state)).profiles[0];
  assert.equal(q.round.target, target); assert.equal(q.round.completed, true);
  const old = structuredClone(q.endless); assert.equal(finishRound(q, { solved: true }), null); assert.deepEqual(q.endless, old);
  assert.equal(awardRadio(q.endless, 200, true), false); assert.deepEqual(q.endless, old);
  nextRadioStep(q.endless); attempt(q, radioMission(q.endless).text);
  assert.equal(q.endless.contacts, 1);
  nextRadioStep(q.endless); assert.equal(q.endless.step, 0); assert.equal(q.endless.missionRank, q.endless.rank);
});

test('skipping a radio message cannot complete its contact, while assisted correct copies still earn Paragon XP', () => {
  const e = emptyEndless();
  for (let step = 0; step < 5; step++) { awardRadio(e, step === 2 ? 0 : 8, step !== 2); if (step < 4) nextRadioStep(e); }
  assert.equal(e.contacts, 0); assert.equal(e.xp, 32);
  nextRadioStep(e);
  for (let step = 0; step < 5; step++) { awardRadio(e, 8, true); if (step < 4) nextRadioStep(e); }
  assert.equal(e.contacts, 1); assert.equal(e.xp, 72);
});

test('course reset retains lifetime listening history, head-copy calibration and Paragon score while clearing earned levels', () => {
  const state = newState(), p = state.profiles[0]; state.profiles.push(newProfile('Other'));
  attempt(p, 'E'); graduate(p); p.endless.rank = 20; p.settings.copyMode = 'head'; p.settings.visualSupport = 'off'; p.settings.showMorse = false;
  const other = structuredClone(state.profiles[1]), reset = resetLearnerProgress(p);
  assert.deepEqual(reset.review, p.review); assert.equal(reset.endless.rank, 20); assert.equal(reset.endless.unlocked, false); assert.deepEqual(reset.headPacing, p.headPacing);
  assert.deepEqual(reset.stats.mastery, {}); assert.equal(reset.stats.xp, p.stats.xp);
  assert.equal(reset.settings.copyMode, 'head'); assert.equal(reset.settings.visualSupport, 'off'); assert.equal(reset.settings.track, 'course');
  assert.deepEqual(state.profiles[1], other); assert.equal(p.endless.rank, 20);
});
