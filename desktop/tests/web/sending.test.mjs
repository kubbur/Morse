import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline, timing, MORSE } from '../../website/public/js/morse.mjs';
import { SENDING_LEVELS, SENDING_CHAPTERS, SENDING_LETTERS, SENDING_DIGITS, sendingStage, sendingTokens, sendingExercise, legacySendingLevel } from '../../website/public/js/sending-course.mjs';
import { emptySending, sanitizeSending, sanitizeSendingSettings, gradeSending, decodeSending, recordSending, sendingMastery, advanceSending, mergeSending, SEND_BADGES, earnedSendBadges } from '../../website/public/js/sending.mjs';
import { PaddleKeyer, PaddleConnection, paddleSnapshot, PADDLE_URL } from '../../website/public/js/paddle.mjs';
import { newProfile, sanitizeState, resetLearnerProgress, resetSendingProgress, importState, startRound, finishRound } from '../../website/public/js/progress.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

const settings = { wpm: 30, farnsworth: 15 };
function edgesFor(text, s = settings) {
  return timeline(text, s).tones.flatMap(t => [{ down: true, at: t.start * 1000 }, { down: false, at: (t.start + t.duration) * 1000 }]);
}
function pass(s, target = sendingExercise(s, '', () => 0).target) {
  const grade = gradeSending(edgesFor(target, s.settings), target, s.settings, sendingStage(s.level));
  return recordSending(s, target, grade);
}

test('clean sending rewards accurate manual timing before measured on-air speed', () => {
  function award(wpm, farnsworth=wpm, stretch=1, text='EE', assisted=false) {
    const s=emptySending(); s.level=4;
    const setup={wpm,farnsworth};
    const edges=edgesFor(text,setup).map(e=>({...e,at:e.at*stretch}));
    const grade=gradeSending(edges,'EE',setup,sendingStage(4));
    return recordSending(s,'EE',grade,{assisted}).xp;
  }
  assert.deepEqual([award(15),award(20),award(30),award(60)], [16,17,18,18]);
  assert.equal(award(30,30,1.15),12);
  assert.equal(award(50,8),16);
  assert.equal(award(30,30,1,'TT'),0);
  assert.equal(award(30,30,1,'EE',true),0);
});

test('sending badges credit saved practice, announce each new milestone once and award no extra XP', () => {
  const p = newProfile(), s = p.sending;
  const grade = gradeSending(edgesFor('E'), 'E', settings);
  assert.deepEqual(recordSending(s, 'E', grade, { assisted: true }).badges, []);
  const first = pass(s, 'E');
  assert.deepEqual(first.badges.map(b => b.id), ['send-first']); assert.equal(first.xp, 10);
  assert.deepEqual(pass(s, 'E').badges, []);
  s.level = 4;
  assert.deepEqual(pass(s, 'EE').badges.map(b => b.id), ['send-group']);
  Object.assign(s, { clean: 9, attempts: 10, characters: 11 });
  assert.deepEqual(pass(s, 'EE').badges.map(b => b.id), ['send-ten']);
  Object.assign(s, { clean: 99, attempts: 110, characters: 998 });
  s.sounds = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => [c, {seen:1,good:1,recent:[true]}]));
  assert.deepEqual(pass(s, 'EE').badges.map(b => b.id), ['send-hundred','send-thousand']);
  const expected = ['send-first','send-group','send-ten','send-hundred','send-alphabet','send-thousand','send-clean-25','send-clean-50',
    'send-characters-50','send-characters-250','send-characters-500','send-dit-dah','send-vowels','send-cq','send-report'];
  for (const reloaded of [resetSendingProgress(p), syncProfile(p), importState(JSON.stringify({version:1,profiles:[p],activeId:p.id})).profiles[0]]) {
    assert.deepEqual(earnedSendBadges(reloaded.sending).map(b => b.id), expected);
  }
  assert.deepEqual(earnedSendBadges(emptySending()), []);
});

test('sending has 218 contiguous levels, a full alphabet and all ten digits before symbols and replies', () => {
  assert.equal(SENDING_LEVELS, 218);
  assert.deepEqual(SENDING_CHAPTERS.flatMap(c => Array.from({ length: c.end - c.start + 1 }, (_, i) => c.start + i)), Array.from({ length: SENDING_LEVELS }, (_, i) => i + 1));
  assert.equal(sendingStage(1).focus + sendingStage(2).focus + Array.from({ length: 24 }, (_, i) => sendingStage(9 + i * 4).focus).join(''), SENDING_LETTERS);
  assert.equal(Array.from({ length: 10 }, (_, i) => sendingStage(113 + i * 4).focus).join(''), SENDING_DIGITS);
  assert.equal(sendingStage(153).focus, '?'); assert.equal(sendingStage(173).focus, '<BT>');
  assert.equal(sendingStage(207).kind, 'reply'); assert.equal(sendingStage(SENDING_LEVELS).items.length, 5);
});

test('all sending exercises use taught characters and perfect timestamps pass every exercise', () => {
  for (let level = 1; level <= SENDING_LEVELS; level++) {
    const stage = sendingStage(level);
    for (const item of stage.items) {
      for (const token of sendingTokens(item.target)) assert.ok(token.pattern, `${level}: ${item.target}`);
      for (const c of item.target.replace(/<(BT|AS|AR|KN|SK|BK)>/g, '').replaceAll(' ', '')) assert.ok(stage.known.includes(c), `${level}: ${c} not yet taught`);
      if (item.incoming) assert.ok(timeline(item.incoming, settings).tones.length);
      const grade = gradeSending(edgesFor(item.target), item.target, settings, stage);
      assert.equal(grade.correct, true, `${level}: ${item.target}`); assert.equal(grade.quality, 100); assert.equal(grade.passed, true);
    }
  }
});

