import { MorseAudio } from './audio.mjs';
import { timing, timeline } from './morse.mjs';
import { SENDING_LEVELS, SENDING_CHAPTERS, sendingStage, sendingExercise, sendingTokens } from './sending-course.mjs';
import { decodeSending, gradeSending, sendingMastery, recordSending, advanceSending, sanitizeSendingSettings } from './sending.mjs';
import { PaddleKeyer, PaddleConnection } from './paddle.mjs';
import { PaddleSidetone } from './paddle-control.mjs';
import { ScreenWake } from './screen-wake.mjs';
import { RewardEffects } from './rewards.mjs';

const $ = id => document.getElementById(id);
const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const completed = s => Object.values(s.records).filter(r => r.mastered).length;
const paddleBasics = [
  'Tap the dot contact once to send E. The keyer sets the length; holding the contact repeats dots.',
  'Tap the dash contact once to send T. The keyer makes the dash three times as long as a dot.',
  'Send the shown letter with the dot or dash contact.',
  'Tap the dot contact twice with a character gap between taps. A short gap would join them into I.',
  'Tap the dash contact twice with a character gap between taps.',
  'Change between the contacts. Keep the character gaps even.',
  'Leave a word gap at each space. Word gaps are longer than character gaps.',
];
export const sendingBadges = s => SENDING_CHAPTERS.filter(c => Array.from({ length: c.end - c.start + 1 }, (_, i) => s.records[c.start + i]?.mastered).every(Boolean));

class KeyTone {
  async set(down, settings = {}) {
    this.down = down; clearTimeout(this.idle);
    if (!down) {
      if (this.note) {
        const { oscillator, gain } = this.note, at = this.context.currentTime, fall = settings.fall / 1000 || 0.005;
        gain.gain.cancelScheduledValues(at); gain.gain.setValueAtTime(gain.gain.value, at); gain.gain.linearRampToValueAtTime(0, at + fall);
        oscillator.stop(at + fall + 0.002); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        this.note = null;
      }
      this.idle = setTimeout(() => this.context?.suspend().catch(() => {}), 60000);
      return;
    }
    if (this.note) return;
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return;
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* Optional API. */ }
      this.context ||= new Context({ latencyHint: 'interactive' });
      await this.context.resume();
      if (!this.down || this.note) return;
      const oscillator = this.context.createOscillator(), gain = this.context.createGain(), at = this.context.currentTime;
      oscillator.frequency.value = settings.tone || 600;
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime((settings.volume ?? 55) / 100 * 0.23, at + (settings.rise / 1000 || 0.005));
      oscillator.connect(gain).connect(this.context.destination); oscillator.start(); this.note = { oscillator, gain };
    } catch { /* Input still works if browser audio is unavailable. */ }
  }
  release() { this.set(false); clearTimeout(this.idle); this.context?.suspend().catch(() => {}); }
}

