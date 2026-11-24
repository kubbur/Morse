import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { courseStage, alphabetFor, practiceKey, randomPrompt, transmissionText } from '../../website/public/js/lessons.mjs';
import { COURSE_MARKS, COURSE_PROSIGNS } from '../../website/public/js/course.mjs';
import { newProfile, sanitizeSettings, startRound, finishRound, masteryFor, nextPracticeStep, importState } from '../../website/public/js/progress.mjs';
import { acknowledgeGuidance, lessonGuidance } from '../../website/public/js/guidance.mjs';
import { soundUnits } from '../../website/public/js/review.mjs';
import { queueListening, beginListening, activeListening, listeningPrompt, validListeningTarget, checkpointSettings, leaveListening, listeningCheckpoint, sanitizeListening } from '../../website/public/js/by-ear.mjs';
import { emptyEndless, sanitizeEndless, radioMission, nextRadioStep } from '../../website/public/js/endless.mjs';
import { timeline } from '../../website/public/js/morse.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

const at = (level, extra = {}) => sanitizeSettings({ courseLevel: level, timingMode: 'fixed', ...extra });
const restore = p => importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
function copy(p, target, extra = {}, checkpoint = false) {
  startRound(p, target, { byEar: checkpoint });
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: target, draft: target, responseTimes: Array(target.replaceAll(' ', '').length).fill(100), ...extra });
  return finishRound(p, { solved: true });
}
const has = (text, sound, stage) => soundUnits(text, stage.prosigns || []).some(unit => unit.sound === sound);

test('no fixed lessons repeat their exercise pool in the same listening mode, and long copies only follow the full by-ear rebuild', () => {
  const pools = new Set();
  for (let n = 1; n <= 400; n++) {
    const stage = courseStage(n);
    if (n < 383) assert.ok(stage.maxLength <= 4, `long answer at level ${n}`);
    if (n > 1) assert.ok(stage.maxLength <= courseStage(n - 1).maxLength + 2, `length jump at level ${n}`);
    if (!stage.pool) continue;
    const key = JSON.stringify([!!stage.byEar, [...stage.pool].sort()]);
    assert.equal(pools.has(key), false, `duplicate exercise set at level ${n}`); pools.add(key);
    assert.deepEqual(stage.examples.map(entry => entry.text), stage.pool);
    for (const sound of stage.requiredSounds || []) assert.ok(stage.pool.some(text => has(text, sound, stage)), `${n} cannot assess ${sound}`);
  }
  assert.equal(courseStage(97).maxLength, 4);
  assert.ok(courseStage(388).pool.includes('QSY 7030'));
  assert.ok(courseStage(395).pool.includes('NAME IS ANNA'));
  assert.equal(courseStage(400).maxLength, 12);
});

test('cumulative punctuation and procedural reviews assess every earlier sound in their section', () => {
  for (let i = 0; i < 5; i++) {
    const stage = courseStage(152 + i * 4);
    assert.deepEqual(stage.requiredSounds, [...COURSE_MARKS.slice(0, i + 1)]);
    for (const sound of stage.requiredSounds) assert.ok(stage.pool.some(text => has(text, sound, stage)));
  }
  for (let i = 0; i < 6; i++) for (const first of [172, 352]) {
    const stage = courseStage(first + i * 4);
    assert.deepEqual(stage.requiredSounds, COURSE_PROSIGNS.slice(0, i + 1));
    for (const sound of stage.requiredSounds) assert.ok(stage.pool.some(text => has(text, sound, stage)));
  }
});

test('a review cannot be passed by repeating its newest sound, and tells practice which missing sound to select', () => {
  const p = newProfile(); p.settings = at(156);
  for (let i = 0; i < 22; i++) copy(p, ['/P', '/M', '/QRP'][i % 3]);
  const before = masteryFor(p);
  assert.equal(before.windowReady, true); assert.equal(before.focusReady, true); assert.equal(before.copiesReady, true);
  assert.equal(before.coverageReady, false); assert.deepEqual(before.missingSounds, ['?']); assert.equal(before.targetSound, '?');
  assert.equal(nextPracticeStep(p), null);
  assert.ok(randomPrompt(p.settings, {}, '', () => 0, before.targetSound).includes('?'));
  copy(p, 'QRL?');
  assert.equal(masteryFor(p).mastered, true); assert.equal(nextPracticeStep(p).courseLevel, 157);
  copy(p, 'QRL?', { mistakes: [{ expected: 'Q', actual: 'X' }] });
  assert.equal(masteryFor(p).mastered, false, 'a later incorrect copy still affects the letter window');
});