test('every new character gets singles, single-character review, easy pairs and familiar pairs; triples wait for alphabet review', () => {
  for (const [start, count] of [[9, 24], [113, 10], [153, 5], [173, 6]]) {
    for (let i = 0; i < count; i++) {
      const levels = Array.from({ length: 4 }, (_, phase) => sendingStage(start + i * 4 + phase));
      const focus = levels[0].focus;
      assert.deepEqual(levels[0].items.map(item => item.target), [focus]);
      assert.equal(levels[0].required, 6); assert.equal(levels[0].guided, true);
      assert.equal(levels[1].required, 6); assert.equal(levels[1].focusCopies, 4);
      assert.equal(levels[1].guided, false);
      assert.ok(levels[1].items.every(item => sendingTokens(item.target).length === 1));
      for (const stage of levels.slice(2)) {
        assert.equal(stage.required, 4);
        for (const item of stage.items) {
          const tokens = sendingTokens(item.target).map(t => t.value);
          assert.equal(tokens.length, 2); assert.ok(tokens.includes(focus));
        }
      }
      assert.ok(levels[2].items.every(item => sendingTokens(item.target).some(t => t.value === 'E' || t.value === 'T')));
    }
  }
  for (let level = 1; level <= 107; level++) assert.ok(sendingStage(level).items.every(item => sendingTokens(item.target).length <= 2), `Level ${level}`);
  assert.equal(sendingStage(108).title, 'First triples');
  assert.ok(sendingStage(108).items.every(item => [...item.target].every(c => 'ETAN'.includes(c))));
  assert.ok(sendingStage(112).items.every(item => item.target.split(' ').every(word => word.length <= 4)));
});

test('R cannot jump from three singles to RER and gets ten clean singles before its first pairs', () => {
  const s = emptySending(); s.level = 29;
  for (let i = 0; i < 3; i++) pass(s);
  assert.equal(sendingMastery(s).ready, false); assert.equal(s.pendingLevel, null);
  for (let i = 0; i < 3; i++) pass(s);
  assert.equal(advanceSending(s), true); assert.equal(s.level, 30);
  for (let i = 0; i < 4; i++) { assert.equal(sendingExercise(s).target, 'R'); pass(s); }
  assert.equal(sendingMastery(s).ready, false);
  assert.equal(sendingMastery(s).focusGood, 4);
  assert.equal(sendingExercise(s, '', () => 0).target, 'M'); pass(s, 'M'); pass(s, 'U');
  assert.equal(advanceSending(s), true); assert.equal(s.level, 31);
  assert.equal(s.sounds.R.good, 10);
  assert.deepEqual(sendingStage(s.level).items.map(i => i.target), ['RE', 'ER', 'RT', 'TR']);
  for (const target of ['RE', 'ER', 'RT', 'TR']) pass(s, target);
  assert.equal(advanceSending(s), true); assert.equal(s.level, 32);
  assert.ok(sendingStage(s.level).items.every(i => sendingTokens(i.target).length === 2));
  assert.equal(sendingStage(s.level).items.some(i => i.target === 'RER'), false);
});

test('familiar singles, assisted sends and wrong patterns cannot replace new-character review', () => {
  const s = emptySending(); s.level = 30;
  for (let i = 0; i < 6; i++) pass(s, i % 2 ? 'M' : 'U');
  assert.equal(sendingMastery(s).good, 6); assert.equal(sendingMastery(s).ready, false);
  assert.equal(sendingExercise(s).target, 'R');
  const assisted = gradeSending(edgesFor('R'), 'R', settings, sendingStage(30));
  const wrong = gradeSending(edgesFor('K'), 'R', settings, sendingStage(30));
  for (let i = 0; i < 4; i++) { recordSending(s, 'R', assisted, { assisted: true }); recordSending(s, 'R', wrong); }
  assert.equal(sendingMastery(s).focusGood, 0); assert.equal(s.pendingLevel, null);
  for (let i = 0; i < 4; i++) pass(s, 'R');
  assert.equal(sendingMastery(s).ready, false, 'also rebuild recent clean sending after errors');
  pass(s, 'M'); pass(s, 'U'); assert.equal(sendingMastery(s).ready, true);
});

test('old R mixed practice resumes as single-character review once without losing score, settings or earned checks', () => {
  const old = { ...emptySending(), version: 2, level: 20, attempts: 15, clean: 8, characters: 19, earned: 170, settings: { wpm: 30, farnsworth: 25, keyer: 'b', reverse: true },
    records: { 19: { attempts: 3, good: 3, best: 100, mastered: true, history: [true, true, true], covered: ['R'] },
      20: { attempts: 12, good: 5, best: 100, mastered: false, history: [false, true, false], covered: ['RER', 'RM', 'MR'] } } };
  const p = newProfile(); delete p.soundVersion; delete p.settings.sendWpm; p.sending = old; p.stats.xp = 4321;
  const imported = importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
  const s = imported.sending;
  assert.equal(s.version, 3); assert.equal(s.level, 30); assert.equal(sendingExercise(s).target, 'R');
  assert.equal(s.records[29].mastered, true); assert.equal(s.records[32].attempts, 12);
  assert.deepEqual(s.records[32].covered, ['RM', 'MR']); assert.equal(s.records[30], undefined);
  assert.equal(s.pendingLevel, null); assert.equal(imported.stats.xp, 4321);
  for (const key of ['attempts', 'clean', 'characters', 'earned', 'sounds']) assert.deepEqual(s[key], old[key]);
  assert.deepEqual(imported.previousTiming, {wpm:30,farnsworth:25});
  assert.deepEqual(s.settings, {...old.settings, farnsworth: imported.settings.farnsworth, continueMode: 'timed', pauseSeconds: 2});
  assert.deepEqual(sanitizeSending(s), s);
  assert.deepEqual(syncProfile(imported).sending, { ...s, settings: { ...s.settings, reverse: false } });
});

