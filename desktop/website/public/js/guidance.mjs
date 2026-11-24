import { MORSE, PROSIGNS, patternFor, supportedCharacters } from './morse.mjs';
import { LESSONS, CONTENT, alphabetFor, courseStage, legacyCourseLevel, isGrowingCourse, isEndless, COURSE_LEVELS } from './lessons.mjs';

export const guidanceKey = settings => {
  const stage = isGrowingCourse(settings) ? courseStage(settings.courseLevel) : null;
  const level = stage?.legacyLevel ?? settings.courseLevel;
  return JSON.stringify([
    settings.lesson, settings.content, alphabetFor(settings), isEndless(settings) ? legacyCourseLevel(COURSE_LEVELS) : stage ? level : settings.level,
    ...(isEndless(settings) ? ['endless'] : stage?.audioCourse ? [stage.materialRevision ? 'ear-v2' : 'ear-v1'] : stage && level >= 94 ? [stage.materialRevision && !stage.newSound ? 'cw-v4' : level <= 100 || level >= 141 && !stage.newSound ? 'cw-v3' : 'cw-v2'] : []),
    ...(settings.copyMode === 'head' ? ['head'] : []),
  ]);
};
export const GUIDANCE_LISTENS = 3;
export const RECOVERY_MISTAKES = 3;
export const emptyGuidance = () => ({ welcomed: false, seen: [], alphabet: '', prosigns: [], previewed: '', rehearsal: null });

function validKey(key) {
  if (typeof key !== 'string' || key.length > 180) return false;
  try {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length > 6) return false;
    if (parts.at(-1) === 'head') parts.pop();
    return (parts.length === 4 || parts.length === 5 && ['cw-v2', 'cw-v3', 'cw-v4', 'ear-v1', 'ear-v2', 'endless'].includes(parts[4])) && LESSONS.some(lesson => lesson.id === parts[0]) &&
      typeof parts[1] === 'string' && Object.hasOwn(CONTENT, parts[1]) && typeof parts[2] === 'string' &&
      parts[2].length > 0 && parts[2].length <= 50 && [...parts[2]].every(c => Object.hasOwn(MORSE, c)) &&
      Number.isInteger(parts[3]) && parts[3] >= 1 && parts[3] <= (parts[0] === 'starter' && parts[1] === 'groups' ? COURSE_LEVELS : 10);
  } catch { return false; }
}

export function sanitizeGuidance(input, settings, total = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    // Existing learners already know their current stage. Explain their next one.
    return total > 0 ? { ...emptyGuidance(), welcomed: true, seen: isGrowingCourse(settings) && settings.courseLevel >= 94 ? [] : [guidanceKey(settings)], alphabet: alphabetFor(settings) } : emptyGuidance();
  }
  return {
    welcomed: input.welcomed === true,
    seen: Array.isArray(input.seen) ? [...new Set(input.seen.slice(-1000).filter(validKey))] : [],
    alphabet: typeof input.alphabet === 'string' ? supportedCharacters(input.alphabet.slice(0, 100)).slice(0, 50) : '',
    prosigns: Array.isArray(input.prosigns) ? [...new Set(input.prosigns.slice(0, 6).filter(c => typeof c === 'string' && Object.hasOwn(PROSIGNS, c)))] : [],
    previewed: typeof input.previewed === 'string' ? supportedCharacters(input.previewed.slice(0, 100)).slice(0, 50) : '',
    rehearsal: input.rehearsal?.key === guidanceKey(settings) ? {
      key: guidanceKey(settings),
      counts: Object.fromEntries([...alphabetFor(settings), ...(isGrowingCourse(settings) || isEndless(settings) ? courseStage(settings.courseLevel).prosigns || [] : [])].filter(c => Object.hasOwn(input.rehearsal.counts || {}, c)).map(c => [c,
        Number.isInteger(input.rehearsal.counts[c]) ? Math.min(GUIDANCE_LISTENS, Math.max(0, input.rehearsal.counts[c])) : 0,
      ])),
    } : null,
  };
}

