import { LETTERS, KOCH, PROSIGNS, clamp } from './morse.mjs';
import { introductoryRadio, numericApplications, punctuationApplications, signalApplication, radioPath, materialMeanings } from './course-material.mjs';

export const COURSE_LETTERS = 'ETAN' + [...KOCH].filter(c => LETTERS.includes(c) && !'ETAN'.includes(c)).join('');
export const COURSE_GROUP_LENGTH = 3;
export const COURSE_LEVELS = 400;
export const EAR_COURSE_START = 193;
export const EAR_COURSE_END = 392;
export const legacyCourseLevel = level => level < 149 ? level : level < EAR_COURSE_START ? level + 4 : level <= EAR_COURSE_END ? null : level <= 396 ? level - 244 : level - 200;
export const expandedCourseLevel = level => level < 149 ? level : level <= 152 ? level + 244 : level <= 196 ? level - 4 : level + 200;
export const earCourseLevelFor = count => EAR_COURSE_START + (Math.round(clamp(count, 2, 26, 2)) - 2) * 4;
export const COURSE_DIGITS = '5019283746';
export const COURSE_MARKS = '?/.,-';
export const COURSE_PROSIGNS = ['BT', 'AS', 'AR', 'KN', 'SK', 'BK'];

// Original practice material. Meanings follow CWops' beginner curriculum and
// ARRL operating aids; joined-signal meanings/patterns follow EUCW.
const NAMES = ['ANNA', 'SAM', 'JOHN', 'NINA', 'LEO', 'ELI'];
const PLACES = ['OSLO', 'LONDON', 'ROME', 'TOKYO', 'BERLIN', 'REYKJAVIK'];
const CALLS = ['TF3CW', 'W1AW', 'K1ABC', 'G4ABC', 'DL1ABC', 'JA1ABC'];
const REPORTS = ['599', '579', '559', '589', '569', '459'];
const POWERS = ['5', '10', '25', '50', '75', '100'];
const FREQS = ['7030', '7040', '14050', '14060', '10120', '10130'];
const FIRST_FREQUENCIES = ['7010', '7020', '7030', '7040', '3530', '3540'];
const expand = templates => [...new Set(templates.flatMap(template => NAMES.map((name, i) => template
  .replaceAll('{name}', name).replaceAll('{place}', PLACES[i]).replaceAll('{call}', CALLS[i])
  .replaceAll('{other}', CALLS[(i + 1) % CALLS.length]).replaceAll('{rst}', REPORTS[i])
  .replaceAll('{power}', POWERS[i]).replaceAll('{freq}', FREQS[i]).replaceAll('{nr}', String(i + 1).padStart(3, '0')))))];
const example = (text, meaning) => ({ text, meaning });

