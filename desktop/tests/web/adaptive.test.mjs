import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline } from '../../website/public/js/morse.mjs';
import { createCopySession, recordCopyInput, headCopyResponse, copyResponses, copyFeedback, responseGoal, sanitizePacing } from '../../website/public/js/recognition.mjs';
import { newProfile, newState, sanitizeSettings, importState, startRound, finishRound, masteryFor, nextPracticeStep, resetLearnerProgress } from '../../website/public/js/progress.mjs';

function answer(p, ms = 2400, options = {}) {
  startRound(p, 'E');
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'E', responseTimes: [ms], ...options });
  return finishRound(p, { solved: true });
}

test('Adaptive is the default, while legacy preferences and unknown timing remain intact', () => {
  assert.equal(newProfile().settings.timingMode, 'adaptive');
  const state = newState();
  const p = state.profiles[0];
  delete p.settings.timingMode;
  delete p.pacing;
  p.settings.recallSeconds = 2.4;
  p.stats.xp = 1500;
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(responseGoal(restored), 2.4);
  assert.equal(restored.settings.timingMode, 'adaptive');
  assert.equal(restored.stats.xp, 1500);
  assert.deepEqual(restored.pacing.samples, []);
  assert.equal(masteryFor(restored).total, 0);
  assert.equal(sanitizeSettings({ timingMode: 'anything' }).timingMode, 'adaptive');
});

test('head-copy starts at the final beep, scales with length, and preserves raw per-letter timings', () => {
  const session = createCopySession(timeline('ET', { wpm: 30, farnsworth: 3 }), 1000);
  const end = session.characters.at(-1).endsAt;
  const raw = recordCopyInput(session, 'ET', end + 2400);
  assert.ok(raw[0] > 5000);
  assert.equal(headCopyResponse(session), 1200);
  assert.deepEqual(copyResponses({ responseTimes: raw, headCopyMs: 1200 }), [1200, 1200]);
  assert.deepEqual(session.responses, raw);
  recordCopyInput(session, 'ET', end + 10000);
  assert.equal(headCopyResponse(session), 1200, 'rendering an unchanged answer must not restart the clock');
});

test('typing along retains separate clocks and cannot hide a late letter inside a head-copy average', () => {
  const session = createCopySession(timeline('ET', { wpm: 30, farnsworth: 3 }), 1000);
  recordCopyInput(session, 'E', session.characters[0].endsAt + 50);
  recordCopyInput(session, 'ET', session.characters[1].endsAt + 2400);
  assert.equal(headCopyResponse(session), null);
  assert.deepEqual(copyResponses({ responseTimes: session.responses, headCopyMs: headCopyResponse(session) }), [50, 2400]);
});

test('incorrect, incomplete and premature entries receive no head-copy timing; edits use their new times', () => {
  const session = createCopySession(timeline('ET', { wpm: 30, farnsworth: 15 }), 1000);
  const end = session.characters.at(-1).endsAt;
  recordCopyInput(session, 'ET', session.characters[0].endsAt - 1);
  assert.equal(headCopyResponse(session), null);
  recordCopyInput(session, '', end);
  recordCopyInput(session, 'EX', end + 100);
  assert.equal(headCopyResponse(session), null);
  recordCopyInput(session, 'E', end + 200);
  assert.equal(headCopyResponse(session), null);
  recordCopyInput(session, 'ET', end + 2400);
  assert.equal(headCopyResponse(session), 1200);
  recordCopyInput(session, '', end + 3000);
  recordCopyInput(session, 'ET', end + 4000);
  assert.equal(headCopyResponse(session), 2000);
});