export class SendingUI {
  constructor({ getProfile, persist, active, onEarn = () => {} }) {
    Object.assign(this, { getProfile, persist, active, onEarn });
    this.audio = new MorseAudio(); this.tone = new KeyTone();
    this.edges = []; this.source = 'paddle'; this.contacts = { dit: false, dah: false };
    this.wake = new ScreenWake({ onState: state => { this.wakeState = state; this.renderInput(); } });
    this.sidetone = new PaddleSidetone({ onState: state => { this.muteState = state; this.renderInput(); this.renderExercise(); } });
    this.rewards = new RewardEffects($('send-reward'), $('send-announcement'), $('sender'));
    let wanted = false;
    try { wanted = sessionStorage.getItem('morse.paddle.connection') === '1'; } catch { /* Connection intent still works in memory. */ }
    this.connection = new PaddleConnection({
      enabled: false, wanted,
      onIntent: wanted => { try { if (wanted) sessionStorage.setItem('morse.paddle.connection', '1'); else sessionStorage.removeItem('morse.paddle.connection'); } catch { /* Storage is optional. */ } },
      onContacts: (dit, dah, at) => this.hardware(dit, dah, at),
      onStatus: (status, message) => {
        this.connectionStatus = status;
        this.connectionMessage = message;
        if (status === 'ready' && this.source === 'paddle') { this.updateMute(); this.sidetone.enable(); }
        $('send-connection').textContent = message;
        $('send-connect').textContent = this.connection?.wanted ? 'Disconnect Morse Paddle' : 'Connect Morse Paddle';
        this.renderInput();
      },
      onReset: () => { this.sidetone.release(); this.neutral = false; this.contacts = { dit: false, dah: false }; this.heard = false; this.abort('Paddle connection paused. Your unfinished answer was cleared.'); },
    });
    const select = $('send-level');
    for (const chapter of SENDING_CHAPTERS) {
      const group = make('optgroup'); group.label = chapter.name;
      for (let level = chapter.start; level <= chapter.end; level++) {
        const option = make('option'); option.dataset.title = `${level}. ${sendingStage(level).title}`; option.value = level; group.append(option);
      }
      select.append(group);
    }
    $('send-course-plan').replaceChildren(...SENDING_CHAPTERS.map(c => {
      const row = make('div', 'send-plan-row'); row.append(make('strong', '', `${c.start}–${c.end} · ${c.name}`), make('p', 'muted small-copy', c.description)); return row;
    }));
    select.addEventListener('change', () => this.selectLevel(Number(select.value)));
    $('send-course-count').textContent = `${SENDING_LEVELS}-level course plan`;
    $('send-source').addEventListener('change', () => {
      this.abort(); this.connection.disconnect(); this.source = $('send-source').value; this.render(); this.focusKey();
    });
    $('send-connect').addEventListener('click', () => {
      if (this.connection.wanted) this.connection.disconnect();
      else {
        this.source = 'paddle'; $('send-source').value = 'paddle';
        this.audio.unlock().catch(() => { if (this.active()) $('send-feedback').textContent = 'Tap Hear signal once to enable sound, then use the paddle.'; });
        this.connection.connect();
      }
      this.renderInput();
    });
    for (const id of ['send-wpm', 'send-farnsworth']) $(id).addEventListener('input', () => this.renderSpeed());
    for (const id of ['send-wpm', 'send-farnsworth', 'send-keyer', 'send-reverse']) $(id).addEventListener('change', () => {
      this.abort('Settings changed. Start the answer again.');
      const s = this.getProfile().sending;
      s.settings = sanitizeSendingSettings({ wpm: Number($('send-wpm').value), farnsworth: Number($('send-farnsworth').value), keyer: $('send-keyer').value, reverse: $('send-reverse').checked });
      this.persist(); this.render();
    });
    $('send-listen').addEventListener('click', () => this.listen());
    $('send-help').addEventListener('click', () => { this.revealed = true; if (!this.stage.guided) this.assisted = true; this.renderExercise(); $('send-feedback').textContent = 'Pattern shown. This attempt is practice; use the next exercise for mastery.'; });
    $('send-retry').addEventListener('click', () => { this.abort('Answer cleared. Try again.'); this.focusKey(); });
    $('send-next').addEventListener('click', () => this.getProfile().sending.pendingLevel ? this.continueLevel() : this.next({ autoListen: true }));
    this.bindHold($('send-key'), (down, at) => this.straight(down, at));
    this.bindHold($('send-dit'), down => this.keyboardContact('dit', down));
    this.bindHold($('send-dah'), down => this.keyboardContact('dah', down));
    document.addEventListener('keydown', e => this.key(e, true), true);
    document.addEventListener('keyup', e => this.key(e, false), true);
    window.addEventListener('blur', () => { this.suspended = true; this.abort('Input paused. Try the answer again.'); this.updateMute(); });
    window.addEventListener('focus', () => { this.suspended = false; this.heard = false; this.updateMute(); this.renderExercise(); this.updateActivity(); this.wake.refresh(); });
    document.addEventListener('visibilitychange', () => {
      this.updateActivity();
      if (document.hidden) { this.abort(); this.audio.release(); this.tone.release(); }
      else this.wake.refresh();
    });
    window.addEventListener('pagehide', () => { this.pageHidden = true; this.updateActivity(); this.abort(); this.audio.release(); this.tone.release(); });
    window.addEventListener('pageshow', () => { this.pageHidden = false; this.updateActivity(); this.wake.refresh(); });
  }

