import { MORSE, PROSIGNS, timing, timeline } from './morse.mjs';
import { SENDING_LEVELS, legacySendingLevel, sendingStage, sendingTokens } from './sending-course.mjs';
import { mergeSendingSessions, recordSendingSession } from './sessions.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const number = (v, min, max, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const count = v => Math.floor(number(v, 0, 1e9));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plus = (b = 0, l = 0, r = 0) => Math.min(1e9, r + Math.max(0, l - b));

export const DEFAULT_SENDING_SETTINGS = Object.freeze({ wpm: 30, farnsworth: 30, keyer: 'a', reverse: false, continueMode: 'timed', pauseSeconds: 2 });
export const SEND_BADGES = [
  { id: 'send-first', icon: 'check', title: 'First clean send', description: 'Send one answer cleanly without help.', earned: s => s.clean >= 1 },
  { id: 'send-group', icon: 'layers', title: 'First clean group', description: 'Send two or more characters in one clean answer.', earned: s => s.characters > s.clean },
  { id: 'send-ten', icon: 'spark', title: '10 clean sends', description: 'Send 10 answers cleanly.', earned: s => s.clean >= 10 },
  { id: 'send-hundred', icon: 'flame', title: '100 clean sends', description: 'Send 100 answers cleanly.', earned: s => s.clean >= 100 },
  { id: 'send-alphabet', icon: 'book', title: 'Alphabet sent', description: 'Match the Morse pattern for each of the 26 letters.', earned: s => [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].every(c => s.sounds[c]?.good > 0) },
  { id: 'send-thousand', icon: 'flag', title: '1,000 characters sent', description: 'Send 1,000 characters in clean answers.', earned: s => s.characters >= 1000 },
  ...[25, 50, 250, 500, 1000].map(n => ({
    id: 'send-clean-' + n, icon: 'check', title: n.toLocaleString('en') + ' clean sends',
    description: 'Send ' + n.toLocaleString('en') + ' answers cleanly without help.', earned: s => s.clean >= n,
  })),
  ...[50, 250, 500, 2500, 5000].map(n => ({
    id: 'send-characters-' + n, icon: 'layers', title: n.toLocaleString('en') + ' characters sent',
    description: 'Send ' + n.toLocaleString('en') + ' characters in clean answers.', earned: s => s.characters >= n,
  })),
  ...[
    ['dit-dah', 'Dit and dah', 'ET'], ['vowels', 'Five vowels', 'AEIOU'],
    ['cq', 'Calling CQ', 'CQ'], ['report', 'Signal report', 'RST'],
    ['digits', 'All ten digits', '0123456789'], ['punctuation', 'CW punctuation', '.,?/'],
  ].map(([id, title, characters]) => ({
    id: 'send-' + id, icon: 'book', title, description: 'Match each of these characters in sending practice: ' + [...characters].join(' '),
    earned: s => [...characters].every(c => s.sounds[c]?.good > 0),
  })),
  ...[10, 50, 100].map(n => ({
    id: 'send-first-try-' + n, icon: 'spark', title: n + ' first-try sends',
    description: 'Send ' + n + ' exercises cleanly on your first attempt.',
    earned: s => Object.values(s.activity || {}).reduce((total, row) => total + row.clean, 0) >= n,
  })),
];

export function earnedSendBadges(sending) {
  return SEND_BADGES.filter(badge => badge.earned(sending));
}

// A device writes its own counters. Re-imports, pairing and retried pushes can
// take their maxima without counting a first attempt twice.
export function mergeSendActivity(left, right) {
  const activity = {};
  for (const source of [left, right]) {
    for (const [id, row] of Object.entries(object(source)).slice(0, 100)) {
      if (!/^[a-f\d-]{36}$/i.test(id) || !row) continue;
      const prior = activity[id], first = Math.max(prior?.first || 0, count(row.first));
      const days = Array.isArray(row.days) ? row.days.slice(-366).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
      activity[id] = { first, clean: Math.min(first, Math.max(prior?.clean || 0, count(row.clean))),
        days: [...new Set([...(prior?.days || []), ...days])].sort().slice(-366) };
    }
  }
  return Object.keys(activity).length ? activity : undefined;
}

