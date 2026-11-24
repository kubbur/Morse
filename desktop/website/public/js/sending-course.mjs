import { MORSE, PROSIGNS, patternFor } from './morse.mjs';

export const SENDING_LEVELS = 218;
export const SENDING_LETTERS = 'ETANKMURSPLWIJZFOYVGQHBCDX';
export const SENDING_DIGITS = '5019283746';
export const SENDING_MARKS = '?/.,-';
export const SENDING_SIGNALS = ['BT', 'AS', 'AR', 'KN', 'SK', 'BK'];
export const SENDING_CHAPTERS = Object.freeze([
  { start: 1, end: 8, name: 'Key timing', description: 'Dots, dashes, character gaps and word gaps.' },
  { start: 9, end: 104, name: 'The alphabet', description: 'Four levels per letter: singles, single-letter review, E/T pairs, then familiar pairs.' },
  { start: 105, end: 112, name: 'Alphabet review', description: 'Review pairs before introducing triples, short words and word spacing.' },
  { start: 113, end: 152, name: 'Numbers', description: 'Four levels per digit, starting with singles and building to pairs.' },
  { start: 153, end: 172, name: 'Punctuation', description: 'Learn ? / . , - separately, then use each in pairs.' },
  { start: 173, end: 196, name: 'Radio signals', description: 'Learn joined BT, AS, AR, KN, SK and BK separately, then combine them with familiar characters.' },
  { start: 197, end: 206, name: 'Sending messages', description: 'Short CW words, callsigns, reports and station details.' },
  { start: 207, end: 218, name: 'Listen and answer', description: 'Hear the other station and key a reply. Finish with a simulated contact.' },
]);

export function sendingTokens(text) {
  if (typeof text !== 'string' || text.length > 200) return [];
  return (text.toUpperCase().match(/<(?:BT|AS|AR|KN|SK|BK)>|[^\s]/g) || []).map(value => ({
    value, pattern: value.startsWith('<') ? PROSIGNS[value.slice(1, -1)]?.pattern : MORSE[value],
  }));
}

// Stages hold complete exercises, not examples of a larger hidden vocabulary.
const exercise = (target, incoming = '', context = '') => ({ target, incoming, context });
const foundations = [
  ['A dot · E', ['E'], 'Hold the key for one short beat. Release it to end the dot.', 'E'],
  ['A dash · T', ['T'], 'Hold a dash three times as long as a dot.', 'T'],
  ['Dots and dashes', ['E', 'T', 'E', 'T'], 'Send the shown letter. Keep the dot short and the dash three times longer.'],
  ['Separate letters', ['EE'], 'Send two dots with a character gap between them. A short gap would join them into I.'],
  ['Dash spacing', ['TT'], 'Send two dashes with a character gap between them.'],
  ['Change between E and T', ['ET', 'TE'], 'Keep the character gaps even as you change between dots and dashes.'],
  ['Separate words', ['E E', 'T T', 'E T'], 'Leave a word gap at each space. Word gaps are longer than character gaps.'],
  ['Listen, then send', ['E', 'T', 'ET', 'TE'], 'Listen to the signal, then send it back. There is no response deadline.'],
];

const alphabetReview = [
  ['Review E, T, A and N', ['ET', 'TA', 'AN', 'NE'], 'Send pairs of familiar letters. Keep a character gap between them.'],
  ['Review the first eight letters', ['KM', 'MU', 'UR', 'RK'], 'Two letters per answer. Keep the character gaps even.'],
  ['Review alphabet pairs', ['SP', 'LW', 'IJ', 'ZF', 'OY', 'VG', 'QH', 'BC', 'DX'], 'Review the rest of the alphabet in pairs.'],
  ['First triples', ['ETE', 'TEN', 'ANT'], 'Three familiar letters per answer. Keep each letter separate.'],
  ['More triples', ['KUR', 'MUR', 'RUM'], 'Practise three-letter groups using the first eight letters.'],
  ['Alphabet triples', ['SPL', 'WIJ', 'ZFO', 'YVG', 'QHB', 'CDX'], 'Send three-letter groups from across the alphabet.'],
  ['Short words', ['TO', 'AT', 'IN', 'THE', 'AND'], 'Send short words with two or three letters.'],
  ['Words and word gaps', ['SEND', 'NAME', 'TO ME', 'AT NO'], 'Send words up to four letters long, or two short words with a clear word gap.'],
];

