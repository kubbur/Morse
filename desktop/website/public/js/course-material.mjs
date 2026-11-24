// Numbered lessons use deliberately chosen, whole radio fragments. A length
// limit must not turn a message into unrelated words or duplicate lessons.
const unique = values => [...new Set(values)];

export const introductoryRadio = [
  ['Common CW shorthand', ['R', 'TU', 'TNX', 'PSE', 'AGN', 'DE', 'GM', 'GL'], 'Learn the short forms used in CW contacts.'],
  ['Common Q codes', ['QTH', 'QRS', 'QRM', 'QRN', 'QSB', 'QSL', 'QSO', 'QRZ'], 'Recognise a Q code as a short group.'],
  ['Short two-word calls', ['CQ CQ', 'CQ DX', 'VY FB', 'R R', 'GL ES'], 'Keep the word gap. Each answer has at most four letters.'],
  ['Names and places', ['ANNA', 'SAM', 'JOHN', 'NINA', 'LEO', 'ELI', 'OSLO', 'ROME', 'LIMA', 'YORK'], 'Copy one short name or place. Full name and location messages come after the by-ear course.'],
  ['Operating words', ['WX', 'RAIN', 'CLDY', 'RPT', 'CPY', 'SIG', 'SRI', 'WX OK'], 'Learn short weather and copying terms.'],
  ['Short sign-offs', ['TU', 'TNX', 'TKS', 'CUL', 'GL', 'VY TU', 'TU GL', 'GL ES'], 'Copy short closing words before combining them into messages later.'],
  ['Short radio review', ['R', 'TU', 'TNX', 'PSE', 'AGN', 'DE', 'GM', 'GL', 'QTH', 'QRS', 'QRZ', 'CQ CQ', 'CQ DX', 'ANNA', 'JOHN', 'OSLO', 'RAIN', 'WX OK', 'CUL', 'VY TU'], 'Review shorthand, Q codes, names and short word groups.'],
];

export const numericApplications = [
  ['Number pairs', ['50', '19', '28', '37', '46', '01', '73', '59', '88', '10'], 'Copy two digits together.'],
  ['Number groups', ['501', '928', '374', '6501', '1928', '3746', '001', '123', '987'], 'Build from three digits to four.'],
  ['Signal reports', ['599', '579', '559', '589', '569', '459'], 'Copy the three digits of an RST report.'],
  ['Acknowledging reports', ['R 599', 'R 579', 'R 559', 'R 589', 'R 569', 'R 459'], 'R means received. Copy the acknowledgement and report, keeping the space.'],
  ['Short sign-offs with numbers', ['73', 'TU 73', 'VY 73', 'GL 73', 'TNX', 'TU'], '73 means best regards. Combine it with a short closing.'],
  ['Power fragments', ['5 W', '10 W', '25 W', '50 W', '75 W', '100 W', 'PWR 5', 'PWR 1'], 'Copy a short power fragment. W means watts.'],
  ['Four-digit frequencies', ['7010', '7020', '7030', '7040', '3530', '3540'], 'Copy four digits. Full frequency commands come after the by-ear course.'],
  ['Short callsigns', ['W1AW', 'K1A', 'W2B', 'G4CW', 'N0C', 'TF3A', 'K7AA', 'M0CW'], 'Copy the whole station identifier without spaces.'],
];

// Three applications follow each new mark's single-character introduction.
export const punctuationApplications = [
  [
    ['Question endings', ['?', 'E?', 'T?', 'A?', 'N?'], 'Hear the question mark after one familiar letter.'],
    ['Short radio questions', ['QRL?', 'AGN?', 'QRZ?', 'QTH?'], 'Copy a short question, including its final question mark.'],
    ['Question mark review', ['?', 'QRL?', 'AGN?', 'QRZ?', 'QTH?', 'TU', '73', 'R 5'], 'Review questions alongside earlier short copies.'],
  ],
  [
    ['Portable and mobile suffixes', ['/', '/P', '/M'], 'Learn the slash and two common callsign suffixes.'],
    ['Low-power suffix', ['/P', '/M', '/QRP'], 'Distinguish portable, mobile and low-power suffixes. These are suffix fragments, not complete callsigns.'],
    ['Questions and slash review', ['/', '/P', '/M', '/QRP', '?', 'QRL?', 'AGN?', 'QRZ?'], 'Review both punctuation sounds learned so far.'],
  ],
  [
    ['Short decimals', ['0.5', '1.5', '2.5'], 'Copy a decimal point between digits.'],
    ['Four-character decimals', ['7.03', '7.04', '3.53', '3.54', '10.1', '14.0'], 'Keep the decimal point in the right place.'],
    ['Questions, slash and decimal review', ['2.5', '7.03', '10.1', '/P', '/M', 'QRL?', 'AGN?'], 'Review all three punctuation sounds.'],
  ],
  [
    ['Short comma endings', ['E,', 'T,', '5,', '0,', 'R,'], 'Hear the comma after one letter or digit.'],
    ['Names and reports with commas', ['SAM,', 'LEO,', '599,', '579,', '73,'], 'Copy a short name or report followed by a comma.'],
    ['Four-mark review', ['SAM,', '599,', '2.5', '7.03', '/P', '/M', 'QRL?', 'AGN?'], 'Review question mark, slash, decimal point and comma.'],
  ],
  [
    ['Short ranges', ['1-2', '2-3', '3-4', '5-9'], 'Copy the hyphen between two digits.'],
    ['Longer ranges', ['1-5', '2-5', '5-10', '1-10'], 'Copy a range containing one- and two-digit numbers.'],
    ['All punctuation review', ['5-10', '1-10', 'SAM,', '599,', '2.5', '7.03', '/P', 'QRL?', 'AGN?'], 'Review all five punctuation sounds before learning procedural signals.'],
  ],
];