test('old focus successes expire from the review window and familiar characters cannot mask repeated R errors', () => {
  const s = emptySending(); s.level = 30;
  for (let i = 0; i < 4; i++) pass(s, 'R');
  const wrong = gradeSending(edgesFor('K'), 'R', settings, sendingStage(30));
  for (let i = 0; i < 8; i++) recordSending(s, 'R', wrong);
  for (let i = 0; i < 6; i++) pass(s, i % 2 ? 'M' : 'U');
  assert.equal(sendingMastery(s).good, 6); assert.equal(sendingMastery(s).focusGood, 0);
  assert.equal(sendingMastery(s).ready, false); assert.equal(sendingExercise(s).target, 'R');
  const imported = sanitizeSending(s);
  assert.equal(sendingMastery(imported).focusGood, 0); assert.equal(sendingExercise(imported).target, 'R');
  for (let i = 0; i < 4; i++) pass(imported, 'R');
  assert.equal(sendingMastery(imported).ready, true);
});

test('all 120 legacy levels retain their earned counterpart and pending moves take only one new step', () => {
  for (let level = 1; level <= 120; level++) {
    const row = { attempts: 3, good: 3, best: 100, mastered: true, history: [true, true, true], covered: [] };
    const legacy = { ...emptySending(), version: 2, level, pendingLevel: level < 120 ? level + 1 : null, records: { [level]: row } };
    const restored = sanitizeSending(legacy), mapped = legacySendingLevel(level);
    assert.equal(restored.level, mapped); assert.equal(restored.records[mapped].mastered, true);
    assert.equal(Object.values(restored.records).filter(r => r.mastered).length, 1, 'no unearned extra checks');
    assert.equal(restored.pendingLevel, level === 120 ? null : mapped + 1);
    assert.deepEqual(sanitizeSending(restored), restored);
    if (level < 120) { assert.equal(advanceSending(restored), true); assert.equal(restored.level, mapped + 1); assert.equal(advanceSending(restored), false); }
  }
});

test('legacy offline progress and new focus-copy counters merge once across the curriculum change', () => {
  const base = { ...emptySending(), version: 2, level: 20 };
  const local = sanitizeSending(base); pass(local, 'R'); pass(local, 'R');
  const remote = structuredClone(base);
  remote.attempts = remote.clean = 1; remote.earned = 10;
  remote.records[20] = { attempts: 1, good: 1, history: [true], covered: ['RM'] };
  const merged = mergeSending(base, local, remote);
  assert.equal(merged.level, 30); assert.equal(merged.records[30].focusHistory.filter(Boolean).length, 2);
  assert.equal(merged.records[32].good, 1); assert.equal(merged.attempts, 3); assert.equal(merged.earned, 30);
  assert.deepEqual(mergeSending(merged, merged, merged), merged);
  const a = structuredClone(merged), b = structuredClone(merged); pass(a, 'R'); pass(b, 'R');
  const both = mergeSending(merged, a, b);
  assert.equal(both.records[30].focusHistory.filter(Boolean).length, 4); assert.equal(both.records[30].good, 4);
  assert.equal(sendingExercise(both, '', () => 0).target, 'M');
  const p = newProfile(); p.sending = both; p.stats.xp = 500;
  const reset = resetLearnerProgress(p);
  assert.equal(reset.sending.level, 1); assert.deepEqual(reset.sending.records, {}); assert.equal(reset.stats.xp, 500);
});

test('fresh profiles listen at 30 WPM and send at 15 WPM while saved keyer choices remain available', () => {
  const p = newProfile();
  assert.equal(p.settings.wpm, 30); assert.equal(p.settings.sendWpm, 15);
  assert.equal(p.sending.settings.wpm, p.settings.sendWpm);
  assert.equal(p.sending.settings.farnsworth, p.settings.farnsworth); assert.equal(p.settings.farnsworth, 15);
  assert.equal(p.sending.settings.keyer, 'a');
  assert.deepEqual(sanitizeSendingSettings({ wpm: 5, farnsworth: 60, keyer: 'unsafe' }), { wpm: 5, farnsworth: 60, keyer: 'a', reverse: false, continueMode: 'timed', pauseSeconds: 2 });
  assert.equal(sanitizeSendingSettings({ wpm: 25 }).farnsworth, 25);
  p.sending.settings.keyer = 'b';
  assert.equal(sanitizeSending(p.sending).settings.keyer, 'b');
  assert.equal(importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0].sending.settings.keyer, 'b');
});

test('old sending defaults upgrade once while progress, custom spacing and sync deltas survive', () => {
  const p = newProfile(); pass(p.sending); p.stats.xp = 1234; p.sending.level = 8;
  delete p.soundVersion; delete p.settings.sendWpm; p.sending.version = 1;
  Object.assign(p.sending.settings, {wpm:30, farnsworth:15});
  const expected = structuredClone(p.sending); expected.version = 3; expected.settings.farnsworth = 30;
  const restored = sanitizeState({ version: 1, activeId: p.id, profiles: [p] }).profiles[0];
  assert.deepEqual(restored.previousTiming, {wpm:30, farnsworth:30});
  assert.deepEqual(restored.sending, {...expected, settings:{...expected.settings,farnsworth:15}}); assert.equal(restored.stats.xp, 1234);
  assert.deepEqual(restored.settings, p.settings);
  assert.deepEqual(sanitizeSending(expected), expected);
  for (const custom of [{ wpm: 25, farnsworth: 15 }, { wpm: 30, farnsworth: 20 }]) {
    const old = structuredClone(p.sending); Object.assign(old.settings, custom);
    assert.deepEqual(sanitizeSending(old).settings, old.settings);
  }
  const local = structuredClone(expected); local.settings.farnsworth = 15;
  assert.deepEqual(sanitizeSending(local), local);
  assert.deepEqual(mergeSending(p.sending, local, expected), local);
  assert.equal(syncProfile({ ...restored, sending: local }).sending.settings.farnsworth, 15);
});

test('earned sending advancement survives reload and import and is consumed once without awarding credit twice', () => {
  const p = newProfile();
  for (let i = 0; i < 3; i++) p.stats.xp += pass(p.sending).xp;
  assert.equal(p.sending.pendingLevel, 2); assert.equal(p.sending.level, 1);
  const restored = importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
  assert.equal(restored.sending.pendingLevel, 2);
  const before = structuredClone(restored.sending);
  assert.equal(advanceSending(restored.sending), true);
  assert.equal(restored.sending.level, 2); assert.equal(restored.sending.pendingLevel, null);
  assert.equal(advanceSending(restored.sending), false);
  assert.deepEqual(restored.sending, { ...before, level: 2, pendingLevel: null });
  assert.equal(restored.stats.xp, 60); assert.equal(restored.sending.earned, 60);
  assert.deepEqual(Object.keys(restored.sending.records), ['1']);
});