export function lessonGuidance(learner, { reference = false } = {}) {
  const { settings, guidance } = learner;
  const key = guidanceKey(settings);
  if (!reference && guidance.seen.includes(key)) return null;
  const alphabet = alphabetFor(settings);
  const stage = isGrowingCourse(settings) || isEndless(settings) ? courseStage(settings.courseLevel) : null;
  const signals = stage?.prosigns || [];
  const characters = [...alphabet, ...signals];
  const first = !reference && !guidance.welcomed;
  const added = characters.filter(c => c.length > 1 ? !(guidance.prosigns || []).includes(c) : !guidance.alphabet.includes(c));
  const level = stage ? settings.courseLevel : settings.level;
  const length = stage?.review ? `${stage.minLength}–${stage.maxLength} characters per answer.` : `${settings.level === 1 ? 'One character' : `${settings.level} characters`} per answer.`;
  const detail = {
    key, alphabet, first, reference, level, prosigns: signals, examples: stage?.examples || [],
    repetitions: !first && !reference && added.length ? GUIDANCE_LISTENS : 0,
    title: reference ? stage?.catalogue ? 'Lesson phrases' : 'Lesson characters' : first ? 'Learn the characters' : added.length === 1 ? Object.hasOwn(PROSIGNS, added[0]) ? `New prosign: <${added[0]}>` : `New ${/^[A-Z]$/.test(added[0]) ? 'letter' : 'character'}: ${added[0]}` : `Level ${level} · ${stage?.label || `${settings.level}-character practice`}`,
    copy: reference ? stage?.catalogue ? 'Every message in this level. Tap one to hear it.' : 'Tap a letter to hear its sound.' : first ? 'Morse gives each letter a pattern of short and long sounds.' : added.length ? added.some(c => c.length > 1) ? 'Listen to one continuous sound. Type the shown letters together.' : /^[A-Z]$/.test(added[0]) ? 'Look at the letter and listen to the sound.' : 'Look at the character and listen to the sound.' : stage?.catalogue ? 'Learn the meaning, then listen. These are all the messages in this level.' : stage?.pool ? 'Learn the meaning, listen to the examples, then copy what you hear.' : `Same ${characters.length} ${characters.every(c => /^[A-Z]$/.test(c)) ? 'letters' : 'characters'}. ${length}`,
    instruction: reference ? '' : stage?.pool && !added.length ? 'Keep spaces between words. Type along or head-copy the whole message. Three different quick, clean copies are needed alongside the letter meter.' : first ? `Learn these ${characters.length} sounds first. ${length} Type what you hear.` : added.length ? length : 'Type along, or listen to the whole group and then type it.',
    characters: first || reference && !stage?.catalogue ? characters : added,
    button: reference ? 'Back to practice' : first ? 'Start practice' : 'Continue',
  };
  if (stage?.shortCopies && !first && (reference || !added.length)) Object.assign(detail, {
    title: reference ? 'Lesson exercises' : `Level ${level} · ${stage.label}`,
    copy: reference ? 'Every exercise in this level. Tap one to hear it.' : stage.objective || (stage.byEar ? 'Listen without the pattern, then type. Show help is available for practice.' : 'Copy short radio fragments. The alphabet-by-ear course starts at level 193.'),
    instruction: reference ? '' : `Up to ${stage.maxLength} characters per answer. ${stage.minCopies} different quick, correct ${stage.minCopies === 1 ? 'copy is' : 'copies are'} needed alongside the letter meter.${stage.requiredSounds?.length ? ` Review sounds: ${stage.requiredSounds.join(', ')}. Each needs a quick, correct copy.` : ''}${stage.byEar ? ' Replays and visual help do not count toward mastery.' : ''}`,
  });
  if (stage?.kind === 'frequencies' && !first && (reference || !added.length)) Object.assign(detail, {
    title: reference ? 'Lesson frequencies' : `Level ${level} · ${stage.label}`,
    copy: reference ? 'Every frequency in this level. Tap one to hear it.' : 'Copy four digits, such as 7030. Full frequency commands come later.',
    instruction: reference ? '' : 'No letters or spaces. Type along or listen first, then type. Copy three different frequencies correctly within your time goal, alongside the letter meter.',
  });
  if (!reference && !first && !added.length && isEndless(settings)) Object.assign(detail, {
    title: 'Endless radio', copy: 'Course complete. Copy simulated radio contacts to earn Paragon XP.',
    instruction: 'Copy five messages to finish each simulated contact. Earn XP toward Paragon ranks, with no final rank. Your sound settings and earned course progress stay saved.', examples: [],
  });
  if (stage?.audioCourse) {
    const sounds = reference ? stage.pool ? [] : [...alphabet, ...signals] : stage.reintroduced ? stage.introducedSounds : [];
    Object.assign(detail, {
      title: reference ? 'Audio practice reference' : `Level ${level} · ${stage.label}`,
      copy: level === 193 ? 'Start again with E and T. Listen to the sound, then type the letter. Short refreshers revisit earlier material between blocks.' : stage.reintroduced && sounds.length ? `Practise ${sounds.join(' and ')} by ear. Earlier sounds stay in the mix.` : stage.objective || 'Listen, then type. You can type along or enter the whole group afterward.',
      instruction: `${stage.minLength === stage.maxLength ? stage.maxLength : `${stage.minLength}–${stage.maxLength}`} character${stage.maxLength === 1 ? '' : 's'} per answer. The pattern appears after your answer. Show help is available; helped copies do not count toward mastery.${stage.minCopies ? ` Copy ${stage.minCopies} different exercises correctly within your goal.` : ''}${stage.requiredSounds?.length ? ` Review sounds: ${stage.requiredSounds.join(', ')}.` : ''}`,
      characters: [], repetitions: 0,
      examples: sounds.length ? sounds.map(sound => ({ text: sound, meaning: sound.length > 1 ? PROSIGNS[sound].meaning : `Listen to ${sound}` })) : stage.examples || [],
    });
    if (reference) { detail.copy = stage.pool ? 'Every exercise in this level. Tap one to hear it.' : 'Tap a character to hear it.'; detail.instruction = ''; }
  }
  if (!reference && !first && !added.length && settings.copyMode === 'head') {
    if (!isEndless(settings) && !stage?.shortCopies && !stage?.audioCourse) { detail.title = 'Head-copy · listen first'; detail.copy = 'Hear the whole group, hold it in your head, then type it.'; }
    detail.instruction += ' In Head-copy, typing opens after the final beep. The response allowance starts there and scales with the number of characters. Head-copy has its own course progress and timing.';
  }
  return detail;
}