  bindHold(button, callback) {
    const held = new Set();
    button.addEventListener('pointerdown', e => {
      if (e.button !== 0 || held.size) return;
      e.preventDefault(); button.focus({ preventScroll: true }); button.setPointerCapture(e.pointerId); held.add(e.pointerId); callback(true, e.timeStamp);
    });
    const release = e => { if (held.delete(e.pointerId)) callback(false, e.timeStamp); };
    button.addEventListener('pointerup', release);
    for (const name of ['pointercancel', 'lostpointercapture']) button.addEventListener(name, e => { if (held.delete(e.pointerId)) this.abort('Touch input paused. Try the answer again.'); });
    button.addEventListener('contextmenu', e => e.preventDefault());
  }

  get stage() { return sendingStage(this.getProfile().sending.level); }
  get settings() { return { ...this.getProfile().settings, ...this.getProfile().sending.settings }; }
  get busy() { return this.down || this.playing || this.edges.length > 0 && !this.result; }
  usable() { return this.active() && !this.suspended && !document.hidden && !document.querySelector('dialog[open]') && !this.playing; }
  inputHeld() { return this.source === 'paddle' ? this.contacts.dit || this.contacts.dah : this.source === 'keyboard' ? this.keyboardContacts?.dit || this.keyboardContacts?.dah : this.straightHeld; }

  render() {
    const s = this.getProfile().sending;
    if (this.owner !== s || this.level !== s.level) {
      this.abort(); this.owner = s; this.level = s.level; this.next({ reset: true });
    }
    const stage = this.stage;
    $('send-chapter').textContent = stage.chapter;
    $('send-stage-title').textContent = stage.title;
    $('send-level-label').textContent = `Sending · level ${s.level}/${SENDING_LEVELS}`;
    $('send-level').value = s.level;
    for (const option of $('send-level').options) {
      const mastered = s.records[option.value]?.mastered === true;
      const text = `${mastered ? '✓ ' : ''}${option.dataset.title}`;
      if (option.textContent !== text) option.textContent = text;
      option.setAttribute('aria-label', `${option.dataset.title}${mastered ? ', completed' : ', not completed'}`);
    }
    $('send-instruction').textContent = this.source !== 'straight' && stage.level <= 7 ? paddleBasics[stage.level - 1] : stage.instruction;
    $('send-wpm').value = s.settings.wpm;
    $('send-farnsworth').max = s.settings.wpm; $('send-farnsworth').value = s.settings.farnsworth;
    $('send-keyer').value = s.settings.keyer; $('send-reverse').checked = s.settings.reverse;
    this.renderSpeed();
    const mastery = sendingMastery(s);
    $('send-progress-copy').textContent = s.pendingLevel ? this.source === 'straight' ? 'Level complete · tap the key for the next level' : 'Level complete · tap dit (E) for the next level' : mastery.mastered ? 'Level complete · continue practising or choose another level' : `${mastery.good}/${mastery.required} clean transmissions${stage.focusCopies ? ` · ${stage.focus}: ${mastery.focusGood}/${stage.focusCopies}` : ''}`;
    $('send-completed-count').textContent = `${completed(s)}/${SENDING_LEVELS} completed`;
    const meter = $('send-progress-meter');
    meter.setAttribute('aria-valuemax', mastery.required); meter.setAttribute('aria-valuenow', mastery.good);
    meter.firstElementChild.style.width = `${100 * mastery.good / mastery.required}%`;
    $('send-progress-rule').textContent = `${stage.required} clean transmissions in the last ${stage.window} attempts${stage.distinct > 1 ? `, covering ${stage.distinct} different exercises` : ''}${stage.focusCopies ? `; at least ${stage.focusCopies} clean singles of ${stage.focus}` : ''}. ${this.source === 'straight' ? 'Timing' : 'Spacing'} score ${stage.qualityGoal}% or higher; at least 80% of ${this.source === 'straight' ? 'marks and gaps' : 'letter and word gaps'} within ±${Math.round(stage.tolerance * 100)}%. No response deadline.`;
    this.renderExercise(); this.renderInput(); this.renderJourney(); this.updateActivity();
  }

