import test from 'node:test';
import assert from 'node:assert/strict';
import { COURSE_LEVELS, expandedCourseLevel, courseStage } from '../../website/public/js/lessons.mjs';
import { MORSE, gradeAnswer } from '../../website/public/js/morse.mjs';
import { newState, newProfile, sanitizeSettings, importState, startRound, finishRound, resetLearnerProgress } from '../../website/public/js/progress.mjs';
import { guidanceKey, lessonGuidance, acknowledgeGuidance, sanitizeGuidance, rememberGuidanceSound, guidanceListenCount, GUIDANCE_LISTENS, beginRecovery, sanitizeRecovery, recoveryCharacter, rememberRecoverySound } from '../../website/public/js/guidance.mjs';

test('new learners meet all four named starter sounds before their first guess', () => {
  const p = newProfile();
  const detail = lessonGuidance(p);
  assert.equal(detail.first, true);
  assert.deepEqual(detail.characters, ['E', 'T', 'A', 'N']);
  assert.deepEqual(detail.characters.map(c => MORSE[c]), ['.', '-', '.-', '-.']);
  assert.match(detail.instruction, /One character/);
  assert.equal(p.stats.xp, 0);
  acknowledgeGuidance(p);
  assert.equal(lessonGuidance(p), null);
  assert.equal(p.stats.total, 0);
});

test('the updated frequency lesson appears once for existing learners and lists every short exercise in both modes', () => {
  for (const copyMode of ['flexible', 'head']) {
    const p = newProfile(); p.settings = sanitizeSettings({ ...p.settings, courseLevel: 147, copyMode });
    const current = guidanceKey(p.settings), parts = JSON.parse(current); parts[4] = 'cw-v2';
    p.guidance = { ...p.guidance, welcomed: true, alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', seen: [JSON.stringify(parts)] };
    const detail = lessonGuidance(p);
    assert.ok(detail); assert.equal(detail.characters.length, 0);
    assert.match(detail.copy, /four digits/); assert.match(detail.instruction, /No letters or spaces/);
    assert.ok(detail.examples.length >= 3 && detail.examples.every(entry => /^\d{4}$/.test(entry.text) && entry.meaning));
    acknowledgeGuidance(p); assert.equal(lessonGuidance(p), null);
    const restored = importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
    assert.equal(lessonGuidance(restored), null);
    const reference = lessonGuidance(restored, { reference: true });
    assert.equal(reference.title, 'Lesson frequencies'); assert.deepEqual(reference.examples, detail.examples);
  }
});

test('shorter radio reviews preserve in-progress new-character introductions and their completed listens', () => {
  for (const copyMode of ['flexible', 'head']) for (const [level, sound] of [[149, '?'], [153, '/'], [169, 'BT'], [173, 'AS']]) {
    const p = newProfile();
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: level - 1, copyMode });
    acknowledgeGuidance(p);
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: level });
    const key = guidanceKey(p.settings);
    assert.equal(JSON.parse(key)[4], 'cw-v2', 'new-character introductions retain their existing save key');
    assert.deepEqual(lessonGuidance(p).characters, [sound]);
    rememberGuidanceSound(p, sound); rememberGuidanceSound(p, sound);
    const restored = importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
    assert.equal(guidanceKey(restored.settings), key);
    assert.equal(guidanceListenCount(restored, sound), 2);
    rememberGuidanceSound(restored, sound);
    assert.equal(guidanceListenCount(restored, sound), 3);
    acknowledgeGuidance(restored);
    assert.equal(lessonGuidance(restored), null);
  }
});

test('all 400 steps explain their lengths and teach exactly the letters newly joining the mix', () => {
  const p = newProfile();
  let previousAlphabet = '';
  let previousProsigns = [];
  for (let level = 1; level <= COURSE_LEVELS; level++) {
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: level });
    const detail = lessonGuidance(p);
    assert.equal(detail.level, level);
    assert.deepEqual(detail.characters, courseStage(level).audioCourse ? [] : [...[...detail.alphabet].filter(c => !previousAlphabet.includes(c)), ...detail.prosigns.filter(c => !previousProsigns.includes(c))]);
    if (level > 1 && level <= 89 && level % 4 === 1) {
      assert.equal(detail.characters.length, 1);
      assert.match(detail.title, /^New letter:/);
      assert.match(detail.instruction, /One character/);
    }
    if (level === 2) assert.match(detail.copy, /Same 4 letters\. 2 characters/);
    if (level === 3) assert.match(detail.copy, /3 characters/);
    if (level === 4) assert.match(detail.copy, /1–3 characters/);
    if (level === 100) assert.match(detail.copy, /Review shorthand/);
    acknowledgeGuidance(p, detail.key);
    assert.equal(lessonGuidance(p), null);
    previousAlphabet = [...new Set(previousAlphabet + detail.alphabet)].join('');
    previousProsigns = [...new Set([...previousProsigns, ...detail.prosigns])];
  }
  assert.equal(p.guidance.seen.length, COURSE_LEVELS);
});

