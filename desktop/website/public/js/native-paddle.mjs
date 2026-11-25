import { nativeSound } from './shared-sound.mjs';

// A watermark comes from an idle audio render block. Renderer timers cannot
// finish an answer while its final edge is still buffered in the native pipe.
export class NativeElements {
  constructor({ edge, idle, interrupt }) {
    Object.assign(this, { edge, idle, interrupt });
    this.reset();
  }
  reset() { this.epoch = null; this.seq = null; this.frame = -1; this.rate = null; this.down = false; this.neutral = false; }
  receive(row) {
    if (row.type === 'reset') { this.reset(); this.interrupt(); return; }
    if (row.type !== 'element') return;
    if (!Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.epoch) || !Number.isSafeInteger(row.frame) || row.frame < 0 ||
        ![0,1,2].includes(row.kind) || !Number.isFinite(row.rate) || row.rate < 8000 || row.rate > 384000) {
      this.reset(); this.interrupt(); return;
    }
    if (this.epoch !== null && (this.epoch !== row.epoch || this.seq + 1 !== row.seq || this.rate !== row.rate || row.frame < this.frame)) {
      this.reset(); this.interrupt();
    }
    Object.assign(this, { epoch: row.epoch, seq: row.seq, frame: row.frame, rate: row.rate });
    const at = row.frame * 1000 / row.rate;
    if (row.kind === 0) {
      if (this.down) { this.reset(); this.interrupt(); return; }
      this.neutral = true; this.idle(at); return;
    }
    if (!this.neutral) return;
    if ((row.kind === 1) === this.down) { this.reset(); this.interrupt(); return; }
    this.down = row.kind === 1;
    this.edge({ down: this.down, at });
  }
}

