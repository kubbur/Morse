import { timeline, envelopeAt } from './morse.mjs';

const AUDIO_IDLE_MS = 60_000;

function schedule(context, destination, text, settings, when) {
  const plan = timeline(text, settings);
  const sources = [];
  for (const tone of plan.tones) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = settings.tone;
    const start = when + tone.start;
    const amplitude = Math.max(0, Math.min(100, settings.volume)) / 100 * 0.23;
    // Sample the complete envelope: one curve avoids overlapping gain events
    // even when the user chooses long ramps at a high character speed.
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      curve[i] = amplitude * envelopeAt(i / (curve.length - 1) * tone.duration, tone.duration, settings.rise, settings.fall, settings.curve);
    }
    gain.gain.setValueAtTime(0, start);
    gain.gain.setValueCurveAtTime(curve, start, tone.duration);
    gain.gain.setValueAtTime(0, start + tone.duration);
    oscillator.connect(gain).connect(destination);
    oscillator.start(start);
    oscillator.stop(start + tone.duration);
    sources.push({ oscillator, gain });
  }
  return { ...plan, sources };
}

export class MorseAudio {
  context = null;
  active = null;
  #holdSource = null;
  #idleTimer = null;
  #listening = false;

  setListening(enabled) {
    this.#listening=enabled;
    this.#releaseAfterIdle();
  }

  #cancelRelease() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #hold(context) {
    if (this.#holdSource) return;
    // A connected, looping buffer keeps the output graph alive between Morse
    // signals. Its samples are exactly zero: there is no extra tone or noise.
    const source = context.createBufferSource();
    this.#holdSource = source;
    source.buffer = context.createBuffer(1, 128, context.sampleRate);
    source.loop = true;
    source.connect(context.destination);
    source.start();
  }

  #releaseAfterIdle() {
    this.#cancelRelease();
    if (!this.#holdSource || this.active || this.#listening) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (!this.active) this.release();
    }, AUDIO_IDLE_MS);
  }

  #ensureContext() {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('This browser cannot play Morse audio. Try a current Safari, Chrome, Firefox, or Edge browser.');
    // Morse is intentional media playback. Safari's default ambient category
    // obeys the iPhone silent switch; request playback before creating/resuming.
    try {
      const session = globalThis.navigator?.audioSession;
      if (session) session.type = 'playback';
    } catch { /* Optional platform support must not prevent normal Web Audio. */ }
    this.context ||= new AudioContext({ latencyHint: 'interactive' });
    return this.context;
  }

  async unlock() {
    // Connect is a browser gesture; a later hardware contact is not.
    const context = this.#ensureContext();
    this.#cancelRelease();
    this.#hold(context);
    try { await context.resume(); }
    finally { this.#releaseAfterIdle(); }
  }

  async play(text, settings, { onSchedule } = {}) {
    this.stop();
    this.#cancelRelease();
    const context = this.#ensureContext();
    // Creation/resume happens directly from the Play button, including on iOS.
    const pending = { cancelled: false, resolve: null, sources: [], master: null };
    this.active = pending;
    try {
      this.#hold(context);
      await context.resume();
      if (pending.cancelled) return { completed: false };
      if (context.state !== 'running') throw new Error('Sound is paused. Tap Play again and check your device volume.');
      const master = context.createGain();
      pending.master = master;
      master.gain.value = 1;
      master.connect(context.destination);
      const startsAt = context.currentTime + 0.04;
      const plan = schedule(context, master, text, settings, startsAt);
      pending.sources = plan.sources;
      onSchedule?.(plan, performance.now() + (startsAt - context.currentTime) * 1000, () => context.currentTime - startsAt);
      return await new Promise(resolve => {
        pending.resolve = resolve;
        const last = plan.sources.at(-1).oscillator;
        last.onended = () => {
          if (pending.cancelled) return;
          // Audio ended is driven by the audio clock, not a wall-clock timeout.
          for (const source of plan.sources) { source.oscillator.disconnect(); source.gain.disconnect(); }
          master.disconnect();
          if (this.active === pending) {
            this.active = null;
            this.#releaseAfterIdle();
          }
          resolve({ completed: true });
        };
      });
    } catch (error) {
      if (this.active === pending) this.release();
      throw error;
    }
  }

  stop() {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    for (const source of active.sources) {
      source.oscillator.onended = null;
      try { source.oscillator.stop(); } catch { /* An already-finished voice is harmless. */ }
      source.oscillator.disconnect();
      source.gain.disconnect();
    }
    active.master?.disconnect();
    active.resolve?.({ completed: false });
    this.active = null;
    this.#releaseAfterIdle();
  }

  release() {
    this.#listening=false;
    this.stop();
    this.#cancelRelease();
    if (this.#holdSource) {
      try { this.#holdSource.stop(); } catch { /* The browser may already have stopped it. */ }
      this.#holdSource.disconnect();
      this.#holdSource = null;
    }
    // Suspend immediately; no deferred cleanup can race a later user-gesture
    // resume. Keep the context so the next sound can reuse it after idling.
    if (this.context && this.context.state !== 'closed') {
      try { return this.context.suspend().catch(() => {}); }
      catch { /* An inactive document may no longer allow audio operations. */ }
    }
    return Promise.resolve();
  }
}

// The browser acceptance test measures PCM from the same scheduler used above.
export async function renderOffline(text, settings, sampleRate = 48000) {
  const plan = timeline(text, settings);
  const context = new OfflineAudioContext(1, Math.ceil((plan.duration + 0.02) * sampleRate), sampleRate);
  schedule(context, context.destination, text, settings, 0.01);
  return context.startRendering();
}