test('acknowledgements survive reload and import independently for each learner', () => {
  const state = newState();
  acknowledgeGuidance(state.profiles[0]);
  state.profiles.push(newProfile('New listener'));
  const restored = importState(JSON.stringify(state));
  assert.equal(lessonGuidance(restored.profiles[0]), null);
  assert.equal(lessonGuidance(restored.profiles[1]).first, true);
  restored.profiles[0].settings = sanitizeSettings({ courseLevel: 5 });
  assert.deepEqual(lessonGuidance(restored.profiles[0]).characters, ['K']);
  acknowledgeGuidance(restored.profiles[0], guidanceKey(state.profiles[0].settings));
  assert.ok(lessonGuidance(restored.profiles[0]), 'a stale popup cannot acknowledge a different stage');
});

test('existing learners skip a repeat welcome but receive their next stage explanation', () => {
  const state = newState();
  const p = state.profiles[0];
  delete p.guidance;
  p.stats.total = 130;
  p.stats.xp = 2600;
  p.settings = sanitizeSettings({ courseLevel: 4 });
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(lessonGuidance(restored), null);
  assert.equal(restored.stats.xp, 2600);
  restored.settings = sanitizeSettings({ courseLevel: 5 });
  assert.equal(lessonGuidance(restored).first, false);
  assert.deepEqual(lessonGuidance(restored).characters, ['K']);
});

test('guidance metadata is bounded and malformed fields or embedded keys cannot become UI data', () => {
  const p = newProfile();
  const key = guidanceKey(p.settings);
  const result = sanitizeGuidance({ welcomed: 'yes', seen: [null, {}, '[]', '['.repeat(5000), JSON.stringify(['starter', {}, '<script>', 1]), key, key], alphabet: '<img>ETAN🙂' }, p.settings);
  assert.equal(result.welcomed, false);
  assert.deepEqual(result.seen, [key]);
  assert.ok([...result.alphabet].every(c => Object.hasOwn(MORSE, c)));
  const many = sanitizeGuidance({ seen: Array(1000).fill(key) }, p.settings);
  assert.deepEqual(many.seen, [key]);
  assert.equal(sanitizeGuidance({ alphabet: { toString: 'bad' } }, p.settings).alphabet, '');
  assert.equal(sanitizeGuidance({ previewed: { toString: 'bad' } }, p.settings).previewed, '');
  assert.equal(sanitizeGuidance({ previewed: 'EETT🙂' }, p.settings).previewed, 'ET');
});

test('completed learning previews survive reload without acknowledging the welcome or awarding guesses', () => {
  const state = newState(), p = state.profiles[0];
  assert.equal(rememberGuidanceSound(p, 'E'), true);
  assert.equal(rememberGuidanceSound(p, 'E'), true);
  assert.equal(rememberGuidanceSound(p, 'T'), true);
  assert.equal(rememberGuidanceSound(p, 'ET'), false);
  assert.equal(rememberGuidanceSound(p, 'K'), false);
  assert.equal(p.guidance.previewed, 'ET');
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.guidance.previewed, 'ET');
  assert.equal(lessonGuidance(restored).first, true);
  assert.equal(restored.stats.total, 0);
  assert.equal(restored.stats.xp, 0);
  const oldKey = guidanceKey(restored.settings);
  restored.settings = sanitizeSettings({ ...restored.settings, courseLevel: 5 });
  assert.equal(rememberGuidanceSound(restored, 'K', oldKey), false, 'a previous lesson cannot finish a new lesson’s preview');
  acknowledgeGuidance(restored);
  assert.equal(restored.guidance.previewed, 'ET');
});

test('the lesson reference remains available after acknowledgement and includes every current letter without changing progress', () => {
  const p = newProfile();
  acknowledgeGuidance(p);
  assert.equal(lessonGuidance(p), null);
  const before = JSON.stringify(p);
  const reference = lessonGuidance(p, { reference: true });
  assert.equal(reference.reference, true);
  assert.equal(reference.first, false);
  assert.deepEqual(reference.characters, ['E', 'T', 'A', 'N']);
  assert.equal(JSON.stringify(p), before);
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 5 });
  acknowledgeGuidance(p);
  assert.deepEqual(lessonGuidance(p, { reference: true }).characters, ['E', 'T', 'A', 'N', 'K']);
});