export class BuiltInPaddle {
  constructor(api, ui) {
    this.api = api; this.ui = ui; ui.migrationPending = true; this.wanted = true; this.connected = false; this.configGeneration = 0;
    this.input = null;
    this.stream = new NativeElements({
      interrupt: () => this.interrupt(),
      edge: edge => {
        if (!this.active || !this.connected || !this.configured || this.status?.typing || this.ui.migrationPending) return;
        const eligible = ui.usable() && document.hasFocus() && !ui.listenHeld;
        if (this.command || !eligible || !ui.heard || ui.result?.valid || ui.getProfile().sending.pendingLevel) {
          // A held paddle can generate many dits. Only a single complete dit
          // followed by a neutral watermark is a playback command.
          if (!this.command) this.command = { start: edge.at, single: eligible && edge.down, dit: false };
          else if (edge.down || !eligible) this.command.single = false;
          else this.command.dit = edge.at - this.command.start < 2 * 1200 / ui.settings.wpm;
          return;
        }
        ui.edge(edge);
      },
      idle: at => {
        const command = this.command;
        this.command = null;
        if (!this.active || !this.connected || !this.configured || ui.migrationPending || this.status?.typing || !ui.usable() || !document.hasFocus()) return;
        if (command) {
          if (command.single && command.dit && (!ui.heard || ui.result?.valid || ui.getProfile().sending.pendingLevel)) ui.playPrompt();
          return;
        }
        if (ui.down || !ui.edges.length || ui.result) return;
        if (at - ui.originAt - ui.edges.at(-1).at >= ui.idleDelay()) ui.finish();
      },
    });
    api.onPaddle(row => {
      if (row.type === 'status') {
        if (row.source && row.source !== this.input) return;
        const ready = this.input !== 'off' && row.phase === 'ready' && row.outputReady && !row.typing;
        if (ready !== this.connected) {
          this.key = null; this.configGeneration++;
          this.configured = false;
        }
        ui.sidetone.setAvailable(this.input !== 'off' && !!row.output);
        if (!ready && this.connected) { this.resetStream(); this.interrupt(true); }
        this.status = row; this.connected = ready;
        if (row.output) this.resolveMigration(row);
        ui.connectionStatus = ready ? 'ready' : 'waiting';
        ui.connectionMessage = row.typing ? 'External typing is on. Turn it off in Settings to use the paddle here.' : row.detail;
        ui.renderInput();
      } else {
        if (row.type === 'reset' && row.epoch == null) {
          this.connected = false;
          this.configured = false;
          this.key = null; this.configGeneration++;
          ui.sidetone.setAvailable(false);
          this.resetStream(); this.interrupt(true);
          return;
        }
        if (row.type === 'reset') this.stream.receive(row);
        else if (this.active && this.connected && this.configured && row.session === this.status?.session && row.epoch === this.status?.epoch) {
          if (Number.isSafeInteger(row.seq) && row.seq <= this.captureAfter) return;
          this.stream.receive(row);
        }
      }
    });
    this.selectInput(ui.source);
    void api.paddle('status');
  }
  selectInput(source) {
    const input = ['paddle','vband'].includes(source) ? source : 'off';
    if (this.input === input) return;
    this.input = input;
    this.connected = false;
    this.configured = false;
    this.key = null;
    this.configGeneration++;
    this.status = null;
    this.resetStream();
    this.ui.sidetone.setAvailable(false);
    void this.api.paddle('input', input);
  }
  get acceptsVBand() {
    return this.input === 'vband' && this.active && this.connected && this.configured && !this.ui.migrationPending;
  }
  vbandContacts(mask) {
    if (!this.acceptsVBand) return;
    const { epoch, session } = this.status;
    this.api.paddle('vband', { mask, epoch, session }).then(reply => {
      if (reply?.error && this.acceptsVBand && this.status.epoch === epoch && this.status.session === session) {
        void this.api.paddle('vband-release');
        this.resetStream(); this.interrupt();
      }
    });
  }
  resetStream() {
    this.command = null;
    this.stream.reset();
  }
  interrupt(outputLost = false) {
    this.command = null;
    // A new keyer clock invalidates input. A prompt already playing in Web Audio
    // can finish normally when only the keyer settings changed.
    if (!this.active || (this.ui.playing && !outputLost)) return;
    this.ui.pauseInput('Paddle input was interrupted. Send the answer again.');
  }
  resolveMigration(row) {
    const ui = this.ui, settings = ui.getProfile().sending.settings;
    if (row.hasReverse && settings.reverse !== !!row.reverse) {
      settings.reverse = !!row.reverse; ui.persist();
      document.getElementById('send-reverse').checked = settings.reverse;
    } else if (!row.hasReverse && settings.reverse && !this.restoreReverse) {
      this.restoreReverse = true;
      void this.api.paddle('reverse', true).finally(() => { this.restoreReverse = false; });
    }
    ui.migrationPending = ui.soundChoice(row);
    if (!ui.migrationPending) this.configure(ui.settings);
  }
  configure(settings, resume = false) {
    if (this.ui.migrationPending || !this.status) return;
    const value = nativeSound(settings);
    const key = JSON.stringify(value);
    if (this.key === key && !resume) return;
    const applied = this.key === key && this.configured;
    this.key = key; this.configured = false; this.resetStream();
    const generation = ++this.configGeneration;
    // Both replies include the last event flushed by the helper. A delayed
    // background mark or an old-speed mark cannot start the next answer.
    const request = applied ? this.api.paddle('capture-position') : this.api.paddle('sound', value);
    request.then(reply => {
      if (this.configGeneration !== generation) return;
      this.configured = !reply?.error && Number.isSafeInteger(reply?.sequence) && reply.sequence >= 0;
      if (this.configured) this.captureAfter = reply.sequence;
      else this.key = null;
    });
  }
  setActive(active) {
    if (this.active === active) return;
    this.active = active; this.resetStream();
    if (!active && this.input === 'vband') void this.api.paddle('vband-release');
    if (active && this.connected) this.configure(this.ui.settings, true);
    else this.ui.sidetone.release();
  }
  disconnect() { this.setActive(false); }
}

export class NativeSidetone {
  constructor(api, onState) {
    this.api = api; this.onState = onState; this.supported = true;
    this.confirmed = null; this.available = false; this.generation = 0;
  }
  setAvailable(available) {
    if (this.available === available) return;
    this.available = available;
    this.generation++;
    this.desired = null; this.confirmed = null;
  }
  setMuted(value) {
    if (!this.available) return Promise.resolve(false);
    if (value === this.desired) return this.pending;
    this.desired = value;
    const generation = ++this.generation;
    this.pending = this.api.paddle('mute', value).then(reply => {
      if (this.generation !== generation) return false;
      this.confirmed = reply?.error ? null : value;
      this.onState(reply?.error ? 'error' : value ? 'muted' : 'sending');
      if (reply?.error) this.desired = null;
      return !reply?.error;
    });
    return this.pending;
  }
  release() { return this.setMuted(false); }
}
