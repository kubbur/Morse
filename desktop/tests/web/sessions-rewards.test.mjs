import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, newProfile, startRound, finishRound, sanitizeState, importState, resetLearnerProgress, collectBadges, collectedBadges, BADGES, localDay } from '../../website/public/js/progress.mjs';
import { SESSION_GAP_MS, SESSION_HISTORY_LIMIT, listeningSessions, sanitizeSessions, sessionsFromRounds, recordSessionAnswer, sessionDuration } from '../../website/public/js/sessions.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

const start = new Date(2026, 10, 22, 12).getTime();
function answer(p, at, { correct = true, clean = true } = {}) {
  startRound(p, 'E');
  Object.assign(p.round, { heard: true, plays: clean ? 1 : 2, attempts: 1, firstGuess: correct ? 'E' : 'T', responseTimes: [100] });
  if (correct) return finishRound(p, { solved: true, now: new Date(at) });
  return recordSessionAnswer(p, { correct: false, at });
}

test('sessions include the exact two-minute boundary, split above it and measure first to last answer without idle padding', () => {
  const p = newProfile();
  answer(p, start);
  answer(p, start + SESSION_GAP_MS, { correct: false });
  answer(p, start + SESSION_GAP_MS * 2);
  let sessions = listeningSessions(p.stats.sessions);
  assert.equal(sessions.length, 1); assert.equal(sessions[0].duration, 240000);
  assert.equal(sessions[0].answers, 3); assert.equal(sessions[0].correct, 2);
  answer(p, start + SESSION_GAP_MS * 3 + 1);
  sessions = listeningSessions(p.stats.sessions);
  assert.equal(sessions.length, 2); assert.equal(sessions[1].duration, 0);
  assert.equal(sessions[0].end, start + SESSION_GAP_MS * 2);
  assert.equal(sessionDuration(0), '0s'); assert.equal(sessionDuration(65000), '1m 05s'); assert.equal(sessionDuration(3720000), '1h 02m');
});

test('wrong submissions bridge sessions, duplicate handling and skipping cannot count an answer twice', () => {
  const p = newProfile(); answer(p, start, { correct: false });
  assert.equal(recordSessionAnswer(p, { correct: false, at: start }), false);
  p.round.attempts++; p.round.plays++; p.round.firstGuess = 'T';
  finishRound(p, { solved: true, now: new Date(start + 60000) });
  assert.equal(finishRound(p, { solved: true }), null);
  startRound(p, 'E'); finishRound(p, { now: new Date(start + 180001) });
  const [session] = listeningSessions(p.stats.sessions);
  assert.equal(session.answers, 2); assert.equal(session.correct, 1); assert.equal(session.clean, 0); assert.equal(session.duration, 60000);
});

test('a long session retains its original start after round history is trimmed and recent fragments stay bounded', () => {
  const p = newProfile();
  for (let i = 0; i < 310; i++) answer(p, start + i * 1000);
  assert.equal(p.stats.rounds.length, 300);
  assert.equal(listeningSessions(p.stats.sessions)[0].start, start);
  assert.equal(listeningSessions(p.stats.sessions)[0].answers, 310);
  assert.ok(p.stats.badges.includes('session-five'));
  for (let i = 1; i < 110; i++) answer(p, start + 310000 + i * 180000);
  assert.equal(p.stats.sessions.length, SESSION_HISTORY_LIMIT);
  assert.ok(p.stats.badges.includes('session-five'), 'collected milestones outlive the recent history window');
});

test('old round history migrates to sessions once, without inventing earlier duration or answers', () => {
  const state = newState(), p = state.profiles[0];
  delete p.stats.sessions; p.stats.total = 10000;
  p.stats.rounds = [start, start + 120000, start + 240001].map(at => ({ at, level: 1, wpm: 30, solved: true, clean: true }));
  const restored = sanitizeState(state).profiles[0];
  assert.deepEqual(restored.stats.sessions, sessionsFromRounds(restored.stats.rounds));
  assert.equal(listeningSessions(restored.stats.sessions).length, 2);
  assert.equal(restored.stats.sessions.reduce((n, s) => n + s.answers, 0), 3);
  assert.equal(restored.sessionId, '');
  assert.deepEqual(sanitizeState({ ...state, profiles: [restored] }).profiles[0].stats.sessions, restored.stats.sessions);
});

test('session validation strips unknown fields, invalid dates/IDs, impossible counters and unbounded history', () => {
  const valid = { id: 'valid-id', start, end: start + 1000, answers: 3, correct: 99, clean: 99, xp: 99, injected: '<script>' };
  const records = sanitizeSessions([valid, { ...valid, id: '<script>' }, { ...valid, id: 'nan', end: NaN }, { ...valid, id: 'backwards', end: start - 1 }, { ...valid, id: 'zero', answers: 0 }]);
  assert.deepEqual(records, [{ id: 'valid-id', start, end: start + 1000, answers: 3, correct: 3, clean: 3, xp: 99 }]);
  assert.equal(sanitizeSessions(Array.from({ length: 1000 }, (_, i) => ({ ...valid, id: `safe-${i}` }))).length, SESSION_HISTORY_LIMIT);
});