test('old interrupted sending promotions recover once while selected reviews, invalid destinations and the final level remain unchanged', () => {
  const old = emptySending(); for (let i = 0; i < 3; i++) pass(old);
  delete old.pendingLevel;
  const recovered = sanitizeSending(old);
  assert.equal(recovered.pendingLevel, 2);
  assert.equal(advanceSending(recovered), true);
  recovered.level = 1; // A deliberate review is saved with an explicit null.
  assert.equal(sanitizeSending(recovered).pendingLevel, null);
  assert.equal(advanceSending(recovered), false);
  for (const value of [0, 1, 3, 999, '2', true]) {
    const invalid = sanitizeSending({ ...old, pendingLevel: value });
    assert.equal(invalid.pendingLevel, null); assert.equal(advanceSending(invalid), false);
  }
  assert.equal(sanitizeSending({ ...emptySending(), pendingLevel: 2 }).pendingLevel, null);
  const earlierReview = { ...old, records: { ...old.records, 2: { ...old.records[1], mastered: true } } };
  assert.equal(sanitizeSending(earlierReview).pendingLevel, null);
  const last = emptySending(); last.level = SENDING_LEVELS;
  for (const item of sendingStage(SENDING_LEVELS).items) pass(last, item.target);
  assert.equal(last.records[SENDING_LEVELS].mastered, true);
  assert.equal(last.pendingLevel, null); assert.equal(advanceSending(last), false); assert.equal(last.level, SENDING_LEVELS);
});

test('pending sending advancement and its consumption synchronize without recreating a promotion or duplicating score', () => {
  const base = emptySending(); pass(base); pass(base);
  const local = structuredClone(base), remote = structuredClone(base); pass(local);
  remote.settings.wpm = remote.settings.farnsworth = 25;
  const earned = mergeSending(base, local, remote);
  assert.equal(earned.pendingLevel, 2); assert.equal(earned.settings.wpm, 25); assert.equal(earned.earned, 60);
  const advanced = structuredClone(earned); advanceSending(advanced);
  for (const merged of [mergeSending(earned, advanced, earned), mergeSending(earned, earned, advanced), mergeSending(earned, advanced, advanced)]) {
    assert.equal(merged.level, 2); assert.equal(merged.pendingLevel, null);
    assert.equal(merged.earned, 60); assert.equal(merged.attempts, 3);
    assert.deepEqual(Object.keys(merged.records), ['1']);
  }
});

test('a whole 218-level pass can be completed in small steps and survives export and import', () => {
  const p = newProfile();
  for (let level = 1; level <= SENDING_LEVELS; level++) {
    assert.equal(p.sending.level, level);
    let tries = 0;
    while (!p.sending.records[level]?.mastered && tries++ < 12) pass(p.sending);
    assert.equal(p.sending.records[level].mastered, true, `Level ${level}`);
    assert.equal(advanceSending(p.sending), level < SENDING_LEVELS);
  }
  assert.equal(Object.values(p.sending.records).filter(r => r.mastered).length, SENDING_LEVELS);
  assert.ok(p.sending.attempts < 1150);
  const restored = importState(JSON.stringify({ version: 1, activeId: p.id, profiles: [p] })).profiles[0];
  assert.deepEqual(restored.sending, p.sending);
  assert.equal(Object.keys(restored.stats.mastery).length, 0);
});

test('reply lessons require all conversation turns in order and never select a different question after an error', () => {
  const s = emptySending(); s.level = SENDING_LEVELS;
  const item = sendingExercise(s); assert.equal(item.target, 'DE N0ABC');
  const bad = gradeSending(edgesFor('E'), item.target, settings, sendingStage(SENDING_LEVELS)); recordSending(s, item.target, bad);
  assert.equal(sendingExercise(s).target, item.target);
  for (const target of ['DE N0ABC', 'RST 599', 'NAME ANNA', 'QTH OSLO']) {
    assert.equal(sendingExercise(s).target, target); pass(s, target);
    assert.equal(sendingMastery(s).mastered, false);
  }
  assert.equal(sendingExercise(s).target, '73 <SK>'); assert.equal(pass(s).levelUp, true);
});

test('a dot, dash, character gap and word gap are decoded independently', () => {
  assert.equal(decodeSending(edgesFor('ET E'), settings).decoded, 'ET E');
  assert.equal(gradeSending(edgesFor('I'), 'EE', settings).correct, false);
  assert.equal(gradeSending(edgesFor('EE'), 'E E', settings).correct, false);
  assert.equal(gradeSending(edgesFor('E E'), 'EE', settings).correct, false);
  assert.equal(gradeSending(edgesFor('T'), 'E', settings).correct, false);
});

test('joined prosigns are assessed as one pattern, distinct from spaced ordinary letters', () => {
  assert.equal(gradeSending(edgesFor('<AR>'), '<AR>', settings).passed, true);
  assert.equal(gradeSending(edgesFor('AR'), '<AR>', settings).correct, false);
  assert.equal(gradeSending(edgesFor('73 <SK>'), '73 <SK>', settings).passed, true);
});

test('paddle scores assess manual letter and word gaps without credit from automatic marks', () => {
  const stage = sendingStage(202);
  const normal = edgesFor('HH');
  // The many automatic marks would dilute this error in a combined average.
  const shift = timing(30, 15).letterGap * 1000 * 0.45;
  const broken = normal.map((e, i) => ({ ...e, at: e.at + (i >= 8 ? shift : 0) }));
  const grade = gradeSending(broken, 'HH', settings, stage, { keyerTimed: true });
  assert.equal(grade.correct, true); assert.equal(grade.passed, false); assert.match(grade.issue, /Letter gap too long/);
  assert.equal(grade.assessed.length, 1); assert.equal(grade.quality, 55);
  const single = gradeSending(edgesFor('H'), 'H', settings, stage, { keyerTimed: true });
  assert.equal(single.assessed.length, 0); assert.equal(single.passed, true);
});

