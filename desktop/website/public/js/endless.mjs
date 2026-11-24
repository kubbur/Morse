import { COURSE_LEVELS, legacyCourseLevel, courseStage } from './course.mjs';
import { normalizeText } from './morse.mjs';

const integer = (value, maximum, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback;
export const emptyEndless = () => ({ unlocked: false, rank: 1, xp: 0, earned: 0, contacts: 0, seed: 17321, step: 0, solved: 0, missionRank: 1, formatVersion: 2, finished: false });
export const rankGoal = rank => 100 + Math.floor(Math.sqrt(Math.max(0, rank - 1)) * 25);
export const isEndless = settings => settings.lesson === 'starter' && settings.content === 'groups' && settings.track === 'endless';
const finalCourseKey = `course:${legacyCourseLevel(COURSE_LEVELS)}`;

export function courseCompleted(stats = {}) {
  return Object.entries(stats.mastery || {}).some(([key, value]) => {
    try { const parts = JSON.parse(key); return value.mastered === true && parts[3] === finalCourseKey; }
    catch { return false; }
  });
}

export function sanitizeEndless(input, stats = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rank = Math.max(1, integer(source.rank, 1e9, 1));
  const step = integer(source.step, 4);
  return {
    unlocked: courseCompleted(stats), rank, xp: Math.min(rankGoal(rank) - 1, integer(source.xp, 1e9)), earned: integer(source.earned, 1e9), contacts: integer(source.contacts, 1e9),
    seed: integer(source.seed, 0xffffffff, 17321), step, solved: integer(source.solved, step + 1), missionRank: Math.max(1, integer(source.missionRank, rank, rank)),
    formatVersion: source.formatVersion === 2 || !Object.keys(source).length ? 2 : 1, finished: source.finished === true,
  };
}

const pick = (values, n) => values[n % values.length];
export function radioMission(endless) {
  const seed = endless.seed >>> 0;
  const rank = endless.missionRank || endless.rank;
  const prefixes = ['TF3', 'K1', 'W4', 'G4', 'DL1', 'JA2', 'VK3', 'VE7'];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const call = pick(prefixes, seed) + letters[(seed >>> 3) % 26] + letters[(seed >>> 8) % 26] + (rank > 8 && seed % 3 === 0 ? '/P' : '');
  const name = pick(['ANNA', 'SAM', 'JOHN', 'NINA', 'LEO', 'ELI', 'SARA', 'BEN'], seed >>> 4);
  const place = pick(['OSLO', 'LONDON', 'ROME', 'TOKYO', 'BERLIN', 'REYKJAVIK', 'PARIS', 'DUBLIN'], seed >>> 7);
  const report = pick(['599', '579', '559', '589', '569', '459'], seed >>> 11);
  const power = pick(['5', '10', '25', '50', '75', '100'], seed >>> 15);
  const weather = pick(['SUNNY', 'RAIN', 'CLDY', 'WINDY'], seed >>> 18);
  const details = rank >= 15 ? `RIG ${power} W BT WX ${weather} BT QTH ${place} BK` : `PWR ${power} W BT WX ${weather} BK`;
  let tasks = [
    { label: 'Incoming call', text: `CQ CQ DE ${call} K` },
    { label: 'Copy your signal report', text: `UR RST ${report} BK` },
    { label: 'Meet the operator', text: `NAME ${name} BT QTH ${place} KN` },
    { label: 'Copy the station details', text: details },
    { label: 'Finish the contact', text: rank >= 8 ? `${call} TNX FER QSO TU 73 SK` : 'TU TNX FER QSO 73 SK' },
  ];
  if (endless.formatVersion === 2) {
    // Start at the course's twelve-character ceiling, adding two characters
    // every three ranks. Choose complete alternatives rather than cutting words.
    const limit = Math.min(40, 12 + Math.floor((rank - 1) / 3) * 2);
    const fitting = choices => choices.find(text => text.replaceAll(' ', '').length <= limit);
    tasks = [
      { label: 'Incoming call', text: fitting([`CQ CQ DE ${call} K`, `CQ DE ${call} K`, `DE ${call}`]) },
      { label: 'Copy your signal report', text: `UR RST ${report} BK` },
      { label: 'Meet the operator', text: fitting([`NAME ${name} BT QTH ${place} KN`, `NAME ${name} QTH ${place}`, `NAME ${name} KN`]) },
      { label: 'Copy the station details', text: fitting([details, `PWR ${power} W BT QTH ${place} BK`, `PWR ${power} W BK`]) },
      { label: 'Finish the contact', text: fitting([`${call} TNX FER QSO TU 73 SK`, 'TU TNX FER QSO 73 SK', 'TNX QSO TU 73 SK', 'TU TNX 73 SK']) },
    ];
  }
  return { call, tasks, ...tasks[endless.step], number: endless.step + 1, total: tasks.length };
}

export function validRadioTarget(endless, target) {
  return normalizeText(target) === radioMission(endless).text;
}

export function awardRadio(endless, points, solved) {
  if (endless.finished) return false;
  endless.finished = true;
  const previous = endless.rank;
  if (solved) endless.solved = Math.min(endless.step + 1, endless.solved + 1);
  if (endless.step === 4 && endless.solved === 5) endless.contacts = Math.min(1e9, endless.contacts + 1);
  endless.xp += Math.max(0, Math.min(220, points));
  endless.earned = Math.min(1e9, (endless.earned || 0) + Math.max(0, Math.min(220, points)));
  while (endless.xp >= rankGoal(endless.rank) && endless.rank < 1e9) {
    endless.xp -= rankGoal(endless.rank);
    endless.rank++;
  }
  return endless.rank > previous;
}

export function nextRadioStep(endless) {
  endless.finished = false;
  if (endless.step < 4) endless.step++;
  else {
    endless.seed = (Math.imul(endless.seed, 1664525) + 1013904223) >>> 0;
    endless.step = 0;
    endless.solved = 0;
    endless.missionRank = endless.rank;
    endless.formatVersion = 2;
  }
}

export const radioSounds = () => courseStage(COURSE_LEVELS).prosigns;