const phraseStage = (label, entries) => [label, entries.map(entry => entry.text), entries];
const PHRASE_STAGES = [
  phraseStage('Common CW shorthand', [
    example('R', 'Received; understood'), example('TU', 'Thank you'), example('TNX', 'Thanks'), example('PSE', 'Please'),
    example('AGN', 'Again; repeat'), example('DE', 'From; this is'), example('GM', 'Good morning'), example('GL', 'Good luck'),
  ]),
  phraseStage('Common Q codes', [
    example('QTH', 'Location'), example('QRS', 'Send more slowly'), example('QRM', 'Interference from other signals'),
    example('QRN', 'Atmospheric noise'), example('QSB', 'Signal fading'), example('QSL', 'Acknowledgement of receipt'),
    example('QSO', 'Radio contact'), example('QRZ', 'Who is calling me?'),
  ]),
  phraseStage('Short radio phrases', [
    example('CQ CQ', 'Calling any station'), example('CQ DX', 'Calling distant stations'), example('PSE AGN', 'Please repeat'),
    example('PSE QRS', 'Please send more slowly'), example('TNX QSO', 'Thanks for the contact'), example('VY FB', 'Very fine; excellent'),
    example('GL ES DX', 'Good luck and distant contacts'), example('R R', 'Received; understood'),
  ]),
  phraseStage('Names and locations', [
    ...NAMES.map(name => example(`NAME IS ${name}`, `The operator’s name is ${name[0] + name.slice(1).toLowerCase()}`)),
    ...['OSLO', 'ROME', 'LIMA', 'YORK'].map(place => example(`QTH IS ${place}`, `The station is in ${place[0] + place.slice(1).toLowerCase()}`)),
  ]),
  phraseStage('Everyday radio messages', [
    example('WX SUNNY', 'The weather is sunny'), example('WX RAIN', 'The weather is rainy'), example('WX CLDY', 'The weather is cloudy'),
    example('ALL OK', 'Everything is OK'), example('SRI NO CPY', 'Sorry, I could not copy'), example('PSE RPT', 'Please repeat'),
    example('GD SIG', 'Good signal'), example('SOLID CPI', 'Copying your signal clearly'),
  ]),
  phraseStage('Closing a contact', [
    example('TNX FER QSO', 'Thanks for the contact'), example('TKS FER CALL', 'Thanks for the call'),
    example('HPE CUAGN', 'Hope to see you again'), example('CUL', 'See you later'), example('GL ES DX', 'Good luck and distant contacts'),
    example('VY TNX', 'Many thanks'), example('TU ES GL', 'Thank you and good luck'),
  ]),
];
const PHRASE_MEANINGS = new Map(PHRASE_STAGES.flatMap(([, , entries]) => entries.map(entry => [entry.text, entry.meaning])));
const PHRASE_REVIEW = [...PHRASE_MEANINGS.keys()].filter(text => text.replaceAll(' ', '').length >= 4);
const NUMBER_STAGES = [
  ['Number pairs', ['50', '19', '28', '37', '46', '01', '73', '59', '88', '10'], [example('73', 'Best regards')]],
  ['Number groups', ['501', '928', '374', '6501', '1928', '3746', '001', '123', '987'], []],
  ['Signal reports', REPORTS, [example('599', 'Readability 5, strength 9, tone 9'), example('579', 'Readability 5, strength 7, tone 9')]],
  ['Reports in context', expand(['UR RST {rst}', 'RST {rst} {rst}', 'R R UR {rst}']), [example('UR RST 579', 'Your readability, signal strength and tone report is 579')]],
  ['Sign-offs', ['73', 'TU 73', 'TNX ES 73', 'GL ES 73', '73 ES CUAGN', 'VY 73'], [example('TU 73', 'Thank you and best regards')]],
  ['Power reports', expand(['PWR {power} W', 'RIG {power} W', 'RUNNING {power} W']), [example('PWR 5 W', 'Transmitting with five watts')]],
  ['Frequencies', expand(['QSY {freq}', 'QRV {freq}', 'QRG {freq}']), [example('QSY 7030', 'Change frequency to 7030 kHz')]],
  ['Short callsigns', ['W1AW', 'K1A', 'W2B', 'G4CW', 'N0C', 'TF3A', 'K7AA', 'M0CW'], [example('W1AW', 'A practice station identifier; letters and numbers together')]],
  ['Callsigns around the world', CALLS, [example('TF3CW', 'Copy every letter and digit of the station identifier')]],
  ['Serial numbers', expand(['NR {nr}', 'UR NR {nr}', 'R NR {nr}']), [example('NR 001', 'Number one, sent as three digits')]],
  ['Mixed numeric messages', expand(['DE {call}', 'NAME {name} PWR {power} W', 'UR RST {rst} NAME {name}']), []],
  ['First contact fragments', expand(['CQ CQ DE {call} K', '{call} DE {other} K', 'R TNX {name} UR RST {rst}']), [example('CQ CQ DE TF3CW K', 'Calling any station; this is TF3CW; go ahead')]],
];
const MARK_TEMPLATES = [
  [['QRL?', 'AGN?', 'QRZ?', 'QTH?'], ['HW CPY?', 'UR NAME?', 'UR QTH?', 'PSE AGN?'], ['{call} DE {other} HW CPY?', 'NAME {name} QTH {place} OK?']],
  [['{call}/P', '{other}/P'], ['{call}/M', '{other}/M', '{call}/QRP'], ['{call}/P DE {other}', 'CQ DE {call}/QRP K']],
  [['PWR 2.5 W', 'PWR 1.5 W', 'PWR 0.5 W'], ['QSY 7.030', 'QSY 14.060', 'QRG 10.120'], ['RIG 2.5 W QSY 7.030', '{call} PWR 1.5 W']],
  [['QTH {place}, {name}', 'NAME {name}, QTH {place}'], ['RST {rst}, NAME {name}', 'WX SUNNY, PWR {power} W'], ['{call}, UR RST {rst}', 'NAME {name}, PWR {power} W']],
  [['PWR 5-10 W', 'PWR 10-25 W', 'PWR 25-50 W'], ['QSY 7030-7040', 'QSY 14050-14060', 'QSY 10120-10130'], ['QTH {place}, PWR 5-10 W', '{call}/P QSY 7.030 OK?', 'NAME {name}, RST {rst}']],
];
const SIGN_MESSAGES = {
  BT: ['NAME {name} BT QTH {place}', 'WX SUNNY BT PWR {power} W', 'RST {rst} BT NAME {name}'],
  AS: ['{call} DE {other} AS', 'PSE AS', 'AS {name}'],
  AR: ['NAME {name} QTH {place} AR', 'UR RST {rst} AR', 'TNX FER CALL {name} AR'],
  KN: ['{call} DE {other} KN', 'UR RST {rst} KN', 'HW CPY {name}? KN'],
  SK: ['TNX FER QSO {name} SK', '{call} DE {other} TU 73 SK', 'GL ES 73 {name} SK'],
  BK: ['UR RST {rst} BK', 'R R {name} BK', 'QTH {place} BK'],
};
const FINAL_STAGES = [
  ['Portable station practice', expand(['CQ CQ DE {call}/P K', '{call}/QRP DE {other} KN', 'R UR RST {rst} {name} BK']), []],
  ['Complete radio messages', expand(['RST {rst} BT NAME {name} BT QTH {place} KN', '{call} DE {other} PWR {power} W BK', 'QSY {freq} PSE AS']), []],
  ['Head-copy on air', expand(['NAME {name}, QTH {place} BT RST {rst} KN', 'TU {name} TNX FER QSO 73 SK', '{call}/P DE {other} HW CPY? KN']), []],
  ['Full radio contacts', expand(['CQ CQ DE {call} {call} K', '{call} DE {other} UR RST {rst} BT NAME {name} KN', 'R R {name} QTH {place} BT PWR {power} W BK', '{call} DE {other} TNX FER QSO TU 73 SK']), [example('TU 73 SK', 'Thank you, best regards, end of contact; SK is sent joined')]],
];