test('standard letter boundaries remain readable with a slower Farnsworth spacing goal', () => {
  const actual = edgesFor('EE', { wpm: 30, farnsworth: 30 });
  const grade = gradeSending(actual, 'EE', settings, sendingStage(4), { keyerTimed: true });
  assert.equal(grade.correct, true); assert.equal(grade.passed, false);
  assert.equal(grade.decoded, 'EE'); assert.match(grade.issue, /Letter gap too short/);
});

test('readable but mistimed marks receive specific feedback without passing mastery', () => {
  const grade = gradeSending([{ down: true, at: 0 }, { down: false, at: 190 }], 'T', settings, sendingStage(197));
  assert.equal(grade.correct, true); assert.equal(grade.passed, false); assert.match(grade.issue, /Dash too long/);
  const s = emptySending(); recordSending(s, 'E', gradeSending([{ down: true, at: 0 }, { down: false, at: 70 }], 'E', settings));
  assert.equal(s.clean, 0); assert.equal(sendingMastery(s).mastered, false);
});

test('target speed accepts accurate sending after arbitrarily long thinking time before the first press', () => {
  const edges = edgesFor('ET').map(e => ({ ...e, at: e.at + 90000 }));
  assert.equal(gradeSending(edges, 'ET', settings).passed, true);
});

test('invalid, incomplete, duplicated and oversized key captures do not earn credit', () => {
  for (const edges of [[], [{ down: true, at: 0 }], [{ down: true, at: 0 }, { down: true, at: 40 }], [{ down: true, at: 0 }, { down: false, at: Infinity }], [{ down: false, at: 1 }], [{ down: true, at: 40 }, { down: false, at: 20 }], Array(4097).fill({ down: true, at: 0 })]) {
    const s = emptySending(); assert.equal(recordSending(s, 'E', gradeSending(edges, 'E', settings)).xp, 0); assert.equal(s.attempts, 0);
  }
});

test('assisted sending earns no mastery and failed attempts do not advance the prompt cursor', () => {
  const s = emptySending();
  const grade = gradeSending(edgesFor('E'), 'E', settings);
  assert.equal(recordSending(s, 'E', grade, { assisted: true }).xp, 0);
  assert.equal(s.clean, 0); assert.equal(s.records[1].good, 0);
  for (let i = 0; i < 3; i++) pass(s);
  assert.equal(sendingMastery(s).mastered, true);
  assert.equal(pass(s).xp, 10); // The level bonus is awarded once per run.
});

test('mixed levels require different exercises, not the same short answer repeated', () => {
  const s = emptySending(); s.level = 12;
  for (let i = 0; i < 4; i++) pass(s, 'AE');
  assert.equal(sendingMastery(s).ready, false);
  pass(s, 'EA'); pass(s, 'AT');
  assert.equal(sendingMastery(s).mastered, true);
});

test('sending sanitization strips unknown records, event data and invalid counters', () => {
  const s = sanitizeSending({ level: 9999, settings: { wpm: '30', farnsworth: 200 }, attempts: 2, clean: 900, source: 'token', records: { 1: { history: [true, '<script>'], covered: ['E', '<script>'], mastered: true }, 121: { mastered: true } }, sounds: { E: { seen: Infinity, recent: [true, 1] }, '<script>': { seen: 10 } }, edges: edgesFor('E') });
  assert.equal(s.level, SENDING_LEVELS); assert.equal(s.clean, 2); assert.deepEqual(s.records[1].covered, ['E']);
  assert.equal(Object.hasOwn(s.records, '121'), false); assert.equal(Object.hasOwn(s, 'edges'), false); assert.equal(Object.hasOwn(s, 'source'), false);
  assert.deepEqual(s.sounds.E.recent, [true, false]);
});

test('old saves start the independent sending course without modifying listening achievements', () => {
  const p = newProfile(); p.stats.xp = 1234; delete p.sending;
  const restored = sanitizeState({ version: 1, profiles: [p], activeId: p.id }).profiles[0];
  assert.deepEqual(restored.sending,newProfile().sending); assert.equal(restored.stats.xp, 1234);
});

test('sending progress and XP merge across offline devices without transporting input events', () => {
  const base = newProfile(), a = structuredClone(base), b = structuredClone(base);
  a.stats.xp += pass(a.sending).xp; b.sending.level = 2; b.stats.xp += pass(b.sending, 'T').xp;
  const merged = mergeProgress(base, a, b);
  assert.equal(merged.sending.records[1].good, 1); assert.equal(merged.sending.records[2].good, 1);
  assert.equal(merged.sending.attempts, 2); assert.equal(merged.stats.xp, 20);
  assert.deepEqual(syncProfile(merged).sending, merged.sending);
  assert.equal(Object.hasOwn(merged.sending, 'edges'), false);
});

test('acknowledged sending changes do not merge twice and concurrent mastery is retained', () => {
  const base = emptySending(), local = structuredClone(base), remote = structuredClone(base);
  for (let i = 0; i < 3; i++) pass(local);
  remote.level = 2; pass(remote, 'T');
  const merged = mergeSending(base, local, remote);
  assert.equal(merged.records[1].mastered, true); assert.equal(merged.attempts, 4);
  assert.deepEqual(mergeSending(merged, merged, merged), merged);
});

test('reset progress clears sending levels and preserves lifetime score, history and sending setup', () => {
  const p = newProfile(); for (let i = 0; i < 3; i++) p.stats.xp += pass(p.sending).xp;
  p.sending.settings.wpm = 25; const reset = resetLearnerProgress(p);
  assert.equal(reset.stats.xp, 60); assert.equal(reset.sending.earned, 60); assert.equal(reset.sending.clean, 3);
  assert.deepEqual(reset.sending.records, {}); assert.equal(reset.sending.level, 1); assert.equal(reset.sending.settings.wpm, 25);
  assert.equal(reset.sending.pendingLevel, null);
});