  renderSpeed() {
    const wpm = Number($('send-wpm').value), spacing = $('send-farnsworth');
    spacing.max = wpm;
    const farnsworth = Number(spacing.value);
    for (const [id, value] of [['send-wpm', wpm], ['send-farnsworth', farnsworth]]) {
      $(`${id}-value`).textContent = `${value} WPM`;
      $(id).setAttribute('aria-valuetext', `${value} words per minute`);
    }
    $('send-speed-label').textContent = `${wpm} WPM · ${farnsworth === wpm ? 'standard spacing' : `${farnsworth} Farnsworth`}`;
  }

  renderJourney() {
    const s = this.getProfile().sending;
    $('sending-journey-copy').textContent = `${completed(s)}/${SENDING_LEVELS} levels · ${s.clean} clean transmissions · ${s.characters} characters sent · ${s.earned.toLocaleString()} sending XP`;
    const earned = sendingBadges(s);
    $('sending-badges').replaceChildren(...SENDING_CHAPTERS.map(c => { const badge = make('span', `sending-badge${earned.includes(c) ? ' earned' : ''}`, `${earned.includes(c) ? '✓ ' : ''}${c.name}`); return badge; }));
  }

  renderExercise() {
    if (!this.item) return;
    const stage = this.stage, hidden = stage.kind !== 'copy' && !this.revealed;
    const pending = this.getProfile().sending.pendingLevel;
    const autoQueued = !!this.nextTimer && !pending;
    const awaitingCommand = !pending && !autoQueued && !this.playing && !this.heard;
    $('send-instruction').textContent = pending ? this.source === 'straight' ? 'Tap the key to start the next level.' : 'Tap dit (E) to start the next level.' : autoQueued ? this.result?.passed ? 'Next signal plays automatically.' : 'The same signal will replay.' : this.playing ? 'Listening…' : awaitingCommand ? this.source === 'straight' ? 'Tap the key to hear the signal, then send it back.' : 'Tap dit (E) to hear the signal, then send your answer.' : this.source !== 'straight' && stage.level <= 7 ? paddleBasics[stage.level - 1] : stage.instruction;
    const waitingForSound = this.source === 'paddle' && this.sidetone.supported && this.sidetone.confirmed !== false;
    $('send-target-label').textContent = pending ? 'LEVEL COMPLETE' : autoQueued ? this.result?.passed ? 'NEXT SIGNAL' : 'REPLAYING' : this.playing ? 'LISTENING' : !this.heard ? 'LISTEN FIRST' : this.listenHeld ? 'RELEASE THE PADDLE' : waitingForSound && !this.result ? 'WAIT FOR PADDLE' : stage.kind === 'reply' ? 'SEND YOUR REPLY' : 'SEND';
    $('send-target').textContent = pending ? `Level ${stage.level} complete` : hidden ? this.playing ? 'Listening…' : this.heard ? stage.kind === 'reply' ? 'Send your reply' : 'Send it back' : 'Listen first' : this.item.target;
    $('send-target').classList.toggle('long-target', !!pending || this.item.target.length > 5 || hidden);
    const listenLabel = stage.kind === 'reply' ? 'Hear message' : 'Hear signal';
    $('send-listen').querySelector('span').textContent = pending ? this.source === 'straight' ? 'Next level · tap key' : 'Next level · tap dit (E)' : autoQueued ? this.result?.passed ? 'Next signal…' : 'Replaying…' : this.playing ? 'Playing…' : `${listenLabel}${awaitingCommand ? this.source === 'straight' ? ' · tap key' : ' · tap dit (E)' : ''}`;
    $('send-listen').disabled = !!this.playing || autoQueued;
    $('send-help').hidden = !!pending || stage.guided || this.revealed;
    if (pending) $('send-next').hidden = true;
    const pattern = $('send-pattern'); pattern.replaceChildren();
    const show = !pending && (stage.guided || this.revealed);
    pattern.hidden = !show;
    if (show) {
      for (const token of sendingTokens(this.item.target)) {
        const group = make('span', 'send-pattern-character');
        for (const mark of token.pattern) group.append(make('i', mark === '.' ? 'dot' : 'dash'));
        pattern.append(group);
      }
      pattern.setAttribute('aria-label', sendingTokens(this.item.target).map(t => `${t.value}: ${t.pattern.replaceAll('.', 'dot ').replaceAll('-', 'dash ')}`).join('; '));
    }
    $('send-context').textContent = this.item.context || '';
    $('send-context').hidden = !this.item.context;
  }

