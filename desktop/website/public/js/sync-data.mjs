import { sanitizeState } from './progress.mjs';
import { rankGoal } from './endless.mjs';
import { sanitizePacing } from './recognition.mjs';
import { emptyFocus } from './focus-level.mjs';
import { mergeSessions } from './sessions.mjs';
import { recentReview, REVIEW_WINDOW } from './review.mjs';
import { mergeSending } from './sending.mjs';

export const MAX_SYNC_BYTES = 1_000_000;
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (...objects) => [...new Set(objects.flatMap(o => Object.keys(o || {})))];
const plus = (base = 0, local = 0, remote = 0) => Math.min(1e9, remote + Math.max(0, local - base));
const unique = (a = [], b = [], limit = 1000) => [...new Set([...a, ...b])].slice(-limit);

// Exactly one sanitized learner, never credentials, other learners, or a live
// round. Playback, drafts, volume and typing calibration belong to each device.
export function syncProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.settings || !input.stats) throw new Error('Invalid saved progress.');
  const profile = sanitizeState({ version: 1, activeId: input.id, profiles: [input] }).profiles[0];
  profile.round = null;
  profile.focus = emptyFocus();
  profile.listening.active = null;
  profile.listening.cooldown = 0;
  profile.sessionId = '';
  profile.id = 'paired-listener';
  profile.name = 'Listener';
  profile.settings.volume = 55;
  profile.pacing = sanitizePacing();
  profile.headPacing = sanitizePacing();
  for (const record of Object.values(profile.stats.mastery)) {
    record.samples ??= record.recognition.length;
    record.characterSamples ||= {};
    for (const [c, values] of Object.entries(record.characterRecognition)) record.characterSamples[c] ??= values.length;
  }
  if (new TextEncoder().encode(JSON.stringify(profile)).byteLength > MAX_SYNC_BYTES) throw new Error('This save is too large to sync. Export a backup.');
  return profile;
}

export function syncChanged(base, local) {
  return !same(base, local);
}

