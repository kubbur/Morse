import { MORSE, PROSIGNS, clamp, supportedCharacters, normalizeText, gradeAnswer } from './morse.mjs';
import { LESSONS, CONTENT, COURSE_LETTERS, COURSE_GROUP_LENGTH, COURSE_LEVELS, EAR_COURSE_START, EAR_COURSE_END, expandedCourseLevel, courseStage, courseLevelFor, alphabetFor, isGrowingCourse, isEndless, courseFocus, candidatesFor, practiceKey } from './lessons.mjs';
import { isSaluteId } from './celebrations.mjs';
import { parseProgressJson } from './import-validation.mjs';
import { emptyGuidance, sanitizeGuidance, sanitizeRecovery } from './guidance.mjs';
import { copyResponses, responseGoal, sanitizePacing, adaptPacing, sanitizeMistakes } from './recognition.mjs';
import { emptyReview, sanitizeReview, observeReview, visualHelpPhase, soundUnits } from './review.mjs';
import { emptyEndless, sanitizeEndless, courseCompleted, radioMission, validRadioTarget, awardRadio } from './endless.mjs';
import { emptyFocus, sanitizeFocus, focusPhase, recordFocusRound } from './focus-level.mjs';
import { sanitizeSessions, sessionsFromRounds, recordSessionAnswer, listeningSessions } from './sessions.mjs';
import { emptyListening, sanitizeListening, activeListening, validListeningTarget, recordListeningRound, guidedListeningPractice } from './by-ear.mjs';
import { emptySending, sanitizeSending } from './sending.mjs';

export const STORAGE_KEY = 'morse.progress.v1';
export const DEFAULT_SETTINGS = Object.freeze({
  level: 1, courseVersion: 3, earReturnLevel: 0, lesson: 'starter', content: 'groups', courseLevel: 1, courseCount: 4, kochCount: 2, custom: 'ETAN',
  wpm: 30, farnsworth: 15, tone: 600, volume: 55, rise: 5, fall: 5,
  curve: 'smooth', adaptive: true, timingMode: 'adaptive', goal: 10, recallSeconds: 1.5, showMorse: true,
  copyMode: 'flexible', visualSupport: 'auto', track: 'course',
});
export const QUICK_LETTER_XP = 2;
export const COURSE_FOCUS_COPIES = 5;
export function sanitizeCallsign(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9][A-Z0-9/]{1,15}$/.test(text) ? text : '';
}

