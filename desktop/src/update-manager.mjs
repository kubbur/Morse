export class UpdateManager {
  constructor({ version, installedNotes, enabled, automatic, storeAutomatic, lookup, download, stage, changed }) {
    Object.assign(this, { version, installedNotes, enabled, automatic, storeAutomatic, lookup, download, stage, changed });
    this.release = null;
    this.ready = false;
    this.phase = 'idle';
    this.message = '';
  }

  state() {
    return { version: this.version, installedNotes: this.installedNotes, enabled: this.enabled,
      automatic: this.automatic, available: this.release?.version || '', notes: this.release?.notes || '',
      installable: !!this.release?.archive && this.enabled, ready: this.ready, phase: this.phase, message: this.message };
  }

  show(phase, message = '') {
    this.phase = phase; this.message = message;
    this.changed(this.state());
  }

  async check() {
    if (!this.enabled || this.checking || this.transfer || this.phase === 'installing') return;
    this.checking = true;
    this.show('checking');
    try {
      const result = await this.lookup();
      if (!result || result.version !== this.release?.version || result.archive?.digest !== this.release?.archive?.digest)
        this.ready = false;
      this.release = result;
      this.show('checked');
    } catch {
      this.show('error', 'Couldn’t reach GitHub. You can keep practising and check again later.');
      return;
    } finally { this.checking = false; }
    if (this.automatic) await this.prepareDownload();
  }

  setAutomatic(value) {
    if (typeof value !== 'boolean' || !this.enabled || this.phase === 'installing') return;
    this.storeAutomatic(value);
    this.automatic = value;
    this.changed(this.state());
    if (!value && this.transfer?.automaticOnly) this.transfer.abort();
    if (value && !this.checking) {
      if (this.release) void this.prepareDownload();
      else void this.check();
    }
  }

  async prepareDownload(manual = false) {
    if (!this.enabled || !this.release?.archive || this.ready || this.checking || this.phase === 'installing') return;
    if (this.transfer) {
      if (manual) this.transfer.automaticOnly = false;
      return;
    }
    const transfer = new AbortController();
    transfer.automaticOnly = !manual;
    this.transfer = transfer;
    this.show('downloading');
    try {
      await this.download(this.release, AbortSignal.any([transfer.signal, AbortSignal.timeout(180000)]));
      this.ready = !transfer.signal.aborted;
      this.show('checked');
    } catch {
      if (transfer.signal.aborted) this.show('checked');
      else this.show('error', 'The update download could not be verified. Try again or open the release on GitHub.');
    } finally { this.transfer = null; }
    if (transfer.signal.aborted && this.automatic) await this.prepareDownload();
  }

  wantsInstall(restart) {
    return this.enabled && this.ready && !this.checking && !this.transfer && this.phase !== 'installing' && (restart || this.automatic);
  }

  async installAtQuit(restart, save) {
    if (!this.wantsInstall(restart) || this.phase === 'installing') return false;
    this.show('installing');
    try {
      if (!await save()) {
        this.show('error', 'Progress could not be saved. Export it from Saved progress before restarting.');
        return false;
      }
      await this.stage(this.release);
      return true;
    } catch {
      this.show('error', 'macOS could not prepare this update. See the release on GitHub for the Mac download.');
      return false;
    }
  }
}
