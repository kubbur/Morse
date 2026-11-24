import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, createApp, validateBoundary } from '../../website/server.mjs';

const next = 'https://trainer.example';
const previous = 'https://previous.example';
const settings = {
  MORSE_PUBLIC_ORIGIN: next, MORSE_LEGACY_ORIGINS: previous,
  MORSE_TRUSTED_PROXY_IP: '192.0.2.10', MORSE_EDGE_IP: '198.51.100.20',
};

test('canonical and configured earlier origins accept only their own requests', () => {
  const config = configuration(settings);
  assert.equal(config.moveFromOrigin, previous);
  for (const origin of [next, previous]) {
    const host = new URL(origin).host;
    const headers = { host, origin, 'x-forwarded-host': host, 'x-forwarded-proto': 'https',
      'x-forwarded-port': '443', 'x-forwarded-for': settings.MORSE_EDGE_IP };
    const request = { method: 'POST', url: '/api/sync/status', headers, rawHeaders: Object.entries(headers).flat(),
      socket: { remoteAddress: settings.MORSE_TRUSTED_PROXY_IP } };
    assert.equal(validateBoundary(request, config), null);
    const wrong = { ...headers, origin: origin === next ? previous : next };
    assert.ok(validateBoundary({ ...request, headers: wrong, rawHeaders: Object.entries(wrong).flat() }, config));
  }
  for (const origin of ['http://previous.example', previous + '/path', 'https://user:pass@previous.example'])
    assert.throws(() => configuration({ ...settings, MORSE_LEGACY_ORIGINS: origin }));
});

test('an edge and any previous origin must be explicitly configured for that deployment', () => {
  assert.throws(() => configuration({ ...settings, MORSE_EDGE_IP: '' }));
  assert.throws(() => configuration({ ...settings, MORSE_MOVE_FROM_ORIGIN: 'https://elsewhere.example' }));
  const multiple = { ...settings, MORSE_LEGACY_ORIGINS: previous + ',https://earlier.example' };
  assert.equal(configuration(multiple).moveFromOrigin, '');
  assert.equal(configuration({ ...multiple, MORSE_MOVE_FROM_ORIGIN: previous }).moveFromOrigin, previous);
  assert.equal(configuration({ MORSE_PUBLIC_ORIGIN: next }).moveFromOrigin, '');
});

test('the transfer page gets its addresses from the deployment on both sides of a move', async t => {
  const server = await createApp(configuration(settings));
  t.after(() => server.close());
  for (const origin of [previous, next]) {
    const host = new URL(origin).host;
    const headers = { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https',
      'x-forwarded-port': '443', 'x-forwarded-for': settings.MORSE_EDGE_IP };
    let status, html;
    server.emit('request', { method: 'GET', url: '/move-progress', headers,
      rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: settings.MORSE_TRUSTED_PROXY_IP } },
    { setHeader() {}, writeHead(code) { status = code; }, end(body) { html = body.toString(); } });
    assert.equal(status, 200);
    assert.ok(html.includes(`data-move-from="${encodeURIComponent(previous)}" data-move-to="${encodeURIComponent(next)}"`));
  }
});