export function sanitizeSendingSettings(input) {
  const s = object(input);
  const wpm = Math.round(number(s.wpm, 5, 80, 30));
  return { wpm, farnsworth: Math.round(number(s.farnsworth, 1, 80, wpm)), keyer: s.keyer === 'b' ? 'b' : 'a', reverse: s.reverse === true,
    continueMode: s.continueMode === 'manual' ? 'manual' : 'timed',
    pauseSeconds: Math.round(number(s.pauseSeconds, 0.5, 15, DEFAULT_SENDING_SETTINGS.pauseSeconds) * 10) / 10 };
}

export function emptySending() {
  return { version: 3, level: 1, pendingLevel: null, settings: { ...DEFAULT_SENDING_SETTINGS }, records: {}, results: [], attempts: 0, clean: 0, characters: 0, earned: 0, sounds: {} };
}

export function sanitizeSending(input) {
  let s = object(input);
  const version = number(s.version, 0, 1e9), result = emptySending();
  if (version < 3) {
    const level = Math.floor(number(s.level, 1, 120, 1)), oldRecords = object(s.records), records = {};
    for (let id = 1; id <= 120; id++) if (Object.hasOwn(oldRecords, String(id))) records[legacySendingLevel(id)] = oldRecords[id];
    const mastered = oldRecords[level]?.mastered === true;
    const pending = Object.hasOwn(s, 'pendingLevel') ? s.pendingLevel : mastered && !oldRecords[level + 1]?.mastered ? level + 1 : null;
    const current = legacySendingLevel(level, { resume: !mastered });
    // Continue through the added practice, rather than jumping over it. A
    // previously unfinished mixed lesson returns to single-character review.
    s = { ...s, level: current, records, pendingLevel: mastered && pending === level + 1 && pending <= 120 ? current + 1 : null };
  }
  result.level = Math.floor(number(s.level, 1, SENDING_LEVELS, 1));
  result.settings = sanitizeSendingSettings(s.settings);
  // Upgrade the original sending default once; later manual choices survive.
  if (version < 2 && result.settings.wpm === 30 && result.settings.farnsworth === 15) result.settings.farnsworth = 30;
  result.results=Array.isArray(s.results) ? s.results.slice(-300).filter(r=>r && typeof r.id==='string' && /^[0-9a-f-]{36}$/i.test(r.id) && Number.isSafeInteger(r.at)).map(r=>({id:r.id,at:r.at,xp:count(r.xp)})) : [];
  const history = mergeSendingSessions(s.sessionHistory, null, result.results);
  if (history) result.sessionHistory = history;
  const activity = mergeSendActivity(s.activity);
  if (activity) result.activity = activity;
  for (const key of ['attempts', 'clean', 'characters', 'earned']) result[key] = count(s[key]);
  result.clean = Math.min(result.clean, result.attempts);
  for (let level = 1; level <= SENDING_LEVELS; level++) {
    if (!Object.hasOwn(object(s.records), String(level))) continue;
    const row = object(s.records[level]), stage = sendingStage(level);
    result.records[level] = {
      attempts: count(row.attempts), good: count(row.good), best: Math.round(number(row.best, 0, 100)),
      mastered: row.mastered === true, turn: count(row.turn),
      focusHistory: Array.isArray(row.focusHistory) ? row.focusHistory.slice(-8).map(v => v === true) : [],
      history: Array.isArray(row.history) ? row.history.slice(-8).map(v => v === true) : [],
      covered: Array.isArray(row.covered) ? [...new Set(row.covered.slice(-20).filter(t => stage.items.some(i => i.target === t)))] : [],
    };
  }
  // Older saves could retain mastery after losing the level-up timer. Recover
  // that unfinished boundary once; an explicit null preserves selected reviews.
  const pending = Object.hasOwn(s, 'pendingLevel') ? s.pendingLevel :
    result.records[result.level]?.mastered && !result.records[result.level + 1]?.mastered ? result.level + 1 : null;
  if (pending === result.level + 1 && pending <= SENDING_LEVELS && result.records[result.level]?.mastered) result.pendingLevel = pending;
  for (const sound of [...Object.keys(MORSE), ...Object.keys(PROSIGNS).map(s => `<${s}>`)]) {
    const row = object(s.sounds?.[sound]);
    if (!Object.hasOwn(object(s.sounds), sound)) continue;
    result.sounds[sound] = { seen: count(row.seen), good: count(row.good), recent: Array.isArray(row.recent) ? row.recent.slice(-6).map(v => v === true) : [] };
  }
  return result;
}

