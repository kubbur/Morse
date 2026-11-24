import { MORSE, normalizeText } from './morse.mjs';

export function sanitizeMistakes(input, target) {
  if (!Array.isArray(input)) return [];
  return [...normalizeText(target).replaceAll(' ', '').slice(0, 100)].map((expected, index) => {
    const item = input[index];
    return item?.expected === expected && typeof item.actual === 'string' && item.actual.length === 1 && item.actual !== expected && Object.hasOwn(MORSE, item.actual) ? { expected, actual: item.actual } : null;
  });
}

export function createCopySession(plan, startsAt) {
  const characters = [];
  for (const tone of plan.tones) {
    let character = characters.at(-1);
    if (character?.index !== tone.characterIndex) {
      character = { index: tone.characterIndex, character: tone.character, startsAt: startsAt + tone.start * 1000, endsAt: 0 };
      characters.push(character);
    }
    character.endsAt = startsAt + (tone.start + tone.duration) * 1000;
  }
  return { characters, text: '', responses: [], mistakes: [] };
}

// Keep the original entry time so edits, input batching and later renders do not
// restart a character's clock. Early entries never receive measured credit.
export function recordCopyInput(session, input, now) {
  const text = normalizeText(input).replaceAll(' ', '');
  let unchanged = 0;
  while (unchanged < text.length && text[unchanged] === session.text[unchanged]) unchanged++;
  let suffix = 0;
  while (suffix < Math.min(text.length, session.text.length) - unchanged && text.at(-suffix - 1) === session.text.at(-suffix - 1)) suffix++;
  // Only newly entered/replaced characters are observations. Backspace and an
  // unchanged suffix shifting left are not new mistakes. Ignore unheard sounds.
  session.mistakes ||= [];
  for (let index = unchanged; index < text.length - suffix; index++) {
    const sound = session.characters[index], actual = text[index];
    if (sound && now >= sound.startsAt && actual !== sound.character && Object.hasOwn(MORSE, actual)) {
      session.mistakes[index] ||= { expected: sound.character, actual };
    }
  }
  session.responses = session.responses.slice(0, unchanged);
  for (let index = unchanged; index < text.length; index++) {
    const sound = session.characters[index];
    session.responses[index] = sound?.character === text[index] && now >= sound.endsAt
      ? Math.round(now - sound.endsAt) : null;
  }
  session.text = text;
  return [...session.responses];
}

export const measuredResponse = ms => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;

// Head-copy starts only once the whole group has sounded. Its typing allowance
// scales with length, without charging for the time spent listening to it.
export function headCopyResponse(session) {
  const { characters, responses, text } = session;
  if (!characters.length || text !== characters.map(c => c.character).join('') || responses.length !== characters.length || !responses.every(measuredResponse)) return null;
  const end = characters.at(-1).endsAt;
  const entered = responses.map((ms, i) => characters[i].endsAt + ms);
  if (entered.some(at => at < end)) return null;
  return Math.round((Math.max(...entered) - end) / characters.length);
}

export function copyResponses(round) {
  const head = measuredResponse(round?.headCopyMs) ? round.headCopyMs : Infinity;
  return (round?.responseTimes || []).map((ms, index) => !(round.plays === 1 && round.mistakes?.[index]) && measuredResponse(ms) ? Math.min(ms, head) : null);
}

// Correctness is visible even when a response cannot earn speed credit. Keep
// that display separate from the first-listen measurements used for mastery.
export function copyFeedback(round) {
  const expected = normalizeText(round?.target).replaceAll(' ', '');
  const actual = normalizeText(round?.draft).replaceAll(' ', '');
  const responses = copyResponses(round);
  return [...expected].map((character, index) => {
    const correct = actual[index] === character;
    return {
      correct,
      corrected: correct && round.plays === 1 && !!round.mistakes?.[index],
      ms: correct && measuredResponse(responses[index]) ? responses[index] : null,
    };
  });
}

const boundedSeconds = (value, fallback) => Math.round(Math.min(4, Math.max(0.5, typeof value === 'number' && Number.isFinite(value) ? value : fallback)) * 10) / 10;

export function sanitizePacing(input, fallback = 1.5) {
  return {
    seconds: boundedSeconds(input?.seconds, fallback),
    samples: Array.isArray(input?.samples) ? input.samples.slice(-20).filter(measuredResponse).map(ms => Math.min(ms, 600000)) : [],
    pending: Number.isInteger(input?.pending) ? Math.min(3, Math.max(0, input.pending)) : 0,
  };
}

export function responseGoal(profile) {
  return profile.settings.timingMode === 'fixed' ? profile.settings.recallSeconds : sanitizePacing(profile.settings.copyMode === 'head' ? profile.headPacing : profile.pacing, profile.settings.recallSeconds).seconds;
}

// Calibrate on four clean, measured first-listen answers, then update after each
// four more. Ease promptly; tighten by at most 0.1s. A pause, error or replay is
// never an observation. The 90th percentile and margin tolerate ordinary wobble.
export function adaptPacing(profile, responses) {
  if (profile.settings.timingMode === 'fixed' || !responses.length || !responses.every(measuredResponse)) return;
  const field = profile.settings.copyMode === 'head' ? 'headPacing' : 'pacing';
  const pacing = sanitizePacing(profile[field], profile.settings.recallSeconds);
  pacing.samples = [...pacing.samples, Math.max(...responses)].slice(-20);
  pacing.pending++;
  if (pacing.pending === 4) {
    const sorted = [...pacing.samples].sort((a, b) => a - b);
    const typical = sorted[Math.ceil(sorted.length * 0.9) - 1];
    const target = boundedSeconds(Math.ceil((typical * 1.15 + 100) / 100) / 10, pacing.seconds);
    pacing.seconds = target >= pacing.seconds ? target : Math.max(target, Math.round((pacing.seconds - 0.1) * 10) / 10);
    pacing.pending = 0;
  }
  profile[field] = pacing;
}
