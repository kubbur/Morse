import { MorseAudio } from './audio.mjs';
import { timing, timeline, rampGain } from './morse.mjs';
import { SENDING_LEVELS, SENDING_CHAPTERS, sendingStage, sendingExercise, sendingTokens } from './sending-course.mjs';
import { DEFAULT_SENDING_SETTINGS, decodeSending, gradeSending, matchesSendingTarget, sendingMastery, recordSending, advanceSending, sanitizeSendingSettings } from './sending.mjs';
import { BuiltInPaddle, NativeSidetone } from './native-paddle.mjs';
import { VBandKeys, loadInput, saveInput } from './vband.mjs';
import { keyLabel, loadKeyboardPaddles, paddleCharacter, saveKeyboardPaddles } from './keyboard-paddles.mjs';
import { PaddleKeyer, PaddleConnection } from './paddle.mjs';
import { PaddleSidetone } from './paddle-control.mjs';
import { ScreenWake } from './screen-wake.mjs';
import { RewardEffects } from './rewards.mjs';
import { sendingTrace, SendingTraceView } from './send-trace.mjs';

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

// The release point of a hand-keyed note is unknown at attack. Schedule
// short linear segments so a release can interrupt any of the three curves.
function scheduleRamp(param, at, duration, amplitude, curve, release) {
  const segments = curve === 'linear' ? 1 : 24;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    param.linearRampToValueAtTime(amplitude * rampGain(release ? 1 - t : t, curve), at + t * duration);
  }
}

