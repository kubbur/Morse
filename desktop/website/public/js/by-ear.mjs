import { MORSE, normalizeText, gradeAnswer } from './morse.mjs';
import { COURSE_LEVELS, legacyCourseLevel, expandedCourseLevel, courseStage, courseFocus, alphabetFor, isGrowingCourse, practiceKey } from './lessons.mjs';
import { soundUnits } from './review.mjs';
import { COURSE_DIGITS, COURSE_MARKS, COURSE_PROSIGNS } from './course.mjs';

export const LISTENING_GOAL = 6;
export const LISTENING_COOLDOWN = 8;
export const emptyListening = () => ({ records: {}, active: null, cooldown: 0 });
const bounded = (value, max) => Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
const own = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pick = (values, random) => values[Math.min(values.length - 1, Math.max(0, Math.floor(random() * values.length)))];

// Checkpoints follow completed material. They never introduce the next stage's
// new character, renumber a course level, or require a particular typing speed.
export function listeningCheckpoint(level) {
  if (!Number.isInteger(level) || level < 1 || level >= COURSE_LEVELS) return null;
  // These short, untimed refreshers preserve earlier material during the
  // systematic rebuild. They never expand the current letter/digit lesson.
  if (level >= 204 && level <= 288 && (level - 204) % 12 === 0) {
    const slot = (level - 204) / 12, type = slot % 3;
    const pool = type === 0 ? [...COURSE_DIGITS].slice((Math.floor(slot / 3) * 3) % 7, (Math.floor(slot / 3) * 3) % 7 + 4) : type === 1 ? [...COURSE_MARKS] : COURSE_PROSIGNS.slice(slot < 5 ? 0 : 3, slot < 5 ? 3 : 6);
    return { level, kind: 'maintenance', maintenance: true, pool, prosigns: COURSE_PROSIGNS, label: `${['Number', 'Punctuation', 'Procedural signal'][type]} refresher` };
  }
  if ([304, 316, 328, 340, 352, 364].includes(level)) {
    const pool = level <= 328 ? [...(level === 304 ? 'FLGWAN' : level === 316 ? 'KRUDBX' : 'ETIHSO')] : level === 340 ? [...COURSE_DIGITS] : level === 352 ? [...COURSE_MARKS] : [...'ANFLGW'];
    return { level, kind: 'maintenance', maintenance: true, pool, prosigns: COURSE_PROSIGNS, label: `${level <= 328 || level === 364 ? 'Alphabet' : level === 340 ? 'Number' : 'Punctuation'} refresher` };
  }
  const step = legacyCourseLevel(level);
  if (step === null) return null;
  const stage = courseStage(level);
  if (step === 1) return { level, kind: 'groups', length: 1, label: 'Your first sounds by ear' };
  if (step <= 92 && step % 4 === 0) return { level, kind: 'groups', length: step === 4 ? 2 : 3, label: 'Your alphabet by ear' };
  if (step === 93) return { level, kind: 'groups', length: 3, label: 'The alphabet by ear' };
  if (step >= 94 && step <= 100) return { level, kind: 'messages', label: `${stage.label} by ear` };
  if (step === 101 || step >= 104 && step <= 140 && step % 4 === 0) return { level, kind: 'groups', length: step === 101 ? 1 : 3, label: 'Letters and numbers by ear' };
  if (step >= 142 && step <= 152 && step % 2 === 0) return { level, kind: 'messages', label: `${stage.label} by ear` };
  if (step >= 156 && step <= 172 && step % 4 === 0) return { level, kind: 'messages', label: `${stage.label} by ear` };
  if (step >= 176 && step <= 196 && step % 4 === 0) return { level, kind: 'prosigns', length: 2, label: 'Radio signals by ear' };
  if (step >= 197 && step <= 199) return { level, kind: 'messages', label: 'On air by ear' };
  return null;
}

export function checkpointSettings(settings, level) {
  const sourceLevel = listeningCheckpoint(level)?.maintenance ? 192 : level;
  const stage = courseStage(sourceLevel);
  return { ...settings, track: 'course', lesson: 'starter', content: 'groups', courseLevel: sourceLevel, courseCount: stage.letterCount, level: stage.maxLength };
}

