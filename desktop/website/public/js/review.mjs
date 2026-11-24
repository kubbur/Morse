import { MORSE, PROSIGNS, gradeAnswer, normalizeText } from './morse.mjs';

const SOUNDS = [...Object.keys(MORSE), ...Object.keys(PROSIGNS)];
const validSound = sound => typeof sound === 'string' && SOUNDS.includes(sound);
const number = (value, maximum = 1e9) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
const own = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const emptyReview = () => ({ copies: 0, sounds: {} });
export const REVIEW_WINDOW = 6;

// Keep outcomes and their mix-ups aligned. Older saves have outcomes without
// recent mix-up details; lifetime totals cannot identify those individual errors.
export function recentReview(entry, sound) {
  const outcomes = Array.isArray(entry?.recent) ? entry.recent.slice(-REVIEW_WINDOW) : [];
  if (!outcomes.length) return [];
  const confusions = Array.isArray(entry?.recentConfusions) ? entry.recentConfusions.slice(-outcomes.length) : [];
  const offset = outcomes.length - confusions.length;
  return outcomes.map((value, index) => {
    const correct = value === true, other = confusions[index - offset];
    return { correct, other: !correct && validSound(other) && other !== sound ? other : '' };
  });
}

export function sanitizeReview(input) {
  const source = own(input);
  return { copies: number(source.copies), sounds: Object.fromEntries(SOUNDS.filter(sound => Object.hasOwn(own(source.sounds), sound)).map(sound => {
    const data = own(source.sounds[sound]), seen = number(data.seen), recent = recentReview(data, sound);
    return [sound, {
      seen, correct: Math.min(seen, number(data.correct)), streak: number(data.streak, 100), earWins: number(data.earWins, 100),
      lapses: number(data.lapses), lastAt: number(data.lastAt, 8.64e15), dueAt: number(data.dueAt, 8.64e15), dueCopy: number(data.dueCopy),
      confusions: Object.fromEntries(SOUNDS.filter(other => other !== sound && Object.hasOwn(own(data.confusions), other)).map(other => [other, number(data.confusions[other], 10000)]).filter(([, count]) => count)),
      ...(Array.isArray(data.recent) ? { recent: recent.map(row => row.correct), recentConfusions: recent.map(row => row.other) } : {}),
      ...(Object.hasOwn(data, 'earAccuracy') ? { earAccuracy: number(data.earAccuracy, 100) } : {}),
    }];
  })) };
}

export function soundUnits(text, prosigns = []) {
  let position = 0;
  return normalizeText(text).split(' ').flatMap(word => {
    const sounds = prosigns.includes(word) ? [word] : [...word];
    return sounds.map(sound => { const start = position; position += sound.length; return { sound, start, end: position }; });
  });
}