test('new-letter introductions need three listens per new sound, independently of earlier previews', () => {
  const p = newProfile();
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 32 });
  acknowledgeGuidance(p);
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 33 });
  const detail = lessonGuidance(p);
  assert.deepEqual(detail.characters, ['W']);
  assert.equal(detail.copy, 'Look at the letter and listen to the sound.');
  assert.equal(detail.repetitions, 3);
  p.guidance.previewed += 'W';
  assert.equal(guidanceListenCount(p, 'W'), 0, 'one earlier preview cannot satisfy a new three-listen introduction');
  const stats = structuredClone(p.stats);
  for (let i = 1; i <= GUIDANCE_LISTENS + 1; i++) {
    rememberGuidanceSound(p, 'W');
    assert.equal(guidanceListenCount(p, 'W'), Math.min(i, 3));
    assert.ok(lessonGuidance(p), 'hearing the sound never acknowledges or closes the introduction');
  }
  assert.deepEqual(p.stats, stats);
  assert.equal(guidanceListenCount(p, 'E'), 0);
  acknowledgeGuidance(p);
  assert.equal(p.guidance.rehearsal, null);
  assert.equal(lessonGuidance(p), null);
});

test('pending new-letter counts survive reload/import separately per learner and reject stale completions', () => {
  const state = newState(), p = state.profiles[0];
  acknowledgeGuidance(p);
  const oldKey = guidanceKey(p.settings);
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 5 });
  rememberGuidanceSound(p, 'K');
  rememberGuidanceSound(p, 'K');
  state.profiles.push(newProfile('Other'));
  const restored = importState(JSON.stringify(state));
  assert.equal(guidanceListenCount(restored.profiles[0], 'K'), 2);
  assert.equal(guidanceListenCount(restored.profiles[1], 'K'), 0);
  assert.equal(rememberGuidanceSound(restored.profiles[0], 'K', oldKey), false);
  assert.equal(guidanceListenCount(restored.profiles[0], 'K'), 2);
  assert.equal(restored.profiles[0].stats.total, 0);
  assert.equal(restored.profiles[0].guidance.welcomed, true);
  assert.ok(lessonGuidance(restored.profiles[0]));
});

test('rehearsal metadata is restricted to the current lesson, known characters and integer counts of zero to three', () => {
  const settings = sanitizeSettings({ courseLevel: 5 });
  const key = guidanceKey(settings);
  const sanitized = sanitizeGuidance({ rehearsal: { key, counts: { E: 500, T: -1, A: '3', N: 2.5, K: 2, X: 3 } } }, settings);
  assert.deepEqual(sanitized.rehearsal, { key, counts: { E: 3, T: 0, A: 0, N: 0, K: 2 } });
  assert.equal(sanitizeGuidance({ rehearsal: { key: 'x'.repeat(10000), counts: { K: 3 } } }, settings).rehearsal, null);
  assert.equal(sanitizeGuidance({ rehearsal: { key: guidanceKey(sanitizeSettings({})), counts: { K: 3 } } }, settings).rehearsal, null);
  assert.deepEqual(sanitizeGuidance({ rehearsal: { key, counts: null } }, settings).rehearsal.counts, {});
});

test('welcome and reference previews keep their existing sequence and cannot add new-letter rehearsal counts', () => {
  const p = newProfile();
  assert.equal(lessonGuidance(p).repetitions, 0);
  rememberGuidanceSound(p, 'E');
  assert.equal(p.guidance.rehearsal, null);
  acknowledgeGuidance(p);
  assert.equal(lessonGuidance(p, { reference: true }).repetitions, 0);
  rememberGuidanceSound(p, 'T');
  assert.equal(p.guidance.rehearsal, null);
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 2 });
  assert.equal(lessonGuidance(p).repetitions, 0, 'a length-only change still closes on its first Enter');
});

test('three wrong submissions offer sound recovery without changing guesses, timing credit or progress', () => {
  const p = newProfile();
  const round = startRound(p, 'T');
  Object.assign(round, { heard: true, plays: 3, firstGuess: 'E', lastGuess: 'E', firstResponseTimes: [380] });
  const before = structuredClone({ stats: p.stats, pacing: p.pacing, guidance: p.guidance });
  for (const attempts of [0, 1, 2]) {
    round.attempts = attempts;
    assert.equal(beginRecovery(round, gradeAnswer('T', 'E')), false);
  }
  round.attempts = 3;
  assert.equal(beginRecovery(round, gradeAnswer('T', 'E')), true);
  assert.equal(round.assisted, true);
  assert.deepEqual(round.recovery, { at: 3, characters: 'T', counts: {} });
  assert.equal(recoveryCharacter(round), 'T');
  assert.deepEqual(round.firstResponseTimes, [380]);
  assert.equal(round.firstGuess, 'E');
  assert.equal(round.attempts, 3);
  assert.equal(beginRecovery(round, gradeAnswer('T', 'E')), false);
  assert.deepEqual({ stats: p.stats, pacing: p.pacing, guidance: p.guidance }, before);
});