function poolStage(label, pool, examples = [], extra = {}) {
  const lengths = pool.map(text => text.replaceAll(' ', '').length);
  return { letterCount: 26, minLength: Math.min(...lengths), maxLength: Math.max(...lengths), review: true, kind: 'messages', label, pool, examples, minCopies: 3, digits: COURSE_DIGITS, marks: '', prosigns: [], ...extra };
}

function originalStage(level) {
  const step = Math.round(clamp(level, 1, 200, 1));
  if (step <= 92) {
    const phase = (step - 1) % 4;
    return { letterCount: 4 + Math.floor((step - 1) / 4), minLength: phase === 3 ? 1 : phase + 1, maxLength: phase === 3 ? 3 : phase + 1, review: phase === 3, label: ['Singles', 'Pairs', 'Triples', 'Mixed review'][phase] };
  }
  if (step === 93) return { letterCount: 26, minLength: 4, maxLength: 4, review: false, label: '4-character groups' };
  if (step <= 99) return poolStage(...PHRASE_STAGES[step - 94], { digits: '', catalogue: true });
  if (step === 100) return poolStage('Phrase head-copy milestone', PHRASE_REVIEW, PHRASE_REVIEW.map(text => example(text, PHRASE_MEANINGS.get(text))), { digits: '', catalogue: true });
  if (step <= 140) {
    const index = Math.floor((step - 101) / 4), phase = (step - 101) % 4;
    const focus = COURSE_DIGITS[index];
    return { letterCount: 26, minLength: phase === 3 ? 1 : phase + 1, maxLength: phase === 3 ? 3 : phase + 1, review: phase === 3, label: `${focus} · ${['singles', 'pairs', 'triples', 'mixed review'][phase]}`, digits: COURSE_DIGITS.slice(0, index + 1), focus, newSound: phase === 0, examples: [example(focus, `Digit ${focus}`)] };
  }
  if (step <= 152) return poolStage(...NUMBER_STAGES[step - 141]);
  if (step <= 172) {
    const index = Math.floor((step - 153) / 4), phase = (step - 153) % 4;
    const focus = COURSE_MARKS[index], marks = COURSE_MARKS.slice(0, index + 1);
    const names = ['Question mark', 'Slash', 'Full stop / decimal point', 'Comma', 'Hyphen'];
    const examples = [example(focus, names[index])];
    if (!phase) return { letterCount: 26, minLength: 1, maxLength: 1, review: false, label: `${names[index]} · first sound`, digits: COURSE_DIGITS, marks, focus, newSound: true, examples };
    return poolStage(`${names[index]} · ${['', 'short copies', 'in context', 'mixed review'][phase]}`, expand(MARK_TEMPLATES[index][phase - 1]), examples, { marks, focus });
  }
  if (step <= 196) {
    const index = Math.floor((step - 173) / 4), phase = (step - 173) % 4;
    const focus = COURSE_PROSIGNS[index], prosigns = COURSE_PROSIGNS.slice(0, index + 1);
    const examples = [example(focus, PROSIGNS[focus].meaning)];
    const pool = phase === 0 ? [focus] : phase === 1 ? [focus, ...expand(SIGN_MESSAGES[focus]).filter(text => text.length <= 24)] : phase === 2 ? expand(SIGN_MESSAGES[focus]) : prosigns.flatMap(code => expand(SIGN_MESSAGES[code]));
    return poolStage(`${focus} · ${['joined signal', 'short copies', 'in context', 'mixed review'][phase]}`, pool, examples, { kind: 'prosigns', focus, prosigns, marks: COURSE_MARKS, newSound: phase === 0, minCopies: phase === 0 ? 0 : 3 });
  }
  return poolStage(...FINAL_STAGES[step - 197], { kind: 'prosigns', prosigns: COURSE_PROSIGNS, marks: COURSE_MARKS });
}