export function sendingGapType(milliseconds, time) {
  if (milliseconds >= (time.letterGap * 1000 + time.wordGap * 1000) / 2) return 'word';
  return milliseconds >= 2 * time.dit * 1000 ? 'letter' : 'element';
}

function capture(edges, settings) {
  if (!Array.isArray(edges) || !edges.length || edges.length > 4096) throw new Error('No complete key presses.');
  const time = timing(settings.wpm, settings.farnsworth);
  const unit = time.dit * 1000;
  let last = -1;
  const marks = [], gaps = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e || typeof e.down !== 'boolean' || e.down !== (i % 2 === 0) || !Number.isFinite(e.at) || e.at < 0 || e.at > 180000 || e.at <= last) throw new Error('The key timing was interrupted. Try again.');
    if (i && !e.down) {
      const duration = e.at - last;
      if (duration > 10000 || duration < 2) throw new Error('That key press is outside the practice range. Try again.');
      marks.push({ duration, symbol: duration < 2 * unit ? '.' : '-', start: last });
    } else if (i) gaps.push({ duration: e.at - last, after: marks.length - 1 });
    last = e.at;
  }
  const groups = [];
  let group = null, wordIndex = 0;
  marks.forEach((mark, i) => {
    const gap = i ? gaps[i - 1] : null;
    if (gap) {
      // Farnsworth stretches inter-character gaps, not the recognition unit.
      // A readable standard character gap should decode as a boundary and get
      // "too short" spacing feedback, rather than merging letters into I/M/etc.
      gap.type = sendingGapType(gap.duration, time);
      if (gap.type === 'word') wordIndex++;
    }
    if (!group || gap?.type !== 'element') {
      group = { pattern: '', word: wordIndex, marks: [] };
      groups.push(group);
    }
    group.pattern += mark.symbol;
    group.marks.push(mark);
    mark.group = groups.length - 1;
  });
  const decode = pattern => Object.keys(MORSE).find(c => MORSE[c] === pattern) || Object.keys(PROSIGNS).find(c => PROSIGNS[c].pattern === pattern)?.replace(/^(.+)$/, '<$1>') || '�';
  let decoded = '';
  groups.forEach((g, i) => { if (i && g.word !== groups[i - 1].word) decoded += ' '; decoded += decode(g.pattern); });
  return { marks, gaps, groups, decoded, time, complete: edges.length % 2 === 0, duration: edges.at(-1).at - edges[0].at };
}

export function decodeSending(edges, settings = DEFAULT_SENDING_SETTINGS) {
  try { return { valid: true, ...capture(edges, sanitizeSendingSettings(settings)) }; }
  catch (error) { return { valid: false, complete: false, decoded: '', marks: [], gaps: [], groups: [], message: error.message }; }
}

function expectedGroups(target) {
  let word = 0;
  return target.split(' ').flatMap(part => { const w = word++; return sendingTokens(part).map(t => ({ ...t, word: w })); });
}

function matchesGroups(groups, expected) {
  return expected.length > 0 && groups.length === expected.length &&
    groups.every((g, i) => g.pattern === expected[i].pattern && g.word === expected[i].word);
}

export function matchesSendingTarget(capture, target) {
  return capture.valid && capture.complete && matchesGroups(capture.groups, expectedGroups(target));
}

