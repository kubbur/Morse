import test from 'node:test';
import assert from 'node:assert/strict';
import { COURSE_LEVELS, COURSE_LETTERS, EAR_COURSE_START, EAR_COURSE_END, expandedCourseLevel, legacyCourseLevel, courseStage, alphabetFor, practiceKey, randomPrompt } from '../../website/public/js/lessons.mjs';
import { COURSE_DIGITS, COURSE_MARKS, COURSE_PROSIGNS } from '../../website/public/js/course.mjs';
import { newProfile, sanitizeSettings, importState, loadState, STORAGE_KEY, startRound, finishRound, masteryFor, nextPracticeStep } from '../../website/public/js/progress.mjs';
import { acknowledgeGuidance, guidanceKey, lessonGuidance, rememberGuidanceSound, guidanceListenCount } from '../../website/public/js/guidance.mjs';
import { beginListening, queueListening } from '../../website/public/js/by-ear.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

const at = (level, extra = {}) => sanitizeSettings({ courseLevel: level, timingMode: 'fixed', ...extra });
const restored = p => importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
function copy(p, target, extra = {}) {
  startRound(p, target);
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: target, responseTimes: Array(target.replaceAll(' ', '').length).fill(100), ...extra });
  return finishRound(p, { solved: true });
}

test('guided radio symbols precede a full hundred-level alphabet restart from E and T', () => {
  assert.equal(COURSE_LEVELS, 400); assert.equal(EAR_COURSE_START, 193); assert.equal(EAR_COURSE_END, 392);
  for (const [index, sound] of [...COURSE_MARKS, ...COURSE_PROSIGNS].entries()) {
    const level = 149 + index * 4, stage = courseStage(level);
    assert.equal(stage.focus, sound); assert.equal(stage.newSound, true); assert.notEqual(stage.byEar, true);
  }
  for (let count = 2; count <= 26; count++) for (let phase = 0; phase < 4; phase++) {
    const level = 193 + (count - 2) * 4 + phase, stage = courseStage(level), settings = at(level);
    assert.equal(stage.audioAlphabet, true); assert.equal(stage.byEar, true);
    assert.equal(stage.letterCount, count); assert.equal(alphabetFor(settings), COURSE_LETTERS.slice(0, count));
    assert.equal(stage.maxLength, phase === 3 ? 3 : phase + 1);
    assert.equal(stage.minLength, phase === 3 ? 1 : phase + 1);
    assert.equal(stage.focus, count > 2 ? COURSE_LETTERS[count - 1] : '');
    for (let i = 0; i < 10; i++) {
      const target = randomPrompt(settings, {}, '', () => i / 10);
      assert.ok([...target].every(c => alphabetFor(settings).includes(c)));
    }
  }
  assert.equal(alphabetFor(at(193)), 'ET'); assert.equal(at(193).level, 1);
  assert.equal(at(197).level, 1); assert.equal(alphabetFor(at(197)), 'ETA');
});

test('the second hundred levels rebuild digits, punctuation and joined signals before short mixed radio reviews', () => {
  for (let count = 2; count <= 10; count++) for (let phase = 0; phase < 4; phase++) {
    const level = 293 + (count - 2) * 4 + phase, stage = courseStage(level);
    assert.equal(stage.audioNumbers, true); assert.equal(alphabetFor(at(level)), COURSE_DIGITS.slice(0, count));
    assert.equal(stage.focus, count > 2 ? COURSE_DIGITS[count - 1] : '');
  }
  for (let i = 0; i < 5; i++) {
    const stage = courseStage(329 + i * 4);
    assert.equal(stage.focus, COURSE_MARKS[i]); assert.equal(stage.maxLength, 1);
    assert.equal(stage.marks, COURSE_MARKS.slice(0, i + 1));
  }
  for (let i = 0; i < 6; i++) {
    const stage = courseStage(349 + i * 4);
    assert.equal(stage.focus, COURSE_PROSIGNS[i]); assert.deepEqual(stage.prosigns, COURSE_PROSIGNS.slice(0, i + 1));
  }
  for (let level = 193; level <= 392; level++) {
    const stage = courseStage(level);
    assert.equal(stage.byEar, true); assert.ok(stage.maxLength <= (level < 383 ? 4 : 8));
    assert.equal(legacyCourseLevel(level), null);
    if (stage.pool) {
      const p = newProfile(); p.settings = at(level);
      assert.deepEqual(lessonGuidance(p, { reference: true }).examples.map(row => row.text), stage.pool);
    }
  }
  for (const [level, max] of [[397, 10], [398, 11], [399, 12], [400, 12]]) assert.ok(courseStage(level).maxLength <= max);
});