const SHORT_CALLS = ['TF3A', 'W1AW', 'G4CW', 'DL1A', 'JA1A', 'K7AA'];
const DECIMALS = ['2.5', '1.5', '0.5', '7.03', '7.04', '3.53', '3.54', '10.1', '14.0'];
const RANGES = ['1-5', '2-5', '5-10', '1-10'];
const RADIO_MESSAGES = ['QSY 7030', 'QRV 7040', 'QRG 14050', 'UR RST 599', 'NAME SAM', 'QTH OSLO', 'TU 73 SK', 'PSE AS'];
const RADIO_FINALE = ['CQ CQ DE W1AW', 'W1AW DE K1A K', 'UR RST 599 BK', 'NAME IS ANNA', 'QTH IS OSLO', 'PWR 5 W BK', 'QSY 7030 AS', 'TNX QSO TU 73 SK'];
const FRAGMENT_MEANINGS = new Map([...PHRASE_MEANINGS, ...Object.entries({
  RST: 'Readability, signal strength and tone', UR: 'Your', PWR: 'Transmitter power', RIG: 'Radio equipment',
  W: 'Watts', NR: 'Serial number', NAME: 'Operator name', WX: 'Weather', CALL: 'Station callsign',
  QSY: 'Change frequency', QRV: 'Ready', QRG: 'Frequency', QRP: 'Low power',
  '/P': 'Portable station suffix', '/M': 'Mobile station suffix', '/QRP': 'Low-power station suffix',
  ...materialMeanings,
})]);
const soundIn = (text, sound) => sound.length === 1 ? text.includes(sound) : text.split(' ').includes(sound);

// Whole words and adjacent words are useful radio fragments. Never cut inside
// a callsign, number or joined procedural signal just to meet a length limit.
function shortFragments(messages, limit, focus = '') {
  const choices = new Set();
  for (const message of messages) {
    const words = message.split(' ');
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const text = words.slice(start, end).join(' ');
        if (text.replaceAll(' ', '').length > limit) break;
        choices.add(text);
      }
    }
  }
  return [...choices].sort((a, b) => Number(!!focus && soundIn(b, focus)) - Number(!!focus && soundIn(a, focus)) || b.replaceAll(' ', '').length - a.replaceAll(' ', '').length).slice(0, 8);
}

