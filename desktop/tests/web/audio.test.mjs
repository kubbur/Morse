import test from 'node:test';
import assert from 'node:assert/strict';
import { MorseAudio } from '../../website/public/js/audio.mjs';
import { DEFAULT_SETTINGS } from '../../website/public/js/progress.mjs';

async function withPlatform(t, navigator, events, action, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new Map(['navigator', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const contexts = [];
  class Context {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    destination = {};
    holds = [];
    voices = [];
    constructor() { events.push('context'); contexts.push(this); }
    resume() { events.push('resume'); this.state = 'running'; return options.resume?.() || Promise.resolve(); }
    suspend() { events.push('suspend'); this.state = 'suspended'; return options.suspend?.() || Promise.resolve(); }
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { numberOfChannels: channels, length, sampleRate, getChannelData() { return data; } };
    }
    createBufferSource() {
      const source = { starts: 0, stops: 0, connected: false,
        connect(destination) { this.connected = true; return destination; },
        start() { this.starts++; }, stop() { this.stops++; }, disconnect() { this.connected = false; } };
      this.holds.push(source);
      return source;
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, setValueCurveAtTime() {} }, connect() { return this; }, disconnect() {} };
    }
    createOscillator() {
      const source = { frequency: { value: 0 }, connect(destination) { return destination; }, start() {},
        stop() { if (options.autoEnd !== false) queueMicrotask(() => this.onended?.()); },
        finish() { this.onended?.(); }, disconnect() {} };
      this.voices.push(source);
      return source;
    }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  try { await action({ contexts, timers: t.mock.timers }); }
  finally {
    t.mock.timers.reset();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('intentional playback selects the media category before creating or resuming audio, including subsequent sounds', async t => {
  const events = [];
  const session = { set type(value) { events.push(value); } };
  await withPlatform(t, { audioSession: session }, events, async () => {
    const audio = new MorseAudio();
    assert.deepEqual(events, [], 'visiting the site must not take over audio');
    assert.deepEqual(await audio.play('E', DEFAULT_SETTINGS), { completed: true });
    assert.deepEqual(events, ['playback', 'context', 'resume']);
    events.length = 0;
    assert.deepEqual(await audio.play('T', DEFAULT_SETTINGS), { completed: true });
    assert.deepEqual(events, ['playback', 'resume'], 'reuse the context and reassert the category before resuming');
  });
});

test('audio-session support is optional and does not change ordinary audio playback', async t => {
  for (const navigator of [undefined, {}, { audioSession: null }]) {
    const events = [];
    await withPlatform(t, navigator, events, async () => {
      assert.deepEqual(await new MorseAudio().play('E', DEFAULT_SETTINGS), { completed: true });
      assert.deepEqual(events, ['context', 'resume']);
    });
  }
});

test('connecting can unlock hardware-triggered playback silently with the existing idle release', async t => {
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    await audio.unlock();
    const context = contexts[0];
    assert.equal(context.state, 'running');
    assert.equal(context.voices.length, 0);
    assert.ok(context.holds[0].buffer.getChannelData(0).every(sample => sample === 0));
    await audio.play('E', DEFAULT_SETTINGS);
    assert.equal(contexts.length, 1); assert.equal(context.holds.length, 1);
    timers.tick(60_000);
    assert.equal(context.state, 'suspended');
    await audio.unlock();
    assert.equal(context.state, 'running');
    await audio.release();
    assert.equal(context.state, 'suspended');
  });
});

test('a rejected audio-session getter or setter cannot block Morse playback', async t => {
  const platforms = [
    { get audioSession() { throw new Error('unavailable'); } },
    { audioSession: { set type(value) { throw new Error('not permitted'); } } },
  ];
  for (const navigator of platforms) {
    const events = [];
    await withPlatform(t, navigator, events, async () => {
      assert.deepEqual(await new MorseAudio().play('E', DEFAULT_SETTINGS), { completed: true });
      assert.deepEqual(events, ['context', 'resume']);
    });
  }
});

test('audio stays silently connected for exactly one idle minute, then suspends and can be reused', async t => {
  const events = [];
  await withPlatform(t, {}, events, async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    assert.equal(contexts.length, 0);
    await audio.play('E', DEFAULT_SETTINGS);
    const context = contexts[0], hold = context.holds[0];
    assert.equal(hold.starts, 1);
    assert.equal(hold.loop, true);
    assert.ok(hold.buffer.getChannelData(0).every(sample => sample === 0), 'the hold must not generate a tone or noise');
    timers.tick(59_999);
    assert.equal(context.state, 'running');
    assert.equal(hold.connected, true);
    assert.equal(hold.stops, 0);
    timers.tick(1);
    assert.equal(context.state, 'suspended');
    assert.equal(hold.connected, false);
    assert.equal(hold.stops, 1);
    timers.tick(60_000);
    assert.equal(events.filter(event => event === 'suspend').length, 1);
    await audio.play('T', DEFAULT_SETTINGS);
    assert.equal(contexts.length, 1, 'resume the existing context after idling');
    assert.equal(context.state, 'running');
    assert.equal(context.holds.length, 2);
    assert.equal(context.holds[1].connected, true);
  });
});

