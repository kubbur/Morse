import test from 'node:test';
import assert from 'node:assert/strict';
import { MORSE, PROSIGNS, timeline, timing, gradeAnswer, patternFor } from '../../website/public/js/morse.mjs';
import { COURSE_LEVELS, expandedCourseLevel, courseStage, courseLevelFor, alphabetFor, randomPrompt, practiceKey, courseFocus, transmissionText } from '../../website/public/js/lessons.mjs';
import { COURSE_DIGITS, COURSE_MARKS, COURSE_PROSIGNS } from '../../website/public/js/course.mjs';
import { DEFAULT_SETTINGS, newState, sanitizeSettings, importState, startRound, finishRound, masteryFor, nextPracticeStep } from '../../website/public/js/progress.mjs';
import { acknowledgeGuidance, lessonGuidance, rememberGuidanceSound, guidanceListenCount, beginRecovery, recoveryCharacter, rememberRecoverySound } from '../../website/public/js/guidance.mjs';
import { createCopySession, recordCopyInput, headCopyResponse } from '../../website/public/js/recognition.mjs';

const settingsAt = courseLevel => sanitizeSettings({ ...DEFAULT_SETTINGS, courseLevel, timingMode: 'fixed' });
function copy(p, target, ms = 150) {
  startRound(p, target);
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: target, responseTimes: Array(target.replaceAll(' ', '').length).fill(ms) });
  return finishRound(p, { solved: true });
}

test('all 400 stages have playable, bounded prompts containing only taught characters and procedural signals', () => {
  assert.equal(COURSE_LEVELS, 400);
  const keys = new Set();
  for (let level = 1; level <= COURSE_LEVELS; level++) {
    const settings = settingsAt(level), stage = courseStage(level), alphabet = alphabetFor(settings);
    keys.add(practiceKey(settings));
    const prompts = stage.pool || Array.from({length: 40}, () => randomPrompt(settings));
    assert.ok(prompts.length > 0);
    for (const target of prompts) {
      const count = target.replaceAll(' ', '').length;
      assert.ok(count >= stage.minLength && count <= stage.maxLength && target.length <= 100, `${level}: ${target}`);
      assert.ok([...target].every(c => c === ' ' || alphabet.includes(c)), `${level}: ${target}`);
      const plan = timeline(transmissionText(target, settings), settings);
      assert.equal(plan.text, target);
      assert.ok(plan.duration > 0);
      assert.ok(plan.tones.every(t => !t.prosign || stage.prosigns.includes(t.prosign)));
    }
  }
  assert.equal(keys.size, COURSE_LEVELS);
  assert.equal(courseLevelFor(26, 10), 93, 'letter-count selection cannot jump past the phrase lessons');
});

test('digits and common marks arrive one at a time, keep earlier sounds, and avoid an ASCII survey', () => {
  assert.equal(new Set(COURSE_DIGITS).size, 10);
  for (let i = 0; i < 10; i++) {
    const s = settingsAt(101 + i * 4);
    assert.equal(courseFocus(s), COURSE_DIGITS[i]);
    assert.equal(s.level, 1);
    assert.equal(alphabetFor(s).replace(/[A-Z]/g, ''), COURSE_DIGITS.slice(0, i + 1));
    assert.equal(courseStage(s.courseLevel + 2).maxLength, 3);
  }
  for (let i = 0; i < COURSE_MARKS.length; i++) {
    const s = settingsAt(149 + i * 4);
    assert.equal(courseFocus(s), COURSE_MARKS[i]);
    assert.equal(alphabetFor(s).replace(/[A-Z0-9]/g, ''), COURSE_MARKS.slice(0, i + 1));
  }
  assert.equal(alphabetFor(settingsAt(400)).replace(/[A-Z0-9]/g, ''), '?/.,-');
  assert.deepEqual(courseStage(400).prosigns, COURSE_PROSIGNS);
});

test('phrase levels require varied clean copies; repeating one memorized phrase cannot finish a stage', () => {
  const p = newState().profiles[0]; p.settings = settingsAt(96);
  for (let i = 0; i < 12; i++) copy(p, 'CQ DX');
  assert.equal(masteryFor(p).windowReady, true);
  assert.equal(masteryFor(p).cleanCopies, 1);
  assert.equal(nextPracticeStep(p), null);
  copy(p, 'CQ CQ'); copy(p, 'VY FB');
  assert.equal(masteryFor(p).mastered, true);
  assert.equal(nextPracticeStep(p).courseLevel, 97);
  const state = newState(); state.profiles[0] = p; state.activeId = p.id;
  assert.equal(masteryFor(importState(JSON.stringify(state)).profiles[0]).cleanCopies, 3);
});