export function signalApplication(signs, phase) {
  const focus = signs.at(-1), earlier = signs.slice(0, -1);
  if (phase === 0) return { label: `${focus} · joined signal`, pool: [focus], minCopies: 0, objective: `Hear <${focus}> as one continuous signal.` };
  if (phase === 1) return {
    label: `${focus} · short copies`, pool: [`R ${focus}`, `TU ${focus}`, `${focus} R`, `${focus} E`],
    objective: `Copy <${focus}> with one short word. The procedural signal is sent joined.`,
  };
  if (phase === 2) return {
    label: `${focus} · signal contrasts`,
    pool: earlier.length ? unique([focus, ...earlier, ...earlier.flatMap(sign => [`${focus} ${sign}`, `${sign} ${focus}`])]) : [focus, focus.split('').join(' '), `${focus} E`, `E ${focus}`],
    objective: earlier.length ? `Distinguish <${focus}> from earlier procedural signals.` : `Compare joined <${focus}> with ${focus.split('').join(' ')} sent separately. Keep the spaces when copying separate letters.`,
  };
  return {
    label: `${focus} · cumulative review`,
    pool: unique([...signs, `R ${focus}`, `TU ${focus}`, `${focus} R`, 'QRL?', '/P', '2.5', '5,', '1-5']),
    requiredSounds: [...signs],
    objective: `Review every procedural signal learned so far, with earlier punctuation. Copy each signal correctly at least once.`,
  };
}