export function gradeSending(edges, target, settings = DEFAULT_SENDING_SETTINGS, stage = sendingStage(1), { keyerTimed = false } = {}) {
  const result = decodeSending(edges, settings);
  const expected = expectedGroups(target);
  if (!result.valid || !result.complete || !expected.length || expected.some(t => !t.pattern)) return { ...result, correct: false, passed: false, quality: 0, issue: result.message || 'Release the key to finish.' };
  const correct = matchesGroups(result.groups, expected);
  const plan = timeline(target, settings);
  const parts = [];
  result.marks.forEach((mark, i) => {
    const expectedDuration = (correct ? plan.tones[i]?.duration : mark.symbol === '.' ? result.time.dit : result.time.dah) * 1000;
    parts.push({ type: mark.symbol === '.' ? 'dot' : 'dash', actual: mark.duration, expected: expectedDuration, error: Math.abs(mark.duration / expectedDuration - 1) });
  });
  result.gaps.forEach((gap, i) => {
    const expectedDuration = correct ? (plan.tones[i + 1].start - plan.tones[i].start - plan.tones[i].duration) * 1000 : (gap.type === 'word' ? result.time.wordGap : gap.type === 'letter' ? result.time.letterGap : result.time.elementGap) * 1000;
    parts.push({ type: `${gap.type} gap`, actual: gap.duration, expected: expectedDuration, error: Math.abs(gap.duration / expectedDuration - 1) });
  });
  // A paddle keyer generates marks and element gaps automatically. Assess the
  // learner's letter/word spacing on its own, without automatic marks inflating
  // the score. A single joined character has no manual spacing to assess yet.
  const assessed = keyerTimed ? parts.filter(p => ['letter gap', 'word gap'].includes(p.type)) : parts;
  const quality = assessed.length ? Math.round(100 * assessed.reduce((sum, p) => sum + Math.max(0, 1 - p.error), 0) / assessed.length) : 100;
  const inRange = assessed.length ? assessed.filter(p => p.error <= stage.tolerance + 1e-6).length / assessed.length : 1;
  const timingOK = quality >= stage.qualityGoal && inRange >= 0.8;
  const worst = [...assessed].sort((a, b) => b.error - a.error)[0];
  const issue = !correct ? 'The decoded pattern differs. Compare it with the target and try again.' : !timingOK ? `${worst.type[0].toUpperCase() + worst.type.slice(1)} ${worst.actual < worst.expected ? 'too short' : 'too long'}: ${Math.round(worst.actual)} ms; aim for ${Math.round(worst.expected)} ms.` : 'Correct pattern and timing.';
  return { ...result, correct, timingOK, passed: correct && timingOK, quality, parts, assessed, keyerTimed, issue, expected, soundResults: expected.map((t, i) => ({ sound: t.value, good: result.groups[i]?.pattern === t.pattern && result.groups[i]?.word === t.word })) };
}

export function sendingMastery(sending, level = sending.level) {
  const stage = sendingStage(level), record = sending.records[level];
  const recent = (record?.history || []).slice(-stage.window);
  const good = recent.filter(Boolean).length;
  const distinct = record?.covered.length || 0;
  const focusGood = Math.min(stage.focusCopies, (record?.focusHistory || []).slice(-stage.window).filter(Boolean).length);
  const ready = good >= stage.required && recent.at(-1) === true && distinct >= stage.distinct && focusGood >= stage.focusCopies && (stage.kind !== 'reply' || (record?.turn || 0) >= stage.items.length);
  return { good: Math.min(stage.required, good), required: stage.required, distinct, distinctRequired: stage.distinct, focusGood, focusRequired: stage.focusCopies, mastered: record?.mastered === true, ready };
}

export function advanceSending(sending) {
  if (sending.pendingLevel !== sending.level + 1 || sending.pendingLevel > SENDING_LEVELS || !sending.records[sending.level]?.mastered) return false;
  sending.level = sending.pendingLevel;
  sending.pendingLevel = null;
  return true;
}

const masteryXP = 30;
const sendBaseXP = characters => 10 + 2 * Math.min(characters - 1, 10);
const sendAwards = new Set([10, 10 + masteryXP]);
for (let characters = 2; characters <= 11; characters++) {
  for (const bonus of [0, 4, 5, 6]) {
    const xp = sendBaseXP(characters) + bonus;
    sendAwards.add(xp);
    sendAwards.add(xp + masteryXP);
  }
}
export const validSendingXP = xp => sendAwards.has(xp);

function cleanSendingXP(target, grade, characters) {
  const base = sendBaseXP(characters);
  if (characters < 2 || !grade.assessed?.length || grade.quality < 90) return base;
  // Compare complete transmissions, including the gaps the operator actually sent.
  const referenceWpm = 30;
  const referenceMs = timeline(target, {wpm:referenceWpm, farnsworth:referenceWpm}).duration * 1000;
  const measuredWpm = Math.round(referenceWpm * referenceMs / grade.duration * 10) / 10;
  return base + 4 + (measuredWpm >= 20 ? 1 : 0) + (measuredWpm >= 30 ? 1 : 0);
}

