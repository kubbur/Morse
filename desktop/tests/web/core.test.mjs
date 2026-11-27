import test from 'node:test';
import assert from 'node:assert/strict';
import { MORSE, timing, timeline, envelopeAt, gradeAnswer } from '../../website/public/js/morse.mjs';
import { createCopySession, recordCopyInput } from '../../website/public/js/recognition.mjs';
import { COURSE_LETTERS, COURSE_LEVELS, expandedCourseLevel, courseStage, courseLevelFor, alphabetFor, courseFocus, practiceKey, candidatesFor, randomPrompt } from '../../website/public/js/lessons.mjs';
import { STORAGE_KEY, DEFAULT_SETTINGS, newState, newProfile, sanitizeSettings, sanitizeState, loadState, saveState, importState, startRound, finishRound, masteryFor, nextPracticeStep, dayStreak, localDay } from '../../website/public/js/progress.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
const memory = () => {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
};
const cleanRound = (p, correct = true, options = {}) => {
  const round = startRound(p, 'E'.repeat(p.settings.level));
  Object.assign(round, { heard: true, plays: 1, attempts: 1, firstGuess: correct ? round.target : 'X', responseTimes: Array(p.settings.level).fill(250), ...options });
  return finishRound(p, { solved: correct });
};

test('Morse uses international letter, digit and punctuation patterns', () => {
  assert.equal(MORSE.S + MORSE.O + MORSE.S, '...---...');
  assert.equal(MORSE['0'], '-----');
  assert.equal(MORSE['?'], '..--..');
  assert.equal(MORSE['@'], '.--.-.');
});

test('PARIS plus word spacing takes exactly one word at the requested effective speed', () => {
  for (const [wpm, farnsworth] of [[30, 15], [20, 20], [80, 1], [5, 5], [40, 25]]) {
    const plan = timeline('PARIS', { wpm, farnsworth }, { trailingWordGap: true });
    close(plan.duration, 60 / farnsworth);
  }
});

test('Farnsworth stretches only character/word gaps, preserving dit and dah lengths', () => {
  const normal = timing(30, 30);
  const spaced = timing(30, 15);
  close(normal.dit, 0.04);
  close(spaced.dah, 0.12);
  close(normal.elementGap, spaced.elementGap);
  assert.ok(spaced.letterGap > normal.letterGap);
  close(spaced.wordGap / spaced.letterGap, 7 / 3);
  const ee = timeline('E E', { wpm: 30, farnsworth: 15 });
  close(ee.tones[1].start - ee.tones[0].duration, spaced.wordGap);
  assert.throws(() => timeline('🙂'));
});

test('extreme speed settings are bounded and effective speed never exceeds character speed', () => {
  const settings = sanitizeSettings({ wpm: 5, farnsworth: 80, tone: NaN, rise: -1, fall: 500, volume: 500 });
  assert.equal(settings.farnsworth, 80);
  assert.deepEqual(timing(5, 80), timing(5, 5));
  assert.equal(settings.tone, 600);
  assert.equal(settings.rise, 1);
  assert.equal(settings.fall, 30);
  assert.equal(settings.volume, 100);
});

test('envelopes have quiet endpoints, a plateau, and bounded monotonic ramps', () => {
  for (const shape of ['smooth', 'linear']) {
    for (const [duration, rise, fall] of [[0.04, 5, 5], [0.015, 30, 30]]) {
      close(envelopeAt(0, duration, rise, fall, shape), 0);
      close(envelopeAt(duration, duration, rise, fall, shape), 0);
      close(envelopeAt(duration / 2, duration, rise, fall, shape), 1);
      const values = Array.from({ length: 100 }, (_, i) => envelopeAt(i / 99 * duration, duration, rise, fall, shape));
      assert.ok(values.every(v => v >= 0 && v <= 1));
      assert.ok(values.slice(0, 50).every((v, i, a) => !i || v >= a[i - 1]));
      assert.ok(values.slice(50).every((v, i, a) => !i || v <= a[i - 1]));
    }
  }
});