const messages = [
  ['Short CW words', ['CQ', 'DE', 'TNX', 'PSE'], 'Send each short word with clear character spacing.'],
  ['Acknowledgements', ['R', 'RR', 'QSL'], 'R acknowledges a message. QSL confirms receipt.'],
  ['Requests', ['QRS', 'AGN', 'PSE AGN'], 'QRS asks for slower sending. AGN asks for a repeat.'],
  ['Word spacing', ['CQ CQ', 'TNX FER', '73 TU'], 'Keep the word gaps clear.'],
  ['Practice callsigns', ['N0ABC', 'G4ABC', 'K1ABC'], 'These are example callsigns for practice. Send the full call.'],
  ['Signal reports', ['RST 599', 'RST 579', 'RST 559'], 'Send the RST label followed by the three-digit report.'],
  ['Names', ['NAME ANNA', 'NAME JOHN', 'NAME ERIK'], 'Send the name as a separate word.'],
  ['Locations', ['QTH OSLO', 'QTH ROME', 'QTH LIMA'], 'QTH gives the station location.'],
  ['Joined signals in messages', ['R <BK>', 'TNX <AR>', '73 <SK>'], 'Keep letters spaced. Send a signal inside angle brackets as one joined pattern.'],
  ['Prepare for replies', ['DE N0ABC', 'QSL TNX', '73 <SK>'], 'Send a callsign, an acknowledgement and a closing.'],
];

const replies = [
  ['Answer a call', 'Listen for CQ. Identify this practice station as N0ABC.', [exercise('DE N0ABC', 'CQ CQ', 'CQ is a general call. Reply with DE N0ABC.')]],
  ['Give your name', 'This practice operator is ANNA. Listen for the name request.', [exercise('NAME ANNA', 'NAME?', 'The other station asks for your name. Send NAME ANNA.')]],
  ['Give your location', 'This practice station is in OSLO. Listen for the location request.', [exercise('QTH OSLO', 'QTH?', 'The other station asks for your location. Send QTH OSLO.')]],
  ['Send a report', 'The practice signal report is 599. Listen for the request.', [exercise('RST 599', 'RST?', 'The other station asks for a signal report. Send RST 599.')]],
  ['Confirm receipt', 'Acknowledge the report from the other station.', [exercise('QSL', 'RST 579', 'Confirm that you received the report. Send QSL.')]],
  ['Request a repeat', 'Practise asking the other station to send a message again.', [exercise('PSE AGN', 'NAME JOHN', 'Ask for the message again. Send PSE AGN.')]],
  ['Request slower sending', 'Practise the CW request to slow down.', [exercise('PSE QRS', 'CQ DE G4ABC', 'Ask the other station to slow down. Send PSE QRS.')]],
  ['Ask the other station to wait', 'Use the joined AS signal to ask the other station to stand by.', [exercise('<AS>', 'QRV?', 'QRV? asks if you are ready. Ask them to wait with <AS>.')]],
  ['Hand the conversation back', 'Acknowledge the name and hand the conversation back with joined BK.', [exercise('R <BK>', 'NAME ERIK', 'Send R, then the joined <BK> signal.')]],
  ['Close a contact', 'Acknowledge a closing with 73 and the joined SK signal.', [exercise('73 <SK>', 'TNX 73', 'Send 73, then the joined <SK> signal.')]],
  ['A short exchange', 'Listen and answer each turn. You are ANNA in OSLO at practice station N0ABC.', [
    exercise('DE N0ABC', 'CQ DE G4ABC', 'Answer the call with DE N0ABC.'),
    exercise('NAME ANNA', 'NAME?', 'Send NAME ANNA.'),
    exercise('73 <SK>', 'TNX 73', 'Close with 73 <SK>.'),
  ]],
  ['A complete practice contact', 'Five turns: identify, report, name, location and close. No response deadline.', [
    exercise('DE N0ABC', 'CQ CQ DE G4ABC', 'Answer the call with DE N0ABC.'),
    exercise('RST 599', 'RST?', 'Send RST 599.'),
    exercise('NAME ANNA', 'NAME?', 'Send NAME ANNA.'),
    exercise('QTH OSLO', 'QTH?', 'Send QTH OSLO.'),
    exercise('73 <SK>', 'TNX 73', 'Close with 73 <SK>.'),
  ]],
];

// Map earned work from the original two-level introductions onto equivalent
// lessons. Unfinished mixed practice resumes at the new single-letter review.
export function legacySendingLevel(level, { resume = false } = {}) {
  if (level <= 8) return level;
  if (level >= 99) return level + 98;
  const oldStart = level >= 87 ? 87 : level >= 77 ? 77 : level >= 57 ? 57 : 9;
  const newStart = { 9: 9, 57: 113, 77: 153, 87: 173 }[oldStart];
  const offset = level - oldStart;
  return newStart + Math.floor(offset / 2) * 4 + (offset % 2 ? resume ? 1 : 3 : 0);
}