function fragmentMeaning(text, stage) {
  const known = stage.examples?.find(entry => entry.text === text)?.meaning || FRAGMENT_MEANINGS.get(text) || PROSIGNS[text]?.meaning;
  if (known) return known;
  if (text === 'QRL?') return 'Is this frequency in use?';
  if (text === 'AGN?') return 'Again? Please repeat';
  if (text === 'QTH?') return 'What is your location?';
  if (text === 'QRZ?') return 'Who is calling me?';
  if (/^QSY \d+$/.test(text)) return `Change frequency to ${text.slice(4)} kHz`;
  if (/^QRV \d+$/.test(text)) return `Ready on ${text.slice(4)} kHz`;
  if (/^QRG \d+$/.test(text)) return `Frequency ${text.slice(4)} kHz`;
  if (/^NAME (?:IS )?[A-Z]+$/.test(text)) return `Operator name: ${text.split(' ').at(-1)}`;
  if (/^QTH (?:IS )?[A-Z]+$/.test(text)) return `Station location: ${text.split(' ').at(-1)}`;
  if (/^(?:UR )?RST \d{3}$/.test(text)) return `Signal report: readability ${text.at(-3)}, strength ${text.at(-2)}, tone ${text.at(-1)}`;
  if (/^R \d{3}$/.test(text)) return `Received; report ${text.slice(2)}`;
  if (/^(?:UR )?NR \d+$/.test(text)) return `Serial number ${text.split(' ').at(-1)}`;
  if (/^PWR \d+ W$/.test(text)) return `Transmitting with ${text.split(' ')[1]} watts`;
  if (/^WX /.test(text)) return `Weather: ${text.slice(3)}`;
  if (stage.kind === 'frequencies') return `${text} kHz · copy all four digits`;
  if (stage.label === 'Signal reports' && /^\d{3}$/.test(text)) return `Readability ${text[0]}, strength ${text[1]}, tone ${text[2]}`;
  if (/^[\d.-]+$/.test(text)) return 'Number group';
  if (NAMES.includes(text)) return 'Operator name';
  if (PLACES.includes(text)) return 'Station location';
  if (SHORT_CALLS.includes(text)) return 'Station callsign';
  if (stage.prosigns?.some(sign => text.split(' ').includes(sign))) return 'Radio fragment · procedural signals are sent joined';
  return 'Radio fragment';
}

function revisedStage(step) {
  const stage = originalStage(step);
  if (step < 141 || !stage.pool) return stage;
  const limit = step <= 197 ? 4 : step === 198 ? 6 : step === 199 ? 8 : 12;
  let pool = stage.maxLength <= limit ? stage.pool : shortFragments(stage.pool, limit, stage.focus);
  let label = step === 144 ? 'Report fragments' : step === 146 ? 'Power report fragments' : step === 151 ? 'Mixed radio fragments' : step === 152 ? 'Radio fragment review' : stage.label;
  let kind = stage.kind;
  if (step === 147) { pool = FIRST_FREQUENCIES; label = 'Four-digit frequencies'; kind = 'frequencies'; }
  if (step === 149) pool = SHORT_CALLS;
  if (step === 150) pool = ['001', '002', '003', '004', '005', '006'];
  if (step >= 158 && step <= 160) pool = ['/P', '/M', '/QRP'];
  if (step >= 162 && step <= 164) pool = step === 162 ? DECIMALS.slice(0, 3) : step === 163 ? DECIMALS.slice(3) : DECIMALS;
  if (step >= 170 && step <= 172) pool = RANGES;
  if (step === 197) label = 'Short radio fragments by ear';
  if (step === 198) label = 'Radio groups by ear';
  if (step === 199) { pool = RADIO_MESSAGES; label = 'Short radio messages'; }
  if (step === 200) { pool = RADIO_FINALE; label = 'Radio contact finale'; }
  const focused = stage.focus ? pool.filter(text => soundIn(text, stage.focus)) : pool;
  const byEar = step >= 149 && step <= 152 || step >= 197;
  return poolStage(label, pool, pool.map(text => example(text, fragmentMeaning(text, { ...stage, kind }))), {
    kind, digits: stage.digits, marks: stage.marks, prosigns: stage.prosigns,
    ...(stage.focus ? { focus: stage.focus, newSound: stage.newSound } : {}),
    minCopies: Math.min(stage.minCopies, focused.length), catalogue: true, shortCopies: true,
    progressLength: stage.maxLength, byEar,
  });
}

export function courseStage(level) {
  const number = Math.round(clamp(level, 1, COURSE_LEVELS, 1));
  if (number >= EAR_COURSE_START && number <= EAR_COURSE_END) {
    return coherentStage(number, blindStage(number - EAR_COURSE_START));
  }
  const legacyLevel = legacyCourseLevel(number);
  return coherentStage(number, { ...revisedStage(legacyLevel), legacyLevel });
}