test('grading handles case, whitespace, missing letters and insertions without shifting all feedback', () => {
  assert.equal(gradeAnswer('CQ DX', ' cq   dx ').correct, true);
  const missing = gradeAnswer('KMA', 'MA');
  assert.equal(missing.correct, false);
  assert.deepEqual(missing.letters.map(l => [l.expected, l.actual, l.correct]), [['K', '', false], ['M', 'M', true], ['A', 'A', true]]);
  const extra = gradeAnswer('ET', 'EXT');
  assert.equal(extra.distance, 1);
  assert.equal(extra.letters.filter(l => l.correct).length, 2);
  assert.equal(gradeAnswer('E', '').correct, false);
});

test('answer length grows independently of the selected lesson alphabet', () => {
  const settings = { ...DEFAULT_SETTINGS, lesson: 'koch', kochCount: 2, level: 7 };
  assert.equal(alphabetFor(settings), 'KM');
  const prompt = randomPrompt(settings, {}, '', () => 0.7);
  assert.equal(prompt.length, 7);
  assert.ok([...prompt].every(c => 'KM'.includes(c)));
  assert.notEqual(randomPrompt({ ...settings, level: 1 }, {}, 'M', () => 0.9), 'M');
  assert.notEqual(practiceKey(settings), practiceKey({ ...settings, kochCount: 3 }));
});

test('the growing course preserves the starter alphabet and adds only one of all 26 letters at a time', () => {
  assert.equal(alphabetFor(DEFAULT_SETTINGS), 'ETAN');
  assert.equal(COURSE_LETTERS.length, 26);
  assert.equal([...new Set(COURSE_LETTERS)].sort().join(''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.equal(sanitizeSettings({ courseCount: 500 }).courseCount, 26);
  assert.equal(sanitizeSettings({ courseCount: -1 }).courseCount, 4);
  assert.equal(sanitizeSettings({}).courseCount, 4);
  assert.equal(alphabetFor({ ...DEFAULT_SETTINGS, courseCount: 5 }), 'ETANK');
  assert.equal(courseFocus({ ...DEFAULT_SETTINGS, courseCount: 5 }), 'K');
  assert.notEqual(practiceKey(DEFAULT_SETTINGS), practiceKey({ ...DEFAULT_SETTINGS, courseCount: 5 }));
  assert.equal(practiceKey(DEFAULT_SETTINGS), JSON.stringify(['groups', 'AENT', 1]), 'old starter progress must keep the same key');
});

test('all 400 course milestones are distinct, include early triples and return to singles for each new letter', () => {
  const p = newProfile();
  const keys = new Set();
  for (let number = 1; number <= COURSE_LEVELS; number++) {
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: number });
    const stage = courseStage(number);
    const focus = courseFocus(p.settings) || 'E';
    keys.add(practiceKey(p.settings));
    for (let i = 0; i < 60 && !nextPracticeStep(p); i++) {
      const wanted = masteryFor(p).targetSound;
      const focused = wanted && stage.pool?.filter(text => wanted.length === 1 ? text.includes(wanted) : text.split(' ').includes(wanted));
      const pool = focused?.length ? focused : stage.pool;
      const target = pool ? pool[i % pool.length] : (wanted || focus).repeat(stage.maxLength);
      startRound(p, target);
      Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: target, responseTimes: Array(target.replaceAll(' ', '').length).fill(250) });
      finishRound(p, { solved: true });
      if (number === COURSE_LEVELS && masteryFor(p).mastered) break;
    }
    const step = nextPracticeStep(p);
    if (number === COURSE_LEVELS) assert.equal(step.track, 'endless');
    else {
      const following = courseStage(number + 1);
      assert.deepEqual(step, { courseLevel: number + 1, level: following.maxLength, courseCount: following.letterCount, addedCharacter: following.newSound ? following.focus : following.letterCount > stage.letterCount ? COURSE_LETTERS[following.letterCount - 1] : '' });
      if (step.addedCharacter && step.addedCharacter.length === 1) assert.equal(step.level, 1);
    }
    assert.equal(p.settings.courseLevel, number, 'a pending step must not change settings before continuation');
  }
  assert.equal(keys.size, COURSE_LEVELS);
  assert.deepEqual(courseStage(3), { letterCount: 4, minLength: 3, maxLength: 3, review: false, label: 'Triples', legacyLevel: 3 });
});

