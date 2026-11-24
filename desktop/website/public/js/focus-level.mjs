import { alphabetFor, isGrowingCourse, courseStage, practiceKey } from './lessons.mjs';
import { MORSE, gradeAnswer, normalizeText } from './morse.mjs';
import { soundUnits } from './review.mjs';

export const FOCUS_COOLDOWN = 6;
export const emptyFocus = () => ({ key: '', active: null, cooldown: 0 });
const count = (value, max) => Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : 0;

// The exercise cursor stays with this device's unfinished practice. Its actual
// recognition observations and XP use the existing shared review/score records.
export function sanitizeFocus(input, settings) {
  if (!isGrowingCourse(settings) || !settings.adaptive || input?.key !== practiceKey(settings)) return emptyFocus();
  const result = { key: practiceKey(settings), active: null, cooldown: count(input.cooldown, FOCUS_COOLDOWN) };
  const source = input.active;
  if (!source || typeof source !== 'object' || typeof source.sounds !== 'string') return result;
  const sounds = [...new Set([...source.sounds.slice(0, 20)].filter(c => alphabetFor(settings).includes(c)))].slice(0, 3).join('');
  if (!sounds) return result;
  result.active = {
    sounds, maxLength: Math.min(3, courseStage(settings.courseLevel).maxLength),
    singles: Object.fromEntries([...sounds].map(c => [c, count(source.singles?.[c], 2)])),
    pairs: count(source.pairs, 2), triples: count(source.triples, 2), acknowledged: source.acknowledged === true,
  };
  return result;
}

export function focusPhase(active) {
  if (!active) return 0;
  if ([...active.sounds].some(c => (active.singles[c] || 0) < 2)) return 1;
  if (active.maxLength >= 2 && active.pairs < 2) return 2;
  if (active.maxLength >= 3 && active.triples < 2) return 3;
  return 0;
}

export function focusProgress(active) {
  const goal = active.sounds.length * 2 + (active.maxLength >= 2 ? 4 : 0) + (active.maxLength >= 3 ? 6 : 0);
  const done = Object.values(active.singles).reduce((sum, n) => sum + n, 0) + (active.maxLength >= 2 ? active.pairs * 2 : 0) + (active.maxLength >= 3 ? active.triples * 3 : 0);
  return { goal, done, phase: focusPhase(active) };
}

export function trickySounds(profile) {
  const allowed = alphabetFor(profile.settings);
  return Object.entries(profile.review?.sounds || {}).flatMap(([sound, data]) => {
    if (sound.length !== 1 || !allowed.includes(sound)) return [];
    const recent = data.recent || [];
    const misses = recent.filter(correct => !correct).length;
    if (recent.at(-1) !== false || misses < 3) return [];
    return [{ sound, score: misses / recent.length + misses, data }];
  }).sort((a, b) => b.score - a.score || a.sound.localeCompare(b.sound));
}

function missedSounds(profile) {
  const round = profile.round;
  if (!round || round.focus || round.byEar) return new Set();
  const target = normalizeText(round.target).replaceAll(' ', '');
  // An unfinished draft has only its recorded typing mistakes. Its remaining
  // unsubmitted letters must not become invented omission errors on skip.
  const aligned = typeof round.firstGuess === 'string'
    ? gradeAnswer(target, normalizeText(round.firstGuess).replaceAll(' ', '')).letters.filter(letter => letter.expected)
    : [];
  const signals = courseStage(profile.settings.courseLevel).prosigns || [];
  return new Set(soundUnits(round.target, signals).filter(unit => {
    if (unit.sound.length !== 1) return false;
    const mistake = round.mistakes?.[unit.start];
    return aligned[unit.start]?.correct === false || mistake?.expected === unit.sound && mistake.actual !== unit.sound && Object.hasOwn(MORSE, mistake.actual);
  }).map(unit => unit.sound));
}

export function beginFocus(profile, manualSounds = '') {
  const settings = profile.settings;
  if (!isGrowingCourse(settings) || !settings.adaptive) return false;
  profile.focus = sanitizeFocus(profile.focus, settings);
  if (profile.focus.active || !manualSounds && profile.focus.cooldown) return false;
  const allowed = alphabetFor(settings), weak = trickySounds(profile), missed = missedSounds(profile);
  // Automatic detours belong to the answer just completed. Older weak sounds
  // and healthy companion letters remain available through manual practice.
  const sounds = [...new Set([...(manualSounds || weak.filter(entry => missed.has(entry.sound)).map(entry => entry.sound).join(''))].filter(c => allowed.includes(c)))].slice(0, 3);
  if (!sounds.length) return false;
  profile.focus = { key: practiceKey(settings), cooldown: 0, active: { sounds: sounds.join(''), maxLength: Math.min(3, courseStage(settings.courseLevel).maxLength), singles: Object.fromEntries(sounds.map(c => [c, 0])), pairs: 0, triples: 0, acknowledged: false } };
  return true;
}

export function focusPrompt(active, previous = '', random = Math.random) {
  const length = focusPhase(active);
  if (!length) return null;
  const sounds = [...active.sounds];
  if (length === 1) {
    const remaining = sounds.filter(c => active.singles[c] < 2);
    const minimum = Math.min(...remaining.map(c => active.singles[c]));
    const choices = remaining.filter(c => active.singles[c] === minimum);
    const varied = choices.filter(c => c !== previous);
    const pool = varied.length ? varied : choices;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }
  const offset = (active.pairs + active.triples) % sounds.length;
  let text = Array.from({ length }, (_, i) => sounds[(i + offset) % sounds.length]).join('');
  if (random() < .5) text = [...text].reverse().join('');
  if (text === previous && sounds.length > 1) text = text.slice(1) + text[0];
  return text;
}

export function recordFocusRound(profile, clean) {
  profile.focus = sanitizeFocus(profile.focus, profile.settings);
  const round = profile.round, active = profile.focus.active;
  if (!round?.focus) {
    profile.focus.cooldown = Math.max(0, profile.focus.cooldown - 1);
    return false;
  }
  if (!active || !clean || [...round.target].some(c => !active.sounds.includes(c))) return false;
  const phase = focusPhase(active);
  if (round.target.length !== phase) return false;
  if (phase === 1) active.singles[round.target] = Math.min(2, active.singles[round.target] + 1);
  else if (phase === 2) active.pairs++;
  else if (phase === 3) active.triples++;
  return focusPhase(active) === 0;
}

export function endFocus(profile) {
  profile.focus = { key: practiceKey(profile.settings), active: null, cooldown: FOCUS_COOLDOWN };
}