test('visible copy feedback stays aligned across word spaces and phone whitespace', () => {
  const target = 'NAME IS JOHN', session = createCopySession(timeline(target), 1000);
  const end = session.characters.at(-1).endsAt;
  let draft = '', count = 0;
  for (const character of target) {
    draft += character === ' ' ? '\u00a0  ' : character.toLowerCase();
    const responseTimes = recordCopyInput(session, draft, end + 100 + count++);
    const feedback = copyFeedback({ target, draft, plays: 1, responseTimes });
    assert.equal(feedback.filter(sample => sample.correct).length, draft.replace(/\s/g, '').length);
    assert.equal(feedback.filter(sample => sample.ms !== null).length, draft.replace(/\s/g, '').length);
  }
  const round = { target, draft, plays: 1, responseTimes: session.responses, headCopyMs: headCopyResponse(session) };
  const before = structuredClone(round);
  assert.ok(copyFeedback(round).every(sample => sample.correct && sample.ms !== null));
  assert.deepEqual(round, before, 'Rendering never changes saved timing or guesses');
});

test('an early but correct M remains visibly copied without inventing response timing', () => {
  const session = createCopySession(timeline('NAME IS JOHN'), 1000), [n, a, m] = session.characters;
  recordCopyInput(session, 'N', n.endsAt + 30);
  recordCopyInput(session, 'NA', a.endsAt + 30);
  recordCopyInput(session, 'NAM', m.startsAt + 25);
  const round = { target: 'NAME IS JOHN', draft: 'NAME IS JOH', plays: 1 };
  round.responseTimes = recordCopyInput(session, round.draft, session.characters.at(-1).endsAt + 300);
  round.headCopyMs = headCopyResponse(session);
  assert.deepEqual(copyFeedback(round)[2], { correct: true, corrected: false, ms: null });
  assert.equal(copyFeedback(round).filter(sample => sample.correct).length, 9);
  assert.equal(copyFeedback(round).at(-1).correct, false);
  assert.equal(copyResponses(round)[2], null);
  assert.equal(round.headCopyMs, null);
  assert.deepEqual(round.responseTimes.slice(0, 3), [30, 30, null]);
});

test('corrections receive visible feedback while first-listen mistake credit remains excluded', () => {
  const target = 'NAME IS JOHN', session = createCopySession(timeline(target), 1000), end = session.characters.at(-1).endsAt;
  const round = { target, plays: 1, draft: 'NAME T' };
  round.responseTimes = recordCopyInput(session, round.draft, end + 200);
  round.mistakes = session.mistakes;
  assert.deepEqual(copyFeedback(round)[4], { correct: false, corrected: false, ms: null });
  recordCopyInput(session, 'NAME ', end + 300);
  round.draft = 'NAME I';
  round.responseTimes = recordCopyInput(session, round.draft, end + 400);
  assert.deepEqual(copyFeedback(round)[4], { correct: true, corrected: true, ms: null });
  assert.equal(copyResponses(round)[4], null);
  assert.deepEqual(round.mistakes[4], { expected: 'I', actual: 'T' });
  round.draft = 'NAME '; recordCopyInput(session, round.draft, end + 500);
  assert.equal(copyFeedback(round)[4].correct, false, 'Erasing the replacement clears its color');
  assert.deepEqual(copyFeedback(null), []);
});

test('accurate slower learners calibrate after four clean answers and can advance without changing sound speed', () => {
  const p = newProfile();
  for (let i = 0; i < 3; i++) {
    answer(p);
    assert.equal(responseGoal(p), 1.5);
    assert.equal(p.round.quick, false);
  }
  answer(p);
  assert.equal(responseGoal(p), 2.9);
  assert.equal(p.round.quick, true);
  assert.equal(masteryFor(p).good, 4, 'measured earlier correct answers count at the personalized window');
  for (let i = 4; i < 20; i++) answer(p);
  assert.equal(masteryFor(p).total, 20);
  assert.equal(masteryFor(p).mastered, true);
  assert.equal(nextPracticeStep(p).courseLevel, 2);
  assert.equal(p.settings.recallSeconds, 1.5, 'keep the manual goal');
  assert.equal(p.settings.wpm, 30);
  assert.equal(p.settings.farnsworth, 15);
});