test('level 147 teaches four-digit frequencies before the later full frequency commands', () => {
  const settings = sanitizeSettings({ courseLevel: 147 }), stage = courseStage(147);
  assert.equal(settings.level, 4); assert.equal(stage.minLength, 4); assert.equal(stage.maxLength, 4);
  assert.ok(stage.pool.length >= stage.minCopies && new Set(stage.pool).size === stage.pool.length);
  assert.ok(stage.pool.every(text => /^\d{4}$/.test(text)));
  assert.deepEqual(stage.examples.map(entry => entry.text), stage.pool);
  const targets = new Set();
  for (let i = 0; i < 100; i++) targets.add(randomPrompt(settings, {}, '', () => i / 100));
  assert.deepEqual([...targets].sort(), [...stage.pool].sort());
  assert.ok(courseStage(399).pool.some(text => /^QSY /.test(text)));
  assert.ok(courseStage(400).pool.some(text => /^QSY /.test(text)));
});

test('reordered radio lessons stay short and retain every original progress key', () => {
  const legacyLengths = [2,4,3,9,9,11,8,4,6,7,16,16,1,4,7,22,1,8,10,16,1,7,9,15,1,20,15,15,1,9,14,21,2,18,21,21,2,16,16,21,2,18,21,21,2,16,16,21,2,19,20,21,2,14,14,21,20,31,30,33];
  const byEar = [];
  for (let level = 141; level <= 200; level++) {
    const number = expandedCourseLevel(level), stage = courseStage(number), cap = number < 383 ? 4 : number <= 394 ? 8 : number <= 397 ? 10 : number === 398 ? 11 : 12;
    assert.ok(stage.maxLength <= cap, `level ${level} exceeds ${cap}`);
    if (stage.byEar) byEar.push(number);
    if (stage.newSound) assert.notEqual(stage.byEar, true, 'new sounds get guided practice first');
    if (stage.pool) {
      assert.deepEqual(stage.examples.map(entry => entry.text), stage.pool);
      assert.ok(stage.pool.length > 0 && stage.pool.every(text => text.replaceAll(' ', '').length <= cap));
      const focused = stage.focus ? stage.pool.filter(text => stage.focus.length === 1 ? text.includes(stage.focus) : text.split(' ').includes(stage.focus)) : stage.pool;
      assert.ok(stage.pool.length >= stage.minCopies && focused.length > 0, `level ${level} has enough varied exercises and a copy of its focus sound`);
    }
    for (const copyMode of ['flexible', 'head']) {
      const settings = sanitizeSettings({ courseLevel: number, copyMode });
      const expected = JSON.stringify(['groups', [...(stage.progressAlphabet || alphabetFor(settings))].sort().join(''), legacyLengths[level - 141], `course:${level}`, ...(copyMode === 'head' ? ['head'] : [])]);
      assert.equal(practiceKey(settings), expected, `level ${level}, ${copyMode}: old progress key survives`);
    }
  }
  assert.equal(byEar.length, 8); assert.ok(byEar.includes(393) && byEar.includes(397));
  assert.deepEqual(byEar.slice(-4), [397, 398, 399, 400]);
});

test('audio-only course stages hide the pattern without changing visual preferences and restore that rule after reload', () => {
  for (const level of [193, 197, 292, 293, 329, 349, 392, 397, 398, 399, 400]) for (const visualSupport of ['always', 'auto', 'off']) {
    const state = newState(), p = state.profiles[0];
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: level, visualSupport });
    const settings = structuredClone(p.settings), target = courseStage(level).pool?.[0] || alphabetFor(p.settings)[0].repeat(courseStage(level).maxLength);
    startRound(p, target);
    assert.equal(p.round.earOnly, true); assert.equal(p.round.visualPhase, 'review');
    assert.deepEqual(p.settings, settings);
    p.round.earOnly = false; p.round.visualPhase = 'live';
    const q = importState(JSON.stringify(state)).profiles[0];
    assert.equal(q.round.earOnly, true); assert.equal(q.round.visualPhase, 'review');
    assert.deepEqual(q.settings, settings);
  }
});