function materialStage(previous, [label, pool, objective], extra = {}) {
  const stage = { ...previous, ...extra, label };
  return { ...stage, ...poolStage(label, pool, pool.map(text => example(text, fragmentMeaning(text, stage)))),
    letterCount: stage.letterCount, digits: stage.digits || '', marks: stage.marks || '', prosigns: stage.prosigns || [],
    ...extra, objective, catalogue: true, shortCopies: true, materialRevision: 1,
    // Exercise length and allowed characters may change without losing the
    // earned checkmark, partial meter or paired device's existing identity.
    progressLength: previous.progressLength ?? previous.maxLength,
    progressAlphabet: courseAlphabet(previous),
  };
}

function coherentStage(level, stage) {
  if (level >= 94 && level <= 100) return materialStage(stage, introductoryRadio[level - 94]);
  if (level >= 141 && level <= 148) return materialStage(stage, numericApplications[level - 141], { kind: level === 147 ? 'frequencies' : 'messages' });
  if (level >= 149 && level <= 168) {
    const index = Math.floor((level - 149) / 4), phase = (level - 149) % 4;
    if (!phase) return stage;
    return materialStage(stage, punctuationApplications[index][phase - 1], {
      focus: stage.focus, minCopies: 3,
      ...(phase === 3 ? { requiredSounds: [...COURSE_MARKS.slice(0, index + 1)] } : {}),
    });
  }
  if (level >= 169 && level <= 192 || level >= 349 && level <= 372) {
    const first = level <= 192 ? 169 : 349, phase = (level - first) % 4;
    const material = signalApplication(stage.prosigns, phase);
    return materialStage(stage, [material.label, material.pool, material.objective], {
      kind: 'prosigns', focus: stage.focus, minCopies: material.minCopies ?? 3,
      ...(material.requiredSounds ? { requiredSounds: material.requiredSounds } : {}),
      ...(level >= 349 ? { byEar: true } : {}),
    });
  }
  if (level >= 193 && level <= 348 && (level - 193) % 4 === 3) {
    const sounds = stage.audioAlphabet ? [...courseAlphabet(stage)].slice(-4) : stage.audioNumbers ? [...stage.digits] : [...stage.marks];
    return { ...stage, requiredSounds: sounds };
  }
  if (level >= 373) {
    const allSounds = COURSE_LETTERS + COURSE_DIGITS + COURSE_MARKS;
    return materialStage(stage, radioPath[level - 373], {
      chapter: 'radio', kind: 'prosigns', byEar: true, audioNumbers: level === 373,
      practiceAlphabet: level === 373 ? COURSE_DIGITS : allSounds,
      digits: COURSE_DIGITS, marks: level === 373 ? '' : COURSE_MARKS,
      prosigns: level === 373 ? [] : COURSE_PROSIGNS,
      ...(level === 376 ? { requiredSounds: [...COURSE_MARKS] } : {}),
    });
  }
  return stage;
}

