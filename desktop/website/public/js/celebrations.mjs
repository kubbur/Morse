import { alphabetFor, isGrowingCourse, COURSE_LEVELS, EAR_COURSE_END, courseStage } from './lessons.mjs';

// CW meanings: CWops' CW Abbreviations and RSGB's Starting Out in Morse.
// E E is the customary spaced two-dit wave; NEAT is plain-language praise.
export const SALUTES = Object.freeze([
  { id: 'neat', text: 'NEAT', label: 'NEAT', meaning: 'Correct copy' },
  { id: 'wave', text: 'E E', label: 'dit dit', meaning: 'Two-dit sign-off' },
  { id: 'tu', text: 'TU', label: 'TU', meaning: 'Thank you' },
  { id: 'r', text: 'R R', label: 'R R', meaning: 'Received' },
  { id: 'tks', text: 'TKS', label: 'TKS', meaning: 'Thanks' },
  { id: 'ok', text: 'OK', label: 'OK', meaning: 'Okay' },
  { id: 'gl', text: 'GL', label: 'GL', meaning: 'Good luck' },
  { id: 'hi', text: 'HI HI', label: 'HI HI', meaning: 'The telegraph laugh' },
  { id: 'fb', text: 'FB', label: 'FB', meaning: 'Fine business' },
  { id: 'vfb', text: 'VFB', label: 'VFB', meaning: 'Very fine business' },
  { id: 'ufb', text: 'UFB', label: 'UFB', meaning: 'Ultra fine business' },
  { id: 'vyfb', text: 'VY FB', label: 'VY FB', meaning: 'Very fine business' },
  { id: 'tnx', text: 'TNX', label: 'TNX', meaning: 'Thanks' },
  { id: '73', text: '73', label: '73', meaning: 'Best regards' },
  { id: '55', text: '55', label: '55', meaning: 'Wishing you success' },
  { id: '77', text: '77', label: '77', meaning: 'Long live CW' },
  { id: 'congrats', text: 'CONGRATS', label: 'CONGRATS', meaning: 'Congratulations', finale: true },
].map(salute => Object.freeze(salute)));

export const isSaluteId = id => typeof id === 'string' && (id === 'practice' || SALUTES.some(salute => salute.id === id));
const available = (salute, settings) => [...salute.text].every(c => c === ' ' || alphabetFor(settings).includes(c));

export function chooseSalute(settings, previous = '', { milestone = true } = {}) {
  const level = isGrowingCourse(settings) ? settings.courseLevel : settings.level;
  const finale = SALUTES.find(salute => salute.finale);
  if (milestone && isGrowingCourse(settings) && (level === EAR_COURSE_END || courseStage(level).legacyLevel === 100 || level === COURSE_LEVELS) && available(finale, settings)) return finale;
  const choices = SALUTES.filter(salute => !salute.finale && available(salute, settings));
  const last = choices.findIndex(salute => salute.id === previous);
  if (choices.length) return choices[last >= 0 ? (last + 1) % choices.length : (Math.max(1, level) - 1) % choices.length];
  const alphabet = alphabetFor(settings);
  const character = alphabet[(Math.max(1, level) - 1) % alphabet.length];
  // Custom sets may contain no established CW compliment. Stay within their
  // sounds, and do not present an invented abbreviation as real radio lingo.
  return { id: 'practice', text: `${character} ${character}`, label: `${character} ${character}`, meaning: 'Practice signal' };
}

export function saluteForId(id, settings) {
  return SALUTES.find(salute => salute.id === id && available(salute, settings)) || chooseSalute(settings);
}