test('all original course records retain their keys while the added levels have separate blind mastery', () => {
  const seen = new Set();
  for (let old = 1; old <= 200; old++) {
    const level = expandedCourseLevel(old), stage = courseStage(level);
    assert.equal(stage.legacyLevel, old); assert.equal(legacyCourseLevel(level), old);
    for (const mode of ['flexible', 'head']) {
      const settings = at(level, { copyMode: mode }), key = practiceKey(settings);
      assert.equal(seen.has(key), false); seen.add(key);
      if (old >= 94) assert.equal(JSON.parse(key)[3], `course:${old}`);
    }
  }
  for (let level = 193; level <= 392; level++) for (const copyMode of ['flexible', 'head']) {
    const key = practiceKey(at(level, { copyMode }));
    assert.equal(seen.has(key), false); seen.add(key);
    assert.equal(JSON.parse(key)[3], `ear:${level}`);
  }
  assert.equal(seen.size, 800);
});

test('old saved positions resume their actual lessons without skipping the symbol introductions or the alphabet rebuild', () => {
  for (const old of [1, 93, 100, 147, 148, 149, 150, 152, 153, 173, 196, 197, 200]) {
    for (const copyMode of ['flexible', 'head']) {
      const p = newProfile(), mapped = expandedCourseLevel(old);
      p.settings = at(mapped, { copyMode, wpm: 30, farnsworth: 15, tone: 650, recallSeconds: 4 });
      const key = practiceKey(p.settings);
      p.stats.xp = 12345; p.stats.total = 450;
      p.stats.mastery[key] = { unit: 'letters', samples: 120, mastered: true, history: Array(20).fill(true), recognition: Array(20).fill(100), characterRecognition: {} };
      p.settings.courseLevel = old; p.settings.courseVersion = 2;
      const q = restored(p);
      assert.equal(q.settings.courseVersion, 3);
      assert.equal(q.settings.courseLevel, old >= 149 && old <= 152 ? 149 : old >= 197 ? 193 : mapped);
      assert.equal(q.settings.earReturnLevel, old >= 149 && old <= 152 || old >= 197 ? mapped : 0);
      assert.equal(q.stats.xp, 12345); assert.equal(q.stats.total, 450); assert.equal(q.stats.mastery[key].mastered, true);
      for (const pref of ['copyMode', 'wpm', 'farnsworth', 'tone', 'recallSeconds']) assert.equal(q.settings[pref], p.settings[pref]);
      assert.deepEqual(restored(q), q, 'upgrading the course is idempotent');
      if (q.settings.earReturnLevel) {
        q.settings = at(392, { ...q.settings, courseLevel: 392 });
        const pool = courseStage(392).pool;
        for (let i = 0; i < 20 && !nextPracticeStep(q); i++) copy(q, pool[i % pool.length]);
        assert.equal(nextPracticeStep(q).courseLevel, mapped);
      }
    }
  }
});

test('renumbered symbol teaching retains partial three-listen counts and does not forget them after blind practice', () => {
  const p = newProfile(); p.settings = at(168); acknowledgeGuidance(p); p.settings = at(169);
  rememberGuidanceSound(p, 'BT'); rememberGuidanceSound(p, 'BT');
  const key = guidanceKey(p.settings); p.settings.courseVersion = 2; p.settings.courseLevel = 173;
  const q = restored(p);
  assert.equal(q.settings.courseLevel, 169); assert.equal(guidanceKey(q.settings), key); assert.equal(guidanceListenCount(q, 'BT'), 2);
  q.settings = at(192); acknowledgeGuidance(q);
  for (const level of [193, 293, 349, 392, 393, 394, 395, 396, 397]) {
    q.settings = at(level); const detail = lessonGuidance(q);
    assert.deepEqual(detail.characters, [], `level ${level} must not reteach the known symbol alphabet`);
    acknowledgeGuidance(q);
  }
  assert.ok([...COURSE_MARKS].every(c => q.guidance.alphabet.includes(c)));
  assert.deepEqual(q.guidance.prosigns, COURSE_PROSIGNS);
});