test('sound recovery teaches only missed expected letters once each and handles omissions or extra input', () => {
  const p = newProfile();
  for (const [target, answer, expected] of [['ETAN', 'EEAA', 'TN'], ['ETT', 'EAA', 'T'], ['ETAN', 'ETN', 'A'], ['ET', 'ETA', 'ET']]) {
    const round = startRound(p, target);
    round.attempts = 3;
    assert.equal(beginRecovery(round, gradeAnswer(target, answer)), true);
    assert.equal(round.recovery.characters, expected);
  }
  const round = startRound(p, 'T');
  round.attempts = 3;
  assert.equal(beginRecovery(round, gradeAnswer('T', 'T')), false);
  round.completed = true;
  assert.equal(beginRecovery(round, gradeAnswer('T', 'E')), false);
});

test('each missed letter needs three completed sounds in sequence and stale callbacks cannot count', () => {
  const p = newProfile();
  const round = startRound(p, 'TN');
  round.attempts = 3;
  beginRecovery(round, gradeAnswer('TN', 'AA'));
  const recovery = round.recovery;
  assert.equal(rememberRecoverySound(round, 'N', recovery), false);
  assert.equal(rememberRecoverySound(round, 'T', { ...recovery }), false);
  assert.equal(rememberRecoverySound(round, 'E', recovery), false);
  for (const character of ['T', 'N']) {
    for (let count = 1; count <= 3; count++) {
      assert.equal(recoveryCharacter(round), character);
      assert.equal(rememberRecoverySound(round, character, recovery), true);
      assert.equal(recovery.counts[character], count);
    }
    assert.equal(rememberRecoverySound(round, character, recovery), false);
  }
  assert.equal(recoveryCharacter(round), '');
  round.recovery = null;
  round.attempts = 6;
  assert.equal(beginRecovery(round, gradeAnswer('TN', 'AA')), true);
  assert.equal(rememberRecoverySound(round, 'T', recovery), false);
  assert.equal(round.recovery.counts.T, undefined);
});

test('recovery survives reload/import independently per learner and resets with the original round', () => {
  const state = newState(), p = state.profiles[0];
  p.settings = sanitizeSettings({ courseLevel: 2 });
  const round = startRound(p, 'TN');
  Object.assign(round, { attempts: 3, heard: true, plays: 3, firstGuess: 'AA', lastGuess: 'AA', firstResponseTimes: [250, 400] });
  beginRecovery(round, gradeAnswer('TN', 'AA'));
  rememberRecoverySound(round, 'T', round.recovery);
  rememberRecoverySound(round, 'T', round.recovery);
  state.profiles.push(newProfile('Other'));
  const restored = importState(JSON.stringify(state));
  const saved = restored.profiles[0];
  assert.deepEqual(saved.round.recovery, { at: 3, characters: 'TN', counts: { T: 2, N: 0 } });
  assert.equal(saved.round.assisted, true);
  assert.deepEqual(saved.round.firstResponseTimes, [250, 400]);
  assert.equal(restored.profiles[1].round, null);
  assert.equal(resetLearnerProgress(saved).round, null);
  finishRound(saved, { solved: true });
  assert.equal(saved.round.recovery, null);
  assert.equal(saved.round.clean, false);
  assert.equal(saved.round.speedBonus, 0);
  assert.equal(saved.round.awarded, 8);
  startRound(saved, 'ET');
  assert.equal(saved.round.recovery, null);
});

test('imported recovery is bounded to this unfinished signal, trigger and valid integer listen counts', () => {
  assert.equal(sanitizeRecovery({ at: 3, characters: 'T' }, 'T', 2), null);
  assert.equal(sanitizeRecovery({ at: 2, characters: 'T' }, 'T', 2), null);
  assert.equal(sanitizeRecovery({ at: 3, characters: {} }, 'T', 3), null);
  assert.equal(sanitizeRecovery({ at: 3, characters: 'X🙂' }, 'T', 3), null);
  assert.equal(sanitizeRecovery({ at: 3, characters: 'T', counts: { T: 3 } }, 'T', 3), null);
  assert.deepEqual(sanitizeRecovery({ at: 3, characters: 'TTNEX🙂', counts: { T: 300, N: -5, E: 2.5, X: 2 } }, 'TNE', 3), { at: 3, characters: 'TNE', counts: { T: 3, N: 0, E: 0 } });
  assert.deepEqual(sanitizeRecovery({ at: 3, characters: 'T', counts: null }, 'T', 3), { at: 3, characters: 'T', counts: { T: 0 } });
  const state = newState(), p = state.profiles[0];
  const round = startRound(p, 'T');
  Object.assign(round, { attempts: 3, completed: true, recovery: { at: 3, characters: 'T', counts: {} } });
  assert.equal(importState(JSON.stringify(state)).profiles[0].round.recovery, null);
});
