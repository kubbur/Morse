import { newProfile } from './progress.mjs';
import { syncProfile, mergeProgress, legacyXP, creditTotal } from './sync-data.mjs';

// Legacy exports lack result IDs. Preserve each original separately. The
// common part of each lifetime counter can only be bounded, not attributed.
function overlap(left, right) {
  if (typeof left === 'number') return Math.min(left, typeof right === 'number' ? right : 0);
  if (Array.isArray(left)) return [];
  if (left && typeof left === 'object') return Object.fromEntries(Object.keys(left).map(k => [k, overlap(left[k],right?.[k])]));
  return left;
}
export function initialMerge(a, b) {
  a = syncProfile(a); b = syncProfile(b);
  const base = overlap(b, a);
  base.sending.records = {}; // derive each distinct record below
  base.stats.rounds = a.stats.rounds;
  base.credits={};
  base.stats.xp=Math.min(legacyXP(a),legacyXP(b));
  const result = mergeProgress(base, b, a);
  result.stats.xp=Math.min(1e9,Math.max(legacyXP(a),legacyXP(b))+creditTotal(result.credits));
  for (const [id, row] of Object.entries(b.sending.records)) {
    const previous = a.sending.records[id];
    if (previous) {
      const merged = result.sending.records[id];
      merged.attempts = Math.max(previous.attempts,row.attempts);
      merged.good = Math.max(previous.good,row.good);
      merged.mastered = previous.mastered || row.mastered;
    }
  }
  const byId = new Map();
  for (const round of [...a.stats.rounds, ...b.stats.rounds]) byId.set(round.id || JSON.stringify(round),round);
  result.stats.rounds = [...byId.values()].sort((x,y)=>x.at-y.at).slice(-300);
  result.settings = { ...(a.stats.total || a.stats.xp ? a.settings : b.settings),
    courseLevel: Math.max(a.settings.courseLevel,b.settings.courseLevel) };
  result.sending.level = Math.max(a.sending.level,b.sending.level);
  result.endless.rank = Math.max(a.endless.rank,b.endless.rank);
  return syncProfile(result);
}
export function pairedProgress(left, right, leftFoundation, rightFoundation) {
  const empty = syncProfile(newProfile());
  const l = leftFoundation || left, r = rightFoundation || right;
  const foundation = initialMerge(l || empty,r || empty);
  const withLeft = mergeProgress(l,left,foundation);
  return { foundation, profile: mergeProgress(r,right,withLeft) };
}