// A three-way merge applies only work performed since this device's acknowledged
// snapshot. Requests carry a persistent sequence number, so retrying a lost
// response cannot apply this delta twice. Resets/imports use a separate epoch.
export function mergeProgress(baseInput, localInput, remoteInput) {
  const base = syncProfile(baseInput), local = syncProfile(localInput), remote = syncProfile(remoteInput);
  const result = clone(remote);
  result.sending = mergeSending(base.sending, local.sending, remote.sending);
  for (const key of ['callsign', 'leaderboard']) if (!same(base[key], local[key])) result[key] = local[key];
  for (const key of keys(base.settings, local.settings)) {
    if (!same(base.settings[key], local.settings[key])) result.settings[key] = local.settings[key];
  }
  for (const key of ['xp', 'total', 'solved', 'clean', 'focusCompletions']) result.stats[key] = plus(base.stats[key], local.stats[key], remote.stats[key]);
  result.stats.sessions = mergeSessions(remote.stats.sessions, local.stats.sessions);
  result.stats.badges = unique(remote.stats.badges, local.stats.badges, 100);
  for (const id of keys(local.listening.records, remote.listening.records)) {
    const l = local.listening.records[id], r = remote.listening.records[id];
    result.listening.records[id] = { letters: Math.max(l?.letters || 0, r?.letters || 0), passed: l?.passed === true || r?.passed === true, covered: unique(r?.covered, l?.covered, 50) };
  }
  for (const key of ['cleanStreak', 'lastSalute']) if (!same(base.stats[key], local.stats[key])) result.stats[key] = local.stats[key];
  result.stats.bestStreak = Math.max(local.stats.bestStreak, remote.stats.bestStreak);
  for (const day of keys(base.stats.days, local.stats.days)) result.stats.days[day] = plus(base.stats.days[day], local.stats.days[day], remote.stats.days[day]);
  for (const c of keys(base.stats.characters, local.stats.characters)) {
    const b = base.stats.characters[c] || {}, l = local.stats.characters[c] || {}, r = remote.stats.characters[c] || {};
    result.stats.characters[c] = { seen: plus(b.seen, l.seen, r.seen), correct: plus(b.correct, l.correct, r.correct) };
  }
  for (const mode of ['flexible', 'head']) {
    const b = base.stats.modes[mode], l = local.stats.modes[mode], r = remote.stats.modes[mode];
    result.stats.modes[mode] = { total: plus(b.total, l.total, r.total), clean: plus(b.clean, l.clean, r.clean), quick: plus(b.quick, l.quick, r.quick), best: Math.max(l.best, r.best) };
  }
  // Round histories are a bounded display, while lifetime counters above remain
  // additive. Comparing multiplicities retains legitimate same-millisecond rounds.
  const counts = new Map();
  for (const entry of base.stats.rounds) { const key = JSON.stringify(entry); counts.set(key, (counts.get(key) || 0) + 1); }
  const added = local.stats.rounds.filter(entry => {
    const key = JSON.stringify(entry), count = counts.get(key) || 0;
    if (count) { counts.set(key, count - 1); return false; }
    return true;
  });
  result.stats.rounds = [...remote.stats.rounds, ...added].sort((a, b) => a.at - b.at).slice(-300);
  for (const key of keys(base.stats.mastery, local.stats.mastery)) {
    const b = base.stats.mastery[key] || {}, l = local.stats.mastery[key];
    if (!l) continue;
    const r = result.stats.mastery[key] ||= { unit: 'letters', samples: 0, history: [], recognition: [], characterRecognition: {}, characterSamples: {} };
    const n = Math.max(0, (l.samples || 0) - (b.samples || 0));
    if (n) {
      r.history = [...r.history, ...l.history.slice(-n)].slice(-20);
      r.recognition = [...r.recognition, ...l.recognition.slice(-n)].slice(-20);
    }
    r.samples = plus(b.samples, l.samples, r.samples);
    r.mastered ||= l.mastered;
    r.cleanPrompts = unique(r.cleanPrompts, l.cleanPrompts, 5);
    r.characterRecognition ||= {};
    r.characterSamples ||= {};
    for (const c of keys(b.characterRecognition, l.characterRecognition)) {
      const n = Math.max(0, (l.characterSamples?.[c] || 0) - (b.characterSamples?.[c] || 0));
      if (n) r.characterRecognition[c] = [...(r.characterRecognition[c] || []), ...(l.characterRecognition[c] || []).slice(-n)].slice(-5);
      r.characterSamples[c] = plus(b.characterSamples?.[c], l.characterSamples?.[c], r.characterSamples[c]);
    }
  }
  result.review.copies = plus(base.review.copies, local.review.copies, remote.review.copies);
  for (const c of keys(base.review.sounds, local.review.sounds)) {
    const b = base.review.sounds[c] || {}, l = local.review.sounds[c];
    if (!l || same(b, l)) continue;
    const r = remote.review.sounds[c] || {};
    const next = result.review.sounds[c] = { ...l };
    const observations = Math.max(0, l.seen - (b.seen || 0));
    if (r.recent || l.recent) {
      const recent = [...recentReview(r, c), ...(observations ? recentReview(l, c).slice(-observations) : [])].slice(-REVIEW_WINDOW);
      next.recent = recent.map(row => row.correct);
      next.recentConfusions = recent.map(row => row.other);
    }
    for (const key of ['seen', 'correct', 'lapses']) next[key] = plus(b[key], l[key], r[key]);
    if ([b, l, r].some(entry => Object.hasOwn(entry, 'earAccuracy'))) next.earAccuracy = Math.max(0, Math.min(100, (r.earAccuracy || 0) + (l.earAccuracy || 0) - (b.earAccuracy || 0)));
    if ((r.lastAt || 0) > l.lastAt) for (const key of ['lastAt', 'dueAt', 'streak', 'earWins']) next[key] = r[key];
    next.dueCopy = result.review.copies + Math.max(0, l.dueCopy - local.review.copies);
    next.confusions = { ...r.confusions };
    for (const other of keys(b.confusions, l.confusions)) next.confusions[other] = plus(b.confusions?.[other], l.confusions?.[other], r.confusions?.[other]);
  }
  result.guidance.welcomed ||= local.guidance.welcomed;
  result.guidance.seen = unique(remote.guidance.seen, local.guidance.seen);
  for (const key of ['alphabet', 'previewed']) result.guidance[key] = unique([...remote.guidance[key]], [...local.guidance[key]], 50).join('');
  result.guidance.prosigns = unique(remote.guidance.prosigns, local.guidance.prosigns, 6);
  if (!same(base.guidance.rehearsal, local.guidance.rehearsal)) result.guidance.rehearsal = clone(local.guidance.rehearsal);
  // Radio XP has its own cumulative counter: rank rollover does not lose an
  // offline device's credit. Continue the most recently used mission cursor.
  const points = Math.max(0, local.endless.earned - base.endless.earned);
  if (!same(base.endless, local.endless)) {
    if (same(base.endless, remote.endless)) result.endless = clone(local.endless);
    else {
      const radio = result.endless;
      radio.earned = plus(base.endless.earned, local.endless.earned, remote.endless.earned);
      radio.contacts = plus(base.endless.contacts, local.endless.contacts, remote.endless.contacts);
      radio.xp += points;
      while (radio.xp >= rankGoal(radio.rank) && radio.rank < 1e9) { radio.xp -= rankGoal(radio.rank); radio.rank++; }
      if (local.endless.rank > remote.endless.rank) Object.assign(radio, { seed: local.endless.seed, step: local.endless.step, solved: local.endless.solved, missionRank: local.endless.missionRank, formatVersion: local.endless.formatVersion, finished: local.endless.finished });
    }
  }
  return syncProfile(result);
}
