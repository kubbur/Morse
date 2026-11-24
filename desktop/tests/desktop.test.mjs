import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { APP_ORIGIN, APP_PORT, allowedRequest, allowedPermission, appDocument, progressExport } from '../src/policy.mjs';
import { startLocalServer } from '../src/local-server.mjs';
import { newProfile } from '../website/public/js/progress.mjs';
import { stageApp, stage, root } from '../scripts/stage.mjs';

test('desktop network policy allows the trainer and exact companion commands without granting web or filesystem access', () => {
  for (const url of [APP_ORIGIN, `${APP_ORIGIN}/js/app.mjs`, `${APP_ORIGIN}/fonts/InstrumentSans.woff2`]) assert.equal(allowedRequest(url), true);
  assert.equal(allowedRequest(`${APP_ORIGIN}/api/sync/status`, 'POST'), true);
  for (const [path, method] of [['events','GET'],['sidetone/mute','PUT'],['sidetone/unmute','PUT']]) assert.equal(allowedRequest(`http://127.0.0.1:17373/${path}`, method), true);
  assert.equal(allowedRequest('http://127.0.0.1:17373/sidetone/mute', 'OPTIONS'), true);
  assert.equal(allowedRequest('http://127.0.0.1:17373/other', 'OPTIONS'), false);
  for (const url of ['https://morse.kubbur.digital/', 'https://example.org/', 'file:///etc/passwd', 'http://127.0.0.1:17373/other', 'http://127.0.0.1:17373/events?x=1', 'http://localhost:17373/events', 'http://127.0.0.1:37474/', `${APP_ORIGIN.replace('http://','http://user:password@')}/`]) assert.equal(allowedRequest(url), false, url);
  assert.equal(allowedRequest('http://127.0.0.1:17373/sidetone/mute', 'GET'), false);
  assert.equal(allowedRequest(APP_ORIGIN, 'DELETE'), false);
  assert.equal(progressExport(`blob:${APP_ORIGIN}/test`), true);
  assert.equal(progressExport('blob:https://example.org/test'), false);
});

test('navigation and permissions stay limited to the app window, key companion and screen wake lock', () => {
  assert.equal(appDocument(`${APP_ORIGIN}/#send`), true);
  assert.equal(appDocument(`${APP_ORIGIN}/index.html`), true);
  for (const url of ['https://example.org/', `${APP_ORIGIN}/js/app.mjs`, `${APP_ORIGIN}/?redirect=https://example.org`, 'about:blank', 'file:///tmp/index.html']) assert.equal(appDocument(url), false);
  for (const permission of ['loopback-network','local-network-access','screen-wake-lock','persistent-storage']) assert.equal(allowedPermission(permission, APP_ORIGIN, `${APP_ORIGIN}/#send`), true);
  for (const permission of ['media','geolocation','local-network','camera','microphone','serial','usb','hid','notifications','unknown']) assert.equal(allowedPermission(permission, APP_ORIGIN, APP_ORIGIN), false);
  assert.equal(allowedPermission('loopback-network','https://example.org',APP_ORIGIN), false);
  assert.equal(allowedPermission('screen-wake-lock',APP_ORIGIN,'https://example.org'), false);
});

test('local saves persist across server restarts, reject other origins and bind only to loopback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morse-desktop-save-'));
  let server;
  const send = async (action, body = {}, cookie = '', origin = APP_ORIGIN) => fetch(`${APP_ORIGIN}/api/sync/${action}`, { method: 'POST', headers: { Origin: origin, 'X-Morse-Sync': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    server = await startLocalServer(directory);
    const page = await fetch(APP_ORIGIN); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const profile = newProfile(); profile.stats.xp = 123;
    const started = await send('start', { profile, label: 'Desktop' });
    assert.equal(started.status, 200);
    const cookie = started.headers.get('set-cookie').split(';')[0];
    assert.match(started.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await send('status', {}, cookie, 'https://example.org')).status, 403);
    await server.close(); server = await startLocalServer(directory);
    assert.equal((await (await send('status', {}, cookie)).json()).profile.stats.xp, 123);
    assert.ok((await readdir(directory)).includes('progress.sqlite'));
  } finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an occupied app port fails safely instead of switching origins or adopting another server', async () => {
  const occupied = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => occupied.listen(APP_PORT, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'morse-desktop-port-'));
  try {
    await assert.rejects(startLocalServer(directory), { code: 'EADDRINUSE' });
    assert.equal(await (await fetch(APP_ORIGIN)).text(), 'unrelated');
  } finally { await new Promise(resolve => occupied.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('staging contains only app code and assets, with local-only labels and one trainer entry point', async () => {
  await stageApp();
  const packageData = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  assert.equal(packageData.devDependencies, undefined); assert.equal(packageData.scripts, undefined);
  const html = await readFile(join(stage, 'website/public/index.html'), 'utf8');
  assert.equal(html.match(/src="\/js\/app.mjs"/g).length, 1);
  assert.ok(html.indexOf('src="/js/desktop-ui.mjs"') < html.indexOf('src="/js/app.mjs"'));
  const forbidden = /(^|\/)(\.env|\.git|artifacts|node_modules|compose\.yaml|sync\.sqlite|progress\.sqlite|AGENTS\.md)(\/|$)/;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(forbidden.test(join(directory, entry.name).slice(stage.length)), false);
      if (entry.isDirectory()) await walk(join(directory, entry.name));
    }
  }
  await walk(stage);
});
