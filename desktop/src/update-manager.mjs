import { access } from 'node:fs/promises';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isChannel } from './updates.mjs';

// Each installed app remembers which releases its operator was browsing.
export function channelPreference(directory) {
  const file = join(directory, 'download-channel');
  return {
    read(fallback) {
      try {
        const value = readFileSync(file, 'utf8').trim();
        return isChannel(value) ? value : fallback;
      } catch { return fallback; }
    },
    write(value) {
      if (!isChannel(value)) throw Error('Unknown update channel');
      mkdirSync(directory, {recursive:true, mode:0o700});
      const pending = file + '.' + randomUUID();
      writeFileSync(pending, value + '\n', {mode:0o600, flag:'wx'});
      renameSync(pending, file);
    },
  };
}

export async function macInstaller(resources) {
  const path = join(resources, 'MorseUpdater.node');
  try { await access(path); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  return createRequire(import.meta.url)(path);
}

export class UpdateManager {
  constructor({version, installedNotes, enabled, automatic, storeAutomatic, channel = 'stable', storeChannel, lookup, installer, changed}) {
    Object.assign(this, {version, installedNotes, enabled, storeAutomatic, channel, storeChannel, lookup, installer, changed});
    this.buildChannel = version.includes('-dev.') ? 'dev' : 'stable';
    this.generation = 0;
    this.release = null;
    this.phase = 'idle';
    this.message = '';
    this.automatic = false;
    this.installRequested = false;
    if (enabled && installer) {
      try {
        this.configure(!!automatic);
        this.automatic = !!automatic;
      } catch {
        this.installer = null;
        this.message = 'Use the GitHub download to update this copy of Morse.';
      }
    }
  }
  state() {
    return {version:this.version, installedNotes:this.installedNotes, enabled:this.enabled, channel:this.channel,
      automatic:this.automatic, automaticSupported:!!this.installer && this.enabled,
      available:this.release?.version || '', notes:this.release?.notes || '',
      manualSwitch:!!this.release?.manualSwitch,
      installable:!!this.installer && this.channel === this.buildChannel && !!this.release?.archive && !!this.release?.feedAvailable && !this.release.manualSwitch, phase:this.phase, message:this.message};
  }
  show(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.changed(this.state());
  }
  async check() {
    if (!this.enabled || this.phase === 'checking') return;
    const request = ++this.generation;
    this.show('checking');
    try {
      const channel = this.channel;
      const [release, devUpdate] = await Promise.all([this.lookup(channel),
        this.buildChannel === 'dev' && channel !== 'dev' ? this.lookup('dev').catch(() => this.ownRelease) : null]);
      if (request !== this.generation) return;
      const ownRelease = channel === this.buildChannel ? release : devUpdate;
      if (this.buildChannel === 'dev' && ownRelease?.version !== this.ownRelease?.version) this.configure(this.automatic, ownRelease);
      this.ownRelease = ownRelease;
      this.release = release;
      this.show('checked');
    } catch {
      if (request !== this.generation) return;
      this.show('error', 'Couldn’t reach GitHub. You can keep practising and check again later.');
    }
  }
  configure(automatic, release = this.ownRelease) {
    this.installer?.configure(automatic, this.buildChannel, this.buildChannel === 'dev' && release ? release.version : '');
  }
  async setChannel(value) {
    if (!this.enabled || !isChannel(value) || value === this.channel) return false;
    try { this.storeChannel(value); }
    catch {
      this.show('error','Could not save the update channel on this Mac.');
      return false;
    }
    this.channel = value;
    this.generation++;
    this.release = null;
    this.show('idle');
    const expected = this.generation + 1;
    await this.check();
    return this.generation === expected && this.phase === 'checked';
  }
  setAutomatic(value) {
    if (!this.enabled || !this.installer || typeof value !== 'boolean' || value === this.automatic) return;
    try {
      this.configure(value);
      try { this.storeAutomatic(value); }
      catch (error) { this.configure(this.automatic); throw error; }
      this.automatic = value;
      this.show('idle');
    } catch { this.show('error','Could not save the automatic update setting.'); }
  }
  async install(save) {
    if (!this.state().installable) return;
    const release = this.release;
    if (!await save()) { this.saveFailed(); return; }
    if (this.release !== release || !this.state().installable) return;
    try { this.installer.install(); this.installRequested = true; }
    catch { this.show('error','Could not open the update. You can download it from the release on GitHub.'); }
  }
  saveFailed() {
    this.show('error','Progress could not be saved. Export it from Saved progress before restarting.');
  }
}