test('reload continues an owned session; imported files and paired devices get a fresh fragment instead of overwriting its owner', () => {
  const state = newState(), p = state.profiles[0]; answer(p, start);
  const restored = sanitizeState(state).profiles[0], owner = p.sessionId;
  assert.equal(restored.sessionId, owner); answer(restored, start + 1000);
  assert.equal(restored.stats.sessions.length, 1); assert.equal(restored.stats.sessions[0].answers, 2);
  const imported = importState(JSON.stringify(state)).profiles[0]; assert.equal(imported.sessionId, '');
  assert.equal(importState(JSON.stringify(state), { newSessionOwner: false }).profiles[0].sessionId, owner, 'ordinary inter-tab validation is not a file restore');
  answer(imported, start + 2000); assert.notEqual(imported.sessionId, owner); assert.equal(imported.stats.sessions.length, 2);
  assert.equal(listeningSessions(imported.stats.sessions).length, 1);
  assert.equal(syncProfile(p).sessionId, '');
});

test('offline session fragments merge once, retain concurrent answers and coalesce shared listening time without adding overlapping durations', () => {
  const base = syncProfile(newProfile()), a = structuredClone(base), b = structuredClone(base);
  answer(a, start); answer(a, start + 60000);
  answer(b, start + 30000); answer(b, start + 90000, { correct: false });
  const merged = mergeProgress(base, a, b), [session] = listeningSessions(merged.stats.sessions);
  assert.equal(session.answers, 4); assert.equal(session.correct, 3); assert.equal(session.duration, 90000);
  assert.equal(merged.stats.sessions.length, 2);
  assert.deepEqual(mergeProgress(a, a, merged).stats.sessions, merged.stats.sessions);
  assert.equal(merged.stats.xp, a.stats.xp + b.stats.xp);
});

test('24 distinct badges cover copying, speed, sessions, streaks, head-copy, the alphabet, focus and radio', () => {
  assert.equal(BADGES.length, 24); assert.equal(new Set(BADGES.map(b => b.id)).size, 24);
  const p = newProfile(); assert.deepEqual(collectBadges(p), []);
  p.settings.courseCount = 26; p.settings.courseLevel = 400;
  assert.equal(collectedBadges(p).some(b => b.id === 'alphabet' || b.id === 'graduate'), false, 'jumping ahead is not evidence of copying or mastery');
  p.stats.characters = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => [c, { seen: 1, correct: 1 }]));
  p.stats.focusCompletions = 1; p.stats.modes.head.clean = 10; p.endless.contacts = 1;
  assert.ok(collectBadges(p).includes('alphabet')); assert.ok(p.stats.badges.includes('focus')); assert.ok(p.stats.badges.includes('head-ten')); assert.ok(p.stats.badges.includes('radio-contact'));
});

test('badge awards happen once, survive reload/reset and sync, and clearing all data starts an empty collection', () => {
  const state = newState(), p = state.profiles[0], first = answer(p, start);
  assert.deepEqual(first.badges, ['first', 'first-quick']);
  assert.deepEqual(answer(p, start + 1000).badges, []);
  const reloaded = sanitizeState(state).profiles[0]; assert.deepEqual(collectBadges(reloaded), []);
  const reset = resetLearnerProgress(reloaded); assert.deepEqual(reset.stats.badges, reloaded.stats.badges); assert.deepEqual(reset.stats.sessions, reloaded.stats.sessions);
  const remote = syncProfile(newProfile()); remote.stats.badges = ['focus'];
  const merged = mergeProgress(newProfile(), reloaded, remote); assert.ok(merged.stats.badges.includes('focus')); assert.ok(merged.stats.badges.includes('first'));
  assert.deepEqual(newProfile().stats.badges, []);
});

test('streak badges stay collected after the streak expires, and old saves backfill earned badges without a new-award replay', () => {
  const state = newState(), p = state.profiles[0];
  for (let i = 0; i < 7; i++) { const day = new Date(); day.setDate(day.getDate() - i); p.stats.days[localDay(day)] = 1; }
  assert.ok(collectBadges(p).includes('week'));
  p.stats.days = {};
  assert.ok(collectedBadges(p).some(b => b.id === 'week'));
  assert.ok(sanitizeState(state).profiles[0].stats.badges.includes('week'));
  delete p.stats.badges; p.stats.solved = 100;
  const loaded = sanitizeState(state).profiles[0];
  assert.ok(loaded.stats.badges.includes('hundred-copies')); assert.deepEqual(collectBadges(loaded), []);
});