test('shorter frequency exercises retain the old mastery key, partial meter, earned checks and sound preferences in both modes', () => {
  for (const copyMode of ['flexible', 'head']) {
    const state = newState(), p = state.profiles[0];
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: 147, copyMode, wpm: 30, farnsworth: 15, tone: 650, recallSeconds: 4, timingMode: 'fixed' });
    const key = JSON.stringify(['groups', [...alphabetFor(p.settings)].sort().join(''), 8, 'course:147', ...(copyMode === 'head' ? ['head'] : [])]);
    assert.equal(practiceKey(p.settings), key);
    const record = { unit: 'letters', samples: 120, history: Array.from({ length: 20 }, (_, i) => i % 2 === 0), recognition: Array.from({ length: 20 }, (_, i) => i % 2 ? null : 100), mastered: false, characterRecognition: {}, cleanPrompts: ['QSY 7030', 'QRV 7040', 'QRG 14050'] };
    p.stats.mastery[key] = structuredClone(record); p.stats.xp = 12345;
    p.settings.level = 8; startRound(p, 'QSY 7030'); p.round.draft = 'QSY 70';
    const restored = importState(JSON.stringify(state)).profiles[0];
    assert.equal(restored.settings.level, 4); assert.equal(restored.round, null);
    assert.equal(restored.stats.xp, 12345);
    assert.deepEqual(restored.stats.mastery[key], record);
    assert.equal(masteryFor(restored).good, 10); assert.equal(masteryFor(restored).total, 20);
    assert.equal(masteryFor(restored).cleanCopies, 0, 'obsolete full commands do not count as completed new exercises');
    for (const pref of ['wpm', 'farnsworth', 'tone', 'recallSeconds', 'timingMode', 'copyMode']) assert.equal(restored.settings[pref], p.settings[pref]);
    p.stats.mastery[key].mastered = true;
    assert.equal(importState(JSON.stringify(state)).profiles[0].stats.mastery[key].mastered, true);
    assert.deepEqual(importState(JSON.stringify({ version: 1, activeId: restored.id, profiles: [restored] })).profiles[0].stats.mastery[key], record);
  }
});

test('short frequency copies advance normally without accepting repeated or obsolete examples as variety', () => {
  const p = newProfile(); p.settings = sanitizeSettings({ ...p.settings, courseLevel: 147, timingMode: 'fixed' });
  const key = practiceKey(p.settings), stage = courseStage(147);
  const copy = target => {
    startRound(p, target); Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: target, responseTimes: Array(4).fill(200) });
    return finishRound(p, { solved: true });
  };
  for (let i = 0; i < 5; i++) copy(stage.pool[0]);
  assert.equal(masteryFor(p).good, 20); assert.equal(masteryFor(p).cleanCopies, 1); assert.equal(nextPracticeStep(p), null);
  copy(stage.pool[1]); assert.equal(nextPracticeStep(p), null);
  assert.equal(copy(stage.pool[2]).promoted, true);
  assert.equal(nextPracticeStep(p).courseLevel, 148); assert.equal(p.stats.mastery[key].mastered, true);
});

test('an unfamiliar letter cannot be mastered through quick answers using only familiar letters', () => {
  const p = newProfile();
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 5 });
  for (let i = 0; i < 20; i++) cleanRound(p);
  assert.equal(masteryFor(p).windowReady, true);
  assert.equal(masteryFor(p).focusGood, 0);
  assert.equal(masteryFor(p).mastered, false);
  assert.equal(nextPracticeStep(p), null);
  const copyK = (ms = 250, assisted = false) => {
    startRound(p, 'K');
    Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'K', responseTimes: [ms], assisted });
    return finishRound(p, { solved: true });
  };
  for (let i = 0; i < 4; i++) assert.equal(copyK().promoted, false);
  assert.equal(masteryFor(p).focusGood, 4);
  assert.equal(copyK().promoted, true);
  assert.equal(nextPracticeStep(p).level, 2);
  copyK(1501);
  assert.equal(masteryFor(p).focusReady, false);
  assert.equal(nextPracticeStep(p), null);
  copyK(250, true);
  assert.equal(masteryFor(p).focusGood, 3, 'assistance cannot count as fast recognition');
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 6 });
  assert.equal(masteryFor(p).focusGood, 0, 'new-letter readiness is separate for each length');
});