export function rememberGuidanceSound(learner, character, key = guidanceKey(learner.settings)) {
  if (key !== guidanceKey(learner.settings) || typeof character !== 'string' || !patternFor(character) || !(character.length === 1 ? alphabetFor(learner.settings).includes(character) : (isGrowingCourse(learner.settings) || isEndless(learner.settings)) && courseStage(learner.settings.courseLevel).prosigns?.includes(character))) return false;
  if (character.length === 1) learner.guidance.previewed = supportedCharacters((learner.guidance.previewed || '') + character);
  const detail = lessonGuidance(learner);
  if (detail?.repetitions && detail.characters.includes(character)) {
    const rehearsal = learner.guidance.rehearsal?.key === key ? learner.guidance.rehearsal : { key, counts: {} };
    rehearsal.counts[character] = Math.min(GUIDANCE_LISTENS, guidanceListenCount(learner, character, key) + 1);
    learner.guidance.rehearsal = rehearsal;
  }
  return true;
}

export function guidanceListenCount(learner, character, key = guidanceKey(learner.settings)) {
  return learner.guidance.rehearsal?.key === key ? learner.guidance.rehearsal.counts[character] || 0 : 0;
}

export function acknowledgeGuidance(learner, key = guidanceKey(learner.settings)) {
  if (key !== guidanceKey(learner.settings)) return;
  learner.guidance = {
    welcomed: true,
    seen: [...new Set([...learner.guidance.seen, key])].slice(-1000),
    alphabet: isGrowingCourse(learner.settings) || isEndless(learner.settings) ? supportedCharacters(learner.guidance.alphabet + alphabetFor(learner.settings)) : alphabetFor(learner.settings),
    prosigns: isGrowingCourse(learner.settings) || isEndless(learner.settings) ? [...new Set([...(learner.guidance.prosigns || []), ...(courseStage(learner.settings.courseLevel).prosigns || [])])] : [],
    previewed: learner.guidance.previewed || '',
    rehearsal: null,
  };
}