test('sending-only reset clears earned and pending sending levels while retaining the complete listening save and lifetime credit', () => {
  const p = newProfile();
  startRound(p, 'E');
  Object.assign(p.round, { heard: true, plays: 1, attempts: 1, firstGuess: 'E', responseTimes: [100] });
  finishRound(p, { solved: true });
  for (let i = 0; i < 3; i++) p.stats.xp += pass(p.sending).xp;
  assert.equal(p.sending.records[1].mastered, true); assert.equal(p.sending.pendingLevel, 2);
  Object.assign(p.sending.settings, { wpm: 25, farnsworth: 20, keyer: 'b', reverse: true });
  p.settings.courseLevel = 93; p.callsign = 'TF3TEST'; p.leaderboard = true;
  const before = structuredClone(p), reset = resetSendingProgress(p);
  assert.deepEqual(reset, { ...before, sending: { ...before.sending, level: 1, pendingLevel: null, records: {} } });
  assert.deepEqual(p, before, 'the original save remains available if persistence fails');
  reset.stats.xp++; reset.sending.settings.wpm++;
  assert.deepEqual(p, before, 'the reset does not share mutable listening or sending state');
});

test('paddle keyer repeats held dots and dashes at the selected speed', () => {
  for (const [dit, dah, expected] of [[true, false, [0, 40, 80, 120, 160, 200]], [false, true, [0, 120, 160, 280]]]) {
    const edges = []; const keyer = new PaddleKeyer({ wpm: 30, onEdge: e => edges.push(e) });
    keyer.contacts(dit, dah, 0); keyer.contacts(false, false, dit ? 210 : 290); keyer.advance(500);
    assert.deepEqual(edges.map(e => e.at), expected);
  }
});

test('squeeze alternates and iambic B adds the opposite element after release while A stops', () => {
  const defaults = [], defaultKeyer = new PaddleKeyer({ onEdge: e => defaults.push(e) });
  defaultKeyer.contacts(true, true, 1000); defaultKeyer.contacts(false, false, 1020); defaultKeyer.advance(1400);
  assert.deepEqual(defaults.map(e => e.at), [1000, 1040]);
  for (const mode of ['a', 'b']) {
    const edges = [], keyer = new PaddleKeyer({ wpm: 30, mode, onEdge: e => edges.push(e) });
    keyer.contacts(true, true, 1000); keyer.contacts(false, false, 1020); keyer.advance(1400);
    assert.deepEqual(edges.map(e => e.at), mode === 'a' ? [1000, 1040] : [1000, 1040, 1080, 1200]);
  }
  const edges = [], keyer = new PaddleKeyer({ wpm: 30, onEdge: e => edges.push(e) });
  keyer.contacts(true, true, 0); keyer.contacts(false, false, 290); keyer.advance(700);
  assert.deepEqual(edges.slice(0, 6).map(e => e.at), [0, 40, 80, 200, 240, 280]);
});

test('a slightly late SSE dot after a dash still sends N instead of silently becoming T', () => {
  let now = 0, capture = [], replacements = 0;
  const keyer = new PaddleKeyer({ wpm: 30, onEdge: edge => capture.push(edge), onReplay: edges => { capture = edges; replacements++; } });
  const connection = new PaddleConnection({
    EventSourceClass: FakeSource, now: () => now,
    timers: { setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} },
    onContacts: (dit, dah, at) => { if (dit == null) keyer.advance(at); else keyer.contacts(dit, dah, at); },
  });
  connection.connect();
  let seq = 0;
  const emit = (arrived, at, dit = false, dah = false) => { now = arrived; connection.source.emit(snapshot(seq++, at, dit, dah)); };
  emit(0, 1000);
  emit(100, 1100, false, true); emit(120, 1120);
  now = 200; connection.tick();
  now = 340; connection.tick(); // The browser has already advanced to 1240.
  emit(341, 1238, true); // The actual dot contact is only three ms late.
  emit(350, 1250);
  now = 500; connection.tick();
  assert.equal(decodeSending(capture, { wpm: 30, farnsworth: 30 }).decoded, 'N');
  assert.deepEqual(capture.map(edge => edge.at), [1100, 1220, 1260, 1300], 'the companion timestamps determine the marks');
  assert.equal(replacements, 1);
  connection.disconnect();
});

test('a late paddle release retracts a predicted extra dash and leaves one complete T', () => {
  let capture = [];
  const keyer = new PaddleKeyer({ wpm: 30, onEdge: edge => capture.push(edge), onReplay: edges => { capture = edges; } });
  keyer.contacts(false, true, 1000);
  keyer.advance(1162);
  assert.equal(capture.at(-1).down, true, 'the browser predicted another held dash');
  assert.equal(keyer.contacts(false, false, 1159), true);
  keyer.advance(1500);
  assert.deepEqual(capture, [{ down: true, at: 1000 }, { down: false, at: 1120 }]);
  assert.equal(gradeSending(capture, 'T', { wpm: 30, farnsworth: 30 }).passed, true);
});

test('late contact delivery preserves exact patterns and spacing for letters, numbers, symbols and joined signals in both keyer modes', () => {
  const setup = { wpm: 30, farnsworth: 30 };
  for (const mode of ['a', 'b']) for (const target of [...Object.keys(MORSE), 'NAN', 'TN', 'RST 599', '73 <SK>']) {
    let capture = [];
    const keyer = new PaddleKeyer({ wpm: 30, mode, onEdge: edge => capture.push(edge), onReplay: edges => { capture = edges; } });
    const plan = timeline(target, setup);
    for (const tone of plan.tones) {
      const at = 1000 + tone.start * 1000;
      keyer.advance(at + 2);
      assert.equal(keyer.contacts(tone.symbol === '.', tone.symbol === '-', at), true);
      keyer.advance(at + 12);
      assert.equal(keyer.contacts(false, false, at + 10), true);
    }
    keyer.advance(2000 + plan.duration * 1000);
    const expected = edgesFor(target, setup).map(edge => ({ ...edge, at: edge.at + 1000 }));
    assert.equal(capture.length, expected.length, `${mode}: ${target}`);
    capture.forEach((edge, i) => { assert.equal(edge.down, expected[i].down); assert.ok(Math.abs(edge.at - expected[i].at) < .0001); });
    assert.equal(gradeSending(capture, target, setup, sendingStage(218), { keyerTimed: true }).passed, true, `${mode}: ${target}`);
  }
});