function numeric(value) { return typeof value === 'number' || typeof value === 'string' && value.length <= 32 ? Number(value) : NaN; }
function integer(value, min, max, fallback = min) { return Math.round(clamp(numeric(value), min, max, fallback)); }
function safeText(value, length = 32) { return (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length); }
function id() { return globalThis.crypto?.randomUUID?.() || `learner-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value); }
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function sanitizeSettings(input = {}) {
  const source = safeObject(input);
  const settings = { ...DEFAULT_SETTINGS };
  settings.level = integer(source.level, 1, 10, 1);
  settings.lesson = LESSONS.some(lesson => lesson.id === source.lesson) ? source.lesson : 'starter';
  settings.content = typeof source.content === 'string' && Object.hasOwn(CONTENT, source.content) ? source.content : 'groups';
  settings.courseCount = integer(source.courseCount, 4, COURSE_LETTERS.length, 4);
  settings.courseLevel = integer(source.courseLevel, 1, COURSE_LEVELS, courseLevelFor(settings.courseCount, settings.level));
  const returning = integer(source.earReturnLevel, 0, COURSE_LEVELS, 0);
  settings.earReturnLevel = settings.courseLevel >= 149 && settings.courseLevel <= EAR_COURSE_END && returning > EAR_COURSE_END ? returning : 0;
  settings.kochCount = integer(source.kochCount, 2, 41, 2);
  settings.custom = supportedCharacters(typeof source.custom === 'string' ? source.custom : 'ETAN').slice(0, 50) || 'ETAN';
  settings.wpm = integer(source.wpm, 5, 80, 30);
  settings.farnsworth = integer(source.farnsworth, 1, 80, 15);
  settings.tone = 50 * Math.round(integer(source.tone, 200, 2000, 600) / 50);
  settings.volume = integer(source.volume, 0, 100, 55);
  settings.rise = integer(source.rise, 1, 30, 5);
  settings.fall = integer(source.fall, 1, 30, 5);
  settings.curve = ['linear', 'exponential'].includes(source.curve) ? source.curve : 'smooth';
  settings.adaptive = source.adaptive !== false;
  settings.timingMode = source.timingMode === 'fixed' ? 'fixed' : 'adaptive';
  settings.goal = integer(source.goal, 5, 50, 10);
  settings.recallSeconds = Math.round(clamp(numeric(source.recallSeconds ?? 1.5), 0.5, 4, 1.5) * 10) / 10;
  settings.showMorse = source.showMorse !== false;
  settings.copyMode = source.copyMode === 'head' ? 'head' : 'flexible';
  settings.visualSupport = ['auto', 'always', 'off'].includes(source.visualSupport) ? source.visualSupport : settings.showMorse ? 'auto' : 'off';
  settings.track = source.track === 'endless' && settings.lesson === 'starter' && settings.content === 'groups' ? 'endless' : 'course';
  if (settings.visualSupport === 'off') settings.showMorse = false;
  if (isEndless(settings)) Object.assign(settings, { courseLevel: COURSE_LEVELS, courseCount: 26, level: 100 });
  if (isGrowingCourse(settings)) {
    const stage = courseStage(settings.courseLevel);
    settings.courseCount = stage.letterCount;
    settings.level = stage.maxLength;
  }
  return settings;
}

export function emptyStats() {
  return { xp: 0, rounds: [], sessions: [], badges: [], focusCompletions: 0, characters: {}, mastery: {}, days: {}, lastSalute: '', cleanStreak: 0, bestStreak: 0, total: 0, solved: 0, clean: 0,
    modes: { flexible: { total: 0, clean: 0, quick: 0, best: 0 }, head: { total: 0, clean: 0, quick: 0, best: 0 } } };
}

function sanitizeStats(input) {
  const source = safeObject(input);
  const stats = emptyStats();
  stats.badges = Array.isArray(source.badges) ? [...new Set(source.badges.slice(0, 100).filter(id => BADGES.some(b => b.id === id)))] : [];
  stats.focusCompletions = integer(source.focusCompletions, 0, 1e9, 0);
  stats.lastSalute = isSaluteId(source.lastSalute) ? source.lastSalute : '';
  for (const key of ['xp', 'cleanStreak', 'bestStreak', 'total', 'solved', 'clean']) stats[key] = integer(source[key], 0, 1e9, 0);
  for (const character of Object.keys(MORSE)) {
    if (!Object.hasOwn(safeObject(source.characters), character)) continue;
    const entry = safeObject(source.characters[character]);
    const seen = integer(entry.seen, 0, 1e9, 0);
    stats.characters[character] = { seen, correct: integer(entry.correct, 0, seen, 0) };
  }
  for (const [key, entry] of Object.entries(safeObject(source.mastery)).slice(-1500)) {
    // Keys are generated from a fixed content type, alphabet and level.
    try {
      if (key.length > 160) continue;
      const parts = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length > 5) continue;
      if (parts.at(-1) === 'head') parts.pop();
      if (![3, 4].includes(parts.length) || parts.length === 4 && !['mixed', 'endless'].includes(parts[3]) && (typeof parts[3] !== 'string' || !/^(?:course:(?:9[4-9]|1\d\d|200)|ear:(?:19[3-9]|2\d\d|3[0-8]\d|39[0-2]))$/.test(parts[3])) || !Object.hasOwn(CONTENT, parts[0]) ||
          typeof parts[1] !== 'string' || parts[1].length > 50 || !Number.isInteger(parts[2]) || parts[2] < 1 || parts[2] > 100) continue;
      const value = safeObject(entry);
      // Old records held one worst-response time per group. Expanding that
      // conservative time preserves earned progress without inventing fast letters.
      const copies = value.unit === 'letters' ? 1 : parts[2];
      stats.mastery[key] = {
        unit: 'letters',
        ...(Object.hasOwn(value, 'samples') ? { samples: integer(value.samples, 0, 1e9, 0) } : {}),
        ...(Object.hasOwn(value, 'characterSamples') ? { characterSamples: Object.fromEntries([...Object.keys(MORSE), ...Object.keys(PROSIGNS)].filter(c => Object.hasOwn(safeObject(value.characterRecognition), c)).map(c => [c, integer(value.characterSamples?.[c], 0, 1e9, 0)])) } : {}),
        history: Array.isArray(value.history) ? value.history.slice(-20).flatMap(v => Array(copies).fill(v === true)).slice(-20) : [],
        mastered: value.mastered === true,
        recognition: Array.isArray(value.recognition) ? value.recognition.slice(-20).flatMap(v => Array(copies).fill(typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 600000) : null)).slice(-20) : [],
        ...(Array.isArray(value.cleanPrompts) ? { cleanPrompts: [...new Set(value.cleanPrompts.slice(-5).filter(v => typeof v === 'string' && v.length <= 100 && [...v].every(c => c === ' ' || Object.hasOwn(MORSE, c))))] } : {}),
        characterRecognition: Object.fromEntries([...Object.keys(MORSE), ...Object.keys(PROSIGNS)].filter(c => Object.hasOwn(safeObject(value.characterRecognition), c)).map(c => [c,
          Array.isArray(value.characterRecognition[c]) ? value.characterRecognition[c].slice(-COURSE_FOCUS_COPIES).map(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 600000) : null) : [],
        ])),
      };
    } catch { /* Ignore unknown imported entries. */ }
  }
  for (const [day, count] of Object.entries(safeObject(source.days)).sort().slice(-366)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) stats.days[day] = integer(count, 0, 10000, 0);
  }
  stats.rounds = Array.isArray(source.rounds) ? source.rounds.slice(-300).map(entry => ({
    ...(safeId(entry?.id) ? {id:entry.id} : {}),
    at: Number.isFinite(entry?.at) ? entry.at : 0,
    level: integer(entry?.level, 1, 100, 1),
    wpm: integer(entry?.wpm, 5, 80, 30),
    clean: entry?.clean === true,
    solved: entry?.solved === true,
    assisted: entry?.assisted === true,
    quick: entry?.quick === true,
    speedBonus: integer(entry?.speedBonus, 0, 200, 0),
  })) : [];
  stats.sessions = Array.isArray(source.sessions) ? sanitizeSessions(source.sessions) : sessionsFromRounds(stats.rounds);
  for (const mode of ['flexible', 'head']) {
    const entry = safeObject(source.modes?.[mode]), total = integer(entry.total, 0, 1e9, 0);
    stats.modes[mode] = { total, clean: integer(entry.clean, 0, total, 0), quick: integer(entry.quick, 0, total, 0), best: integer(entry.best, 0, 100, 0) };
  }
  return stats;
}

function sanitizeRound(input, settings, endless, focus, listening) {
  if (!input || typeof input !== 'object' || typeof input.target !== 'string' || input.key !== practiceKey(settings)) return null;
  const target = normalizeText(input.target).slice(0, 100);
  const stage = isGrowingCourse(settings) ? courseStage(settings.courseLevel) : null;
  const length = target.replaceAll(' ', '').length;
  const focused = input.focus === true && !!focus?.active;
  const checkpoint = typeof input.byEar === 'string' && input.byEar === listening.active?.id && validListeningTarget({ settings, listening }, target);
  const courseEar = !focused && !checkpoint && stage?.byEar === true;
  if (input.byEar && !checkpoint || checkpoint && focused) return null;
  if (input.focus && !focused) return null;
  if (focused && (length < 1 || length > focus.active.maxLength || [...target].some(c => !focus.active.sounds.includes(c)) || !input.completed && length !== focusPhase(focus.active))) return null;
  if (!focused && !checkpoint && stage?.pool && !stage.pool.includes(target)) return null;
  if (isEndless(settings) && !validRadioTarget(endless, target)) return null;
  if (!target || [...target].some(c => c !== ' ' && !Object.hasOwn(MORSE, c)) || (!focused && !checkpoint && !isEndless(settings) && (stage?.review ? length < stage.minLength || length > stage.maxLength : length !== settings.level))) return null;
  const introduction = !focused && !checkpoint && !stage?.audioCourse && input.introduction === true && (settings.level === 1 || stage?.newSound) && target === courseFocus(settings);
  const attempts = integer(input.attempts, 0, 10000, 0);
  const recovery = input.completed === true ? null : sanitizeRecovery(input.recovery, target, attempts, settings);
  const units = soundUnits(target, checkpoint ? activeListening({ settings, listening })?.prosigns || stage?.prosigns || [] : !focused && stage ? stage.prosigns || [] : []);
  const mistakes = sanitizeMistakes(input.mistakes, target);
  const mistakenSounds = new Set(units.filter(unit => mistakes.slice(unit.start, unit.end).some(Boolean)).map(unit => unit.sound));
  return {
    target, key: input.key, ...(focused ? { focus: true, focusComplete: input.completed === true && focusPhase(focus.active) === 0 } : {}), draft: safeText(input.draft, 100), earOnly: courseEar || input.earOnly === true,
    ...(checkpoint ? { byEar: input.byEar, byEarComplete: input.completed === true && listening.records[input.byEar].passed, byEarDeferred: input.completed === true && listening.active.misses >= 2 && !listening.records[input.byEar].passed } : {}),
    visualPhase: courseEar ? 'review' : ['live', 'review', 'request'].includes(input.visualPhase) ? input.visualPhase : input.earOnly ? 'request' : 'live', visualRevealed: input.visualRevealed === true, visualHidden: input.visualHidden === true,
    visualUsed: input.visualUsed !== false, reviewed: input.reviewed === true, paragonPromoted: input.paragonPromoted === true,
    firstGuess: typeof input.firstGuess === 'string' ? safeText(input.firstGuess, 100) : null,
    ...(Array.isArray(input.mistakes) ? { mistakes } : {}),
    ...(Array.isArray(input.typedReviewed) ? { typedReviewed: [...new Set(input.typedReviewed.slice(0, 100).filter(c => mistakenSounds.has(c)))] } : {}),
    lastGuess: typeof input.lastGuess === 'string' ? safeText(input.lastGuess, 100) : null,
    plays: integer(input.plays, 0, 10000, 0), attempts, sessionAttempts: integer(input.sessionAttempts, 0, attempts, 0),
    heard: input.heard === true, assisted: introduction || !!recovery || input.assisted === true, introduction, recovery,
    completed: input.completed === true, solved: input.solved === true,
    awarded: integer(input.awarded, 0, 220, 0),
    clean: input.clean === true, hintOpen: input.hintOpen === true,
    saluteId: isSaluteId(input.saluteId) ? input.saluteId : '',
    responseTimes: Array.isArray(input.responseTimes) ? input.responseTimes.slice(0, length).map(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 600000) : null) : [],
    firstResponseTimes: Array.isArray(input.firstResponseTimes) ? input.firstResponseTimes.slice(0, length).map(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 600000) : null) : null,
    headCopyMs: typeof input.headCopyMs === 'number' && Number.isFinite(input.headCopyMs) && input.headCopyMs >= 0 ? Math.min(input.headCopyMs, 600000) : null,
    quick: input.quick === true,
    quickCharacters: integer(input.quickCharacters, 0, length, 0),
    speedBonus: integer(input.speedBonus, 0, length * QUICK_LETTER_XP, 0),
  };
}

// Profile settings drive playback, grading and the native keyer. Keep the
// sending export fields aligned for older readers of the version 1 file.
export function mirrorSendingSpeed(profile) {
  profile.sending.settings.wpm = profile.settings.wpm;
  profile.sending.settings.farnsworth = profile.settings.farnsworth;
}

export function newProfile(name = 'Listener') {
  const profile = { soundVersion: 1, id: id(), name: safeText(name) || 'Listener', callsign: '', leaderboard: false, credits: {}, settings: { ...DEFAULT_SETTINGS }, stats: emptyStats(), sessionId: '', round: null, focus: emptyFocus(), listening: emptyListening(), guidance: emptyGuidance(), pacing: sanitizePacing(), headPacing: sanitizePacing(), review: emptyReview(), endless: emptyEndless(), sending: emptySending() };
  mirrorSendingSpeed(profile);
  return profile;
}

export function resetListeningProgress(learner) {
  return {
    ...learner,
    id: learner.id,
    name: learner.name,
    callsign: learner.callsign || '',
    leaderboard: learner.leaderboard === true,
    credits: structuredClone(learner.credits || {}),
    settings: sanitizeSettings({ ...learner.settings, track: 'course', lesson: 'starter', content: 'groups', level: 1, courseLevel: 1, courseCount: 4, earReturnLevel: 0 }),
    stats: { ...structuredClone(learner.stats), mastery: {} },
    sessionId: '',
    round: null,
    focus: emptyFocus(),
    listening: emptyListening(),
    sending: structuredClone(learner.sending),
    guidance: emptyGuidance(),
    pacing: sanitizePacing(learner.pacing, learner.settings.recallSeconds),
    headPacing: sanitizePacing(learner.headPacing, learner.settings.recallSeconds), review: sanitizeReview(learner.review),
    endless: { ...emptyEndless(), rank: learner.endless?.rank || 1, xp: learner.endless?.xp || 0, earned: learner.endless?.earned || 0, contacts: learner.endless?.contacts || 0 },
  };
}

// Previously queued full-course resets still clear both courses.
export function resetLearnerProgress(learner) {
  return resetSendingProgress(resetListeningProgress(learner));
}

export function resetSendingProgress(learner) {
  return { ...structuredClone(learner), sending: { ...sanitizeSending(learner.sending), level: 1, pendingLevel: null, records: {} } };
}

export function newState() {
  const profile = newProfile();
  return { version: 1, activeId: profile.id, profiles: [profile], theme: 'dark' };
}

export function sanitizeState(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > 12) {
    throw new Error('This is not a Morse progress file. Choose a version 1 export with 1–12 learners.');
  }
  const seen = new Set();
  const profiles = input.profiles.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('That file contains an invalid learner. No learners were replaced.');
    const previousSettings = safeObject(source.settings);
    const legacy = previousSettings.courseVersion !== 3;
    const oldLevel = integer(previousSettings.courseLevel, 1, 200, courseLevelFor(previousSettings.courseCount, previousSettings.level));
    const shifted = legacy ? expandedCourseLevel(oldLevel) : previousSettings.courseLevel;
    let settings = sanitizeSettings({ ...previousSettings, ...(legacy ? { courseLevel: shifted } : {}) });
    // Existing learners beyond the first alphabet pass get the same gradual
    // rebuild as new learners, then resume their former lesson. Old mastery
    // keys remain intact, so neither the detour nor repeated imports lose XP.
    if (legacy && isGrowingCourse(settings) && (oldLevel >= 149 && oldLevel <= 152 || oldLevel >= 197)) settings = sanitizeSettings({ ...settings, courseLevel: oldLevel <= 152 ? 149 : EAR_COURSE_START, earReturnLevel: shifted });
    const stats = sanitizeStats(source?.stats);
    if (![2, 3].includes(source.settings?.courseVersion)) {
      // Retain earned checks, but require fresh evidence for the new phrase tasks.
      for (let courseLevel = 94; courseLevel <= 100; courseLevel++) {
        const oldKey = JSON.stringify(['groups', [...COURSE_LETTERS].sort().join(''), courseLevel === 100 ? 10 : courseLevel - 89, ...(courseLevel === 100 ? ['mixed'] : [])]);
        const key = practiceKey(sanitizeSettings({ ...settings, track: 'course', copyMode: 'flexible', lesson: 'starter', content: 'groups', courseLevel: expandedCourseLevel(courseLevel) }));
        if (stats.mastery[oldKey]?.mastered && !stats.mastery[key]) stats.mastery[key] = { unit: 'letters', mastered: true, history: [], recognition: [], characterRecognition: {}, cleanPrompts: [] };
      }
    }
    const profileId = safeId(source?.id) && !seen.has(source.id) ? source.id : id();
    seen.add(profileId);
    const endless = sanitizeEndless(source.endless, stats);
    const focus = sanitizeFocus(source.focus, settings);
    const listening = sanitizeListening(source.listening, settings);
    if (focus.active) listening.active = null;
    if (isEndless(settings) && !endless.unlocked) Object.assign(settings, sanitizeSettings({ ...settings, track: 'course' }));
    const profile = { id: profileId, name: safeText(source?.name) || `Listener ${index + 1}`, callsign: sanitizeCallsign(source.callsign), leaderboard: source.leaderboard === true && !!sanitizeCallsign(source.callsign), settings, stats, sessionId: stats.sessions.some(row => row.id === source.sessionId) ? source.sessionId : '', focus, listening, round: sanitizeRound(source?.round, settings, endless, focus, listening), guidance: sanitizeGuidance(source.guidance, settings, stats.total), pacing: sanitizePacing(source.pacing, settings.recallSeconds), headPacing: sanitizePacing(source.headPacing, settings.recallSeconds), review: sanitizeReview(source.review), endless };
    // Cumulative contributions have a private device stream ID. Imported
    // totals predating this format remain an unattributed legacy balance.
    profile.credits=Object.fromEntries(Object.entries(safeObject(source.credits)).filter(([key,n])=>
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key) && Number.isSafeInteger(n) && n>0 && n<=1e9));
    if (Math.min(1e9,Object.values(profile.credits).reduce((sum,n)=>sum+n,0))>stats.xp) throw new Error('The result credits exceed the saved XP.');
    profile.sending = sanitizeSending(source.sending);
    profile.soundVersion = 1;
    const oldSpeed = source.soundVersion === 1 ? source.previousTiming :
      source.sending?.settings && profile.sending.settings;
    if (oldSpeed && Number.isFinite(oldSpeed.wpm) && Number.isFinite(oldSpeed.farnsworth)) {
      const wpm = integer(oldSpeed.wpm, 5, 80, 30);
      const farnsworth = integer(oldSpeed.farnsworth, 1, 80, wpm);
      if (wpm !== settings.wpm || farnsworth !== settings.farnsworth) profile.previousTiming = { wpm, farnsworth };
    }
    mirrorSendingSpeed(profile);
    collectBadges(profile);
    return profile;
  });
  return { version: 1, profiles, activeId: profiles.some(p => p.id === input.activeId) ? input.activeId : profiles[0].id, theme: input.theme === 'light' ? 'light' : 'dark' };
}

export function loadState(storage, cookie = '') {
  let state;
  let warning = '';
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      // Existing browser saves can exceed the file-import limit. Keep their
      // recovery behavior while applying the same depth/key/type protections.
      try {
        const parsed = parseProgressJson(raw, { maxBytes: 10_000_000, maxNodes: 2_500_000 });
        state = sanitizeState(parsed);
        if (parsed.profiles.some(p => p.settings?.courseVersion !== 3)) {
          try {
            const key = `${STORAGE_KEY}.before-audio-course`;
            if (!storage.getItem(key)) storage.setItem(key, raw);
          } catch { /* A full storage must not prevent loading the existing save. */ }
        }
      }
      catch {
        // Retain damaged data rather than silently overwriting the only copy.
        storage.setItem(`${STORAGE_KEY}.recovery`, raw);
        const backup = storage.getItem(`${STORAGE_KEY}.backup`);
        if (backup) {
          try { state = sanitizeState(parseProgressJson(backup, { maxBytes: 10_000_000, maxNodes: 2_500_000 })); } catch { /* Start a fresh in-memory state. */ }
        }
        warning = 'We could not read your last save. A recovery copy was kept on this device.';
      }
    }
  } catch { warning = 'Local storage is unavailable. Export your progress before leaving to keep it.'; }
  state ||= newState();
  const selected = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('morse_learner='))?.slice(14);
  if (selected && state.profiles.some(p => p.id === selected)) state.activeId = selected;
  return { state, warning };
}

export function saveState(storage, state, writeCookie = () => {}, secure = true) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    writeCookie(`morse_learner=${state.activeId}; Path=/; Max-Age=31536000; SameSite=Strict${secure ? '; Secure' : ''}`);
    return true;
  } catch { return false; }
}

export function importState(raw, { newSessionOwner = true } = {}) {
  const state = sanitizeState(parseProgressJson(raw));
  // A restored file can be used on another device: start a new owned fragment.
  if (newSessionOwner) for (const profile of state.profiles) profile.sessionId = '';
  return state;
}

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayStreak(stats, now = new Date()) {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!stats.days[localDay(cursor)]) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (stats.days[localDay(cursor)] && count < 366) { count++; cursor.setDate(cursor.getDate() - 1); }
  return count;
}

export function masteryFor(profile, level = profile.settings.level) {
  const record = profile.stats.mastery[practiceKey(profile.settings, level)] || { history: [], mastered: false };
  const limit = responseGoal(profile) * 1000;
  const history = (record.recognition || []).map(ms => ms !== null && ms <= limit);
  const good = history.filter(Boolean).length;
  const windowReady = history.length === 20 && good >= 18 && history.at(-1) === true;
  const stage = isGrowingCourse(profile.settings) ? courseStage(profile.settings.courseLevel) : null;
  const focusCharacter = stage && (profile.settings.courseLevel >= 101 || level <= COURSE_GROUP_LENGTH) ? courseFocus(profile.settings) : '';
  const requiredCopies = stage?.minCopies || 0;
  const cleanCopies = Math.min(requiredCopies, (record.cleanPrompts || []).filter(text => !stage?.pool || stage.pool.includes(text)).length);
  const copiesReady = cleanCopies >= requiredCopies;
  const focusHistory = (record.characterRecognition?.[focusCharacter] || []).slice(-COURSE_FOCUS_COPIES);
  const focusGood = focusHistory.filter(ms => ms !== null && ms <= limit).length;
  const focusReady = !focusCharacter || focusHistory.length === COURSE_FOCUS_COPIES && focusGood === COURSE_FOCUS_COPIES;
  const requiredSounds = stage?.requiredSounds || [];
  const missingSounds = requiredSounds.filter(sound => {
    const ms = record.characterRecognition?.[sound]?.at(-1);
    return typeof ms !== 'number' || !Number.isFinite(ms) || ms > limit;
  });
  const coverageReady = missingSounds.length === 0;
  const targetSound = !focusReady ? focusCharacter : missingSounds[0] || '';
  return { ...record, history, windowReady, focusCharacter, focusGood, focusReady, cleanCopies, requiredCopies, copiesReady,
    requiredSounds, missingSounds, coverageReady, targetSound,
    mastered: windowReady && focusReady && copiesReady && coverageReady, good, total: history.length, accuracy: history.length ? Math.round(good / history.length * 100) : 0 };
}

export function nextPracticeStep(profile) {
  const settings = profile.settings;
  if (profile.round?.focus || profile.focus?.active || profile.round?.byEar || profile.listening?.active) return null;
  if (!profile.round?.solved || !profile.round.quick || !masteryFor(profile).mastered) return null;
  if (isGrowingCourse(settings)) {
    if (settings.courseLevel >= COURSE_LEVELS) return { track: 'endless', courseLevel: COURSE_LEVELS, courseCount: 26, level: 100, addedCharacter: '' };
    const courseLevel = settings.courseLevel === EAR_COURSE_END && settings.earReturnLevel ? settings.earReturnLevel : settings.courseLevel + 1;
    const stage = courseStage(courseLevel);
    return { courseLevel, level: stage.maxLength, courseCount: stage.letterCount, addedCharacter: stage.newSound ? stage.focus : stage.letterCount > settings.courseCount ? COURSE_LETTERS[stage.letterCount - 1] : '' };
  }
  if (settings.level >= 10) return null;
  const level = settings.level + 1;
  const candidates = candidatesFor({ ...settings, level });
  return candidates && !candidates.length ? null : { level, courseCount: settings.courseCount, addedCharacter: '' };
}

export function startRound(profile, target, { focus = false, byEar = false } = {}) {
  const stage = !focus && (isGrowingCourse(profile.settings) || isEndless(profile.settings)) ? courseStage(profile.settings.courseLevel) : null;
  const signals = stage?.prosigns || [];
  const courseEar = !focus && !byEar && isGrowingCourse(profile.settings) && stage?.byEar;
  const visualPhase = byEar || courseEar ? 'review' : guidedListeningPractice(profile) ? 'live' : profile.settings.visualSupport === 'auto' ? visualHelpPhase(profile.review, target, signals) : profile.settings.visualSupport === 'off' ? 'request' : 'live';
  const earOnly = byEar || courseEar || profile.settings.copyMode === 'head' || !profile.settings.showMorse || visualPhase !== 'live';
  profile.round = target ? { target, key: practiceKey(profile.settings), draft: '', firstGuess: null, lastGuess: null, plays: 0, attempts: 0, sessionAttempts: 0, heard: false, assisted: false, introduction: false, recovery: null, completed: false, solved: false, clean: false, awarded: 0, hintOpen: false, saluteId: '', responseTimes: [], firstResponseTimes: null, headCopyMs: null, quick: false, quickCharacters: 0, speedBonus: 0,
    ...(focus ? { focus: true } : {}), ...(byEar && activeListening(profile) ? { byEar: profile.listening.active.id, byEarComplete: false, byEarDeferred: false } : {}), visualPhase, visualRevealed: false, visualHidden: false, earOnly, visualUsed: false, reviewed: false, paragonPromoted: false } : null;
  return profile.round;
}

function roundSignals(profile) {
  return profile.round?.focus ? [] : profile.round?.byEar && activeListening(profile)?.prosigns ||
    (isGrowingCourse(profile.settings) || isEndless(profile.settings) ? courseStage(profile.settings.courseLevel).prosigns || [] : []);
}

export function recordFirstReview(profile, now = Date.now()) {
  const round = profile.round;
  if (!round || round.reviewed || round.firstGuess === null) return false;
  round.reviewed = true;
  if (!round.heard || round.plays !== 1 || round.assisted) return false;
  profile.review ||= emptyReview();
  observeReview(profile.review, { target: round.target, guess: round.firstGuess, responses: round.firstResponseTimes ?? copyResponses(round), mistakes: round.mistakes || [], skipSounds: round.typedReviewed || [],
    prosigns: roundSignals(profile),
    goalMs: responseGoal(profile) * 1000, byEar: !round.visualUsed }, now);
  return true;
}

export function recordTypedMistakes(profile, now = Date.now()) {
  const round = profile.round;
  if (!round || round.completed || round.firstGuess !== null || round.plays !== 1 || round.assisted || !round.mistakes?.some(Boolean)) return false;
  const signals = roundSignals(profile);
  const text = round.target.replaceAll(' ', '');
  let changed = false;
  round.typedReviewed ||= [];
  for (const unit of soundUnits(round.target, signals)) {
    if (round.typedReviewed.includes(unit.sound) || !round.mistakes.slice(unit.start, unit.end).some(Boolean)) continue;
    const guess = [...text.slice(unit.start, unit.end)].map((c, index) => round.mistakes[unit.start + index]?.actual || c).join('');
    observeReview(profile.review, { target: unit.sound, guess, prosigns: unit.sound.length > 1 ? [unit.sound] : [], countCopy: false }, now);
    round.typedReviewed.push(unit.sound);
    changed = true;
  }
  return changed;
}

export function finishRound(profile, { solved = false, now = new Date() } = {}) {
  const round = profile.round;
  if (!round || round.completed) return null;
  const clean = solved && round.heard && round.plays === 1 && round.attempts === 1 && !round.assisted && !round.mistakes?.some(Boolean);
  recordFirstReview(profile, now.getTime());
  const responses = copyResponses(round);
  if (clean && !round.focus && !round.byEar && responses.length === round.target.replaceAll(' ', '').length) adaptPacing(profile, responses);
  const limit = responseGoal(profile) * 1000;
  const quickCharacters = clean ? responses.filter(ms => ms !== null && Number.isFinite(ms) && ms >= 0 && ms <= limit).length : 0;
  const quick = clean && responses.length === round.target.replaceAll(' ', '').length && quickCharacters === responses.length;
  const speedBonus = quickCharacters * QUICK_LETTER_XP;
  const awarded = (clean ? 20 : solved ? 8 : 0) + speedBonus;
  const stats = profile.stats;
  round.completed = true;
  round.recovery = null;
  round.solved = solved;
  round.clean = clean;
  round.awarded = awarded;
  Object.assign(round, { quick, quickCharacters, speedBonus });
  stats.total++;
  if (solved) stats.solved++;
  if (clean) stats.clean++;
  stats.xp = Math.min(1e9,stats.xp + awarded);
  const mode = stats.modes[profile.settings.copyMode === 'head' ? 'head' : 'flexible'];
  mode.total = Math.min(1e9, mode.total + 1);
  if (clean) mode.clean = Math.min(1e9, mode.clean + 1);
  if (quick) { mode.quick = Math.min(1e9, mode.quick + 1); mode.best = Math.max(mode.best, round.target.replaceAll(' ', '').length); }
  stats.cleanStreak = clean ? stats.cleanStreak + 1 : 0;
  stats.bestStreak = Math.max(stats.bestStreak, stats.cleanStreak);
  if (solved) stats.days[localDay(now)] = (stats.days[localDay(now)] || 0) + 1;
  const first = gradeAnswer(round.target.replaceAll(' ', ''), normalizeText(round.firstGuess || '').replaceAll(' ', ''));
  let promoted = false;
  if (!round.focus && !round.byEar) {
    const mastery = stats.mastery[round.key] ||= { history: [], mastered: false, recognition: [] };
    const firstResponses = round.firstResponseTimes ?? (clean ? responses : null);
    let characterIndex = 0;
    const letters = first.letters.map(letter => {
      const mistake = letter.expected ? round.mistakes?.[characterIndex] : null;
      const ms = letter.expected ? firstResponses?.[characterIndex++] : null;
      const correct = firstResponses !== null && letter.correct && !mistake;
      return { character: letter.expected, correct, ms: correct && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null };
    });
    mastery.unit = 'letters';
    mastery.samples = (mastery.samples ?? mastery.recognition?.length ?? 0) + letters.length;
    mastery.characterSamples ||= {};
    mastery.history = [...mastery.history, ...letters.map(letter => letter.correct)].slice(-20);
    mastery.recognition = [...(mastery.recognition || []), ...letters.map(letter => letter.ms)].slice(-20);
    mastery.characterRecognition ||= {};
    letters.forEach(({ character, ms }) => {
      if (character) {
        mastery.characterSamples[character] = (mastery.characterSamples[character] ?? mastery.characterRecognition[character]?.length ?? 0) + 1;
        mastery.characterRecognition[character] = [...(mastery.characterRecognition[character] || []), ms].slice(-COURSE_FOCUS_COPIES);
      }
    });
    const signals = isGrowingCourse(profile.settings) ? courseStage(profile.settings.courseLevel).prosigns || [] : [];
    if (signals.length) {
      const aligned = letters.filter(letter => letter.character);
      for (const unit of soundUnits(round.target, signals).filter(unit => unit.sound.length > 1)) {
        const samples = aligned.slice(unit.start, unit.end);
        const ms = samples.length === unit.end - unit.start && samples.every(entry => entry.correct && entry.ms !== null) ? Math.max(...samples.map(entry => entry.ms)) : null;
        mastery.characterSamples[unit.sound] = (mastery.characterSamples[unit.sound] ?? mastery.characterRecognition[unit.sound]?.length ?? 0) + 1;
        mastery.characterRecognition[unit.sound] = [...(mastery.characterRecognition[unit.sound] || []), ms].slice(-COURSE_FOCUS_COPIES);
      }
    }
    if (quick && isGrowingCourse(profile.settings) && courseStage(profile.settings.courseLevel).minCopies) mastery.cleanPrompts = [...new Set([...(mastery.cleanPrompts || []), round.target])].slice(-5);
    promoted = !isEndless(profile.settings) && !mastery.mastered && masteryFor(profile).mastered && quick;
    if (promoted) mastery.mastered = true;
  }
  const focusComplete = !round.byEar && recordFocusRound(profile, clean);
  const byEarComplete = recordListeningRound(profile, clean);
  if (round.focus) round.focusComplete = focusComplete;
  if (focusComplete) stats.focusCompletions = Math.min(1e9, (stats.focusCompletions || 0) + 1);
  profile.endless ||= emptyEndless();
  profile.endless.unlocked ||= courseCompleted(stats);
  if (isEndless(profile.settings)) {
    round.paragonPromoted = awardRadio(profile.endless, awarded, solved);
    promoted = round.paragonPromoted;
  }
  let expectedIndex = 0;
  for (const letter of first.letters) {
    if (!letter.expected || letter.expected === ' ') continue;
    const mistake = round.mistakes?.[expectedIndex++];
    const entry = stats.characters[letter.expected] ||= { seen: 0, correct: 0 };
    entry.seen++;
    if (letter.correct && !mistake && !round.assisted && round.plays === 1) entry.correct++;
  }
  stats.rounds.push({ id: id(), at: now.getTime(), level: round.target.replaceAll(' ', '').length, wpm: profile.settings.wpm, solved, clean, quick, speedBonus, assisted: round.assisted || round.plays > 1 || round.attempts > 1 });
  stats.rounds = stats.rounds.slice(-300);
  const dayEntries = Object.entries(stats.days).sort().slice(-366);
  stats.days = Object.fromEntries(dayEntries);
  if (solved) recordSessionAnswer(profile, { correct: true, clean, xp: awarded, at: now.getTime() });
  const badges = collectBadges(profile);
  return { clean, awarded, promoted, quick, speedBonus, badges, ...(round.focus ? { focusComplete } : {}), ...(round.byEar ? { byEarComplete } : {}) };
}

export const BADGES = [
  { id: 'first', icon: 'spark', title: 'First copy', description: 'Copy your first signal.', earned: p => p.stats.solved >= 1 },
  { id: 'five', icon: 'flame', title: '5 clean copies', description: 'Get five clean copies in a row.', earned: p => p.stats.bestStreak >= 5 },
  { id: 'twenty', icon: 'headphones', title: '20 rounds', description: 'Complete 20 rounds.', earned: p => p.stats.total >= 20 },
  { id: 'double', icon: 'layers', title: 'Pairs mastered', description: 'Master a two-character level.', earned: p => Object.entries(p.stats.mastery).some(([k, v]) => { try { return v.mastered && JSON.parse(k)[2] === 2; } catch { return false; } }) },
  { id: 'rhythm', icon: 'sun', title: '3-day streak', description: 'Practice three days in a row.', earned: p => dayStreak(p.stats) >= 3 },
  { id: 'explorer', icon: 'compass', title: '10 characters', description: 'Listen to 10 different characters.', earned: p => Object.keys(p.stats.characters).length >= 10 },
  { id: 'ten-copies', icon: 'headphones', title: '10 copies', description: 'Copy 10 signals.', earned: p => p.stats.solved >= 10 },
  { id: 'hundred-copies', icon: 'flag', title: '100 copies', description: 'Copy 100 signals.', earned: p => p.stats.solved >= 100 },
  { id: 'five-hundred', icon: 'volume', title: '500 copies', description: 'Copy 500 signals.', earned: p => p.stats.solved >= 500 },
  { id: 'thousand-copies', icon: 'spark', title: '1,000 copies', description: 'Copy 1,000 signals.', earned: p => p.stats.solved >= 1000 },
  { id: 'first-quick', icon: 'spark', title: 'First quick copy', description: 'Make your first quick, clean copy.', earned: p => p.stats.modes.flexible.quick + p.stats.modes.head.quick >= 1 },
  { id: 'quick-25', icon: 'flame', title: '25 quick copies', description: 'Make 25 quick, clean copies.', earned: p => p.stats.modes.flexible.quick + p.stats.modes.head.quick >= 25 },
  { id: 'quick-100', icon: 'compass', title: '100 quick copies', description: 'Make 100 quick, clean copies.', earned: p => p.stats.modes.flexible.quick + p.stats.modes.head.quick >= 100 },
  { id: 'clean-20', icon: 'check', title: '20 clean copies', description: 'Make 20 clean copies in a row.', earned: p => p.stats.bestStreak >= 20 },
  { id: 'session-20', icon: 'headphones', title: '20 answers in a session', description: 'Answer 20 times in one session.', earned: p => listeningSessions(p.stats.sessions).some(s => s.answers >= 20) },
  { id: 'session-five', icon: 'clock', title: '5-minute session', description: 'Practice for five minutes in one session.', earned: p => listeningSessions(p.stats.sessions).some(s => s.duration >= 300_000) },
  { id: 'sessions-three', icon: 'repeat', title: '3 sessions', description: 'Return for three listening sessions.', earned: p => listeningSessions(p.stats.sessions).length >= 3 },
  { id: 'week', icon: 'sun', title: '7-day streak', description: 'Listen seven days in a row.', earned: p => dayStreak(p.stats) >= 7 },
  { id: 'month', icon: 'flame', title: '30-day streak', description: 'Listen 30 days in a row.', earned: p => dayStreak(p.stats) >= 30 },
  { id: 'head-ten', icon: 'bulb', title: '10 head-copies', description: 'Make 10 clean head-copies.', earned: p => p.stats.modes.head.clean >= 10 },
  { id: 'alphabet', icon: 'book', title: 'Alphabet copied', description: 'Copy every letter correctly on a first listen.', earned: p => [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].every(c => p.stats.characters[c]?.correct > 0) },
  { id: 'focus', icon: 'compass', title: 'Focus level completed', description: 'Complete a personal focus level.', earned: p => p.stats.focusCompletions >= 1 },
  { id: 'graduate', icon: 'flag', title: 'Course completed', description: 'Complete the course.', earned: p => courseCompleted(p.stats) },
  { id: 'radio-contact', icon: 'volume', title: 'QSO complete', description: 'Finish an endless radio contact.', earned: p => p.endless.contacts >= 1 },
];

export function collectedBadges(profile) {
  return BADGES.filter(b => profile.stats.badges?.includes(b.id) || b.earned(profile));
}

export function collectBadges(profile) {
  const before = new Set(profile.stats.badges || []);
  const newlyEarned = collectedBadges(profile).filter(b => !before.has(b.id)).map(b => b.id);
  profile.stats.badges = BADGES.filter(b => before.has(b.id) || newlyEarned.includes(b.id)).map(b => b.id);
  return newlyEarned;
}