export class KeyTone {
  async set(down, settings = {}) {
    this.down = down; clearTimeout(this.idle);
    if (!down) {
      if (this.note) {
        const { oscillator, gain, start, rise, fall, curve, amplitude } = this.note, at = this.context.currentTime;
        const level = amplitude * rampGain(Math.min(1, Math.max(0, (at - start) / rise)), curve);
        gain.gain.cancelScheduledValues(at); gain.gain.setValueAtTime(level, at);
        scheduleRamp(gain.gain, at, fall, level, curve, true);
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
      const amplitude = (settings.volume ?? 55) / 100 * 0.23, rise = (settings.rise ?? 5) / 1000;
      const fall = (settings.fall ?? 5) / 1000, curve = settings.curve || 'smooth';
      gain.gain.setValueAtTime(0, at); scheduleRamp(gain.gain, at, rise, amplitude, curve, false);
      oscillator.connect(gain).connect(this.context.destination); oscillator.start(at);
      this.note = { oscillator, gain, start: at, rise, fall, curve, amplitude };
    } catch { /* Input still works if browser audio is unavailable. */ }
  }
  release() { this.set(false); clearTimeout(this.idle); this.context?.suspend().catch(() => {}); }
}

export class SendingUI {
  constructor({ getProfile, persist, active, activitySource = () => ({}), inputSettingsOpen = () => false, soundChoice = () => false, onEarn = () => {} }) {
    Object.assign(this, { getProfile, persist, active, activitySource, inputSettingsOpen, soundChoice, onEarn });
    this.audio = new MorseAudio(); this.tone = new KeyTone();
    this.trace = new SendingTraceView($('send-trace'), $('send-hit'));
    this.edges = []; this.source = loadInput(); $('send-source').value = this.source; this.contacts = { dit: false, dah: false };
    this.keyboardPaddles = loadKeyboardPaddles();
    this.heldCodes = new Map();
    this.contactHolds = { dit: new Set(), dah: new Set() };
    this.wake = new ScreenWake({ onState: state => { this.wakeState = state; this.renderInput(); } });
    this.native = globalThis.morseMac;
    this.vband = new VBandKeys((mask, contact, down) => {
      if (this.native) this.connection.vbandContacts(mask);
      else this.keyboardContact(contact, down);
    }, () => {
      if (this.native) void this.native.paddle('vband-release');
      this.pauseInput('VBand input was interrupted. Release both paddles and try again.');
    });
    const muteState = state => { if (this.native && state==='sending') this.connection?.resetStream(); this.muteState = state; this.renderInput(); this.renderExercise(); };
    this.sidetone = this.native ? new NativeSidetone(this.native, muteState) : new PaddleSidetone({ onState: muteState });
    this.rewards = new RewardEffects($('send-reward'), $('send-announcement'), $('sender'));
    let wanted = false;
    try { wanted = sessionStorage.getItem('morse.paddle.connection') === '1'; } catch { /* Connection intent still works in memory. */ }
    this.connection = this.native ? new BuiltInPaddle(this.native, this) : new PaddleConnection({
      enabled: false, wanted,
      onIntent: wanted => { try { if (wanted) sessionStorage.setItem('morse.paddle.connection', '1'); else sessionStorage.removeItem('morse.paddle.connection'); } catch { /* Storage is optional. */ } },
      onContacts: (dit, dah, at) => this.hardware(dit, dah, at),
      onStatus: (status, message) => {
        this.connectionStatus = status;
        this.connectionMessage = message;
        if (status === 'ready' && this.source === 'paddle') { this.updateMute(); this.sidetone.enable(); }
        if (this.source === 'paddle') $('send-connection').textContent = message;
        $('send-connect').textContent = this.connection?.wanted ? 'Disconnect Morse Paddle' : 'Connect Morse Paddle';
        this.renderInput();
      },
      onReset: () => { if (this.source !== 'paddle') return; this.sidetone.release(); this.neutral = false; this.contacts = { dit: false, dah: false }; this.abort('Paddle connection paused. Your unfinished answer was cleared.', { keepGraded: true }); },
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
      this.abort(); this.heard = false;
      if (this.native) void this.native.paddle('disarm');
      this.connection.disconnect();
      this.source = $('send-source').value;
      this.connectionStatus = null; this.connectionMessage = '';
      saveInput(this.source);
      if (this.native) this.connection.selectInput(this.source);
      this.render(); this.focusKey();
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
    for (const id of ['send-keyer', 'send-reverse']) $(id).addEventListener('change', event => {
      this.abort('Input settings changed. Hear the signal again.');
      const s = this.getProfile().sending;
      s.settings = sanitizeSendingSettings({ ...this.settings, keyer: $('send-keyer').value, reverse: $('send-reverse').checked });
      if (this.native && event.target.id === 'send-reverse') void this.native.paddle('reverse', s.settings.reverse);
      this.persist(); this.render();
    });
    $('paddle-bindings').addEventListener('submit', e => {
      e.preventDefault();
      const read = id => {
        const value = $(id).value;
        return value.toLowerCase() === 'space' ? ' ' : paddleCharacter(value);
      };
      const dot = read('paddle-dot-key'), dash = read('paddle-dash-key');
      if (!dot || !dash || dot === dash) {
        $('paddle-key-message').textContent = dot && dot === dash ? 'Choose different keys for dot and dash.' : 'Enter one character per key, or Space.';
        return;
      }
      const reverse = this.settings.reverse;
      Object.assign(this.keyboardPaddles, { dit: reverse ? dash : dot, dah: reverse ? dot : dash });
      const saved = saveKeyboardPaddles(this.keyboardPaddles);
      this.bindingLabels = null;
      this.renderInput();
      $('paddle-key-message').textContent = saved ? 'Paddle keys saved.' : 'Keys set for this session. Device storage is unavailable.';
    });
    for (const id of ['paddle-dot-key', 'paddle-dash-key']) $(id).addEventListener('focus', () => $(id).select());
    $('show-paddle-buttons').addEventListener('change', () => {
      this.keyboardPaddles.showButtons = $('show-paddle-buttons').checked;
      if (!saveKeyboardPaddles(this.keyboardPaddles)) $('paddle-key-message').textContent = 'Button visibility set for this session. Device storage is unavailable.';
      this.renderInput();
    });
    $('send-pause').addEventListener('input', () => this.showPause(Number($('send-pause').value)));
    for (const id of ['send-continue-mode', 'send-pause']) $(id).addEventListener('change', () => {
      const sending = this.getProfile().sending;
      sending.settings = sanitizeSendingSettings({ ...sending.settings, continueMode: $('send-continue-mode').value, pauseSeconds: Number($('send-pause').value) });
      this.persist(); this.render();
    });
    $('send-listen').addEventListener('click', () => this.playPrompt());
    $('send-help').addEventListener('click', () => { this.revealed = true; if (!this.stage.guided) this.assisted = true; this.renderExercise(); $('send-feedback').textContent = 'Pattern shown. This attempt is practice; use the next exercise for mastery.'; });
    $('send-retry').addEventListener('click', () => { this.clearAnswer(); this.focusKey(); });
    this.bindHold($('send-key'), (down, at) => this.straight(down, at));
    for (const contact of ['dit', 'dah']) this.bindHold($('send-' + contact), down => {
      if (this.source !== 'keyboard' || !this.keyboardPaddles.showButtons) return;
      const side = this.settings.reverse ? (contact === 'dit' ? 'dah' : 'dit') : contact;
      this.keyboardContact(side, down, 'screen-' + contact);
    });
    document.addEventListener('keydown', e => this.key(e, true), true);
    document.addEventListener('keyup', e => this.key(e, false), true);
    window.addEventListener('blur', () => {
      this.suspended = true;
      this.updateActivity();
      this.pauseInput();
    });
    window.addEventListener('focus', () => { this.suspended = false; this.updateActivity(); this.updateMute(); this.renderExercise(); this.wake.refresh(); });
    document.addEventListener('visibilitychange', () => {
      this.updateActivity();
      if (document.hidden) this.pauseInput();
      else { this.updateMute(); this.wake.refresh(); }
    });
    window.addEventListener('pagehide', () => { this.pageHidden = true; this.updateActivity(); this.pauseInput(); });
    window.addEventListener('pageshow', () => { this.pageHidden = false; this.updateActivity(); this.updateMute(); this.wake.refresh(); });
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
  get settings() { return { ...DEFAULT_SENDING_SETTINGS, ...this.getProfile().sending.settings, ...this.getProfile().settings }; }
  get usesPaddleSidetone() { return this.source === 'paddle' || (this.source === 'vband' && !!this.native); }
  get busy() { return this.down || this.playing || this.edges.length > 0 && !this.result; }
  blockingDialog() {
    if (!this.keyTarget?.dialog?.open) return !!document.querySelector('dialog[open]');
    return [...document.querySelectorAll('dialog[open]')].some(dialog=>dialog!==this.keyTarget.dialog);
  }
  usable() { return this.active() && !this.suspended && !document.hidden && !this.pageHidden && !this.blockingDialog() && !this.playing; }
  inputHeld() { if (this.source === 'vband') return !!this.vband.mask; return this.source === 'paddle' ? this.contacts.dit || this.contacts.dah : this.source === 'keyboard' ? this.contactHolds.dit.size > 0 || this.contactHolds.dah.size > 0 : this.straightHeld; }

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
    $('send-keyer').value = s.settings.keyer; $('send-reverse').checked = s.settings.reverse;
    const { continueMode, pauseSeconds } = this.settings;
    $('send-continue-mode').value = continueMode;
    $('send-manual-hint').hidden = continueMode !== 'manual';
    $('send-pause-control').hidden = continueMode !== 'timed';
    $('send-pause').value = pauseSeconds;
    this.showPause(pauseSeconds);
    if (this.native && !this.migrationPending) this.connection.configure(this.settings);
    const { wpm, farnsworth } = this.settings;
    $('send-speed-label').textContent = `${wpm} WPM · ${farnsworth >= wpm ? 'standard spacing' : farnsworth + ' WPM spacing'}`;
    const mastery = sendingMastery(s);
    $('send-progress-copy').textContent = s.pendingLevel ? 'Level complete · ready for the next level' : mastery.mastered ? 'Level complete · continue practising or choose another level' : `${mastery.good}/${mastery.required} clean transmissions${stage.focusCopies ? ` · ${stage.focus}: ${mastery.focusGood}/${stage.focusCopies}` : ''}`;
    $('send-completed-count').textContent = `${completed(s)}/${SENDING_LEVELS} completed`;
    const meter = $('send-progress-meter');
    meter.setAttribute('aria-valuemax', mastery.required); meter.setAttribute('aria-valuenow', mastery.good);
    meter.firstElementChild.style.width = `${100 * mastery.good / mastery.required}%`;
    $('send-progress-rule').textContent = `${stage.required} clean transmissions in the last ${stage.window} attempts${stage.distinct > 1 ? `, covering ${stage.distinct} different exercises` : ''}${stage.focusCopies ? `; at least ${stage.focusCopies} clean singles of ${stage.focus}` : ''}. ${this.source === 'straight' ? 'Timing' : 'Spacing'} score ${stage.qualityGoal}% or higher; at least 80% of ${this.source === 'straight' ? 'marks and gaps' : 'letter and word gaps'} within ±${Math.round(stage.tolerance * 100)}%. No response deadline.`;
    this.renderExercise(); this.renderInput(); this.renderJourney(); this.updateActivity();
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
    const graded = this.result?.valid;
    const command = this.source === 'straight' ? 'tap the key' : 'send one dit';
    let instruction = this.source !== 'straight' && stage.level <= 7 ? paddleBasics[stage.level - 1] : stage.instruction;
    if (this.playing) instruction = 'Listening…';
    else if (pending || graded) instruction = `Press E or ${command} to ${pending ? 'start the next level' : this.result.passed ? 'hear the next signal' : 'retry'}.`;
    else if (!this.heard) instruction = this.source === 'straight' ? 'Tap the key to hear the signal, then send it back.' : 'Tap dit (E) to hear the signal, then send your answer.';
    $('send-instruction').textContent = instruction;
    const waitingForSound = this.usesPaddleSidetone && this.sidetone.supported && this.sidetone.confirmed !== false;
    $('send-target-label').textContent = pending ? 'LEVEL COMPLETE' : graded ? 'ATTEMPT COMPLETE' : this.playing ? 'LISTENING' : !this.heard ? 'LISTEN FIRST' : this.listenHeld ? 'RELEASE THE PADDLE' : waitingForSound && !this.result ? 'WAIT FOR PADDLE' : stage.kind === 'reply' ? 'SEND YOUR REPLY' : 'SEND';
    $('send-target').textContent = pending ? `Level ${stage.level} complete` : hidden && !graded ? this.playing ? 'Listening…' : this.heard ? stage.kind === 'reply' ? 'Send your reply' : 'Send it back' : 'Listen first' : this.item.target;
    $('send-target').classList.toggle('long-target', !!pending || this.item.target.length > 5 || hidden);
    const listenLabel = stage.kind === 'reply' ? 'Hear message' : 'Hear signal';
    $('send-listen').querySelector('span').textContent = pending ? 'Next level' : graded ? this.result.passed ? 'Hear next signal' : 'Replay signal' : this.playing ? 'Playing…' : listenLabel;
    $('send-listen').disabled = !!this.playing;
    $('send-help').hidden = !!pending || !!graded || stage.guided || this.revealed;
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
    this.paintTrace();
  }

  renderInput() {
    const converter = this.source === 'paddle', usb = this.source === 'vband', keyboard = this.source === 'keyboard';
    const { dit, dah, showButtons } = this.keyboardPaddles;
    const dotKey = keyLabel(this.settings.reverse ? dah : dit), dashKey = keyLabel(this.settings.reverse ? dit : dah);
    const labels = JSON.stringify([dotKey, dashKey]);
    if (this.bindingLabels !== labels) {
      this.bindingLabels = labels;
      $('paddle-dot-key').value = dotKey; $('paddle-dash-key').value = dashKey;
      $('send-dit').querySelector('kbd').textContent = dotKey;
      $('send-dah').querySelector('kbd').textContent = dashKey;
      $('paddle-key-message').textContent = '';
    }
    $('keyboard-paddle-options').hidden = !keyboard;
    $('show-paddle-buttons').checked = showButtons;
    $('send-connect').hidden = !converter || !!this.native;
    $('send-timing-choice').hidden = !this.usesPaddleSidetone || !this.native || !this.migrationPending || $('sound-choice').hidden;
    $('send-key-controls').hidden = converter || usb || (keyboard && !showButtons);
    $('send-connection').hidden = !converter && !usb;
    if (usb) {
      $('send-connection').textContent = this.settings.reverse
        ? 'Left Control sends dah. Right Control sends dit.'
        : 'Left Control sends dit. Right Control sends dah.';
    } else if (converter) {
      $('send-connection').textContent = this.connectionMessage || (this.native ? 'Checking the audio converter…' : 'Link Morse Paddle on this Mac, then connect here.');
    }
    $('send-key').hidden = keyboard;
    $('send-paddles').hidden = !keyboard || !showButtons;
    const soundStatus = !this.sidetone.supported ? 'update Morse Paddle for automatic mute' : this.muteState === 'error' ? 'sidetone control unavailable; reconnect' : this.muteState === 'muted' ? 'sidetone muted' : this.muteState === 'sending' ? 'Mac sidetone' : 'setting paddle sound';
    const awake = this.wakeState === 'held' ? ' · screen awake' : ['blocked', 'unsupported', 'released'].includes(this.wakeState) ? ' · screen may sleep' : '';
    const arming = this.native && (usb || converter) && this.connectionStatus === 'ready' && !this.connection?.readyForInput;
    $('send-input-status').textContent = arming ? 'Preparing input · release both paddles' : usb ? (this.native && this.connectionStatus !== 'ready' ? this.connectionMessage || 'Preparing VBand sidetone output…' : 'Listening for VBand Control keys' + awake) : converter ? this.connectionStatus === 'ready' ? `Paddle ready · ${soundStatus}${awake}` : this.connectionMessage || (this.native ? 'Checking the paddle adapter…' : 'Morse Paddle · connect on this Mac') : keyboard ? `Dot ${dotKey} · Dash ${dashKey}` : 'Straight key · hold Space or the button';
    if (!this.native) {
      $('send-keyer-help').textContent = converter ? 'Match the keyer mode and sending speed in Morse Paddle.' : 'Sending speed and iambic mode control the paddle elements.';
    }
    $('sender').dataset.sidetone = this.muteState || 'off';
    $('sender').dataset.wake = this.wakeState || 'off';
    this.updateMute();
    this.updateWake();
  }

  updateWake() {
    this.wake.setActive(this.active() && !document.hidden && !this.pageHidden && (this.source === 'vband' && !this.native || this.usesPaddleSidetone && !!this.connection?.connected));
  }
  setKeyTarget(target) {
    if ((this.keyTarget || null) === target) return;
    this.abort();
    this.connection.resetStream?.();
    this.connection.setLiveKeying?.(target?.live===true);
    if (target?.live && (this.contacts.dit || this.contacts.dah)) this.neutral=false;
    this.keyTarget = target;
    this.updateActivity();
    this.updateMute();
  }
  updateActivity() {
    const active = this.active() || (!this.native && this.inputSettingsOpen());
    this.connection.setActive(active && !this.suspended && !document.hidden && !this.pageHidden && this.usesPaddleSidetone);
    this.updateWake();
  }

  updateMute() {
    const mute = this.usesPaddleSidetone && this.active() && !this.suspended && !document.hidden && !this.pageHidden && (!this.keyTarget && (!this.heard || this.playing && !this.audioFinished || this.listenHeld || !!this.result?.valid || this.getProfile().sending.pendingLevel != null) || this.blockingDialog());
    return this.sidetone.setMuted(!!mute);
  }

  selectLevel(level) {
    this.getProfile().sending.pendingLevel = null;
    this.getProfile().sending.level = level;
    this.abort();
    this.level = level; this.item = null; this.next({ reset: true }); this.persist(); this.render();
  }

  playPrompt(feedback = '') {
    if (!this.usable()) return;
    if (this.getProfile().sending.pendingLevel || this.result?.passed) this.next({ autoListen: true, feedback });
    else void this.listen({ feedback });
  }

  clearAnswer() {
    if (this.result?.valid) this.heard = false;
    this.abort(this.heard ? 'Answer cleared. Try again.' : 'Answer cleared. Hear the signal again.');
    this.updateMute();
  }

  next({ reset = false, autoListen = false, preservePaddles = autoListen, feedback = '' } = {}) {
    const previous = this.item?.target || '';
    if (!reset && advanceSending(this.getProfile().sending)) {
      this.level = this.getProfile().sending.level;
      this.persist();
    }
    this.abort('', { preservePaddles });
    this.item = sendingExercise(this.getProfile().sending, previous);
    this.firstAttempt = true;
    this.assisted = false; this.revealed = false; this.heard = false;
    if (autoListen && this.usable()) void this.listen({ feedback });
    else {
      $('send-feedback').textContent = this.source === 'straight' ? 'Tap the key to listen, then send the answer. Checking is automatic.' : 'Tap dit (E) to listen, then send the answer. Checking is automatic.';
      this.renderExercise();
    }
    if (!reset) this.render();
  }

  abort(message = '', { preservePaddles = false, keepGraded = false } = {}) {
    this.keyTarget?.reset();
    clearTimeout(this.checkTimer); clearTimeout(this.holdTimer);
    this.checkTimer = this.holdTimer = null;
    cancelAnimationFrame(this.keyerFrame); this.keyerFrame = null;
    this.audio.stop(); this.playing = false; this.audioFinished = false; this.playGeneration = (this.playGeneration || 0) + 1;
    this.tone.set(false, this.settings);
    this.keyer?.reset(); this.keyer = null;
    this.down = false;
    if (!preservePaddles) {
      if (this.vband?.cancel() && this.native && this.source === 'vband') void this.native.paddle('vband-release');
      this.contactHolds.dit.clear(); this.contactHolds.dah.clear();
      this.heldCodes.clear();
      this.listenHeld = false;
      this.straightHeld = false;
    }
    $('sender').classList.remove('is-key-down');
    if (!(keepGraded && this.result?.valid)) {
      this.originAt = null; this.edges = []; this.result = null;
      $('send-decoded').textContent = '';
      this.feedbackRelease = null;
      this.patternComplete = false;
      $('send-metrics').hidden = true;
      $('send-capture').removeAttribute('data-result');
      if (message && this.active()) $('send-feedback').textContent = message;
    }
    this.renderExercise();
  }

  preparePrompt() {
    // A native paddle event cannot activate Web Audio. Resume in the tab gesture.
    this.audio.unlock().catch(() => {
      if (this.active()) $('send-feedback').textContent = 'Tap Hear signal to enable audio.';
    });
  }

  pause() {
    this.heard = false;
    this.pauseInput('');
  }
  pauseInput(message = 'Input paused. Send the answer again.') {
    let feedback = '';
    if (this.playing && !this.audioFinished) feedback = 'Playback paused. Hear the signal again.';
    else if (this.busy && !this.playing) feedback = message;
    if (this.native) this.connection.resetStream();
    this.abort(feedback, { keepGraded: true });
    this.updateMute(); this.audio.release(); this.tone.release();
    this.neutral = !this.contacts.dit && !this.contacts.dah;
  }
  focusKey() {
    if (!this.active() || this.source === 'paddle') return;
    if (this.source === 'vband' || this.source === 'keyboard' && !this.keyboardPaddles.showButtons) {
      $('send-listen').focus({ preventScroll:true });
      if (document.activeElement === $('send-source')) $('send-source').blur();
    } else $(this.source === 'keyboard' ? 'send-dit' : 'send-key').focus({ preventScroll:true });
  }

  async listen({ feedback = '' } = {}) {
    if (!this.usable()) return;
    this.listenHeld ||= !!this.inputHeld();
    this.abort('', { preservePaddles: true });
    const item = this.item, stage = this.stage;
    this.heard = false;
    this.playing = true; const generation = ++this.playGeneration;
    $('send-feedback').textContent = feedback || 'Listening…';
    this.renderExercise();
    try {
      if (this.usesPaddleSidetone && this.sidetone.supported && !await this.updateMute()) throw new Error('Could not mute Morse Paddle. Reconnect it and try again.');
      if (generation !== this.playGeneration || item !== this.item) return;
      const result = await this.audio.play(stage.kind === 'reply' ? item.incoming : item.target, this.settings);
      if (generation !== this.playGeneration || item !== this.item) return;
      this.heard = result.completed;
      this.audioFinished = true;
      await this.updateMute();
      if (generation !== this.playGeneration || item !== this.item) return;
      $('send-feedback').textContent = result.completed ? feedback || (stage.kind === 'reply' ? 'Send your reply, then pause. Checking is automatic.' : 'Send the signal back, then pause. Checking is automatic.') : 'Playback paused. Hear the signal again.';
    } catch (error) { if (generation === this.playGeneration) $('send-feedback').textContent = error.message; }
    finally { if (generation === this.playGeneration) { this.playing = false; this.audioFinished = false; this.updateMute(); this.renderExercise(); } }
  }

  ready() {
    if (!this.usable()) return false;
    if (this.keyTarget) return !this.usesPaddleSidetone || !this.sidetone.supported || this.sidetone.confirmed === false;
    if (this.result?.valid || this.getProfile().sending.pendingLevel) return false;
    if (!this.heard) { $('send-feedback').textContent = 'Listen first, then send your answer.'; return false; }
    if (this.usesPaddleSidetone && this.sidetone.supported && this.sidetone.confirmed !== false) return false;
    return true;
  }

  edge({ down, at }, local = false) {
    if (!this.ready()) return;
    if (this.keyTarget) {
      if (down === this.down) return;
      this.down = down;
      if (local) this.tone.set(down, this.settings);
      clearTimeout(this.holdTimer);
      if (down) this.holdTimer = setTimeout(() => this.abort(), 10000);
      this.keyTarget.edge({ down, at });
      return;
    }
    if (this.result) { this.edges = []; this.originAt = null; this.result = null; $('send-capture').removeAttribute('data-result'); }
    if (down === this.down) return;
    if (this.originAt == null) {
      if (!down) return;
      this.originAt = at;
      $('send-capture').removeAttribute('data-result');
      $('send-metrics').hidden = true;
      $('send-feedback').textContent = 'Sending…';
    }
    const stamp = at - this.originAt;
    if (stamp < 0 || stamp > 180000 || this.edges.length >= 4096) { this.abort('Answer too long. Try a shorter attempt.'); return; }
    this.edges.push({ down, at: stamp }); this.down = down;
    $('sender').classList.toggle('is-key-down', down);
    if (local) this.tone.set(down, this.settings);
    clearTimeout(this.checkTimer); clearTimeout(this.holdTimer);
    if (down) {
      this.patternComplete = false;
      this.paintTrace();
      this.holdTimer = setTimeout(() => this.abort('Key held too long. Release it and try again.'), 10000);
    }
    else {
      this.paintCapture();
      if (this.source === 'straight') this.showReleasedMatch();
      if (!(this.native && this.usesPaddleSidetone)) this.checkTimer = setTimeout(() => this.finish(), this.idleDelay());
    }
  }

  inputPause() {
    if (this.patternComplete) return 500;
    const { wpm, farnsworth } = this.settings;
    const time = timing(wpm, farnsworth), target = this.item.target;
    const gap = target.includes(' ') ? time.wordGap : sendingTokens(target).length > 1 ? time.letterGap : time.elementGap;
    return Math.max(500, gap * 1000 * (1 + this.stage.tolerance) + 180);
  }
  idleDelay() {
    const { continueMode, pauseSeconds } = this.settings;
    return Math.max(this.inputPause(), continueMode === 'timed' ? pauseSeconds * 1000 : 0);
  }
  showPause(seconds) {
    $('send-pause-value').textContent = seconds.toFixed(1) + ' s';
    $('send-pause').setAttribute('aria-valuetext', seconds + ' seconds');
    $('send-pause-hint').textContent = 'Each mark restarts the pause. Longer gaps are allowed inside unfinished groups and words.';
  }
  paintCapture() {
    const decoded = decodeSending(this.edges, this.settings);
    this.patternComplete = matchesSendingTarget(decoded, this.item.target);
    $('send-decoded').textContent = decoded.decoded || '';
    this.paintTrace();
  }

  paintTrace() {
    if (!this.item) return;
    const complete = !!this.result?.valid;
    const showTarget = this.stage.guided || this.revealed || complete;
    this.trace.set(this.traceFor(showTarget ? this.item.target : ''), complete, this.result?.passed === true);
  }

  traceFor(target) {
    return sendingTrace(target, this.settings, this.edges, { keyerTimed: this.source !== 'straight', tolerance: this.stage.tolerance });
  }

  // A keyer can have another mark queued after key-up. Only its idle signal
  // establishes that the last generated mark has actually finished.
  showReleasedMatch() {
    const release = this.edges.at(-1);
    if (!release || release.down || release === this.feedbackRelease || this.result || this.keyer?.busy || this.inputHeld()) return;
    this.feedbackRelease = release;
    const data = this.trace.data;
    this.trace.showMatchedSend(data.expected.length ? data : this.traceFor(this.item.target));
  }

  straight(down, at = performance.now()) {
    if (this.source !== 'straight') return;
    const released = !this.straightHeld;
    this.straightHeld = down;
    if (this.listenContact(down, false, down && released)) return;
    this.edge({ down, at }, true);
  }

  makeKeyer(local) {
    return new PaddleKeyer({ wpm: this.settings.wpm, mode: this.settings.keyer,
      onEdge: edge => this.edge(edge, local),
      onReplay: local || this.keyTarget ? null : edges => this.replacePaddleCapture(edges),
    });
  }

  replacePaddleCapture(edges) {
    clearTimeout(this.checkTimer); clearTimeout(this.holdTimer);
    this.checkTimer = this.holdTimer = null;
    this.edges = []; this.originAt = null; this.down = false;
    $('sender').classList.remove('is-key-down');
    for (const edge of edges) this.edge(edge);
    this.paintCapture();
  }

  listenContact(dit, dah, pressed) {
    if (this.keyTarget) return false;
    if (!dit && !dah && this.listenHeld) { this.listenHeld = false; this.updateMute(); this.renderExercise(); }
    if (this.playing) {
      this.listenHeld = dit || dah;
      this.updateMute();
      return true;
    }
    // The command press, and any contact held through playback, must be
    // released before an answer can begin. It never enters the capture.
    if (this.listenHeld) return true;
    if (this.heard && !this.result?.valid && !this.getProfile().sending.pendingLevel) return false;
    if (pressed && dit && !dah && this.usable()) {
      this.listenHeld = true;
      this.playPrompt();
    }
    return true;
  }

  hardware(dit, dah, at) {
    const released = !this.contacts.dit && !this.contacts.dah;
    if (dit != null) {
      this.contacts = { dit, dah };
      if (!dit && !dah) this.neutral = true;
    }
    if (!this.active() || this.source !== 'paddle' || !this.neutral) return;
    const contacts = this.contacts;
    if (this.listenContact(this.settings.reverse ? contacts.dah : contacts.dit, this.settings.reverse ? contacts.dit : contacts.dah, dit != null && released) || !this.ready()) return;
    this.keyer ||= this.makeKeyer(false);
    if (dit == null) this.keyer.advance(this.keyTarget && !this.keyTarget.live ? Math.max(0,at - 180) : at);
    else if (!this.keyer.contacts(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, this.keyTarget ? Math.max(at,this.keyer.clock) : at)) {
      this.heard = false;
      this.abort('Paddle timing was interrupted. Tap dit (E) to listen and try again.');
      this.updateMute();
    }
    if (!this.keyTarget && !this.keyer?.busy) this.showReleasedMatch();
  }

  keyboardContact(contact, down, owner = contact) {
    if (this.source !== 'keyboard' && !(this.source === 'vband' && !this.native)) return;
    const holds = this.contactHolds[contact];
    const released = !this.contactHolds.dit.size && !this.contactHolds.dah.size;
    const before = holds.size > 0;
    if (down) holds.add(owner); else holds.delete(owner);
    if (before === (holds.size > 0)) return;
    const dit = this.contactHolds.dit.size > 0, dah = this.contactHolds.dah.size > 0;
    if (this.listenContact(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, down && released) || !this.ready()) return;
    this.keyer ||= this.makeKeyer(true);
    if (!this.keyer.contacts(this.settings.reverse ? dah : dit, this.settings.reverse ? dit : dah, performance.now())) {
      this.heard = false; this.abort('Paddle timing was interrupted. Hear the signal again.'); this.updateMute(); return;
    }
    if (!this.keyerFrame) this.keyerFrame = requestAnimationFrame(() => this.tickKeyer());
  }

  tickKeyer() {
    this.keyerFrame = null;
    if (!this.usable() || !this.keyer) return;
    this.keyer.advance(performance.now());
    if (this.keyer.busy) this.keyerFrame = requestAnimationFrame(() => this.tickKeyer());
    else if (!this.keyTarget) this.showReleasedMatch();
  }

  key(event, down) {
    const soundSlider = event.target?.type === 'range' && event.target.closest?.('#send-setup');
    const target = event.composedPath?.()[0] || event.target;
    const editing = !soundSlider && target?.closest?.('input, textarea, select, summary, [contenteditable]:not([contenteditable="false"])');
    if (this.source === 'vband') {
      const enabled = this.active() && !this.suspended && !document.hidden && !this.blockingDialog() &&
        !editing && (!this.native || this.connection.acceptsVBand);
      if (this.vband.handle(event, down, enabled)) return;
    } else if (!down) {
      this.vband.handle(event, false, false);
    }
    const char = paddleCharacter(event.key);
    const code = event.code && event.code !== 'Unidentified' ? event.code : char;
    if (!down) {
      const held = this.heldCodes.get(code);
      if (!held) return;
      this.heldCodes.delete(code);
      event.preventDefault(); event.stopImmediatePropagation();
      if (held === 'straight') this.straight(false, event.timeStamp);
      else if (held !== 'continue') this.keyboardContact(held, false, code);
      return;
    }
    if (!this.active() || this.suspended || document.hidden || this.blockingDialog() ||
        event.ctrlKey || event.altKey || event.metaKey || event.isComposing ||
        editing || event.target?.isContentEditable) return;
    let action;
    if (this.keyTarget && event.code === 'Space' && target?.closest?.('button, a[href]')) return;
    if (!this.keyTarget && char === 'e' && !this.playing && (this.result?.valid || this.getProfile().sending.pendingLevel)) action = 'continue';
    else if (this.source === 'straight' && (event.code === 'Space' || char === ' ')) action = 'straight';
    else if (this.source === 'keyboard' && char === this.keyboardPaddles.dit) action = 'dit';
    else if (this.source === 'keyboard' && char === this.keyboardPaddles.dah) action = 'dah';
    if (action) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat || this.heldCodes.has(code)) return;
      this.heldCodes.set(code, action);
      if (action === 'continue') { if (!this.inputHeld()) this.playPrompt(); }
      else if (action === 'straight') this.straight(true, event.timeStamp);
      else this.keyboardContact(action, true, code);
    } else if (!this.keyTarget && event.key === 'Escape' && !soundSlider) { event.preventDefault(); this.clearAnswer(); }
  }