test('paddle correction retains A/B squeeze release rules, rejects reversed source time and cannot leak into the next answer', () => {
  for (const mode of ['a', 'b']) {
    let capture = [], replays = 0;
    const keyer = new PaddleKeyer({ mode, onEdge: edge => capture.push(edge), onReplay: edges => { capture = edges; replays++; } });
    keyer.contacts(true, true, 1000); keyer.advance(1022);
    assert.equal(keyer.contacts(false, false, 1020), true); keyer.advance(1400);
    assert.equal(decodeSending(capture, { wpm: 30, farnsworth: 30 }).decoded, mode === 'a' ? 'E' : 'A');
    assert.equal(keyer.contacts(true, false, 1019), false);
    assert.equal(replays, 1);
    keyer.reset(); capture = [];
    keyer.contacts(false, true, 2000); keyer.contacts(false, false, 2010); keyer.advance(2500);
    assert.deepEqual(capture, [{ down: true, at: 2000 }, { down: false, at: 2120 }]);
  }
});

test('paddle correction ignores unchanged late snapshots and bounds contact history instead of silently losing an input', () => {
  let replays = 0;
  const keyer = new PaddleKeyer({ onReplay: () => replays++ });
  keyer.contacts(true, false, 1000); keyer.advance(1022);
  assert.equal(keyer.contacts(true, false, 1020), true);
  assert.equal(replays, 0); assert.equal(keyer.clock, 1022);
  keyer.reset();
  for (let i = 0; i < 4096; i++) assert.equal(keyer.contacts(i % 2 === 0, false, i * 2), true);
  assert.equal(keyer.contacts(true, false, 8192), false);
  keyer.reset(); assert.equal(keyer.contacts(true, false, 9000), true);
});

test('paddle reset cancels held contacts and queued elements without fabricating release marks', () => {
  const edges = [], keyer = new PaddleKeyer({ onEdge: e => edges.push(e) });
  keyer.contacts(true, true, 0); keyer.reset(); keyer.advance(10000);
  assert.deepEqual(edges, [{ down: true, at: 0 }]); assert.equal(keyer.busy, false);
});

test('every course exercise can be keyed from independent dit/dah contacts at 30 WPM', () => {
  for (let level = 1; level <= SENDING_LEVELS; level++) for (const item of sendingStage(level).items) {
    const edges = [], keyer = new PaddleKeyer({ wpm: 30, mode: 'b', onEdge: e => edges.push(e) });
    const plan = timeline(item.target, settings);
    for (const tone of plan.tones) {
      keyer.contacts(tone.symbol === '.', tone.symbol === '-', tone.start * 1000);
      keyer.contacts(false, false, tone.start * 1000 + 10);
    }
    keyer.advance(plan.duration * 1000 + 100);
    const grade = gradeSending(edges, item.target, settings, sendingStage(level), { keyerTimed: true });
    assert.equal(grade.passed, true, `${level}: ${item.target}`);
  }
});