test('whole joined signals, not their component letters, satisfy cumulative signal coverage after reload and sync', () => {
  const p = newProfile(); p.settings = at(356);
  for (let i = 0; i < 16; i++) copy(p, ['AS', 'R AS', 'TU AS'][i % 3]);
  assert.equal(masteryFor(p).windowReady, true); assert.equal(masteryFor(p).focusReady, true);
  assert.deepEqual(masteryFor(p).missingSounds, ['BT']);
  copy(p, 'B T'); assert.deepEqual(masteryFor(p).missingSounds, ['BT']);
  const q = restore(p); assert.deepEqual(masteryFor(q).missingSounds, ['BT']);
  const base = syncProfile(q); copy(q, 'BT');
  const merged = mergeProgress(base, q, base);
  assert.equal(masteryFor(merged).coverageReady, true);
  assert.equal(masteryFor(merged).mastered, true);
  assert.equal(merged.stats.mastery[practiceKey(q.settings)].characterRecognition.BT.at(-1), 100);
});

test('all 800 prior mastery identities and earned flags survive the curriculum revision', () => {
  const keys = [];
  for (let n = 1; n <= 400; n++) for (const copyMode of ['flexible', 'head']) keys.push(practiceKey(at(n, { copyMode })));
  // Snapshot of the previously deployed 400-level identity contract, before
  // changing answer lengths or the active radio-review alphabet.
  assert.equal(createHash('sha256').update(JSON.stringify(keys)).digest('hex'), '1cca2c0d4e61cf61ab26c26dc5227b5bc3b6e533b7041b349a3c7f806409251c');
  const p = newProfile(); p.settings = at(97); p.stats.xp = 12345;
  for (const key of keys) p.stats.mastery[key] = { mastered: true, unit: 'letters', history: [], recognition: [], characterRecognition: {} };
  const q = restore(p);
  assert.equal(q.stats.xp, 12345); assert.equal(Object.keys(q.stats.mastery).length, 800);
  assert.ok(Object.values(q.stats.mastery).every(record => record.mastered));
});

test('changed lessons reopen their complete new guide while unfinished new-sound teaching retains its key', () => {
  const p = newProfile(); p.settings = at(97); p.guidance.welcomed = true;
  acknowledgeGuidance(p);
  p.guidance.seen = p.guidance.seen.map(key => key.replace('cw-v4', 'cw-v3'));
  const guide = lessonGuidance(restore(p));
  assert.ok(guide); assert.match(guide.copy, /one short name or place/);
  assert.deepEqual(guide.examples.map(row => row.text), courseStage(97).pool);
  assert.equal(guide.repetitions, 0);
});

test('fourteen small refreshers revisit earlier digits, marks, signals and letters without expanding the rebuild alphabet', () => {
  const levels = Array.from({ length: 400 }, (_, i) => i + 1).filter(n => listeningCheckpoint(n)?.maintenance);
  assert.equal(levels.length, 14);
  const heard = new Set();
  for (const level of levels) for (const copyMode of ['flexible', 'head']) {
    const p = newProfile(); p.settings = at(level + 1, { copyMode });
    const alphabet = alphabetFor(p.settings), key = practiceKey(p.settings), pacing = structuredClone(p.pacing);
    assert.equal(queueListening(p, level), true);
    assert.equal(activeListening(p).maintenance, true);
    assert.match(p.listening.active.id, /:ear:/);
    const taught = checkpointSettings(p.settings, level);
    let count = 0;
    while (!activeListening(p).passed && count++ < 6) {
      const target = listeningPrompt(p, p.round?.target || '', () => 0);
      assert.equal(validListeningTarget(p, target), true);
      const plan = timeline(transmissionText(target, taught), taught);
      if (COURSE_PROSIGNS.includes(target)) assert.equal(plan.tones[0].prosign, target);
      heard.add(target);
      copy(p, target, { responseTimes: Array(target.length).fill(9000) }, true);
    }
    assert.equal(activeListening(p).passed, true);
    const q = restore(p);
    assert.equal(activeListening(q).passed, true); assert.deepEqual(q.round, p.round);
    assert.equal(alphabetFor(q.settings), alphabet); assert.equal(q.stats.mastery[key], undefined); assert.deepEqual(q.pacing, pacing);
    const paired = syncProfile(q); assert.equal(paired.listening.active, null);
    assert.equal(Object.values(paired.listening.records)[0].passed, true);
  }
  assert.ok([...COURSE_MARKS, ...COURSE_PROSIGNS].every(sound => heard.has(sound)));
});