// Observe only the first unassisted listen, once per answer. A later retry or
// teaching-card audition cannot make a sound look remembered or instantly known.
export function observeReview(review, { target, guess, responses = [], mistakes = [], prosigns = [], skipSounds = [], countCopy = true, goalMs = 1500, byEar = false }, now = Date.now()) {
  if (countCopy) review.copies = Math.min(1e9, review.copies + 1);
  const aligned = [];
  let actualIndex = 0;
  for (const letter of gradeAnswer(normalizeText(target).replaceAll(' ', ''), normalizeText(guess).replaceAll(' ', '')).letters) {
    if (letter.expected) {
      const mistake = mistakes[aligned.length];
      aligned.push({ ...letter, ...(mistake?.expected === letter.expected ? { actual: mistake.actual, correct: false } : {}), ms: letter.actual ? responses[actualIndex] : null });
    }
    if (letter.actual) actualIndex++;
  }
  const observed = new Set(), units = soundUnits(target, prosigns);
  for (const unit of units) {
    if (!validSound(unit.sound) || observed.has(unit.sound) || skipSounds.includes(unit.sound)) continue;
    // Repeated letters in a group are one review observation; every occurrence
    // must be right, so EEEE cannot create four independent memory successes.
    observed.add(unit.sound);
    const occurrences = units.filter(other => other.sound === unit.sound);
    const samples = occurrences.flatMap(other => aligned.slice(other.start, other.end));
    const correct = samples.length > 0 && samples.every(sample => sample.correct);
    const quick = correct && samples.every(sample => typeof sample.ms === 'number' && Number.isFinite(sample.ms) && sample.ms >= 0 && sample.ms <= goalMs);
    const entry = review.sounds[unit.sound] ||= { seen: 0, correct: 0, streak: 0, earWins: 0, lapses: 0, lastAt: 0, dueAt: 0, dueCopy: 0, confusions: {} };
    const heard = correct ? '' : occurrences.map(other => aligned.slice(other.start, other.end).map(sample => sample.actual).join('')).find(other => validSound(other) && other !== unit.sound) || '';
    const recent = [...recentReview(entry, unit.sound), { correct, other: heard }].slice(-REVIEW_WINDOW);
    entry.seen = Math.min(1e9, entry.seen + 1);
    entry.correct = Math.min(entry.seen, entry.correct + Number(correct));
    entry.recent = recent.map(row => row.correct);
    entry.recentConfusions = recent.map(row => row.other);
    entry.streak = quick ? Math.min(100, entry.streak + 1) : 0;
    if (byEar && quick) entry.earWins = Math.min(100, entry.earWins + 1);
    if (byEar && correct) entry.earAccuracy = Math.min(100, (entry.earAccuracy || 0) + 1);
    if (!correct) {
      entry.lapses = Math.min(1e9, entry.lapses + 1);
      entry.earWins = Math.max(0, entry.earWins - 1);
      if (entry.earAccuracy) entry.earAccuracy--;
      if (heard) entry.confusions[heard] = Math.min(10000, (entry.confusions[heard] || 0) + 1);
    }
    const stage = correct ? Math.min(5, entry.streak) : 0;
    entry.lastAt = now;
    entry.dueCopy = Math.min(1e9, review.copies + [3, 5, 10, 20, 40, 80][stage]);
    entry.dueAt = now + [60, 300, 1800, 86400, 259200, 604800][stage] * 1000;
  }
}

export function reviewTarget(review, allowed, now = Date.now()) {
  if (!review?.copies) return null;
  const due = allowed.flatMap(sound => {
    const entry = review.sounds[sound];
    if (!entry?.seen || entry.dueCopy > review.copies && entry.dueAt > now) return [];
    const pair = Object.entries(entry.confusions).filter(([other]) => allowed.includes(other)).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const overdue = Math.max(review.copies - entry.dueCopy, (now - entry.dueAt) / 60000, 0);
    return [{ sound, pair, priority: (entry.streak < 3 ? 10 : 0) + Math.min(10, entry.lapses) + Math.min(20, overdue) }];
  });
  return due.sort((a, b) => b.priority - a.priority)[0] || null;
}

export function visualHelpPhase(review, text, prosigns = []) {
  const sounds = [...new Set(soundUnits(text, prosigns).map(unit => unit.sound))];
  const phases = sounds.map(sound => {
    const data = review?.sounds[sound], recent = data?.recent?.slice(-3) || [];
    if (recent.length < 3 || recent.filter(correct => !correct).length >= 2) return 'live';
    if ((data.earAccuracy || 0) >= 3) return 'request';
    if (recent.every(Boolean) || data.earAccuracy > 0) return 'review';
    return 'live';
  });
  return !phases.length || phases.includes('live') ? 'live' : phases.includes('review') ? 'review' : 'request';
}

export function listeningOnly(review, text, prosigns = []) {
  return visualHelpPhase(review, text, prosigns) !== 'live';
}

export function practiceNeeds(review) {
  return Object.entries(review?.sounds || {}).filter(([sound]) => sound.length === 1 && validSound(sound)).map(([sound, entry]) => {
    const recent = recentReview(entry, sound);
    return [sound, { seen: recent.length, correct: recent.filter(row => row.correct).length }];
  }).filter(([, entry]) => entry.correct < entry.seen).sort((a, b) =>
    a[1].correct / a[1].seen - b[1].correct / b[1].seen ||
    (review.sounds[b[0]].lastAt || 0) - (review.sounds[a[0]].lastAt || 0) || b[1].seen - a[1].seen
  ).slice(0, 6);
}

export function confusionPairs(review) {
  return Object.entries(review?.sounds || {}).filter(([sound]) => validSound(sound)).flatMap(([sound, entry]) => {
    const counts = new Map();
    for (const { other } of recentReview(entry, sound)) if (other) counts.set(other, (counts.get(other) || 0) + 1);
    return [...counts].map(([other, count]) => ({ sound, other, count }));
  }).sort((a, b) => b.count - a.count || (review.sounds[b.sound].lastAt || 0) - (review.sounds[a.sound].lastAt || 0)).slice(0, 6);
}
