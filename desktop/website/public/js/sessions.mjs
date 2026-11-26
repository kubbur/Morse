export const SESSION_GAP_MS = 120_000;
export const SESSION_HISTORY_LIMIT = 100;
const count = (value, max = 1e9) => Number.isSafeInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);

// Each device owns its current fragment. Merging by stable ID is idempotent;
// overlapping fragments from paired devices form one listening session below.
export function sanitizeSessions(input) {
  const records = new Map();
  for (const row of Array.isArray(input) ? input.slice(-SESSION_HISTORY_LIMIT * 2) : []) {
    if (!row || !validId(row.id) || !timestamp(row.start) || !timestamp(row.end) || row.end < row.start || !count(row.answers)) continue;
    const next = { id: row.id, start: row.start, end: row.end, answers: count(row.answers), correct: count(row.correct, count(row.answers)), clean: count(row.clean, count(row.correct, count(row.answers))), xp: count(row.xp) };
    const prior = records.get(next.id);
    if (prior) {
      next.start = Math.min(prior.start, next.start);
      for (const key of ['end', 'answers', 'correct', 'clean', 'xp']) next[key] = Math.max(prior[key], next[key]);
    }
    records.set(next.id, next);
  }
  return [...records.values()].sort((a, b) => a.end - b.end || a.id.localeCompare(b.id)).slice(-SESSION_HISTORY_LIMIT);
}

export function mergeSessions(left, right) {
  return sanitizeSessions([...sanitizeSessions(left), ...sanitizeSessions(right)]);
}

export function listeningSessions(records) {
  return groupSessions(sanitizeSessions(records));
}

function groupSessions(records) {
  const sessions = [];
  for (const row of records.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = sessions.at(-1);
    if (last && row.start - last.end <= SESSION_GAP_MS) {
      last.end = Math.max(last.end, row.end);
      for (const key of ['answers', 'correct', 'clean', 'xp']) last[key] = Math.min(1e9, last[key] + row[key]);
    } else sessions.push({ ...row });
  }
  return sessions.map(row => ({ ...row, duration: row.end - row.start }));
}

// Only the recording UI appends to its current fragment. Paired devices
// create separate fragments, which can be merged by ID and grouped by time.
// Keep membership only for attempts still present in the short result log.
export function mergeSendingSessions(left, right, results) {
  const fragments = mergeSessions(left?.fragments, right?.fragments);
  if (!fragments.length) return undefined;
  const ids = new Set(fragments.map(row => row.id));
  const recorded = {};
  for (const { id } of results) {
    const fragment = right?.recorded?.[id] ?? left?.recorded?.[id];
    if (ids.has(fragment)) recorded[id] = fragment;
  }
  return { fragments, recorded };
}

export function recordSendingSession(sending, result, previousId) {
  const history = sending.sessionHistory ??= { fragments: [], recorded: {} };
  let row = history.fragments.find(s => s.id === previousId);
  if (!row || result.at < row.end || result.at - row.end > SESSION_GAP_MS) {
    row = { id: result.id, start: result.at, end: result.at, answers: 0, correct: 0, clean: 0, xp: 0 };
    history.fragments.push(row);
  }
  row.end = result.at;
  row.answers++;
  if (result.xp > 0) { row.correct++; row.clean++; }
  row.xp += result.xp;
  history.recorded[result.id] = row.id;
  sending.sessionHistory = mergeSendingSessions(history, null, sending.results);
  return row.id;
}

export function practiceSessions(profile) {
  const listening = listeningSessions(profile.stats.sessions).map(s => ({ ...s, activity: 'Listen' }));
  const history = profile.sending.sessionHistory;
  const earlier = new Map();
  for (const row of profile.sending.results) {
    if (!validId(row.id) || !timestamp(row.at) || history?.recorded[row.id]) continue;
    const clean = Number(row.xp > 0); // Only an unassisted pass earns sending XP.
    earlier.set(row.id, { start: row.at, end: row.at, answers: 1, correct: clean, clean, xp: row.xp });
  }
  const combined = groupSessions([...earlier.values(), ...(history?.fragments || [])]).map(s => ({ ...s, activity: 'Send' }));
  // The oldest retained result can fall in the middle of a long session.
  if (combined.length && profile.sending.attempts > combined.reduce((n, s) => n + s.answers, 0)) combined[0].partial = true;
  return [...listening, ...combined].sort((a, b) => b.end - a.end || b.start - a.start);
}

export function sessionsFromRounds(rounds) {
  const records = [];
  for (const row of [...rounds].filter(r => timestamp(r.at)).sort((a, b) => a.at - b.at)) {
    let session = records.at(-1);
    if (!session || row.at - session.end > SESSION_GAP_MS) {
      session = { id: `legacy-${row.at}`, start: row.at, end: row.at, answers: 0, correct: 0, clean: 0, xp: 0 };
      records.push(session);
    }
    session.end = row.at;
    session.answers++;
    session.correct += Number(row.solved);
    session.clean += Number(row.clean);
  }
  return sanitizeSessions(records);
}

export function recordSessionAnswer(profile, { correct, clean = false, xp = 0, at = Date.now() }) {
  const round = profile.round;
  if (!round || round.attempts <= (round.sessionAttempts || 0) || !timestamp(at)) return false;
  profile.stats.sessions = sanitizeSessions(profile.stats.sessions);
  let row = profile.stats.sessions.find(entry => entry.id === profile.sessionId);
  if (!row || at < row.end || at - row.end > SESSION_GAP_MS) {
    row = { id: globalThis.crypto?.randomUUID?.() || `session-${at}-${Math.random().toString(36).slice(2)}`, start: at, end: at, answers: 0, correct: 0, clean: 0, xp: 0 };
    profile.sessionId = row.id;
    profile.stats.sessions.push(row);
  }
  row.end = at;
  row.answers = Math.min(1e9, row.answers + 1);
  if (correct) row.correct = Math.min(1e9, row.correct + 1);
  if (correct && clean) row.clean = Math.min(1e9, row.clean + 1);
  row.xp = Math.min(1e9, row.xp + count(xp, 220));
  round.sessionAttempts = round.attempts;
  profile.stats.sessions = sanitizeSessions(profile.stats.sessions);
  return true;
}

export function sessionDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
}
