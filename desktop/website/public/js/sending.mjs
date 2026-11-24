import { MORSE, PROSIGNS, timing, timeline } from './morse.mjs';
import { SENDING_LEVELS, legacySendingLevel, sendingStage, sendingTokens } from './sending-course.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const number = (v, min, max, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const count = v => Math.floor(number(v, 0, 1e9));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plus = (b = 0, l = 0, r = 0) => Math.min(1e9, r + Math.max(0, l - b));

export const DEFAULT_SENDING_SETTINGS = Object.freeze({ wpm: 30, farnsworth: 30, keyer: 'a', reverse: false });
export function sanitizeSendingSettings(input) {
  const s = object(input);
  const wpm = Math.round(number(s.wpm, 5, 60, 30));
  return { wpm, farnsworth: Math.round(number(s.farnsworth, 5, wpm, wpm)), keyer: s.keyer === 'b' ? 'b' : 'a', reverse: s.reverse === true };
}

export function emptySending() {
  return { version: 3, level: 1, pendingLevel: null, settings: { ...DEFAULT_SENDING_SETTINGS }, records: {}, attempts: 0, clean: 0, characters: 0, earned: 0, sounds: {} };
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

function capture(edges, settings) {
  if (!Array.isArray(edges) || !edges.length || edges.length > 4096) throw new Error('No complete key presses.');
  const time = timing(settings.wpm, settings.farnsworth);
  const unit = time.dit * 1000, letter = time.letterGap * 1000, word = time.wordGap * 1000;
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
      gap.type = gap.duration >= (letter + word) / 2 ? 'word' : gap.duration >= 2 * unit ? 'letter' : 'element';
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

export function gradeSending(edges, target, settings = DEFAULT_SENDING_SETTINGS, stage = sendingStage(1), { keyerTimed = false } = {}) {
  const result = decodeSending(edges, settings);
  const expected = expectedGroups(target);
  if (!result.valid || !result.complete || !expected.length || expected.some(t => !t.pattern)) return { ...result, correct: false, passed: false, quality: 0, issue: result.message || 'Release the key to finish.' };
  const correct = result.groups.length === expected.length && result.groups.every((g, i) => g.pattern === expected[i].pattern && g.word === expected[i].word);
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

export function recordSending(sending, target, grade, { assisted = false } = {}) {
  const stage = sendingStage(sending.level);
  if (!stage.items.some(item => item.target === target) || !grade.valid || !grade.complete) return { xp: 0, levelUp: false };
  const record = sending.records[stage.level] ||= { attempts: 0, good: 0, best: 0, mastered: false, turn: 0, focusHistory: [], history: [], covered: [] };
  const passed = grade.passed && !assisted;
  sending.attempts++; record.attempts++;
  record.best = Math.max(record.best, grade.quality);
  record.history = [...record.history, passed].slice(-8);
  record.focusHistory = [...(record.focusHistory || []), passed && target === stage.focus].slice(-8);
  if (passed) {
    sending.clean++; record.good++;
    sending.characters += sendingTokens(target).length;
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
  const xp = (passed ? 10 : 0) + (levelUp ? 30 : 0);
  sending.earned = Math.min(1e9, sending.earned + xp);
  return { xp, levelUp, passed, nextLevel: levelUp && stage.level < SENDING_LEVELS ? stage.level + 1 : null };
}

export function mergeSending(baseInput, localInput, remoteInput) {
  const b = sanitizeSending(baseInput), l = sanitizeSending(localInput), r = sanitizeSending(remoteInput), result = structuredClone(r);
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
