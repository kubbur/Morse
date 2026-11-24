import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { syncProfile, mergeProgress } from '../public/js/sync-data.mjs';
import { sanitizeCallsign, dayStreak, resetSendingProgress } from '../public/js/progress.mjs';

export class SyncError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new SyncError(status, message); };
const hash = token => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Device' : 'Device';
const cookieName = config => config.mode === 'production' ? '__Host-morse_sync' : 'morse_sync_dev';
export function credential(req, config) {
  const values = (req.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${cookieName(config)}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(cookieName(config).length + 1);
  return validToken(token) ? token : null;
}
export function syncCookie(config, token = '') {
  return `${cookieName(config)}=${token}; Path=/; Max-Age=${token ? 31536000 : 0}; HttpOnly; SameSite=Strict${config.mode === 'production' ? '; Secure' : ''}`;
}

export class SyncStore {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      PRAGMA max_page_count=65536; PRAGMA journal_size_limit=8388608;
      CREATE TABLE IF NOT EXISTS saves (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, revision INTEGER NOT NULL, profile TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, save_id TEXT NOT NULL REFERENCES saves(id), token TEXT UNIQUE NOT NULL, label TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, claimant TEXT REFERENCES devices(id) ON DELETE CASCADE, expires INTEGER NOT NULL, code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leaderboard (save_id TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE, callsign TEXT UNIQUE NOT NULL, xp INTEGER NOT NULL, updated INTEGER NOT NULL, days TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS erasures (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS epochs (save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE, old_epoch TEXT PRIMARY KEY, new_epoch TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS devices_save ON devices(save_id);`);
    // Keep existing stations and their rank when upgrading an older database.
    // Store bounded listening dates, rather than a streak that goes stale when
    // a station stops uploading. Dates never leave the leaderboard API.
    if (!this.all('PRAGMA table_info(leaderboard)').some(column => column.name === 'days')) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE leaderboard ADD COLUMN days TEXT NOT NULL DEFAULT '{}'");
        for (const row of this.db.prepare('SELECT leaderboard.save_id, saves.profile FROM leaderboard JOIN saves ON saves.id = leaderboard.save_id').iterate()) {
          const days = syncProfile(JSON.parse(row.profile)).stats.days;
          this.run('UPDATE leaderboard SET days = ? WHERE save_id = ?', JSON.stringify(days), row.save_id);
        }
      });
    }
  }
  close() { this.db.close(); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  device(token) { return validToken(token) ? this.get('SELECT * FROM devices WHERE token = ?', hash(token)) : null; }
  save(device) { return this.get('SELECT * FROM saves WHERE id = ?', device.save_id); }
  courseResetScope(saveId, from, to) {
    let scope = 'send';
    for (let i = 0; i < 100; i++) {
      const step = this.get('SELECT * FROM epochs WHERE save_id = ? AND old_epoch = ?', saveId, from);
      if (!step || !['reset', 'reset-send'].includes(step.reason)) return null;
      if (step.reason === 'reset') scope = 'all';
      if (step.new_epoch === to) return scope;
      from = step.new_epoch;
    }
    return null;
  }
  listing(saveId, profile, { explicit = false } = {}) {
    if (!profile.leaderboard || !profile.callsign) { this.run('DELETE FROM leaderboard WHERE save_id = ?', saveId); return; }
    const existing = this.get('SELECT save_id FROM leaderboard WHERE callsign = ?', profile.callsign);
    if (existing && existing.save_id !== saveId) {
      if (explicit) fail(409, 'That callsign is already on the leaderboard. Choose another or keep your score private.');
      profile.leaderboard = false;
      this.run('DELETE FROM leaderboard WHERE save_id = ?', saveId);
      return;
    }
    this.run('INSERT INTO leaderboard (save_id, callsign, xp, updated, days) VALUES (?, ?, ?, ?, ?) ON CONFLICT(save_id) DO UPDATE SET callsign = excluded.callsign, xp = excluded.xp, days = excluded.days, updated = CASE WHEN leaderboard.xp != excluded.xp THEN excluded.updated ELSE leaderboard.updated END', saveId, profile.callsign, profile.stats.xp, this.now(), JSON.stringify(profile.stats.days));
  }
  snapshot(device) {
    const save = this.save(device);
    const result = { connected: true, epoch: save.epoch, revision: save.revision, profile: JSON.parse(save.profile), seq: device.seq,
      devices: this.all('SELECT id, label FROM devices WHERE save_id = ? ORDER BY updated, id', device.save_id).map(d => ({ ...d, current: d.id === device.id })) };
    // Every successful write carries the same invitation state as a poll, so
    // saving a callsign or practice cannot hide a still-valid QR/approval card.
    const outgoing = this.get('SELECT * FROM invites WHERE owner = ?', device.id);
    const incoming = this.get('SELECT code, expires FROM invites WHERE claimant = ?', device.id);
    if (outgoing) {
      const claim = outgoing.claimant ? this.get('SELECT * FROM devices WHERE id = ?', outgoing.claimant) : null;
      result.invite = { expiresAt: outgoing.expires, ...(claim ? { claim: claim.id, label: claim.label, xp: JSON.parse(this.save(claim).profile).stats.xp, code: outgoing.code } : {}) };
    }
    if (incoming) result.waiting = { code: incoming.code, expiresAt: incoming.expires };
    return result;
  }
  ensure(token, profile, name) {
    const existing = this.device(token);
    if (existing) return { device: existing, token };
    if (this.get('SELECT count(*) AS n FROM saves').n >= 1000) fail(503, 'Device pairing is full. Your progress is still saved in this browser.');
    const id = randomUUID(), deviceId = randomUUID(), nextToken = secret(), now = this.now();
    this.run('INSERT INTO saves VALUES (?, ?, 1, ?, ?)', id, randomUUID(), JSON.stringify(syncProfile(profile)), now);
    this.run('INSERT INTO devices VALUES (?, ?, ?, ?, 0, ?)', deviceId, id, hash(nextToken), label(name), now);
    return { device: this.device(nextToken), token: nextToken };
  }
  prune() { this.run('DELETE FROM invites WHERE expires <= ?', this.now()); this.run('DELETE FROM erasures WHERE expires <= ?', this.now()); }
  request(action, token, body) {
    return this.transaction(() => {
      this.prune();
      let device = this.device(token);
      if (!device && validToken(token) && this.get('SELECT token FROM erasures WHERE token = ?', hash(token))) return { connected: false, erased: true, setToken: '' };
      if (action === 'leaderboard') {
        const now = new Date(this.now());
        const publicEntry = row => ({ callsign: row.callsign, xp: row.xp, streak: dayStreak({ days: JSON.parse(row.days) }, now) });
        const rows = this.all('SELECT callsign, xp, days FROM leaderboard ORDER BY xp DESC, updated ASC, callsign ASC LIMIT 50');
        let me = null;
        if (device) {
          const entry = this.get('SELECT * FROM leaderboard WHERE save_id = ?', device.save_id);
          if (entry) me = { ...publicEntry(entry), rank: this.get('SELECT count(*) + 1 AS rank FROM leaderboard WHERE xp > ? OR (xp = ? AND (updated < ? OR (updated = ? AND callsign < ?)))', entry.xp, entry.xp, entry.updated, entry.updated, entry.callsign).rank };
        }
        return { entries: rows.map((r, index) => ({ rank: index + 1, ...publicEntry(r) })), me };
      }
      if (action === 'identity') {
        const callsign = sanitizeCallsign(body.callsign);
        if (body.callsign && !callsign) fail(400, 'Use 2–16 letters, numbers or / for your callsign.');
        if (body.listed && !callsign) fail(400, 'Add your callsign to join the leaderboard.');
        const ensured = this.ensure(token, body.profile, body.label);
        device = ensured.device;
        const profile = JSON.parse(this.save(device).profile);
        Object.assign(profile, { callsign, leaderboard: body.listed === true });
        this.listing(device.save_id, profile, { explicit: true });
        this.run('UPDATE saves SET profile = ?, revision = revision + 1, updated = ? WHERE id = ?', JSON.stringify(profile), this.now(), device.save_id);
        return { ...this.snapshot(device), setToken: ensured.token };
      }
      if (action === 'status') {
        if (!device) return { connected: false };
        return this.snapshot(device);
      }
      if (action === 'start') {
        const ensured = this.ensure(token, body.profile, body.label);
        device = ensured.device;
        if (this.all('SELECT id FROM devices WHERE save_id = ?', device.save_id).length >= 8) fail(409, 'Disconnect a device before adding another.');
        this.run('DELETE FROM invites WHERE owner = ? OR claimant = ?', device.id, device.id);
        const invitation = secret(), expiresAt = this.now() + 300000;
        this.run('INSERT INTO invites VALUES (?, ?, NULL, ?, ?)', hash(invitation), device.id, expiresAt, String(randomBytes(4).readUInt32BE() % 1000000).padStart(6, '0'));
        return { ...this.snapshot(device), invitation, expiresAt, invite: { expiresAt }, setToken: ensured.token };
      }
      if (action === 'join') {
        if (!validToken(body.invitation)) fail(404, 'That pairing link has expired or was already used.');
        const invite = this.get('SELECT * FROM invites WHERE token = ?', hash(body.invitation));
        if (!invite || invite.claimant) fail(404, 'That pairing link has expired or was already used.');
        const owner = this.get('SELECT * FROM devices WHERE id = ?', invite.owner);
        if (device?.save_id === owner.save_id) fail(409, 'These devices are already connected.');
        if (device && this.all('SELECT id FROM devices WHERE save_id = ?', device.save_id).length > 1) fail(409, 'Disconnect this device from its current pair first.');
        const ensured = this.ensure(token, body.profile, body.label);
        device = ensured.device;
        // A returning unpaired browser may have practiced since its last sync.
        this.run('UPDATE saves SET profile = ?, updated = ? WHERE id = ?', JSON.stringify(syncProfile(body.profile)), this.now(), device.save_id);
        this.run('DELETE FROM invites WHERE claimant = ? OR owner = ?', device.id, device.id);
        this.run('UPDATE invites SET claimant = ? WHERE token = ?', device.id, hash(body.invitation));
        return { ...this.snapshot(device), waiting: { code: invite.code, expiresAt: invite.expires }, setToken: ensured.token };
      }
      if (!device && action === 'erase') return { connected: false, erased: true, setToken: '' };
      if (!device) fail(401, 'This browser is no longer paired. Your local progress is safe.');
      if (action === 'approve') {
        const invite = this.get('SELECT * FROM invites WHERE owner = ? AND claimant = ?', device.id, body.claim);
        if (!invite) fail(409, 'That pairing request is no longer available.');
        const joining = this.get('SELECT * FROM devices WHERE id = ?', invite.claimant);
        if (this.all('SELECT id FROM devices WHERE save_id = ?', joining.save_id).length !== 1) fail(409, 'That device is already paired elsewhere.');
        const left = this.save(device), right = this.save(joining);
        const a = JSON.parse(left.profile), b = JSON.parse(right.profile);
        // XP selects one complete save, never the manually selected level.
        // A tie keeps the device showing the QR code. Approval is atomic.
        const winner = b.stats.xp > a.stats.xp ? b : a;
        this.run('UPDATE saves SET profile = ?, epoch = ?, revision = revision + 1, updated = ? WHERE id = ?', JSON.stringify(winner), randomUUID(), this.now(), left.id);
        this.run('UPDATE devices SET save_id = ? WHERE save_id = ?', left.id, right.id);
        this.run('DELETE FROM invites WHERE owner IN (SELECT id FROM devices WHERE save_id = ?) OR claimant IN (SELECT id FROM devices WHERE save_id = ?)', left.id, left.id);
        this.run('DELETE FROM saves WHERE id = ?', right.id);
        this.listing(left.id, winner);
        this.run('UPDATE saves SET profile = ? WHERE id = ?', JSON.stringify(winner), left.id);
        return { ...this.snapshot(device), paired: true, selectedXp: winner.stats.xp };
      }
      if (action === 'cancel') {
        this.run('DELETE FROM invites WHERE owner = ? OR claimant = ?', device.id, device.id);
        return this.snapshot(device);
      }
      if (action === 'disconnect') {
        const target = body.device || device.id;
        const other = this.get('SELECT id FROM devices WHERE id = ? AND save_id = ?', target, device.save_id);
        if (!other) fail(404, 'Device not found.');
        this.run('DELETE FROM devices WHERE id = ?', target);
        if (!this.get('SELECT id FROM devices WHERE save_id = ?', device.save_id)) this.run('DELETE FROM saves WHERE id = ?', device.save_id);
        return target === device.id ? { connected: false, setToken: '' } : this.snapshot(device);
      }
      if (action === 'erase') {
        for (const entry of this.all('SELECT token FROM devices WHERE save_id = ?', device.save_id)) this.run('INSERT OR REPLACE INTO erasures VALUES (?, ?)', entry.token, this.now() + 366 * 86400000);
        this.run('DELETE FROM devices WHERE save_id = ?', device.save_id);
        this.run('DELETE FROM saves WHERE id = ?', device.save_id);
        return { connected: false, erased: true, setToken: '' };
      }
      if (action !== 'push') fail(404, 'Unknown sync action.');
      const save = this.save(device);
      if (!Number.isSafeInteger(body.seq) || body.seq < 1) fail(400, 'Invalid sync sequence.');
      if (body.epoch !== save.epoch) {
        // A course restart clears levels, not lifetime score. Keep new offline
        // listening credit across resets, but never reintroduce old level marks.
        const scope = this.courseResetScope(save.id, body.epoch, save.epoch);
        if (body.seq === device.seq + 1 && !body.replace && scope) {
          const remote = syncProfile(JSON.parse(save.profile)), merged = mergeProgress(body.base, body.profile, remote);
          const updated = scope === 'send' ? merged : { ...remote, stats: { ...merged.stats, mastery: remote.stats.mastery }, review: merged.review };
          updated.sending = { ...merged.sending, level: remote.sending.level, pendingLevel: remote.sending.pendingLevel, records: remote.sending.records, settings: remote.sending.settings };
          this.listing(save.id, updated);
          this.run('UPDATE saves SET profile = ?, revision = revision + 1, updated = ? WHERE id = ?', JSON.stringify(updated), this.now(), save.id);
          this.run('UPDATE devices SET seq = ?, updated = ? WHERE id = ?', body.seq, this.now(), device.id);
          device = this.device(token);
        }
        return { ...this.snapshot(device), conflict: true };
      }
      if (body.seq <= device.seq) return this.snapshot(device); // committed response was lost
      if (body.seq !== device.seq + 1) fail(409, 'Sync sequence changed. Reopen this page.');
      const current = syncProfile(body.profile);
      const sendReset = body.replace === true && body.reason === 'reset-send';
      const updated = sendReset ? resetSendingProgress(mergeProgress(body.base, current, JSON.parse(save.profile))) : body.replace === true ? current : mergeProgress(body.base, current, JSON.parse(save.profile));
      this.listing(save.id, updated);
      const epoch = body.replace === true ? randomUUID() : save.epoch;
      if (body.replace === true) this.run('INSERT INTO epochs VALUES (?, ?, ?, ?)', save.id, save.epoch, epoch, sendReset ? 'reset-send' : body.reason === 'reset' ? 'reset' : 'import');
      this.run('UPDATE saves SET profile = ?, epoch = ?, revision = revision + 1, updated = ? WHERE id = ?', JSON.stringify(updated), epoch, this.now(), save.id);
      this.run('UPDATE devices SET seq = ?, updated = ? WHERE id = ?', body.seq, this.now(), device.id);
      device = this.device(token);
      return this.snapshot(device);
    });
  }
}