// 28 distinct steps bridge recognition and radio messages. Length grows across
// the section instead of remaining at four characters until its last levels.
export const radioPath = [
  ['Number combinations', ['50', '19', '28', '37', '46', '501', '928', '374', '650', '987'], 'Review two- and three-digit groups by ear.'],
  ['Letters and digits in pairs', ['A1', '1A', 'N0', '0N', 'K7', '7K', 'T5', '5T', 'W2', '2W'], 'Switch between letters and digits without adding answer length.'],
  ['Mixed three-character groups', ['A5N', 'T0E', 'K1A', 'W2B', 'N0C', '5ET', 'R7S', 'Q3M'], 'Keep three mixed characters in order.'],
  ['Punctuation in short copies', ['QRL?', '/P', '2.5', '5,', '1-5', 'AGN?', '7.03', '/M'], 'Review all five punctuation sounds in short fragments.'],
  ['Three-character callsigns', ['K1A', 'W2B', 'N0C', 'K7A', 'G4A', 'M0A'], 'Copy a short station identifier as one group.'],
  ['Four-character callsigns', ['TF3A', 'W1AW', 'G4CW', 'DL1A', 'JA1A', 'K7AA'], 'Add one character to the station identifier.'],
  ['Calling fragments', ['CQ CQ', 'CQ DX', 'CQ DE', 'QRZ?', 'QRL?'], 'Recognise the fragments used to call or check a frequency.'],
  ['Acknowledging a report', ['R 599', 'R 579', 'R 559', 'R 589', 'R 569', 'R 459'], 'Copy an acknowledgement followed by a three-digit report.'],
  ['Short operator names', ['ANNA', 'JOHN', 'NINA', 'SAM', 'LEO', 'ELI'], 'Recognise one short name before adding the NAME prefix.'],
  ['Short locations', ['OSLO', 'ROME', 'LIMA', 'YORK', 'BERN', 'LEON'], 'Recognise one short location before adding the QTH prefix.'],
  ['Callsigns with suffixes', ['K1A/P', 'W2B/M', 'N0C/P', 'G4A/P', 'K7A/M'], 'Copy the callsign and its portable or mobile suffix together.'],
  ['Procedural signal phrases', ['TU AS', '73 SK', 'R BT', 'TU AR', 'PSE AS', 'TNX AR'], 'Copy a short phrase ending in a joined procedural signal.'],
  ['Two- and three-word CW phrases', ['PSE AGN', 'PSE QRS', 'TNX QSO', 'GL ES DX', 'VY FB', 'TU ES GL'], 'Combine familiar short forms into phrases of up to six letters.'],
  ['RST report groups', ['RST 599', 'RST 579', 'RST 559', 'RST 589', 'RST 569', 'RST 459'], 'Add RST before the report. Keep the word gap.'],
  ['Longer callsigns', ['TF3CW', 'K1ABC', 'G4ABC', 'DL1ABC', 'JA1ABC', 'VK2ABC'], 'Build station identifiers from five to six characters.'],
  ['Frequency commands', ['QSY 7030', 'QRV 7040', 'QRG 3530', 'QSY 3540', 'QRG 7010', 'QRV 7020'], 'Combine a three-letter command with four frequency digits.'],
  ['Name messages', ['NAME SAM', 'NAME LEO', 'NAME ELI', 'NAME ANNA', 'NAME JOHN', 'NAME NINA'], 'Add NAME to the names practised earlier.'],
  ['Location messages', ['QTH OSLO', 'QTH ROME', 'QTH LIMA', 'QTH YORK', 'QTH TOKYO', 'QTH PARIS'], 'Add QTH to a location, then try a five-letter location.'],
  ['Power and weather messages', ['PWR 5 W', 'PWR 10 W', 'PWR 100 W', 'WX RAIN', 'WX CLDY', 'WX SUNNY', 'WX WINDY', 'PWR 25 W'], 'Copy one complete power or weather statement.'],
  ['Closing phrases', ['TNX QSO', 'TU ES GL', 'TU 73 SK', 'GL ES DX', 'HPE CUAGN', 'VY TNX', 'CUL 73'], 'Copy a closing phrase before adding a longer sign-off.'],
  ['Opening a call', ['CQ DE W1AW', 'CQ DE TF3A', 'DE K1A K', 'DE W2B K', 'CQ CQ DE', 'CQ DE G4CW'], 'Combine the calling words and station identifier.'],
  ['Serial numbers and reports', ['NR 001', 'UR NR 002', 'UR RST 599', 'UR RST 579', 'R R RST 559', 'NR 123 BK'], 'Keep the prefix, number and any final signal in order.'],
  ['Full name and location statements', ['NAME IS ANNA', 'NAME IS JOHN', 'NAME IS SAM', 'QTH IS OSLO', 'QTH IS ROME', 'QTH IS LIMA'], 'Add the linking word IS to a familiar name or location message.'],
  ['Longer sign-offs', ['TNX FER QSO', 'TKS FER CALL', 'TU ES GL 73', 'HPE CUAGN 73', 'TU TNX 73 SK', '73 ES GL SK'], 'Build a complete sign-off from familiar short forms.'],
  ['Two-station exchanges', ['W1AW DE K1A', 'K1A DE W1AW', 'TF3A DE G4CW', 'G4CW DE TF3A', 'W1AW DE K7AA', 'K7AA DE W1AW'], 'Copy both station identifiers with DE between them.'],
  ['Complete short calls', ['CQ CQ DE W1AW', 'CQ CQ DE TF3A', 'W1AW DE K1A K', 'G4CW DE TF3A K', 'CQ CQ DE G4CW', 'TF3A DE K7AA K'], 'Copy a complete opening of up to eleven characters.'],
  ['Short radio exchanges', ['UR RST 599 BK', 'NAME IS ANNA KN', 'QTH IS OSLO BK', 'PWR 10 W BK', 'QSY 7030 AS', 'UR RST 599 QSL?'], 'Finish a short statement with its procedural signal or question.'],
  ['Radio contact finale', ['CQ CQ DE W1AW', 'W1AW DE K1A K', 'UR RST 599 BK', 'NAME IS ANNA', 'QTH IS OSLO', 'PWR 5 W BK', 'QSY 7030 AS', 'TNX QSO TU 73 SK'], 'Review openings, reports, names, locations, commands and sign-offs. Endless radio begins with messages of the same length.'],
];

export const materialMeanings = {
  'CQ CQ': 'Calling any station', 'CQ DX': 'Calling distant stations', 'CQ DE': 'Calling; this is',
  'VY FB': 'Very fine; excellent', 'R R': 'Received; understood', 'GL ES': 'Good luck and…',
  'VY TU': 'Thank you very much', 'TU GL': 'Thank you; good luck', 'WX OK': 'Weather is OK',
  WX: 'Weather', RAIN: 'Rain', CLDY: 'Cloudy', RPT: 'Repeat', CPY: 'Copy', SIG: 'Signal',
  SRI: 'Sorry', TKS: 'Thanks', CUL: 'See you later',
};