test('the introductory phrase lessons teach the complete exercise pool, and level 97 stays short', () => {
  for (let level = 94; level <= 100; level++) {
    const stage = courseStage(level);
    assert.deepEqual(stage.examples.map(entry => entry.text), stage.pool);
    assert.equal(new Set(stage.pool).size, stage.pool.length);
    assert.ok(stage.examples.every(entry => entry.meaning.length > 3));
  }
  const stage = courseStage(97);
  assert.ok(stage.pool.length >= 6);
  for (const text of stage.pool) {
    const words = text.split(' ');
    assert.ok(words.length <= 3, text);
    assert.ok(words.every(word => word.length <= 4), text);
  }
});

test('the shorter level 97 discards obsolete drafts and reopens its guide without losing earned progress', () => {
  const state = newState(), p = state.profiles[0];
  p.settings = settingsAt(97);
  acknowledgeGuidance(p);
  p.guidance.seen = p.guidance.seen.map(key => key.replace('cw-v4', 'cw-v3'));
  p.stats.xp = 9000; p.stats.total = 450;
  const key = practiceKey(p.settings);
  p.stats.mastery[key] = { mastered: true, unit: 'letters', recognition: Array(20).fill(200), history: Array(20).fill(true), cleanPrompts: ['NAME JOHN QTH LONDON', 'QTH IS REYKJAVIK', 'NAME IS ANNA'] };
  startRound(p, 'NAME JOHN QTH LONDON'); p.round.draft = 'NAME JO';
  const restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.round, null);
  assert.equal(restored.stats.xp, 9000);
  assert.equal(restored.stats.total, 450);
  assert.equal(restored.stats.mastery[key].mastered, true);
  assert.equal(masteryFor(restored).cleanCopies, 0, 'obsolete phrases do not count toward the updated exercise pool');
  const guide = lessonGuidance(restored);
  assert.equal(guide.first, false);
  assert.equal(guide.repetitions, 0);
  assert.deepEqual(guide.examples.map(entry => entry.text), courseStage(97).pool);
  assert.match(guide.copy, /one short name or place/);
  acknowledgeGuidance(restored);
  assert.equal(lessonGuidance(restored), null);
  assert.deepEqual(lessonGuidance(restored, { reference: true }).examples, guide.examples);
  assert.deepEqual(lessonGuidance(restored, { reference: true }).characters, []);
});

test('new digit and mark mastery requires the new sound even when familiar messages are fast', () => {
  for (const level of [101, 102, 103, 104, 149, 150, 151, 152]) {
    const p = newState().profiles[0]; p.settings = settingsAt(level);
    for(let i=0;i<22;i++) copy(p, 'E'.repeat(Math.min(3,p.settings.level)));
    assert.equal(masteryFor(p).focusGood, 0);
    assert.equal(masteryFor(p).mastered, false);
  }
});

test('procedural signals use one continuous element gap and ordinary letters keep Farnsworth spacing', () => {
  const settings = settingsAt(400), clock = timing(settings.wpm, settings.farnsworth);
  for (const [code, data] of Object.entries(PROSIGNS)) {
    assert.equal(patternFor(code), data.pattern);
    const joined = timeline(`<${code}>`, settings), ordinary = timeline(code, settings);
    assert.equal(joined.text, code);
    assert.equal(joined.tones.map(t=>t.symbol).join(''), data.pattern);
    for(let i=1;i<joined.tones.length;i++) assert.ok(Math.abs(joined.tones[i].start - joined.tones[i-1].start - joined.tones[i-1].duration - clock.elementGap) < 1e-8);
    assert.ok(ordinary.duration > joined.duration);
    const session = createCopySession(joined, 1000);
    const last = session.characters.at(-1).endsAt;
    recordCopyInput(session, code, last + 200);
    assert.ok(headCopyResponse(session) !== null);
    assert.equal(gradeAnswer(code, code.toLowerCase()).correct, true);
  }
  assert.equal(transmissionText('AS', settingsAt(94)), 'AS');
  assert.equal(transmissionText('AS', { ...settings, lesson: 'letters' }), 'AS');
  assert.equal(transmissionText('NAME SAM BT QTH OSLO KN', settings), 'NAME SAM <BT> QTH OSLO <KN>');
  for (const text of ['<XX>', '<script>', '<AR', '<AR><X>']) assert.throws(()=>timeline(text,settings), /supported/);
});