  renderInput() {
    const hardware = this.source === 'paddle', keyboard = this.source === 'keyboard';
    $('send-connect').hidden = !hardware;
    $('send-key-controls').hidden = hardware;
    $('send-key').hidden = keyboard;
    $('send-paddles').hidden = !keyboard;
    const soundStatus = !this.sidetone.supported ? 'update Morse Paddle for automatic mute' : this.muteState === 'error' ? 'sidetone control unavailable; reconnect' : this.muteState === 'muted' ? 'sidetone muted' : this.muteState === 'sending' ? 'Mac sidetone' : 'setting paddle sound';
    const awake = this.wakeState === 'held' ? ' · screen awake' : ['blocked', 'unsupported', 'released'].includes(this.wakeState) ? ' · screen may sleep' : '';
    $('send-input-status').textContent = hardware ? this.connectionStatus === 'ready' ? `Paddle ready · ${soundStatus}${awake}` : this.connectionMessage || 'Morse Paddle · connect on this Mac' : keyboard ? 'Paddles · hold Z / X or the buttons' : 'Straight key · hold Space or the button';
    $('sender').dataset.sidetone = this.muteState || 'off';
    $('sender').dataset.wake = this.wakeState || 'off';
    this.updateMute();
    this.updateWake();
  }

  updateWake() {
    this.wake.setActive(this.active() && !document.hidden && !this.pageHidden && this.source === 'paddle' && !!this.connection?.connected);
  }
  updateActivity() {
    this.connection.setActive(this.active() && !document.hidden && !this.pageHidden && this.source === 'paddle');
    this.updateWake();
  }

  updateMute() {
    const mute = this.source === 'paddle' && this.active() && !this.suspended && (!this.heard || this.playing && !this.audioFinished || this.listenHeld || this.result != null || this.nextTimer != null || this.getProfile().sending.pendingLevel != null || !!document.querySelector('dialog[open]'));
    return this.sidetone.setMuted(!!mute);
  }

  selectLevel(level) {
    this.getProfile().sending.pendingLevel = null;
    this.getProfile().sending.level = level;
    this.abort();
    this.level = level; this.item = null; this.next({ reset: true }); this.persist(); this.render();
  }

  continueLevel() {
    if (!this.usable() || !this.getProfile().sending.pendingLevel) return;
    this.next({ preservePaddles: true });
    this.listen();
  }