  finish() {
    clearTimeout(this.checkTimer);
    if (!this.usable() || this.result || this.down || this.keyer?.busy || this.inputHeld() || !this.edges.length) return;
    const s = this.getProfile().sending;
    this.result = gradeSending(this.edges, this.item.target, this.settings, this.stage, { keyerTimed: this.source !== 'straight' });
    const grade = this.result;
    if (!grade.valid) { $('send-feedback').textContent = grade.issue; return; }
    const award = recordSending(s, this.item.target, grade, { assisted: this.assisted, sessionId: this.sessionId, firstAttempt: this.firstAttempt, ...this.activitySource() });
    if (award.id) this.firstAttempt = false;
    this.sessionId = award.sessionId;
    this.onEarn(award.xp,award.id); this.persist();
    $('send-capture').dataset.result = grade.passed ? 'good' : 'retry';
    // Joined prosigns share patterns with some punctuation. Use the matched
    // target spelling when the transmitted groups and boundaries are correct.
    if (grade.correct) $('send-decoded').textContent = this.item.target;
    $('send-feedback').textContent = grade.passed ? this.assisted ? 'Correct. Assisted practice; try the next exercise without the pattern.' : `Correct · ${grade.keyerTimed ? grade.assessed.length ? `spacing ${grade.quality}%` : 'keyer timed' : `timing ${grade.quality}%`} · +${award.xp} XP` : grade.issue;
    $('send-metrics').hidden = false;
    const score = type => { const rows = grade.parts?.filter(p => type === 'marks' ? !p.type.includes('gap') : p.type.includes('gap')) || []; return rows.length ? `${Math.round(100 * rows.reduce((sum, p) => sum + Math.max(0, 1 - p.error), 0) / rows.length)}%` : '—'; };
    $('send-metrics').replaceChildren(make('span', '', `Marks ${score('marks')}${this.source === 'straight' ? '' : ' · keyer timed'}`), make('span', '', `Spacing ${score('gaps')}`));
    if (award.levelUp || award.badges.length) {
      const milestone = award.levelUp && sendingBadges(s).find(c => c.end === this.stage.level);
      const titles = award.badges.map(b => b.title);
      if (milestone) titles.push(`${milestone.name} complete`);
      const levelTitle = this.stage.level === SENDING_LEVELS ? 'Sending course complete' : `Sending level ${this.stage.level} complete`;
      this.rewards.show({ kind: titles.length ? 'badge' : 'level', title: titles.join(' · ') || levelTitle,
        detail: award.levelUp ? (award.nextLevel ? `Up next · ${sendingStage(award.nextLevel).title}` : levelTitle) : award.badges[0].description,
        icon: award.badges[0]?.icon || 'check', badges: titles });
    }
    this.render();
    if (this.settings.continueMode === 'timed') {
      const feedback = $('send-feedback').textContent + (grade.passed ? '' : ' Try again.');
      this.playPrompt(feedback);
    }
  }
}