export function recordSending(sending, target, grade, { assisted = false, sessionId, stream, firstAttempt, day } = {}) {
  const stage = sendingStage(sending.level);
  if (!stage.items.some(item => item.target === target) || !grade.valid || !grade.complete) return { xp: 0, levelUp: false, badges: [] };
  const previousBadges = new Set(earnedSendBadges(sending));
  const record = sending.records[stage.level] ||= { attempts: 0, good: 0, best: 0, mastered: false, turn: 0, focusHistory: [], history: [], covered: [] };
  const passed = grade.passed && !assisted;
  const characters = sendingTokens(target).length;
  if (stream && day) {
    const activity = sending.activity ||= {};
    const row = activity[stream] ||= { first: 0, clean: 0, days: [] };
    if (firstAttempt) { row.first++; if (passed) row.clean++; }
    if (!row.days.includes(day)) row.days = [...row.days, day].sort().slice(-366);
  }
  sending.attempts++; record.attempts++;
  record.best = Math.max(record.best, grade.quality);
  record.history = [...record.history, passed].slice(-8);
  record.focusHistory = [...(record.focusHistory || []), passed && target === stage.focus].slice(-8);
  if (passed) {
    sending.clean++; record.good++;
    sending.characters += characters;
    if (!record.covered.includes(target)) record.covered.push(target);
    if (stage.kind === 'reply') record.turn++;
  }
  for (const row of grade.soundResults || []) {
    const sound = sending.sounds[row.sound] ||= { seen: 0, good: 0, recent: [] };
    sound.seen++;
    if (row.good) sound.good++;
    sound.recent = [...sound.recent, row.good].slice(-6);
  }
  const levelUp = !record.mastered && sendingMastery(sending).ready;
  if (levelUp) {
    record.mastered = true;
    sending.pendingLevel = stage.level < SENDING_LEVELS ? stage.level + 1 : null;
  }
  const xp = (passed ? cleanSendingXP(target, grade, characters) : 0) + (levelUp ? masteryXP : 0);
  sending.earned = Math.min(1e9, sending.earned + xp);
  const result = { id: crypto.randomUUID(), at: Date.now(), xp };
  sending.results = [...sending.results, result].slice(-300);
  sessionId = recordSendingSession(sending, result, sessionId);
  const badges = earnedSendBadges(sending).filter(badge => !previousBadges.has(badge));
  return { id: result.id, xp, levelUp, passed, badges, sessionId, nextLevel: levelUp && stage.level < SENDING_LEVELS ? stage.level + 1 : null };
}

export function mergeSending(baseInput, localInput, remoteInput) {
  const b = sanitizeSending(baseInput), l = sanitizeSending(localInput), r = sanitizeSending(remoteInput), result = structuredClone(r);
  const activity = mergeSendActivity(r.activity, l.activity);
  if (activity) result.activity = activity;
  const results=new Map([...r.results,...l.results].map(row=>[row.id,row]));
  result.results=[...results.values()].sort((a,b)=>a.at-b.at).slice(-300);
  const history = mergeSendingSessions(l.sessionHistory, r.sessionHistory, result.results);
  if (history) result.sessionHistory = history;
  if (l.level !== b.level) { result.level = l.level; result.pendingLevel = l.pendingLevel; }
  else if (l.pendingLevel !== b.pendingLevel) result.pendingLevel = l.pendingLevel;
  for (const key of Object.keys(l.settings)) if (!same(b.settings[key], l.settings[key])) result.settings[key] = l.settings[key];
  for (const key of ['attempts', 'clean', 'characters', 'earned']) result[key] = plus(b[key], l[key], r[key]);
  for (const [id, row] of Object.entries(l.records)) {
    const previous = b.records[id] || {}, remote = r.records[id] || {};
    if (same(row, previous)) continue;
    const n = Math.max(0, row.attempts - (previous.attempts || 0));
    result.records[id] = {
      attempts: plus(previous.attempts, row.attempts, remote.attempts), good: plus(previous.good, row.good, remote.good),
      best: Math.max(remote.best || 0, row.best), mastered: remote.mastered || row.mastered,
      turn: Math.max(remote.turn || 0, row.turn),
      focusHistory: [...(remote.focusHistory || []), ...(n ? row.focusHistory.slice(-n) : [])].slice(-8),
      history: [...(remote.history || []), ...(n ? row.history.slice(-n) : [])].slice(-8),
      covered: [...new Set([...(remote.covered || []), ...row.covered])],
    };
  }
  for (const [id, row] of Object.entries(l.sounds)) {
    const previous = b.sounds[id] || {}, remote = r.sounds[id] || {};
    const n = Math.max(0, row.seen - (previous.seen || 0));
    result.sounds[id] = { seen: plus(previous.seen, row.seen, remote.seen), good: plus(previous.good, row.good, remote.good), recent: [...(remote.recent || []), ...(n ? row.recent.slice(-n) : [])].slice(-6) };
  }
  return sanitizeSending(result);
}