test('blind letter and digit introductions do not expose patterns or inherit guided mastery, and replayed/helped guesses cannot advance them', () => {
  for (const level of [193, 197, 293, 297, 329, 349]) for (const copyMode of ['flexible', 'head']) {
    const p = newProfile(); p.settings = at(192); acknowledgeGuidance(p); p.settings = at(level, { visualSupport: 'always', copyMode });
    const guide = lessonGuidance(p);
    assert.deepEqual(guide.characters, []); assert.equal(guide.repetitions, 0);
    assert.match(guide.instruction, /pattern appears after/);
    if (level === 193) assert.match(guide.copy, /Start again with E and T/);
    const target = courseStage(level).pool?.[0] || alphabetFor(p.settings)[0];
    startRound(p, target); assert.equal(p.round.earOnly, true); assert.equal(p.round.visualPhase, 'review');
    assert.equal(masteryFor(p).total, 0);
    copy(p, target, { assisted: true, visualUsed: true }); assert.equal(masteryFor(p).good, 0);
    copy(p, target, { plays: 2 }); assert.equal(masteryFor(p).good, 0);
    assert.equal(nextPracticeStep(p), null);
  }
  const p = newProfile(); p.settings = at(193);
  for (let i = 0; i < 20; i++) copy(p, i % 2 ? 'E' : 'T');
  assert.equal(nextPracticeStep(p).courseLevel, 194); assert.equal(nextPracticeStep(p).level, 2);
  p.settings = at(197);
  for (let i = 0; i < 20; i++) copy(p, 'E');
  assert.equal(nextPracticeStep(p), null, 'the added A must be recognised independently');
  for (let i = 0; i < 5; i++) copy(p, 'A');
  assert.equal(nextPracticeStep(p).courseLevel, 198);
});

test('an old phone reconnect cannot reset another device’s blind section or double its saved score', () => {
  const old = newProfile(); old.settings = { ...at(393), courseVersion: 2, courseLevel: 149 }; old.stats.xp = 1000;
  const local = structuredClone(old); local.stats.xp += 20;
  const remote = syncProfile(old); remote.settings = at(205, { earReturnLevel: 393 }); remote.stats.xp += 40;
  const merged = mergeProgress(old, local, remote);
  assert.equal(merged.settings.courseLevel, 205); assert.equal(merged.settings.earReturnLevel, 393); assert.equal(merged.stats.xp, 1060);
  assert.deepEqual(mergeProgress(merged, merged, merged), merged);
});

test('old pending six-letter checkpoints cannot replace the new one-character alphabet exercises', () => {
  const p = newProfile(); p.settings = at(193);
  p.listening.records['flexible:100'] = { letters: 4, passed: false, covered: ['Q'] };
  assert.equal(beginListening(p), false); assert.equal(queueListening(p, 192), false);
  assert.equal(p.listening.active, null);
  assert.equal(randomPrompt(p.settings).length, 1);
  const q = restored(p); assert.equal(q.listening.active, null); assert.equal(q.listening.records['flexible:100'].letters, 4);
});

test('the first browser upgrade keeps the original save once and storage failures do not discard its score', () => {
  const p = newProfile(); p.settings = { ...at(393), courseVersion: 2, courseLevel: 149 }; p.stats.xp = 12345;
  const raw = JSON.stringify({ version: 1, activeId: p.id, profiles: [p] }), values = new Map([[STORAGE_KEY, raw]]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const first = loadState(storage);
  assert.equal(first.state.profiles[0].settings.courseLevel, 149); assert.equal(first.state.profiles[0].stats.xp, 12345);
  assert.equal(values.get(`${STORAGE_KEY}.before-audio-course`), raw);
  values.set(STORAGE_KEY, JSON.stringify(first.state)); loadState(storage);
  assert.equal(values.get(`${STORAGE_KEY}.before-audio-course`), raw);
  const full = loadState({ getItem: key => key === STORAGE_KEY ? raw : null, setItem: () => { throw new Error('quota'); } });
  assert.equal(full.state.profiles[0].stats.xp, 12345); assert.equal(full.state.profiles[0].settings.courseLevel, 149);
});

test('existing endless-radio graduates keep their access, rank and score after the course expands', () => {
  const p = newProfile(); p.settings = at(400);
  p.stats.mastery[practiceKey(p.settings)] = { mastered: true, unit: 'letters', history: [], recognition: [], characterRecognition: {} };
  Object.assign(p.settings, { courseVersion: 2, courseLevel: 200, track: 'endless' });
  Object.assign(p.endless, { rank: 3, missionRank: 3, xp: 40, earned: 240, contacts: 2 }); p.stats.xp = 5000;
  p.guidance = { ...p.guidance, welcomed: true, alphabet: alphabetFor(at(400)), prosigns: COURSE_PROSIGNS, seen: [JSON.stringify(['starter', 'groups', alphabetFor(at(400)), 200, 'endless'])] };
  const q = restored(p);
  assert.equal(q.settings.track, 'endless'); assert.equal(q.settings.courseLevel, 400); assert.equal(q.endless.unlocked, true);
  assert.equal(q.endless.rank, 3); assert.equal(q.endless.xp, 40); assert.equal(q.endless.contacts, 2); assert.equal(q.stats.xp, 5000);
  assert.equal(lessonGuidance(q), null, 'the existing endless guide stays acknowledged');
});