export function beginRecovery(round, grade, settings = {}) {
  if (!round || round.completed || grade.correct || round.recovery || !round.attempts || round.attempts % RECOVERY_MISTAKES) return false;
  let position = 0;
  const expected = grade.letters.flatMap(letter => {
    if (!letter.expected) return [];
    return [{ ...letter, index: position++ }];
  });
  const errors = expected.filter(letter => !letter.correct);
  const joined = isGrowingCourse(settings) || isEndless(settings) ? courseStage(settings.courseLevel).prosigns || [] : [];
  const joinedWords = [...round.target.matchAll(/\S+/g)].filter(word => joined.includes(word[0]) && (!errors.length || errors.some(letter => letter.index >= word.index && letter.index < word.index + word[0].length)));
  const signals = [...new Set(joinedWords.map(word => word[0]))];
  const characters = [...new Set((errors.length ? errors : expected).filter(letter => letter.expected !== ' ' && Object.hasOwn(MORSE, letter.expected) && !joinedWords.some(word => letter.index >= word.index && letter.index < word.index + word[0].length)).map(letter => letter.expected))].join('');
  if (!characters && !signals.length) return false;
  round.recovery = { at: round.attempts, characters, counts: {}, ...(signals.length ? { signals } : {}) };
  round.assisted = true;
  return true;
}

export function sanitizeRecovery(input, target, attempts, settings = {}) {
  if (!input || typeof input !== 'object' || input.at !== attempts || !Number.isInteger(attempts) || attempts < RECOVERY_MISTAKES || attempts % RECOVERY_MISTAKES || typeof input.characters !== 'string') return null;
  const characters = [...new Set([...input.characters.slice(0, 100)].filter(c => c !== ' ' && Object.hasOwn(MORSE, c) && target.includes(c)))].join('');
  const allowed = isGrowingCourse(settings) || isEndless(settings) ? courseStage(settings.courseLevel).prosigns || [] : [];
  const signals = Array.isArray(input.signals) ? [...new Set(input.signals.slice(0, 6).filter(c => typeof c === 'string' && allowed.includes(c) && target.split(' ').includes(c)))] : [];
  if (!characters && !signals.length) return null;
  const sounds = [...signals, ...characters];
  const counts = Object.fromEntries(sounds.map(c => [c, Object.hasOwn(input.counts || {}, c) && Number.isInteger(input.counts[c]) ? Math.min(GUIDANCE_LISTENS, Math.max(0, input.counts[c])) : 0]));
  return sounds.some(c => counts[c] < GUIDANCE_LISTENS) ? { at: attempts, characters, counts, ...(signals.length ? { signals } : {}) } : null;
}

export function recoveryCharacter(round) {
  return !round?.completed && round?.recovery ? [...(round.recovery.signals || []), ...round.recovery.characters].find(c => (round.recovery.counts[c] || 0) < GUIDANCE_LISTENS) || '' : '';
}

// Call only after a typed audition has actually finished. The object identity
// keeps a late sound callback from counting toward a later recovery or signal.
export function rememberRecoverySound(round, character, recovery) {
  if (!recovery || round?.recovery !== recovery || recoveryCharacter(round) !== character || recovery.at !== round.attempts) return false;
  recovery.counts[character] = Math.min(GUIDANCE_LISTENS, (recovery.counts[character] || 0) + 1);
  return true;
}