  next({ reset = false, autoListen = false, preservePaddles = autoListen } = {}) {
    const previous = this.item?.target || '';
    if (!reset && advanceSending(this.getProfile().sending)) {
      this.level = this.getProfile().sending.level;
      this.persist();
    }
    this.abort('', { preservePaddles });
    this.item = sendingExercise(this.getProfile().sending, previous);
    this.assisted = false; this.revealed = false; this.heard = false;
    $('send-next').hidden = true;
    if (autoListen && this.usable()) this.listen();
    else {
      $('send-feedback').textContent = this.source === 'straight' ? 'Tap the key to listen, then send the answer. Checking is automatic.' : 'Tap dit (E) to listen, then send the answer. Checking is automatic.';
      this.renderExercise();
    }
    if (!reset) { this.render(); this.focusKey(); }
  }

  abort(message = '', { preservePaddles = false } = {}) {
    clearTimeout(this.checkTimer); clearTimeout(this.nextTimer); clearTimeout(this.holdTimer);
    this.checkTimer = this.nextTimer = this.holdTimer = null;
    cancelAnimationFrame(this.keyerFrame); this.keyerFrame = null;
    this.audio.stop(); this.playing = false; this.audioFinished = false; this.playGeneration = (this.playGeneration || 0) + 1;
    this.tone.set(false, this.settings);
    this.keyer?.reset(); this.keyer = null;
    this.down = false; this.originAt = null; this.edges = []; this.result = null;
    if (!preservePaddles) {
      this.keyboardContacts = { dit: false, dah: false };
      this.heldCodes = new Set();
      this.listenHeld = false;
      this.straightHeld = false;
    }
    $('send-capture').removeAttribute('data-result');
    $('sender').classList.remove('is-key-down');
    $('send-decoded').textContent = '—'; $('send-marks').replaceChildren(); $('send-metrics').hidden = true;
    if (message && this.active()) $('send-feedback').textContent = message;
    this.renderExercise();
  }

  pause() { this.abort(); this.heard = false; this.updateMute(); this.audio.release(); this.tone.release(); this.neutral = !this.contacts.dit && !this.contacts.dah; }
  focusKey() { if (this.active() && this.source !== 'paddle') $(this.source === 'keyboard' ? 'send-dit' : 'send-key').focus({ preventScroll: true }); }

  async listen() {
    if (this.getProfile().sending.pendingLevel) { this.continueLevel(); return; }
    if (!this.usable()) return;
    this.listenHeld ||= !!this.inputHeld();
    this.abort('', { preservePaddles: true });
    const item = this.item, stage = this.stage;
    this.playing = true; const generation = ++this.playGeneration;
    $('send-feedback').textContent = 'Listening…';
    this.renderExercise();
    try {
      if (this.source === 'paddle' && this.sidetone.supported && !await this.updateMute()) throw new Error('Could not mute Morse Paddle. Reconnect it and try again.');
      if (generation !== this.playGeneration || item !== this.item) return;
      const result = await this.audio.play(stage.kind === 'reply' ? item.incoming : item.target, this.settings);
      if (generation !== this.playGeneration || item !== this.item) return;
      this.heard = result.completed;
      this.audioFinished = true;
      await this.updateMute();
      if (generation !== this.playGeneration || item !== this.item) return;
      $('send-feedback').textContent = result.completed ? stage.kind === 'reply' ? 'Send your reply, then pause. Checking is automatic.' : 'Send the signal back, then pause. Checking is automatic.' : 'Playback paused. Tap dit (E) to hear it again.';
    } catch (error) { if (generation === this.playGeneration) $('send-feedback').textContent = error.message; }
    finally { if (generation === this.playGeneration) { this.playing = false; this.audioFinished = false; this.updateMute(); this.renderExercise(); this.focusKey(); } }
  }

  ready() {
    if (!this.usable()) return false;
    if (this.nextTimer || this.getProfile().sending.pendingLevel) return false;
    if (!this.heard) { $('send-feedback').textContent = 'Listen first, then send your answer.'; return false; }
    if (this.source === 'paddle' && this.sidetone.supported && this.sidetone.confirmed !== false) return false;
    return true;
  }