test('fixed timing never adapts or promotes consistently slow copies', () => {
  const p = newProfile();
  p.settings.timingMode = 'fixed';
  for (let i = 0; i < 24; i++) answer(p);
  assert.equal(responseGoal(p), 1.5);
  assert.deepEqual(p.pacing.samples, []);
  assert.equal(masteryFor(p).mastered, false);
  assert.equal(nextPracticeStep(p), null);
});

test('mistakes, assistance, replays, skipped and unmeasured copies cannot calibrate or fake advancement', () => {
  const p = newProfile();
  const initial = structuredClone(p.pacing);
  for (let i = 0; i < 24; i++) {
    for (const options of [{ firstGuess: 'X', attempts: 2 }, { assisted: true }, { plays: 2 }, { attempts: 2 }, { heard: false }, { responseTimes: [null] }, { responseTimes: [] }]) answer(p, 8000, options);
    startRound(p, 'E');
    finishRound(p);
  }
  assert.deepEqual(p.pacing, initial);
  assert.equal(nextPracticeStep(p), null);
  assert.equal(masteryFor(p).good, 0);
});

test('adaptation is bounded, tightens gradually, and still requires accuracy and coverage of new letters', () => {
  const p = newProfile();
  for (let i = 0; i < 4; i++) answer(p, 10000);
  assert.equal(responseGoal(p), 4);
  assert.equal(masteryFor(p).good, 0);
  for (let i = 0; i < 180; i++) {
    const before = responseGoal(p);
    answer(p, 20);
    assert.ok(responseGoal(p) >= before - 0.10001);
    assert.ok(responseGoal(p) >= 0.5 && responseGoal(p) <= 4);
  }
  assert.equal(responseGoal(p), 0.5);
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 5 });
  for (let i = 0; i < 20; i++) answer(p, 2400);
  assert.equal(masteryFor(p).windowReady, true);
  assert.equal(masteryFor(p).focusReady, false);
  assert.equal(nextPracticeStep(p), null, 'familiar letters cannot establish readiness for K');
});

test('real head-copied pairs receive letter mastery credit and advance in ten accurate answers', () => {
  const p = newProfile();
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 2 });
  for (let i = 0; i < 10; i++) {
    const session = createCopySession(timeline('ET', p.settings), 1000);
    const responses = recordCopyInput(session, 'ET', session.characters.at(-1).endsAt + 2400);
    startRound(p, 'ET');
    Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'ET', responseTimes: responses, headCopyMs: headCopyResponse(session) });
    finishRound(p, { solved: true });
    assert.equal(p.round.quick, true);
  }
  assert.equal(masteryFor(p).good, 20);
  assert.equal(nextPracticeStep(p).courseLevel, 3);
  assert.equal(p.round.quickCharacters, 2);
  assert.equal(p.round.speedBonus, 4);
});

test('personalized pacing and head-copy timing survive reload and course restarts, and remain bounded', () => {
  const state = newState();
  const p = state.profiles[0];
  for (let i = 0; i < 5; i++) answer(p);
  p.round.headCopyMs = 2400;
  state.profiles.push(newProfile('Other'));
  const restored = importState(JSON.stringify(state));
  assert.deepEqual(restored.profiles[0].pacing, p.pacing);
  assert.equal(restored.profiles[0].round.headCopyMs, 2400);
  assert.equal(responseGoal(restored.profiles[1]), 1.5);
  const reset = resetLearnerProgress(restored.profiles[0]);
  assert.deepEqual(reset.pacing, restored.profiles[0].pacing);
  assert.equal(responseGoal(reset), responseGoal(restored.profiles[0]));
  assert.equal(restored.profiles[0].stats.total, 5);
  assert.deepEqual(sanitizePacing({ seconds: 99, samples: Array(100).fill(1e10), pending: 99 }), { seconds: 4, samples: Array(20).fill(600000), pending: 3 });
  assert.deepEqual(sanitizePacing({ seconds: -1, samples: [null, '10', -1, Infinity, {}, 10], pending: 2.3 }), { seconds: 0.5, samples: [10], pending: 0 });
  assert.equal(sanitizePacing({ seconds: NaN }, 2.4).seconds, 2.4);
});