class FakeSource {
  constructor(url, options) { this.url = url; this.options = options; this.handlers = {}; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  emit(data) { this.handlers.paddle({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
function connection() {
  const contacts = [], statuses = []; let resets = 0, clock = 0;
  const c = new PaddleConnection({ EventSourceClass: FakeSource, now: () => clock, timers: { setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {} }, onContacts: (...e) => contacts.push(e), onStatus: (...e) => statuses.push(e), onReset: () => resets++ });
  c.connect(); return { c, contacts, statuses, resetCount: () => resets, advance: n => { clock = n; c.tick(); } };
}
const snapshot = (seq, timeMs, dit = false, dah = false, status = 'ready') => ({ v: 1, seq, timeMs, dit, dah, status });

test('Mac protocol reads named SSE snapshots at the fixed loopback URL with no credentials', () => {
  const { c, contacts, advance } = connection();
  assert.equal(c.source.url, PADDLE_URL); assert.equal(PADDLE_URL, 'http://127.0.0.1:17373/events'); assert.equal(c.source.options.withCredentials, false);
  assert.ok(c.source.handlers.paddle);
  c.source.emit(snapshot(42, 1000)); advance(120);
  c.source.emit(snapshot(43, 1040, true)); advance(160);
  c.source.emit(snapshot(44, 1080, false)); advance(200);
  assert.deepEqual(contacts.filter(c => c[0] != null), [[false, false, 1000], [true, false, 1040], [false, false, 1080]]);
  c.disconnect();
});

test('SSE duplicates are ignored and missing, backwards or malformed events disconnect and release contacts', () => {
  for (const variant of ['missing', 'backwards', 'invalid']) {
    const flow = connection(), source = flow.c.source; source.emit(snapshot(1, 1000)); source.emit(snapshot(1, 1000));
    assert.equal(flow.c.lastSeq, 1);
    if (variant === 'missing') source.emit(snapshot(3, 1100, true));
    else if (variant === 'backwards') source.emit(snapshot(2, 999, true));
    else source.handlers.paddle({ data: '{bad' });
    assert.equal(source.closed, true); assert.equal(flow.c.source, null); assert.ok(flow.resetCount() >= 2);
    assert.equal(flow.statuses.at(-1)[0], 'reconnecting');
  }
});

test('every non-ready companion state releases both contacts and resets the queued capture', () => {
  const flow = connection(); flow.c.source.emit(snapshot(1, 1000, true));
  const prior = flow.resetCount(); flow.c.source.emit(snapshot(2, 1040, true, true, 'unlinked'));
  assert.equal(flow.resetCount(), prior + 1); assert.deepEqual(flow.c.queue, []);
  assert.equal(paddleSnapshot(JSON.stringify(snapshot(3, 1100, true, true, 'paused'))).dit, false);
  flow.c.source.onerror(); assert.equal(flow.c.source, null);
});

test('late SSE contact changes clear unfinished input rather than inventing jitter-stretched marks', () => {
  const flow = connection(); flow.c.source.emit(snapshot(1, 1000)); flow.advance(500);
  const n = flow.resetCount(); flow.c.source.emit(snapshot(2, 1100, true));
  assert.equal(flow.resetCount(), n + 1); assert.equal(flow.c.queue.length, 1);
  flow.c.disconnect();
});

test('SSE payloads and held contacts are bounded', () => {
  for (const raw of ['x'.repeat(2049), JSON.stringify({ ...snapshot(1, 0), timeMs: '0' }), JSON.stringify({ ...snapshot(1, 0), seq: -1 }), JSON.stringify({ ...snapshot(1, 0), dit: 1 })]) assert.throws(() => paddleSnapshot(raw));
  const flow = connection(); flow.c.source.emit(snapshot(1, 1000, true)); flow.advance(10100);
  assert.equal(flow.c.source, null); assert.match(flow.statuses.at(-1)[1], /held too long/);
});

function retryConnection(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sources = [], statuses = [], intents = []; let resets = 0;
  class Source extends FakeSource { constructor(...args) { super(...args); sources.push(this); } }
  const c = new PaddleConnection({ EventSourceClass: Source, timers: globalThis, now: () => 0, onStatus: (...args) => statuses.push(args), onIntent: value => intents.push(value), onReset: () => resets++, ...options });
  t.after(() => { c.disconnect(); t.mock.timers.reset(); });
  return { c, sources, statuses, intents, timers: t.mock.timers, resetCount: () => resets };
}

test('paddle reconnect clears contacts and ignores events from the old connection', t => {
  const { c, sources, timers, resetCount } = retryConnection(t);
  c.connect(); const old = c.source; old.emit(snapshot(41, 1000, true));
  old.onerror(); assert.equal(c.connected, false); assert.equal(c.source, null); assert.deepEqual(c.queue, []);
  const resets = resetCount(); old.emit(snapshot(42, 1040)); old.onerror(); assert.equal(resetCount(), resets);
  timers.tick(999); assert.equal(sources.length, 1);
  timers.tick(1); assert.equal(sources.length, 2); assert.equal(c.lastSeq, -1);
  c.source.emit(snapshot(0, 0)); assert.equal(c.connected, true); assert.equal(c.lastSeq, 0);
});

test('paddle reconnect backs off from one second to a bounded thirty seconds', t => {
  const { c, sources, timers, statuses } = retryConnection(t); c.connect();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    c.source.onerror(); const n = sources.length;
    assert.match(statuses.at(-1)[1], new RegExp(`Reconnecting in ${delay / 1000}s`));
    timers.tick(delay - 1); assert.equal(sources.length, n);
    timers.tick(1); assert.equal(sources.length, n + 1);
  }
});

test('leaving Send pauses retries and returning resumes, while explicit disconnect prevents all later retries', t => {
  const { c, sources, timers, intents } = retryConnection(t, { enabled: false });
  timers.tick(60000); assert.equal(sources.length, 0);
  c.connect(); assert.equal(sources.length, 0); assert.equal(c.wanted, true);
  c.setActive(true); assert.equal(sources.length, 1);
  c.source.onerror(); c.setActive(false); timers.tick(60000); assert.equal(sources.length, 1);
  assert.equal(c.wanted, true);
  c.setActive(true); assert.equal(sources.length, 2);
  c.source.onerror(); c.disconnect(); timers.tick(60000);
  c.setActive(false); c.setActive(true); timers.tick(60000);
  assert.equal(sources.length, 2); assert.equal(c.wanted, false); assert.deepEqual(intents, [true, false]);
});

test('a stable paddle connection resets retry backoff and unsolicited connections never start', t => {
  const { c, sources, timers, statuses } = retryConnection(t);
  c.setActive(false); c.setActive(true); timers.tick(60000); assert.equal(sources.length, 0);
  c.connect(); c.source.onerror(); timers.tick(1000); c.source.onerror(); timers.tick(2000);
  c.source.emit(snapshot(0, 0)); timers.tick(10000);
  c.source.onerror(); assert.match(statuses.at(-1)[1], /Reconnecting in 1s/);
  timers.tick(1000); assert.equal(sources.length, 4);
});

test('tracked first sends distinguish a clean retry, merge by device and never infer first attempts from old totals', async () => {
  const { BADGES } = await import('../../website/public/js/progress.mjs');
  assert.ok(SEND_BADGES.length >= BADGES.length);
  assert.equal(new Set(SEND_BADGES.map(b=>b.id)).size,SEND_BADGES.length);
  const a = emptySending(), b = emptySending(), base = emptySending();
  const id=crypto.randomUUID(), day='2026-11-25';
  const correct=gradeSending(edgesFor('E'),'E',settings), miss=gradeSending(edgesFor('T'),'E',settings);
  recordSending(a,'E',miss,{stream:id,firstAttempt:true,day});
  recordSending(a,'E',correct,{stream:id,firstAttempt:false,day});
  assert.deepEqual(a.activity[id],{first:1,clean:0,days:[day]});
  recordSending(a,'E',correct,{stream:id,firstAttempt:true,day:'2026-11-26'});
  const other=crypto.randomUUID();
  recordSending(b,'E',correct,{stream:other,firstAttempt:true,day});
  const merged=mergeSending(base,a,b);
  assert.equal(merged.activity[id].first,2); assert.equal(merged.activity[id].clean,1);
  assert.equal(merged.activity[other].clean,1);
  assert.deepEqual(mergeSending(base,a,merged).activity,merged.activity);
  assert.equal(sanitizeSending({version:3,attempts:200,clean:180}).activity,undefined);
  assert.deepEqual(sanitizeSending(merged).activity,merged.activity);
});