test('new letters get extra airtime while familiar letters remain in generated prompts', () => {
  const settings = { ...DEFAULT_SETTINGS, courseCount: 26 };
  const letters = new Set();
  let focusCopies = 0;
  for (let i = 0; i < 1000; i++) {
    const prompt = randomPrompt(settings, {}, '', () => i / 1000, 'X');
    letters.add(prompt);
    if (prompt === 'X') focusCopies++;
  }
  assert.equal(letters.size, 26);
  assert.ok(focusCopies >= 330 && focusCopies <= 335);
  assert.notEqual(randomPrompt(settings, {}, 'X', () => 0.99, 'X'), 'X');
});

test('course letters, introductions, and per-letter readiness survive export and reload independently for each learner', () => {
  const state = newState();
  const p = state.profiles[0];
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 5 });
  for (let i = 0; i < 20; i++) {
    startRound(p, 'K');
    Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'K', responseTimes: [250] });
    finishRound(p, { solved: true });
  }
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 9 });
  startRound(p, 'M');
  Object.assign(p.round, { introduction: true, assisted: true, draft: 'M' });
  state.profiles.push(newProfile('Second learner'));
  const restored = importState(JSON.stringify(state));
  const first = restored.profiles[0];
  assert.equal(first.settings.courseCount, 6);
  assert.equal(first.round.introduction, true);
  assert.equal(first.round.assisted, true);
  assert.equal(first.round.draft, 'M');
  assert.equal(first.stats.xp, 440);
  first.settings = sanitizeSettings({ ...first.settings, courseLevel: 5 });
  assert.equal(masteryFor(first).focusGood, 5);
  assert.equal(masteryFor(first).mastered, true);
  assert.equal(restored.profiles[1].settings.courseCount, 4);
  assert.equal(restored.profiles[1].stats.total, 0);
});

test('free practice keeps its alphabet and still advances through longer groups', () => {
  const p = newProfile();
  p.settings = { ...p.settings, lesson: 'letters', level: 2 };
  for (let i = 0; i < 20; i++) cleanRound(p);
  assert.deepEqual(nextPracticeStep(p), { level: 3, courseCount: 4, addedCharacter: '' });
  p.settings = { ...p.settings, lesson: 'starter', content: 'words', level: 2 };
  for (let i = 0; i < 20; i++) cleanRound(p);
  assert.equal(nextPracticeStep(p).level, 3);
  assert.equal(nextPracticeStep(p).addedCharacter, '');
});

test('real words respect both answer length and available characters; empty lessons stay explicit', () => {
  const settings = { ...DEFAULT_SETTINGS, lesson: 'letters', content: 'words', level: 5 };
  assert.ok(candidatesFor(settings).includes('MORSE'));
  assert.ok(candidatesFor(settings).every(c => c.length === 5));
  assert.equal(randomPrompt({ ...settings, lesson: 'numbers' }), null);
  const calls = candidatesFor({ ...settings, content: 'callsigns', lesson: 'alphanumeric' });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(c => /\d/.test(c)));
});

test('browser save restores the learner, in-progress answer, settings and mastery after reload', () => {
  const storage = memory();
  const state = newState();
  const second = newProfile('Sam');
  state.profiles.push(second);
  state.activeId = second.id;
  second.settings.level = 4;
  second.settings.lesson = 'custom';
  second.settings.showMorse = false;
  const round = startRound(second, 'ETAN');
  Object.assign(round, { draft: 'eta', plays: 2, heard: true, attempts: 1, firstGuess: 'ETNN', lastGuess: 'ETNN' });
  let cookie = '';
  assert.equal(saveState(storage, state, value => { cookie = value; }), true);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const restored = loadState(storage, cookie).state;
  assert.equal(restored.activeId, second.id);
  assert.equal(restored.profiles[1].round.draft, 'eta');
  assert.equal(restored.profiles[1].round.target, 'ETAN');
  assert.equal(restored.profiles[1].round.lastGuess, 'ETNN');
  assert.equal(restored.profiles[1].round.attempts, 1);
  assert.equal(restored.profiles[1].settings.wpm, 30);
  assert.equal(restored.profiles[1].settings.farnsworth, 15);
  assert.equal(restored.profiles[1].settings.showMorse, false);
  assert.equal(restored.profiles[0].stats.total, 0);
});