function checkpointId(value) {
  const match = /^(flexible|head):(ear:)?(\d{1,3})$/.exec(value);
  const level = match && (match[2] ? Number(match[3]) : expandedCourseLevel(Number(match[3])));
  const checkpoint = listeningCheckpoint(level);
  return match && String(Number(match[3])) === match[3] && checkpoint && !!match[2] === !!checkpoint.maintenance ? { mode: match[1], level, maintenance: !!match[2] } : null;
}

function checkpointAllowed(settings, parsed) {
  return isGrowingCourse(settings) && parsed && parsed.mode === settings.copyMode && parsed.level < settings.courseLevel &&
    (parsed.maintenance ? settings.courseLevel >= 193 : !courseStage(settings.courseLevel).audioCourse && settings.visualSupport === 'auto');
}

export function sanitizeListening(input, settings) {
  const source = own(input), records = {};
  for (const [id, value] of Object.entries(own(source.records)).slice(-200)) {
    const parsed = checkpointId(id);
    if (!parsed) continue;
    const taught = checkpointSettings(settings, parsed.level), signals = courseStage(taught.courseLevel).prosigns || [];
    const allowed = [...alphabetFor(taught), ...signals], record = own(value);
    const letters = bounded(record.letters, LISTENING_GOAL);
    records[id] = { letters, passed: letters === LISTENING_GOAL && record.passed === true, covered: Array.isArray(record.covered) ? [...new Set(record.covered.slice(0, 50).filter(sound => allowed.includes(sound)))].slice(0, 50) : [] };
  }
  const result = { records, active: null, cooldown: bounded(source.cooldown, LISTENING_COOLDOWN) };
  const active = own(source.active), parsed = typeof active.id === 'string' ? checkpointId(active.id) : null;
  if (checkpointAllowed(settings, parsed) &&
      active.ownerKey === practiceKey(settings) && records[active.id]) {
    result.active = { id: active.id, ownerKey: active.ownerKey, misses: bounded(active.misses, 2) };
  }
  return result;
}

export function activeListening(profile) {
  const active = profile.listening?.active, parsed = active && checkpointId(active.id);
  if (!parsed) return null;
  return { ...listeningCheckpoint(parsed.level), ...profile.listening.records[active.id], ...active };
}

export function guidedListeningPractice(profile) {
  return profile.settings.visualSupport === 'auto' && profile.listening?.cooldown > 0 && Object.entries(profile.listening.records).some(([id, record]) => {
    const parsed = checkpointId(id);
    return parsed?.mode === profile.settings.copyMode && parsed.level < profile.settings.courseLevel && !record.passed;
  });
}

export function queueListening(profile, level) {
  const checkpoint = listeningCheckpoint(level);
  if (!checkpoint || !checkpointAllowed(profile.settings, { mode: profile.settings.copyMode, level, maintenance: !!checkpoint.maintenance })) return false;
  profile.listening ||= emptyListening();
  const id = `${profile.settings.copyMode}:${checkpoint.maintenance ? `ear:${level}` : legacyCourseLevel(level)}`;
  profile.listening.records[id] ||= { letters: 0, passed: false, covered: [] };
  return beginListening(profile);
}

export function beginListening(profile) {
  profile.listening = sanitizeListening(profile.listening, profile.settings);
  const listening = profile.listening;
  if (!isGrowingCourse(profile.settings) || profile.focus?.active || listening.active || listening.cooldown) return false;
  const pending = Object.keys(listening.records).filter(id => {
    const parsed = checkpointId(id);
    return checkpointAllowed(profile.settings, parsed) && !listening.records[id].passed;
  }).sort((a, b) => checkpointId(a).level - checkpointId(b).level);
  if (!pending.length) return false;
  listening.active = { id: pending[0], ownerKey: practiceKey(profile.settings), misses: 0 };
  return true;
}

function messagePool(settings, level) {
  const stage = courseStage(level), pool = new Set();
  for (const text of stage.pool || []) {
    const words = text.split(' ');
    for (let start = 0; start < words.length; start++) {
      for (let size = 1; size <= 2 && start + size <= words.length; size++) {
        const phrase = words.slice(start, start + size).join(' ');
        if (phrase.replaceAll(' ', '').length <= 6) pool.add(phrase);
      }
    }
  }
  return [...pool].filter(text => [...text].every(c => c === ' ' || alphabetFor(checkpointSettings(settings, level)).includes(c)));
}

