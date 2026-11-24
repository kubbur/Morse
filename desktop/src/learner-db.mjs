import { DatabaseSync } from 'node:sqlite';
import { parseProgressJson } from '../website/public/js/import-validation.mjs';
import { sanitizeState } from '../website/public/js/progress.mjs';

const validate = raw => {
  const data = parseProgressJson(raw, { maxBytes: 64000000, maxNodes: 6000000 });
  sanitizeState(data);
  return data;
};
export class LearnerDB {
  constructor(path) {
    this.db = new DatabaseSync(path, { allowExtension: false });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS learner(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS originals(id TEXT PRIMARY KEY, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS update_preference(id INTEGER PRIMARY KEY CHECK(id=1), automatic INTEGER NOT NULL CHECK(automatic IN (0,1)));`);
  }
  get automaticUpdates() { return this.db.prepare('SELECT automatic FROM update_preference WHERE id=1').get()?.automatic === 1; }
  set automaticUpdates(value) {
    this.db.prepare('INSERT INTO update_preference VALUES(1,?) ON CONFLICT(id) DO UPDATE SET automatic=excluded.automatic').run(value ? 1 : 0);
  }
  load(legacy) {
    const existing = this.db.prepare('SELECT revision,raw FROM learner WHERE id=1').get();
    if (existing) { validate(existing.raw); return existing; }
    if (!legacy) return { revision: 0, raw: null };
    // Keep even a damaged original. Opening it must never create an empty replacement.
    this.db.prepare('INSERT OR IGNORE INTO originals VALUES (?,?)').run('desktop-v1', legacy);
    validate(legacy);
    this.save(legacy, 0);
    return { revision: 1, raw: legacy };
  }
  save(raw, revision) {
    validate(raw);
    const changed = revision === 0 ? this.db.prepare('INSERT OR IGNORE INTO learner VALUES (1,1,?)').run(raw)
      : this.db.prepare('UPDATE learner SET revision=revision+1,raw=? WHERE id=1 AND revision=?').run(raw, revision);
    if (changed.changes !== 1) throw new Error('A newer save already exists. Reopen Morse before editing.');
    return revision + 1;
  }
  close() { this.db.close(); }
}