test('corrupt browser data is retained for recovery; unavailable storage is reported', () => {
  const storage = memory();
  storage.setItem(STORAGE_KEY, '{broken');
  const restored = loadState(storage);
  assert.ok(restored.warning);
  assert.equal(storage.getItem(`${STORAGE_KEY}.recovery`), '{broken');
  const failing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.match(loadState(failing).warning, /unavailable/);
  assert.equal(saveState(failing, newState()), false);
});

test('mastery requires 18 quick correct letters among 20 guesses and records the completed level', () => {
  const p = newProfile();
  for (let i = 0; i < 19; i++) cleanRound(p, i >= 2);
  assert.equal(masteryFor(p).mastered, false);
  assert.equal(cleanRound(p).promoted, true);
  assert.equal(masteryFor(p).mastered, true);
  assert.equal(p.settings.level, 1);
  assert.equal(p.stats.xp, 18 * 22);
  p.settings.level = 2;
  assert.equal(masteryFor(p).mastered, false);
  p.settings.level = 1;
  p.settings.lesson = 'letters';
  assert.equal(masteryFor(p).mastered, false);
});

test('response timing follows each character sound and preserves its original entry time', () => {
  const plan = timeline('ET', { wpm: 30, farnsworth: 3 });
  const session = createCopySession(plan, 1000);
  const [first, second] = session.characters;
  assert.deepEqual(recordCopyInput(session, 'e', first.endsAt + 100), [100]);
  assert.deepEqual(recordCopyInput(session, 'et', second.endsAt + 200), [100, 200]);
  assert.deepEqual(recordCopyInput(session, 'ET', second.endsAt + 3000), [100, 200]);
  const delayed = createCopySession(plan, 1000);
  const times = recordCopyInput(delayed, 'ET', second.endsAt + 100);
  assert.ok(times[0] > 1500, 'a slow first letter must not hide in the second letter’s fast response');
  assert.equal(times[1], 100);
  const early = createCopySession(plan, 1000);
  assert.deepEqual(recordCopyInput(early, 'ET', first.endsAt - 1), [null, null]);
  recordCopyInput(early, '', second.endsAt);
  assert.equal(recordCopyInput(early, 'ET', second.endsAt + 100)[1], 100);
});

test('pairs count as two letter guesses and triples reach mastery in seven perfect answers', () => {
  for (const level of [2, 3]) {
    const p = newProfile();
    p.settings = sanitizeSettings({ ...p.settings, courseLevel: level });
    const answers = Math.ceil(20 / level);
    for (let i = 0; i < answers - 1; i++) {
      assert.equal(cleanRound(p).promoted, false);
      assert.equal(masteryFor(p).total, (i + 1) * level);
    }
    assert.equal(cleanRound(p).promoted, true);
    assert.equal(p.stats.total, answers);
    assert.equal(masteryFor(p).good, 20);
    assert.equal(masteryFor(p).total, 20);
  }
  const p = newProfile();
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 2 });
  cleanRound(p, true, { responseTimes: [2000, 100] });
  assert.deepEqual(p.stats.mastery[practiceKey(p.settings)].recognition, [2000, 100]);
  assert.equal(masteryFor(p).good, 1, 'one slow letter must not erase the other letter’s quick recognition');
});

test('quick correct letters in an incorrect first guess keep their timing through retries and reload', () => {
  const state = newState();
  const p = state.profiles[0];
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 3 });
  startRound(p, 'ETN');
  Object.assign(p.round, { heard: true, plays: 2, attempts: 2, firstGuess: 'EXN', firstResponseTimes: [100, null, 250], responseTimes: [null, null, null], assisted: true });
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.deepEqual(restored.round.firstResponseTimes, [100, null, 250]);
  finishRound(restored, { solved: true });
  assert.deepEqual(restored.stats.mastery[practiceKey(restored.settings)].recognition, [100, null, 250]);
  assert.equal(masteryFor(restored).total, 3);
  assert.equal(masteryFor(restored).good, 2);
  assert.equal(restored.round.awarded, 8, 'group XP keeps its first-listen requirement');
});