test('a deferred refresher retains its counter, retries after normal practice, and cannot activate at the E/T restart', () => {
  const p = newProfile(); p.settings = at(229); queueListening(p, 228);
  copy(p, 'BT', { responseTimes: [9000, 9000] }, true);
  const id = p.listening.active.id;
  leaveListening(p); assert.equal(beginListening(p), false);
  for (let i = 0; i < 8; i++) copy(p, 'L');
  assert.equal(beginListening(p), true); assert.equal(activeListening(p).letters, 2);
  assert.equal(p.listening.active.id, id);
  p.settings = at(193); assert.equal(restore(p).listening.active, null);
  assert.equal(queueListening(p, 192), false); assert.equal(beginListening(p), false);
});

test('imported refresher metadata cannot create arbitrary positions, targets or playback signals', () => {
  const p = newProfile(); p.settings = at(205); const ownerKey = practiceKey(p.settings);
  p.listening = sanitizeListening({
    records: { 'flexible:ear:204': { letters: 1, covered: ['5'] }, 'flexible:ear:193': { letters: 6, passed: true }, 'flexible:ear:0204': { letters: 6 }, 'flexible:204': { letters: 6 }, 'head:ear:999': { letters: 6 } },
    active: { id: 'flexible:ear:204', ownerKey, misses: 0, pool: ['<script>', 'BT'], prosigns: ['EVIL'] },
  }, p.settings);
  assert.deepEqual(Object.keys(p.listening.records), ['flexible:ear:204']);
  assert.equal(activeListening(p).pool.includes('<script>'), false);
  assert.equal(validListeningTarget(p, '5'), true);
  assert.equal(validListeningTarget(p, 'BT'), false);
  assert.equal(validListeningTarget(p, 'A'), false);
  startRound(p, 'BT', { byEar: true }); assert.equal(restore(p).round, null);
});

test('new endless contacts start at the course length and expand gradually without changing a running contact', () => {
  for (let rank = 1; rank <= 30; rank++) {
    const e = { ...emptyEndless(), rank, missionRank: rank };
    for (let i = 0; i < 30; i++) {
      const mission = radioMission(e), limit = Math.min(40, 12 + Math.floor((rank - 1) / 3) * 2);
      assert.ok(mission.text.replaceAll(' ', '').length <= limit, `${rank}: ${mission.text}`);
      assert.ok(mission.text && mission.text.length <= 100);
      const current = mission.text; e.rank++;
      assert.equal(radioMission(e).text, current); e.rank--;
      nextRadioStep(e);
    }
  }
});

test('an existing endless contact keeps its original message until the next contact adopts the shorter progression', () => {
  const old = { ...emptyEndless(), rank: 1, missionRank: 1, step: 2 }; delete old.formatVersion;
  const e = sanitizeEndless(old), text = radioMission(e).text;
  assert.equal(e.formatVersion, 1); assert.ok(text.replaceAll(' ', '').length > 12);
  assert.equal(radioMission(sanitizeEndless(e)).text, text);
  nextRadioStep(e); nextRadioStep(e); nextRadioStep(e);
  assert.equal(e.step, 0); assert.equal(e.formatVersion, 2);
  assert.ok(radioMission(e).tasks.every(task => task.text.replaceAll(' ', '').length <= 12));
});