export function validListeningTarget(profile, target) {
  const active = activeListening(profile);
  if (!active || typeof target !== 'string' || normalizeText(target) !== target || target.length > 20) return false;
  if (active.maintenance) return active.pool.includes(target);
  const taught = checkpointSettings(profile.settings, active.level), stage = courseStage(active.level);
  if (active.kind === 'prosigns') return (stage.prosigns || []).includes(target);
  if (active.kind === 'messages') return messagePool(profile.settings, active.level).includes(target);
  return target.length >= 1 && target.length <= active.length && [...target].every(c => Object.hasOwn(MORSE, c) && alphabetFor(taught).includes(c));
}

export function listeningPrompt(profile, previous = '', random = Math.random) {
  const active = activeListening(profile);
  if (!active || active.passed || active.misses >= 2) return null;
  const taught = checkpointSettings(profile.settings, active.level), stage = courseStage(active.level);
  const focus = courseFocus(taught), remaining = Math.max(1, LISTENING_GOAL - active.letters);
  let choices;
  if (active.maintenance) {
    const uncovered = active.pool.filter(sound => !active.covered.includes(sound));
    choices = uncovered.length ? uncovered : active.pool;
  } else if (active.kind === 'prosigns') choices = stage.prosigns || [];
  else if (active.kind === 'messages') choices = messagePool(profile.settings, active.level);
  if (choices) {
    const fitting = choices.filter(text => text.replaceAll(' ', '').length <= remaining);
    if (fitting.length) choices = fitting;
    const fresh = choices.filter(text => text !== previous);
    if (fresh.length) choices = fresh;
    const focused = focus && !active.covered.includes(focus) ? choices.filter(text => soundUnits(text, stage.prosigns || []).some(unit => unit.sound === focus)) : [];
    return pick(focused.length ? focused : choices, random) || null;
  }
  const letters = [...alphabetFor(taught)], length = Math.min(active.length, remaining);
  const untested = letters.filter(c => !active.covered.includes(c));
  let target = '';
  for (let i = 0; i < length; i++) {
    const preferred = i === 0 && focus && !active.covered.includes(focus) ? [focus] : untested.filter(c => !target.includes(c));
    const varied = letters.filter(c => c !== target.at(-1) && (length > 1 || c !== previous));
    target += pick(preferred.length ? preferred : varied.length ? varied : letters, random);
  }
  if (target === previous && letters.length > 1) target = target.slice(0, -1) + pick(letters.filter(c => c !== target.at(-1)), random);
  return target;
}

export function recordListeningRound(profile, clean) {
  profile.listening ||= emptyListening();
  const round = profile.round, active = activeListening(profile);
  if (!round?.byEar) {
    if (clean && !round?.focus) profile.listening.cooldown = Math.max(0, profile.listening.cooldown - round.target.replaceAll(' ', '').length);
    return false;
  }
  if (!active || active.id !== round.byEar || !validListeningTarget(profile, round.target)) return false;
  const record = profile.listening.records[active.id];
  if (round.heard && round.plays === 1 && round.attempts === 1 && !round.assisted && !round.visualUsed) {
    const aligned = gradeAnswer(round.target.replaceAll(' ', ''), normalizeText(round.firstGuess).replaceAll(' ', '')).letters.filter(letter => letter.expected);
    const units = soundUnits(round.target, active.prosigns || courseStage(active.level).prosigns || []);
    const correct = units.filter(unit => aligned.slice(unit.start, unit.end).length === unit.end - unit.start && aligned.slice(unit.start, unit.end).every((letter, index) => letter.correct && !round.mistakes?.[unit.start + index]));
    record.letters = Math.min(LISTENING_GOAL, record.letters + correct.reduce((sum, unit) => sum + unit.end - unit.start, 0));
    record.covered = [...new Set([...record.covered, ...correct.map(unit => unit.sound)])];
  }
  if (round.attempts && (!round.solved || round.mistakes?.some(Boolean))) {
    profile.listening.active.misses = Math.min(2, profile.listening.active.misses + 1);
  }
  record.passed ||= record.letters >= LISTENING_GOAL && clean && !round.visualUsed;
  round.byEarComplete = record.passed;
  round.byEarDeferred = !round.byEarComplete && profile.listening.active.misses >= 2;
  return round.byEarComplete;
}

export function leaveListening(profile) {
  profile.listening.active = null;
  profile.listening.cooldown = LISTENING_COOLDOWN;
}