  edge({ down, at }, local = false) {
    if (!this.ready()) return;
    if (this.result) { this.edges = []; this.originAt = null; this.result = null; $('send-capture').removeAttribute('data-result'); $('send-next').hidden = true; }
    if (down === this.down) return;
    if (this.originAt == null) this.originAt = at;
    const stamp = at - this.originAt;
    if (stamp < 0 || stamp > 180000 || this.edges.length >= 4096) { this.abort('Answer too long. Try a shorter attempt.'); return; }
    this.edges.push({ down, at: stamp }); this.down = down;
    $('sender').classList.toggle('is-key-down', down);
    if (local) this.tone.set(down, this.settings);
    clearTimeout(this.checkTimer); clearTimeout(this.holdTimer);
    if (down) this.holdTimer = setTimeout(() => this.abort('Key held too long. Release it and try again.'), 10000);
    else {
      this.paintCapture();
      this.checkTimer = setTimeout(() => this.finish(), this.idleDelay());
    }
  }

  idleDelay() { return Math.max(500, timing(this.settings.wpm, this.settings.farnsworth).wordGap * 1000 * (1 + this.stage.tolerance) + 180); }
  paintCapture() {
    const decoded = decodeSending(this.edges, this.settings);
    $('send-decoded').textContent = decoded.decoded || '—';
    $('send-marks').replaceChildren(...decoded.groups.map(group => make('span', '', group.pattern.replaceAll('.', '·').replaceAll('-', '−'))));
  }

  straight(down, at = performance.now()) {
    if (this.source !== 'straight') return;
    const released = !this.straightHeld;
    this.straightHeld = down;
    if (this.listenContact(down, false, down && released)) return;
    this.edge({ down, at }, true);
  }

  makeKeyer(local) {
    return new PaddleKeyer({ wpm: this.settings.wpm, mode: this.settings.keyer, onEdge: edge => this.edge(edge, local) });
  }

  listenContact(dit, dah, pressed) {
    if (!dit && !dah && this.listenHeld) { this.listenHeld = false; this.updateMute(); this.renderExercise(); }
    if (this.playing) {
      this.listenHeld = dit || dah;
      this.updateMute();
      return true;
    }
    // The command press, and any contact held through playback, must be
    // released before an answer can begin. It never enters the capture.
    if (this.listenHeld) return true;
    if (this.getProfile().sending.pendingLevel) {
      if (pressed && dit && !dah && this.usable()) {
        this.listenHeld = true;
        this.continueLevel();
      }
      return true;
    }
    if (this.heard) return false;
    if (pressed && dit && !dah && this.usable() && !this.nextTimer) {
      this.listen();
      this.listenHeld = true;
    }
    return true;
  }

  hardware(dit, dah, at) {
    const released = !this.contacts.dit && !this.contacts.dah;
    if (dit != null) {
      this.contacts = { dit, dah };
      if (!dit && !dah) this.neutral = true;
    }
    if (this.source !== 'paddle' || !this.neutral) return;
    const contacts = this.contacts;
    if (this.listenContact(this.settings.reverse ? contacts.dah : contacts.dit, this.settings.reverse ? contacts.dit : contacts.dah, dit != null && released) || !this.ready()) return;
    this.keyer ||= this.makeKeyer(false);
    if (dit == null) this.keyer.advance(at);
    else this.keyer.contacts(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, at);
  }

  keyboardContact(contact, down) {
    if (this.source !== 'keyboard') return;
    this.keyboardContacts ||= { dit: false, dah: false };
    const released = !this.keyboardContacts.dit && !this.keyboardContacts.dah;
    this.keyboardContacts[contact] = down;
    const { dit, dah } = this.keyboardContacts;
    if (this.listenContact(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, down && released) || !this.ready()) return;
    this.keyer ||= this.makeKeyer(true);
    this.keyer.contacts(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, performance.now());
    if (!this.keyerFrame) this.keyerFrame = requestAnimationFrame(() => this.tickKeyer());
  }

  tickKeyer() {
    this.keyerFrame = null;
    if (!this.usable() || !this.keyer) return;
    this.keyer.advance(performance.now());
    if (this.keyer.busy) this.keyerFrame = requestAnimationFrame(() => this.tickKeyer());
  }