test('each completed sound renews the minute without replacing the held output; no-op stops do not renew it', async t => {
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    await audio.play('E', DEFAULT_SETTINGS);
    const context = contexts[0];
    timers.tick(50_000);
    await audio.play('T', DEFAULT_SETTINGS);
    assert.equal(context.holds.length, 1, 'keep the same output across replays');
    timers.tick(10_000);
    assert.equal(context.state, 'running', 'the previous deadline must be cancelled');
    timers.tick(49_999);
    audio.stop();
    assert.equal(context.state, 'running');
    timers.tick(1);
    assert.equal(context.state, 'suspended', 'only sound, not unrelated UI stops, extends the hold');
  });
});

test('a long signal is never released mid-playback and gets a full minute after its actual end', async t => {
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    const result = audio.play('T', DEFAULT_SETTINGS);
    await Promise.resolve();
    const context = contexts[0];
    timers.tick(120_000);
    assert.equal(context.state, 'running');
    assert.equal(context.holds[0].stops, 0);
    context.voices.at(-1).finish();
    assert.deepEqual(await result, { completed: true });
    timers.tick(59_999);
    assert.equal(context.state, 'running');
    timers.tick(1);
    assert.equal(context.state, 'suspended');
  }, { autoEnd: false });
});

test('stopping cancels the tones immediately but holds the output for one minute from that stop', async t => {
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    const result = audio.play('T', DEFAULT_SETTINGS);
    await Promise.resolve();
    const context = contexts[0];
    timers.tick(25_000);
    audio.stop();
    assert.deepEqual(await result, { completed: false });
    assert.equal(context.voices[0].onended, null);
    assert.equal(context.holds[0].connected, true);
    timers.tick(59_999);
    assert.equal(context.state, 'running');
    audio.stop();
    timers.tick(1);
    assert.equal(context.state, 'suspended');
  }, { autoEnd: false });
});

test('leaving the page releases immediately and a pending resume cannot restart a cancelled sound', async t => {
  let finishResume;
  const options = { resume: () => new Promise(resolve => { finishResume = resolve; }) };
  const events = [];
  await withPlatform(t, {}, events, async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    const result = audio.play('E', DEFAULT_SETTINGS);
    const context = contexts[0];
    await audio.release();
    assert.equal(context.state, 'suspended');
    assert.equal(context.holds[0].connected, false);
    finishResume();
    assert.deepEqual(await result, { completed: false });
    assert.equal(context.voices.length, 0);
    timers.tick(120_000);
    assert.equal(events.filter(event => event === 'suspend').length, 1, 'no stale release timer remains');
    options.resume = null;
    assert.deepEqual(await audio.play('T', DEFAULT_SETTINGS), { completed: true });
    assert.equal(context.state, 'running');
  }, options);
});

test('a failed resume releases the silent output and does not prevent a later retry', async t => {
  const options = { resume: () => Promise.reject(new Error('interrupted')) };
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    await assert.rejects(audio.play('E', DEFAULT_SETTINGS), /interrupted/);
    const context = contexts[0];
    assert.equal(context.state, 'suspended');
    assert.equal(context.holds[0].connected, false);
    timers.tick(120_000);
    options.resume = null;
    assert.deepEqual(await audio.play('E', DEFAULT_SETTINGS), { completed: true });
    assert.equal(context.holds[1].connected, true);
  }, options);
});

test('a new sound can start while an earlier idle suspension is still resolving', async t => {
  let finishSuspend;
  const options = { suspend: () => new Promise(resolve => { finishSuspend = resolve; }) };
  await withPlatform(t, {}, [], async ({ contexts, timers }) => {
    const audio = new MorseAudio();
    await audio.play('E', DEFAULT_SETTINGS);
    timers.tick(60_000);
    const context = contexts[0];
    const result = audio.play('T', DEFAULT_SETTINGS);
    finishSuspend();
    assert.deepEqual(await result, { completed: true });
    assert.equal(context.state, 'running');
    assert.equal(context.holds[0].stops, 1);
    assert.equal(context.holds[1].stops, 0);
    timers.tick(59_999);
    assert.equal(context.state, 'running');
    timers.tick(1);
    assert.equal(context.state, 'suspended');
    finishSuspend();
  }, options);
});