test('a fully quick final answer earns the milestone even if a mixed-speed group already filled the letter window', () => {
  const p = newProfile();
  p.settings = sanitizeSettings({ ...p.settings, courseLevel: 2 });
  for (let i = 0; i < 9; i++) cleanRound(p);
  assert.equal(cleanRound(p, true, { responseTimes: [2000, 100] }).promoted, false);
  assert.equal(masteryFor(p).good, 19);
  assert.equal(nextPracticeStep(p), null);
  assert.equal(cleanRound(p).promoted, true);
  assert.equal(p.stats.mastery[practiceKey(p.settings)].mastered, true);
  assert.equal(nextPracticeStep(p).courseLevel, 3);
});

test('old group timing migrates conservatively to letter guesses exactly once without losing XP', () => {
  const state = newState();
  const p = state.profiles[0];
  delete p.settings.courseLevel;
  delete p.settings.courseCount;
  p.settings.level = 3;
  p.stats.xp = 2600;
  const key = practiceKey(p.settings);
  p.stats.mastery[key] = { mastered: true, history: [true, true, false], recognition: [100, 2000, null] };
  const restoredState = importState(JSON.stringify(state));
  const restored = restoredState.profiles[0];
  assert.equal(restored.settings.courseLevel, 3);
  assert.equal(restored.stats.xp, 2600);
  assert.equal(restored.stats.mastery[key].unit, 'letters');
  assert.deepEqual(restored.stats.mastery[key].recognition, [100, 100, 100, 2000, 2000, 2000, null, null, null]);
  assert.equal(masteryFor(restored).good, 3);
  assert.equal(masteryFor(restored).total, 9);
  const again = importState(JSON.stringify(restoredState)).profiles[0];
  assert.deepEqual(again.stats.mastery[key].recognition, restored.stats.mastery[key].recognition);
});

test('mixed review uses its own progress and persists different answer lengths at levels 4 and 100', () => {
  for (const courseLevel of [4, 100]) {
    const state = newState();
    const p = state.profiles[0];
    p.settings = sanitizeSettings({ ...p.settings, courseLevel });
    const stage = courseStage(courseLevel);
    const lengths = new Set();
    for (let i = 0; i < 100; i++) lengths.add(randomPrompt(p.settings, {}, '', () => i / 100).replaceAll(' ', '').length);
    assert.deepEqual([...lengths].sort((a,b) => a-b), stage.pool ? [...new Set(stage.pool.map(text => text.replaceAll(' ', '').length))].sort((a,b) => a-b) : Array.from({ length: stage.maxLength - stage.minLength + 1 }, (_, i) => stage.minLength + i));
    assert.notEqual(practiceKey(p.settings), practiceKey({ ...p.settings, courseLevel: courseLevel - 1 }));
    const target = stage.pool?.[0] || 'E'.repeat(stage.minLength);
    startRound(p, target);
    assert.equal(importState(JSON.stringify(state)).profiles[0].round.target, target);
  }
});

test('listening pays for the character speed heard, with full credit for Farnsworth spacing and a bounded quick bonus', () => {
  function award(heardWpm, farnsworth, assisted = false) {
    const p = newProfile();
    Object.assign(p.settings, {wpm:50, farnsworth});
    return cleanRound(p, true, {heardWpm, assisted, responseTimes:[]}).awarded;
  }
  assert.deepEqual([award(15,10), award(20,10), award(30,10), award(30,30), award(60,30), award(30,15,true)], [16,18,20,20,20,8]);
  const p = newProfile();
  p.settings.level = 6;
  const result = cleanRound(p);
  assert.equal(p.round.quickCharacters, 6);
  assert.equal(result.speedBonus, 8);
  assert.equal(result.awarded, 28);
  assert.equal(cleanRound(p, false).awarded, 0);
});