function blindStage(index) {
  const phases = ['singles', 'pairs', 'triples', 'mixed review'];
  const base = { audioCourse: true, byEar: true, digits: '', marks: '', prosigns: [], letterCount: 26 };
  if (index < 136) {
    const phase = index % 4;
    let chapter, alphabet, focus = '', letterCount = 26, digits = '', marks = '';
    if (index < 100) {
      chapter = 'alphabet'; letterCount = 2 + Math.floor(index / 4); alphabet = COURSE_LETTERS.slice(0, letterCount);
      focus = letterCount > 2 ? alphabet.at(-1) : '';
    } else if (index < 136) {
      chapter = 'numbers'; digits = COURSE_DIGITS.slice(0, 2 + Math.floor((index - 100) / 4)); alphabet = digits;
      focus = digits.length > 2 ? digits.at(-1) : '';
    }
    const count = alphabet.length;
    return { ...base, chapter, audioAlphabet: chapter === 'alphabet', audioNumbers: chapter === 'numbers', letterCount, digits, marks,
      practiceAlphabet: alphabet, focus, reintroduced: phase === 0, introducedSounds: phase === 0 ? focus ? [focus] : [...alphabet] : [],
      minLength: phase === 3 ? 1 : phase + 1, maxLength: phase === 3 ? 3 : phase + 1, review: phase === 3,
      label: `${chapter === 'alphabet' ? 'Alphabet' : 'Numbers'} by ear · ${count} ${chapter === 'alphabet' ? 'letters' : 'digits'} · ${phases[phase]}` };
  }
  if (index < 156) {
    const offset = index - 136, phase = offset % 4, marks = COURSE_MARKS.slice(0, 1 + Math.floor(offset / 4)), focus = marks.at(-1);
    return { ...base, chapter: 'punctuation', digits: COURSE_DIGITS, marks, focus, reintroduced: phase === 0, introducedSounds: phase === 0 ? [focus] : [],
      minLength: phase === 3 ? 1 : phase + 1, maxLength: phase === 3 ? 3 : phase + 1, review: phase === 3,
      label: `${focus} by ear · ${phases[phase]}` };
  }
  if (index < 180) {
    const offset = index - 156, phase = offset % 4, prosigns = COURSE_PROSIGNS.slice(0, 1 + Math.floor(offset / 4)), focus = prosigns.at(-1);
    const singles = [...prosigns, 'E', 'T', 'A', 'N'];
    const short = prosigns.flatMap(sign => [`R ${sign}`, `TU ${sign}`, `${sign} E`, `${sign} R`]);
    const pairs = prosigns.flatMap(a => prosigns.map(b => `${a} ${b}`));
    const choices = phase === 0 ? singles : phase === 1 ? short : phase === 2 ? pairs : [...singles, ...short, ...pairs];
    const pool = shortFragments(choices, 4, focus), focused = pool.filter(text => soundIn(text, focus));
    return { ...poolStage(`${focus} by ear · ${['joined signal', 'short copies', 'signal pairs', 'mixed review'][phase]}`, pool,
      pool.map(text => example(text, fragmentMeaning(text, { prosigns }))), { kind: 'prosigns', digits: COURSE_DIGITS, marks: COURSE_MARKS, prosigns, focus, minCopies: phase === 0 ? 0 : Math.min(3, focused.length) }),
      ...base, chapter: 'prosigns', digits: COURSE_DIGITS, marks: COURSE_MARKS, prosigns,
      reintroduced: phase === 0, introducedSounds: phase === 0 ? [focus] : [] };
  }
  const review = index - 180, topic = Math.floor(review / 4), phase = review % 4;
  if (topic < 3) {
    const digits = COURSE_DIGITS, marks = topic === 2 ? COURSE_MARKS : '';
    return { ...base, chapter: 'review', digits, marks, audioNumbers: topic === 0,
      ...(topic === 0 ? { practiceAlphabet: digits } : {}),
      minLength: phase === 3 ? 1 : phase + 1, maxLength: phase === 3 ? 3 : phase + 1, review: phase === 3,
      label: `${['Number review', 'Letters and numbers', 'Punctuation review'][topic]} by ear · ${phases[phase]}` };
  }
  const pool = topic === 3 ? phase === 0 ? ['K1A', 'W2B', 'N0C'] : SHORT_CALLS : ['TU 73', 'QRL?', '599', 'PWR 5', 'QTH', 'W1AW', '73 SK', 'R BT'];
  return { ...poolStage(`${topic === 3 ? 'Callsign' : 'Radio fragment'} review by ear · ${phase + 1}`, pool,
    pool.map(text => example(text, fragmentMeaning(text, { prosigns: COURSE_PROSIGNS }))), { kind: 'prosigns', digits: COURSE_DIGITS, marks: COURSE_MARKS, prosigns: COURSE_PROSIGNS }),
    ...base, chapter: 'review', digits: COURSE_DIGITS, marks: COURSE_MARKS, prosigns: COURSE_PROSIGNS };
}

export function courseLevelFor(letterCount = 4, length = 1) {
  const count = Math.round(clamp(letterCount, 4, 26, 4));
  return count === 26 && length > 3 ? 93 : (count - 4) * 4 + Math.min(3, Math.max(1, length));
}

export function courseAlphabet(stage) {
  return stage.practiceAlphabet || COURSE_LETTERS.slice(0, stage.letterCount) + (stage.digits || '') + (stage.marks || '');
}

// Only explicit procedural tokens are joined; ordinary AR/AS in free practice
// and ordinary individual-letter auditions retain their normal letter gaps.
export function transmissionText(text, settings) {
  if (settings.lesson !== 'starter' || settings.content !== 'groups') return text;
  const signals = courseStage(settings.courseLevel).prosigns || [];
  return text.split(' ').map(word => signals.includes(word) ? `<${word}>` : word).join(' ');
}