test('joined-signal introductions and error recovery retain complete-signal counts across reload', () => {
  const state = newState(), p = state.profiles[0];
  p.settings = settingsAt(168); acknowledgeGuidance(p); p.settings = settingsAt(169);
  const g = lessonGuidance(p);
  assert.deepEqual(g.characters, ['BT']); assert.equal(g.repetitions, 3);
  assert.match(g.copy, /continuous/);
  assert.equal(rememberGuidanceSound(p, 'BT'), true);
  let restored = importState(JSON.stringify(state)).profiles[0];
  assert.equal(guidanceListenCount(restored, 'BT'), 1);
  for(let i=0;i<2;i++) rememberGuidanceSound(restored, 'BT');
  assert.equal(guidanceListenCount(restored, 'BT'), 3);
  acknowledgeGuidance(restored);
  startRound(restored, 'BT'); Object.assign(restored.round, { heard:true, plays:1, attempts:3 });
  assert.equal(beginRecovery(restored.round, gradeAnswer('BT','BB'), restored.settings), true);
  assert.equal(recoveryCharacter(restored.round), 'BT');
  const state2 = { ...state, profiles:[restored], activeId:restored.id };
  restored = importState(JSON.stringify(state2)).profiles[0];
  assert.equal(recoveryCharacter(restored.round), 'BT');
  const recovery=restored.round.recovery;
  for(let i=0;i<3;i++) assert.equal(rememberRecoverySound(restored.round,'BT',recovery),true);
  assert.equal(recoveryCharacter(restored.round), '');
  const message = { target: 'NAME BOB BT QTH ROME', attempts: 3 };
  assert.equal(beginRecovery(message, gradeAnswer(message.target, 'NAME XOX BB QTH ROME'), settingsAt(171)), true);
  assert.deepEqual(message.recovery.signals, ['BT']);
  assert.equal(message.recovery.characters, 'B', 'a missed ordinary letter is still taught when it also appears in a joined signal');
});

test('prosign readiness counts complete joined tokens rather than familiar component letters', () => {
  const p = newState().profiles[0]; p.settings = settingsAt(179);
  for(let i=0;i<15;i++) copy(p,'NAME ANNA QTH OSLO');
  assert.equal(masteryFor(p).focusCharacter,'AR');
  assert.equal(masteryFor(p).focusGood,0);
  assert.equal(masteryFor(p).mastered,false);
  const pool=courseStage(179).pool.filter(text => text.split(' ').includes('AR'));
  for(let i=0;i<5;i++) copy(p,pool[i%pool.length]);
  assert.equal(masteryFor(p).focusGood,5);
  assert.equal(nextPracticeStep(p).courseLevel,180);
});

test('legacy 94–100 achievements and XP survive without granting unearned phrase readiness', () => {
  const state=newState(),p=state.profiles[0];
  p.settings={ ...DEFAULT_SETTINGS,courseLevel:100,courseCount:26,level:10 };
  delete p.settings.courseVersion;
  p.stats.xp=12345; p.stats.total=456;
  const alphabet=alphabetFor(settingsAt(93)).split('').sort().join('');
  for(let n=94;n<=100;n++) p.stats.mastery[JSON.stringify(['groups',alphabet,n===100?10:n-89,...(n===100?['mixed']:[])])] = {mastered:true,unit:'letters',recognition:Array(20).fill(100),history:Array(20).fill(true)};
  const restored=importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.stats.xp,12345); assert.equal(restored.stats.total,456);
  for(let n=94;n<=100;n++) {
    const key=practiceKey(settingsAt(n));
    assert.equal(restored.stats.mastery[key].mastered,true);
    const candidate={...restored,settings:settingsAt(n)};
    assert.equal(masteryFor(candidate).mastered,false);
  }
  assert.ok(lessonGuidance(restored));
  const again=importState(JSON.stringify({...state,profiles:[restored]})).profiles[0];
  assert.deepEqual(again.stats.mastery,restored.stats.mastery);
  p.settings.lesson='letters';
  const free=importState(JSON.stringify(state)).profiles[0];
  assert.equal(free.settings.lesson,'letters');
  for(let n=94;n<=100;n++) assert.equal(free.stats.mastery[practiceKey(settingsAt(n))].mastered,true,'course checks also migrate while free practice is selected');
});

test('final radio drafts, per-character timings, bonuses and course 400 survive valid exports', () => {
  const state=newState(),p=state.profiles[0]; p.settings=settingsAt(400);
  const target=courseStage(400).pool.find(text=>text.replaceAll(' ','').length===12);
  startRound(p,target); Object.assign(p.round,{draft:target,heard:true,plays:1,attempts:1,firstGuess:target,responseTimes:Array(target.replaceAll(' ','').length).fill(100)});
  finishRound(p,{solved:true});
  const restored=importState(JSON.stringify(state)).profiles[0];
  assert.equal(restored.round.target,target); assert.equal(restored.round.draft,target);
  assert.equal(restored.round.responseTimes.length,target.replaceAll(' ','').length);
  assert.equal(restored.round.awarded,p.round.awarded);
  assert.equal(restored.round.speedBonus,p.round.speedBonus);
  assert.equal(restored.stats.rounds.at(-1).level,target.replaceAll(' ','').length);
  assert.equal(restored.settings.courseLevel,400);
});