  key(event, down) {
    if (!this.active() || document.querySelector('dialog[open]') || event.ctrlKey || event.altKey || event.metaKey) return;
    if (down && (['INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(event.target.tagName) || event.target.isContentEditable)) return;
    const key = event.code === 'Space' && this.source === 'straight' ? 'straight' : this.source === 'keyboard' && ['KeyZ', 'KeyX'].includes(event.code) ? event.code === 'KeyZ' ? 'dit' : 'dah' : '';
    if (key) {
      this.heldCodes ||= new Set();
      if (!down && !this.heldCodes.has(event.code)) return;
      // Native button activation after a Space keyup must not create a second
      // hold. The same key handler covers the button and the rest of the view.
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (down) this.heldCodes.add(event.code); else this.heldCodes.delete(event.code);
      if (key === 'straight') this.straight(down, event.timeStamp); else this.keyboardContact(key, down);
    } else if (down && event.key === 'Escape') { event.preventDefault(); this.abort('Answer cleared. Try again.'); }
  }

  finish() {
    clearTimeout(this.checkTimer);
    if (!this.usable() || this.result || this.down || this.keyer?.busy || !this.edges.length) return;
    const s = this.getProfile().sending;
    this.result = gradeSending(this.edges, this.item.target, s.settings, this.stage, { keyerTimed: this.source !== 'straight' });
    const grade = this.result;
    if (!grade.valid) { $('send-feedback').textContent = grade.issue; return; }
    const award = recordSending(s, this.item.target, grade, { assisted: this.assisted });
    this.onEarn(award.xp); this.persist();
    $('send-capture').dataset.result = grade.passed ? 'good' : 'retry';
    // Joined prosigns share patterns with some punctuation. Use the matched
    // target spelling when the transmitted groups and boundaries are correct.
    if (grade.correct) $('send-decoded').textContent = this.item.target;
    $('send-feedback').textContent = grade.passed ? this.assisted ? 'Correct. Assisted practice; try the next exercise without the pattern.' : `Correct · ${grade.keyerTimed ? grade.assessed.length ? `spacing ${grade.quality}%` : 'keyer timed' : `timing ${grade.quality}%`} · +${award.xp} XP` : grade.issue;
    $('send-metrics').hidden = false;
    const score = type => { const rows = grade.parts?.filter(p => type === 'marks' ? !p.type.includes('gap') : p.type.includes('gap')) || []; return rows.length ? `${Math.round(100 * rows.reduce((sum, p) => sum + Math.max(0, 1 - p.error), 0) / rows.length)}%` : '—'; };
    $('send-metrics').replaceChildren(make('span', '', `Marks ${score('marks')}${this.source === 'straight' ? '' : ' · keyer timed'}`), make('span', '', `Spacing ${score('gaps')}`));
    if (grade.passed) {
      $('send-next').hidden = false;
      if (award.levelUp) {
        const milestone = sendingBadges(s).find(c => c.end === this.stage.level);
        this.rewards.show({ kind: milestone ? 'badge' : 'level', title: milestone ? `${milestone.name} complete` : this.stage.level === SENDING_LEVELS ? 'Sending course complete' : `Sending level ${this.stage.level} complete`, detail: award.nextLevel ? `Next: ${sendingStage(award.nextLevel).title}` : `All ${SENDING_LEVELS} levels are available for review.`, icon: 'check', badges: milestone ? [milestone] : [] });
      }
      if (!s.pendingLevel) this.nextTimer = setTimeout(() => { this.nextTimer = null; if (this.usable()) this.next({ autoListen: true }); }, award.levelUp ? 1800 : 1200);
    } else {
      this.heard = false;
      $('send-feedback').textContent += ' Replaying…';
      this.nextTimer = setTimeout(() => { this.nextTimer = null; if (this.usable()) this.listen(); }, 1200);
    }
    this.render();
  }
}