test('quick letters earn bonus XP, but slow correct copies cannot trigger advancement', () => {
  const p = newProfile();
  p.settings.timingMode = 'fixed';
  for (let i = 0; i < 20; i++) assert.equal(cleanRound(p, true, { responseTimes: [2000] }).promoted, false);
  assert.equal(p.stats.xp, 400);
  assert.equal(p.stats.clean, 20);
  assert.equal(masteryFor(p).mastered, false);
  for (let i = 0; i < 17; i++) assert.equal(cleanRound(p).promoted, false);
  assert.equal(cleanRound(p).promoted, true);
  assert.equal(p.round.speedBonus, 2);
  assert.equal(p.round.awarded, 22);
  assert.equal(masteryFor(p).mastered, true);
  assert.equal(cleanRound(p, true, { responseTimes: [2000] }).promoted, false);
  assert.equal(masteryFor(p).mastered, false, 'the latest copy must also be quick');
  p.settings.level = 2;
  const partial = cleanRound(p, true, { responseTimes: [100, 2000] });
  assert.equal(partial.speedBonus, 2);
  assert.equal(partial.quick, false);
  assert.equal(partial.awarded, 22);
});

test('legacy XP and achievements survive while unknown response times do not qualify for readiness', () => {
  const state = newState();
  const p = state.profiles[0];
  p.settings.timingMode = 'fixed';
  p.stats.xp = 2600;
  p.stats.mastery[practiceKey(p.settings)] = { history: Array(20).fill(true), mastered: true };
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.stats.xp, 2600);
  assert.equal(restored.stats.mastery[practiceKey(restored.settings)].mastered, true);
  assert.equal(masteryFor(restored).mastered, false);
  assert.equal(cleanRound(restored, true, { responseTimes: [] }).speedBonus, 0);
  assert.equal(masteryFor(restored).good, 0);
  restored.settings.recallSeconds = 0.5;
  for (let i = 0; i < 20; i++) cleanRound(restored, true, { responseTimes: [1000] });
  assert.equal(masteryFor(restored).mastered, false);
  restored.settings.recallSeconds = 1.5;
  assert.equal(masteryFor(restored).mastered, true);
  const saved = importState(JSON.stringify({ ...state, profiles: [restored] })).profiles[0];
  assert.equal(masteryFor(saved).mastered, true);
});

test('help, retries, stopped audio and replays cannot earn a clean copy; rounds cannot score twice', () => {
  const p = newProfile();
  for (const options of [{ assisted: true }, { plays: 2 }, { attempts: 2 }, { heard: false }]) {
    assert.equal(cleanRound(p, true, options).clean, false);
    assert.equal(finishRound(p, { solved: true }), null);
  }
  assert.equal(p.stats.total, 4);
  assert.equal(p.stats.xp, 32);
  assert.equal(masteryFor(p).good, 0);
});

test('streaks include yesterday and survive month boundaries without counting skipped days', () => {
  const now = new Date(2026, 10, 1, 15);
  const days = { '2026-10-30': 1, '2026-10-31': 3 };
  assert.equal(dayStreak({ days }, now), 2);
  days[localDay(now)] = 1;
  assert.equal(dayStreak({ days }, now), 3);
  assert.equal(dayStreak({ days }, new Date(2026, 10, 3, 15)), 0);
});

test('imports are versioned, bounded, sanitized, and keep a freely chosen advanced level', () => {
  const state = newState();
  state.profiles[0].settings.level = 10;
  state.profiles[0].settings.courseLevel = 100;
  state.profiles[0].settings.lesson = 'missing';
  state.profiles[0].settings.custom = 'ET🙂';
  const restored = importState(JSON.stringify(state));
  assert.equal(restored.profiles[0].settings.level, courseStage(100).maxLength);
  assert.equal(restored.profiles[0].settings.lesson, 'starter');
  assert.equal(restored.profiles[0].settings.custom, 'ET');
  Object.defineProperty(state.profiles[0].stats.characters, '__proto__', { value: { polluted: true }, enumerable: true });
  assert.throws(() => importState(JSON.stringify(state)), /unsupported/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => importState('{broken'), /valid JSON/);
  assert.throws(() => sanitizeState({ version: 8, profiles: [] }), /version 1/);
  assert.throws(() => importState('x'.repeat(2_000_001)), /smaller/);
});
