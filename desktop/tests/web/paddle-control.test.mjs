import test from 'node:test';
import assert from 'node:assert/strict';
import { PaddleSidetone, PADDLE_SIDETONE_URLS } from '../../website/public/js/paddle-control.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));
const response = status => ({ status, text() { throw new Error('A 204 has no body.'); }, json() { throw new Error('A 204 has no JSON.'); } });
function fixture(t, { manual = false, status = 204 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [], states = [];
  const control = new PaddleSidetone({ timers: globalThis, onState: state => states.push(state),
    fetchImpl: (url, options) => {
      assert.ok(Object.values(PADDLE_SIDETONE_URLS).includes(url));
      const row = { muted: url === PADDLE_SIDETONE_URLS.mute, url, options };
      requests.push(row);
      if (!manual || options.keepalive) return Promise.resolve(response(status));
      return new Promise((resolve, reject) => {
        row.resolve = (code = status) => resolve(response(code));
        options.signal.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true });
      });
    },
  });
  t.after(async () => { await control.release(); t.mock.timers.reset(); });
  return { control, requests, states, timers: t.mock.timers };
}

test('mute uses the supplied empty PUT endpoints only after connection, without credentials or a JSON body', async t => {
  const { control, requests } = fixture(t);
  assert.equal(await control.setMuted(true), false);
  assert.equal(requests.length, 0);
  control.enable();
  assert.equal(await control.setMuted(true), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:17373/sidetone/mute');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.mode, 'cors');
  assert.equal(Object.hasOwn(requests[0].options, 'body'), false);
  assert.equal(Object.hasOwn(requests[0].options, 'headers'), false);
  assert.equal(await control.setMuted(false), true);
  assert.equal(requests[1].url, 'http://127.0.0.1:17373/sidetone/unmute');
});

test('mute and unmute requests wait for their predecessors so a slow command cannot reverse the current phase', async t => {
  const { control, requests } = fixture(t, { manual: true });
  control.setMuted(true); control.enable(); await drain();
  const sending = control.setMuted(false);
  assert.equal(requests.length, 1);
  requests[0].resolve(); await drain();
  assert.equal(requests.length, 2); assert.equal(requests[1].muted, false);
  requests[1].resolve();
  assert.equal(await sending, true); assert.equal(control.confirmed, false);
});

test('a phase changed immediately after acknowledgement applies without another paddle event', async t => {
  const { control, requests } = fixture(t);
  control.onState = state => { if (state === 'muted') queueMicrotask(() => control.setMuted(false)); };
  control.setMuted(true); control.enable(); await drain();
  assert.deepEqual(requests.map(r => r.muted), [true, false]);
  assert.equal(control.confirmed, false);
});

test('disconnect waits for an unfinished mute then sends a final keepalive unmute', async t => {
  const { control, requests } = fixture(t, { manual: true });
  control.setMuted(true); control.enable(); await drain();
  const release = control.release();
  assert.equal(requests.length, 1);
  requests[0].resolve(); await release;
  assert.deepEqual(requests.map(r => r.muted), [true, false]);
  assert.equal(requests[1].options.keepalive, true);
  assert.equal(control.supported, false); assert.equal(control.confirmed, null);
});

test('reconnecting waits for the old disconnect cleanup instead of unmuting a new listening exercise', async t => {
  const { control, requests } = fixture(t, { manual: true });
  control.setMuted(true); control.enable(); await drain();
  const release = control.release();
  control.setMuted(true); control.enable();
  const listening = control.setMuted(true);
  requests[0].resolve(); await release; await drain();
  assert.deepEqual(requests.map(r => r.muted), [true, false, true]);
  requests[2].resolve(); assert.equal(await listening, true);
  assert.equal(control.confirmed, true);
});

test('a timeout leaves mute unconfirmed and a later acknowledged retry can recover', async t => {
  const { control, requests, timers, states } = fixture(t, { manual: true });
  control.setMuted(true); control.enable(); await drain();
  const first = control.setMuted(true); timers.tick(2000);
  assert.equal(await first, false); assert.equal(control.confirmed, null); assert.equal(states.at(-1), 'error');
  timers.tick(1000); await drain();
  const retry = control.setMuted(true); requests[1].resolve();
  assert.equal(await retry, true); assert.equal(control.confirmed, true);
});

test('only the specified 204 response confirms success; a 200 response cannot claim the paddle is muted', async t => {
  const { control, states } = fixture(t, { status: 200 });
  control.setMuted(true); control.enable();
  assert.equal(await control.setMuted(true), false);
  assert.equal(control.confirmed, null); assert.equal(states.at(-1), 'error');
});

test('an old companion with no control endpoint is identified without repeated unsupported requests', async t => {
  const { control, requests, states, timers } = fixture(t, { status: 404 });
  control.setMuted(true); control.enable();
  assert.equal(await control.setMuted(true), false);
  assert.equal(control.supported, false); assert.equal(states.at(-1), 'unsupported');
  control.enable(); await control.setMuted(true); timers.tick(20000); await drain();
  assert.equal(requests.length, 1);
});
