import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenWake } from '../../website/public/js/screen-wake.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));
class Sentinel extends EventTarget {
  released = false;
  async release() { this.released = true; this.dispatchEvent(new Event('release')); }
}
function fixture(t, { manual = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], states = [];
  const api = { request(type) {
    const row = { type, lock: new Sentinel() }; calls.push(row);
    return manual ? new Promise(resolve => { row.resolve = () => resolve(row.lock); }) : Promise.resolve(row.lock);
  } };
  const wake = new ScreenWake({ api, onState: state => states.push(state) });
  t.after(async () => { wake.setActive(false); await wake.pending; t.mock.timers.reset(); });
  return { wake, api, calls, states, timers: t.mock.timers };
}

test('screen wake is acquired once only for active connected practice and is released on exit', async t => {
  const { wake, calls, states } = fixture(t);
  wake.setActive(false); wake.refresh(); await drain(); assert.equal(calls.length, 0);
  wake.setActive(true); wake.setActive(true); wake.refresh(); await drain();
  assert.equal(calls.length, 1); assert.equal(calls[0].type, 'screen'); assert.equal(states.at(-1), 'held');
  wake.setActive(false); await drain();
  assert.equal(calls[0].lock.released, true); assert.equal(states.at(-1), 'off');
});

test('a wake lock granted after leaving practice is immediately released without claiming an active lock', async t => {
  const { wake, calls, states } = fixture(t, { manual: true });
  wake.setActive(true); await drain(); wake.setActive(false);
  calls[0].resolve(); await drain();
  assert.equal(calls[0].lock.released, true); assert.equal(wake.lock, null); assert.equal(states.includes('held'), false);
});

test('leaving and returning during a pending wake request releases the stale lock before acquiring a current one', async t => {
  const { wake, calls } = fixture(t, { manual: true });
  wake.setActive(true); await drain(); wake.setActive(false); wake.setActive(true);
  calls[0].resolve(); await drain(); assert.equal(calls[0].lock.released, true); assert.equal(calls.length, 2);
  calls[1].resolve(); await drain(); assert.equal(wake.lock, calls[1].lock); assert.equal(wake.state, 'held');
});

test('denied wake requests do not loop on paddle events and can retry when practice returns', async t => {
  const { wake, api, calls } = fixture(t);
  let denied = 0; api.request = async () => { denied++; throw new Error('Not allowed'); };
  wake.setActive(true); await drain();
  for (let i = 0; i < 100; i++) wake.setActive(true);
  await drain(); assert.equal(denied, 1); assert.equal(wake.state, 'blocked');
  api.request = async type => { calls.push(type); return new Sentinel(); };
  wake.refresh(); await drain(); assert.equal(wake.state, 'held'); assert.deepEqual(calls, ['screen']);
});

test('a system-released screen lock is reacquired during practice and that retry is cancelled on exit', async t => {
  const { wake, calls, timers } = fixture(t);
  wake.setActive(true); await drain(); await calls[0].lock.release();
  assert.equal(wake.state, 'released'); timers.tick(1000); await drain();
  assert.equal(calls.length, 2); assert.equal(wake.state, 'held');
  await calls[1].lock.release(); wake.setActive(false); timers.tick(1000); await drain();
  assert.equal(calls.length, 2); assert.equal(wake.state, 'off');
});

test('an unsupported wake API leaves practice available without claiming screen protection', async () => {
  const wake = new ScreenWake({ api: null });
  wake.setActive(true); assert.equal(wake.state, 'unsupported'); assert.equal(wake.lock, undefined);
  wake.setActive(false); assert.equal(wake.state, 'off');
});
