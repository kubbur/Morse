// International Morse. Durations follow ITU-R M.1677 and PARIS timing.
export const MORSE = Object.freeze({
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---',
  3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
  8: '---..', 9: '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..',
  "'": '.----.', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  ':': '---...', '=': '-...-', '+': '.-.-.', '-': '-....-',
  '"': '.-..-.', '@': '.--.-.',
});

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const PUNCTUATION = '.,?/=@+-:\'()"';
// These are procedural signals, sent joined; ordinary letters remain spaced.
// EUCW operating guide: https://www.eucw.org/op/en/prosigns.html
export const PROSIGNS = Object.freeze({
  BT: { pattern: '-...-', meaning: 'Separator between parts of a message' },
  AS: { pattern: '.-...', meaning: 'Wait or stand by' },
  AR: { pattern: '.-.-.', meaning: 'End of message' },
  KN: { pattern: '-.--.', meaning: 'Go ahead, the named station only' },
  SK: { pattern: '...-.-', meaning: 'End of contact; no reply expected' },
  BK: { pattern: '-...-.-', meaning: 'Break; hand the conversation back' },
});
export const patternFor = character => MORSE[character] || PROSIGNS[character]?.pattern;
// A commonly used Koch sequence. Alphabet size and answer length are independent.
export const KOCH = 'KMURESNAPTLWI.JZ=FOY,VG5/Q9H38B?427C1D60X';
export const clamp = (value, min, max, fallback = min) =>
  Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));

export function normalizeText(text) {
  return String(text ?? '').toUpperCase().trim().replace(/\s+/g, ' ');
}

export function supportedCharacters(text) {
  return [...new Set(normalizeText(text).replaceAll(' ', ''))].filter(c => Object.hasOwn(MORSE, c)).join('');
}

export function timing(characterWpm = 30, effectiveWpm = 15) {
  const character = clamp(characterWpm, 5, 80, 30);
  const effective = clamp(effectiveWpm, 1, character, 15);
  const dit = 1.2 / character;
  // 31 fixed units + 19 spacing units make a 50-unit PARIS word.
  const spacing = (60 / effective - 31 * dit) / 19;
  return { dit, dah: 3 * dit, elementGap: dit, letterGap: 3 * spacing, wordGap: 7 * spacing };
}

export function timeline(text, settings = {}, { trailingWordGap = false } = {}) {
  const units = [];
  const source = normalizeText(text);
  for (let i = 0; i < source.length; i++) {
    const match = source.slice(i).match(/^<(BT|AS|AR|KN|SK|BK)>/);
    if (match) {
      const start = units.length;
      for (const character of match[1]) units.push({ character, prosign: match[1], prosignStart: start });
      i += match[0].length - 1;
    } else units.push({ character: source[i] });
  }
  const normalized = units.map(unit => unit.character).join('');
  if (!normalized || [...normalized].some(c => c !== ' ' && !Object.hasOwn(MORSE, c))) {
    throw new Error('Choose text containing supported Morse characters.');
  }
  const time = timing(settings.wpm, settings.farnsworth);
  const tones = [];
  let cursor = 0;
  units.forEach(({ character, prosign, prosignStart }, characterIndex) => {
    if (character === ' ') return;
    [...MORSE[character]].forEach((symbol, symbolIndex) => {
      const duration = symbol === '.' ? time.dit : time.dah;
      tones.push({ start: cursor, duration, character, characterIndex, symbol, ...(prosign ? { prosign, prosignStart } : {}) });
      cursor += duration;
      if (symbolIndex < MORSE[character].length - 1) cursor += time.elementGap;
    });
    if (characterIndex < normalized.length - 1) {
      cursor += prosign && units[characterIndex + 1]?.prosignStart === prosignStart ? time.elementGap : normalized[characterIndex + 1] === ' ' ? time.wordGap : time.letterGap;
    }
  });
  if (trailingWordGap) cursor += time.wordGap;
  return { tones, duration: cursor, timing: time, text: normalized };
}

export function rampGain(x, shape) {
  if (shape === 'linear') return x;
  if (shape === 'exponential') return Math.expm1(3 * x) / Math.expm1(3);
  return (1 - Math.cos(Math.PI * x)) / 2;
}

export function envelopeAt(time, duration, riseMs = 5, fallMs = 5, shape = 'smooth') {
  let rise = clamp(riseMs, 1, 30, 5) / 1000;
  let fall = clamp(fallMs, 1, 30, 5) / 1000;
  if (rise + fall > duration) {
    const scale = duration / (rise + fall);
    rise *= scale;
    fall *= scale;
  }
  if (time <= 0 || time >= duration) return 0;
  if (time < rise) return rampGain(time / rise, shape);
  if (time > duration - fall) return rampGain((duration - time) / fall, shape);
  return 1;
}

export function gradeAnswer(target, input) {
  const expected = [...normalizeText(target)];
  const actual = [...normalizeText(input)];
  const costs = Array.from({ length: expected.length + 1 }, () => Array(actual.length + 1).fill(0));
  for (let i = 0; i <= expected.length; i++) costs[i][0] = i;
  for (let j = 0; j <= actual.length; j++) costs[0][j] = j;
  for (let i = 1; i <= expected.length; i++) {
    for (let j = 1; j <= actual.length; j++) {
      costs[i][j] = Math.min(
        costs[i - 1][j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1),
        costs[i - 1][j] + 1,
        costs[i][j - 1] + 1,
      );
    }
  }
  const letters = [];
  let i = expected.length;
  let j = actual.length;
  while (i || j) {
    if (i && j && costs[i][j] === costs[i - 1][j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1)) {
      letters.unshift({ expected: expected[--i], actual: actual[--j], correct: expected[i] === actual[j] });
    } else if (i && costs[i][j] === costs[i - 1][j] + 1) {
      letters.unshift({ expected: expected[--i], actual: '', correct: false });
    } else {
      letters.unshift({ expected: '', actual: actual[--j], correct: false });
    }
  }
  return { correct: costs[expected.length][actual.length] === 0, letters, distance: costs[expected.length][actual.length] };
}
