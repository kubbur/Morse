import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export async function macInstaller(resources) {
  const path = join(resources, 'MorseUpdater.node');
  try { await access(path); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  return createRequire(import.meta.url)(path);
}

export class UpdateManager {
  constructor({version, installedNotes, enabled, automatic, storeAutomatic, lookup, installer, changed}) {
    Object.assign(this, {version, installedNotes, enabled, storeAutomatic, lookup, installer, changed});
    this.release = null;
    this.phase = 'idle';
    this.message = '';
    this.automatic = false;
    this.installRequested = false;
    if (enabled && installer) {
      try {
        installer.configure(!!automatic);
        this.automatic = !!automatic;
      } catch {
        this.installer = null;
        this.message = 'Use the GitHub download to update this copy of Morse.';
      }
    }
  }
  state() {
    return {version:this.version, installedNotes:this.installedNotes, enabled:this.enabled,
      automatic:this.automatic, automaticSupported:!!this.installer && this.enabled,
      available:this.release?.version || '', notes:this.release?.notes || '',
      installable:!!this.installer && !!this.release?.archive && !!this.release?.feedAvailable, phase:this.phase, message:this.message};
  }
  show(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.changed(this.state());
  }
  async check() {
    if (!this.enabled || this.phase === 'checking') return;
    this.show('checking');
    try {
      this.release = await this.lookup();
      this.show('checked');
    } catch {
      this.show('error', 'Couldn’t reach GitHub. You can keep practising and check again later.');
    }
  }
  setAutomatic(value) {
    if (!this.enabled || !this.installer || typeof value !== 'boolean' || value === this.automatic) return;
    try {
      this.installer.configure(value);
      try { this.storeAutomatic(value); }
      catch (error) { this.installer.configure(this.automatic); throw error; }
      this.automatic = value;
      this.show('idle');
    } catch { this.show('error','Could not save the automatic update setting.'); }
  }
  async install(save) {
    if (!this.state().installable) return;
    if (!await save()) { this.saveFailed(); return; }
    try { this.installer.install(); this.installRequested = true; }
    catch { this.show('error','Could not open the update. You can download it from the release on GitHub.'); }
  }
  saveFailed() {
    this.show('error','Progress could not be saved. Export it from Saved progress before restarting.');
  }
}