export function sendingStage(value) {
  const level = Math.max(1, Math.min(SENDING_LEVELS, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 1));
  const chapter = SENDING_CHAPTERS.find(c => level >= c.start && level <= c.end);
  let title, instruction, items, focus = '', known = 'ET', kind = 'copy', guided = false, required = 3, focusCopies = 0;
  if (level <= 8) {
    const entry = foundations[level - 1];
    [title, , instruction] = entry;
    items = entry[1].map(t => exercise(t));
    focus = entry[3] || '';
    guided = level <= 7;
    if (level === 8) kind = 'echo';
  } else if (level >= 105 && level <= 112) {
    const entry = alphabetReview[level - 105];
    [title, , instruction] = entry;
    items = entry[1].map(t => exercise(t));
    known = SENDING_LETTERS;
    required = 4;
  } else if (level <= 196) {
    const start = level >= 173 ? 173 : level >= 153 ? 153 : level >= 113 ? 113 : 9;
    const offset = level - start, index = Math.floor(offset / 4), phase = offset % 4;
    focus = start === 9 ? SENDING_LETTERS[index + 2] : start === 113 ? SENDING_DIGITS[index] : start === 153 ? SENDING_MARKS[index] : `<${SENDING_SIGNALS[index]}>`;
    known = start === 9 ? SENDING_LETTERS.slice(0, index + 3) : start === 113 ? SENDING_LETTERS + SENDING_DIGITS.slice(0, index + 1) : SENDING_LETTERS + SENDING_DIGITS + (start === 153 ? SENDING_MARKS.slice(0, index + 1) : SENDING_MARKS);
    const familiar = [...known].filter(c => c !== focus).slice(-3);
    const join = (a, b) => start === 173 ? `${a} ${b}` : a + b;
    const pairWith = others => others.flatMap(c => [join(focus, c), join(c, focus)]);
    guided = phase === 0 || phase === 2;
    required = phase < 2 ? 6 : 4;
    focusCopies = phase === 1 ? 4 : 0;
    if (phase === 0) {
      title = `Send ${focus}`;
      instruction = `Practise ${focus} on its own. Send six clean singles before adding other characters.`;
      items = [focus];
    } else if (phase === 1) {
      title = `${focus} · single-character review`;
      instruction = `One character per answer: four clean sends of ${focus}, then review two earlier characters. No pairs yet.`;
      items = [focus, ...familiar.slice(-2)];
    } else if (phase === 2) {
      title = `${focus} · pairs with E and T`;
      instruction = `Combine ${focus} with E or T. Two characters per answer; the pattern is shown.`;
      items = pairWith(['E', 'T']);
    } else {
      title = `${focus} · familiar pairs`;
      instruction = `Send pairs containing ${focus} and an earlier character. No three-character groups in this introduction.`;
      items = pairWith(familiar);
    }
    if (start === 173) instruction += ` Send ${focus} as one joined pattern. ${PROSIGNS[SENDING_SIGNALS[index]].meaning}.`;
    items = items.map(t => exercise(t));
  } else if (level <= 206) {
    const entry = messages[level - 197];
    [title, , instruction] = entry;
    items = entry[1].map(t => exercise(t));
    known = SENDING_LETTERS + SENDING_DIGITS + SENDING_MARKS;
  } else {
    [title, instruction, items] = replies[level - 207];
    known = SENDING_LETTERS + SENDING_DIGITS + SENDING_MARKS;
    kind = 'reply';
  }
  if (kind === 'reply' && items.length > 1) required = items.length;
  return {
    level, chapter: chapter.name, title, instruction, items, focus, known, kind, guided, required,
    window: Math.max(5, required + 2), focusCopies,
    distinct: kind === 'reply' ? items.length : Math.min(3, new Set(items.map(i => i.target)).size),
    tolerance: level <= 8 ? 0.5 : level <= 112 ? 0.4 : 0.3,
    qualityGoal: level <= 8 ? 65 : level <= 112 ? 70 : 75,
    pattern: focus ? patternFor(focus.replace(/[<>]/g, '')) : '',
  };
}

export function sendingExercise(sending, previous = '', random = Math.random) {
  const stage = sendingStage(sending.level);
  const record = sending.records[String(stage.level)];
  if (stage.kind === 'reply') return stage.items[(record?.turn || 0) % stage.items.length];
  if (stage.focusCopies && (record?.focusHistory || []).slice(-stage.window).filter(Boolean).length < stage.focusCopies) return stage.items.find(item => item.target === stage.focus);
  const uncovered = stage.items.filter(item => !(record?.covered || []).includes(item.target));
  const pool = uncovered.length ? uncovered : stage.items;
  const choices = pool.filter(item => item.target !== previous);
  const selected = choices.length ? choices : pool;
  return selected[Math.min(selected.length - 1, Math.max(0, Math.floor(random() * selected.length)))];
}
