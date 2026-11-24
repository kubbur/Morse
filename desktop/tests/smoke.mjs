import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { APP_ORIGIN } from '../src/policy.mjs';
import { root } from '../scripts/stage.mjs';

const executable = process.env.MORSE_DESKTOP_EXECUTABLE || (process.platform === 'darwin' ? join(root, `build/packages/Morse-darwin-${process.arch}/Morse.app/Contents/MacOS/Morse`) : join(root, 'build/packages/Morse-linux-x64/Morse'));
const temporary = await mkdtemp(join(tmpdir(), 'morse-desktop-smoke-'));
const output = join(root, 'build/test-results'); await mkdir(output, { recursive: true });
const checks = [], errors = [], clients = new Set();
const checked = message => { checks.push(message); console.log(`PASS ${message}`); };
let child, browser, log = '', seq = 0;
let muted = false;
const requests = [];
const bridge = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': APP_ORIGIN, 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
  if (req.headers.origin !== APP_ORIGIN) { res.writeHead(403); res.end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (['/sidetone/mute', '/sidetone/unmute'].includes(req.url) && req.method === 'PUT') {
    let bytes = 0; for await (const chunk of req) bytes += chunk.length;
    assert.equal(bytes, 0); muted = req.url === '/sidetone/mute'; requests.push(req.url);
    res.writeHead(204, cors); res.end(); return;
  }
  if (req.url !== '/events') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
  res.write(`event: paddle\ndata: ${JSON.stringify({ v: 1, seq: seq++, status: 'ready', dit: false, dah: false, timeMs: performance.now() })}\n\n`);
  clients.add(res); req.on('close', () => clients.delete(res));
});
const emit = (dit, dah) => { for (const res of clients) res.write(`event: paddle\ndata: ${JSON.stringify({ v: 1, seq: seq++, status: 'ready', dit, dah, timeMs: performance.now() })}\n\n`); };

async function launch() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const args = [`--user-data-dir=${join(temporary, 'profile')}`, `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-dev-shm-usage'];
  if (process.env.MORSE_DESKTOP_TEST_CONTAINER === '1') args.push('--no-sandbox');
  child = spawn(executable, args, { env: { ...process.env, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { log = (log + data).slice(-40000); }); child.stderr.on('data', data => { log = (log + data).slice(-40000); });
  let version;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited before its window opened: ${log}`);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error(`Desktop debugger did not open: ${log}`);
  // Attach after the first navigation commits. Attaching to Electron's initial
  // empty frame can leave Playwright waiting for a frame that was replaced.
  for (let i = 0; i < 120; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some(target => target.url.startsWith(APP_ORIGIN) && target.title === 'Morse code trainer')) break;
    if (i === 119) throw new Error(`Desktop navigation did not finish: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  context.setDefaultTimeout(15000);
  let page;
  for (let i = 0; i < 100; i++) {
    page = context.pages().find(page => page.url().startsWith(APP_ORIGIN));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw new Error(`No app window: ${log}`);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#play-signal').waitFor();
  return page;
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error(`Desktop did not quit: ${log}`)), 10000).unref())]);
  browser = null; child = null;
}
const saved = page => page.evaluate(() => { const data = JSON.parse(localStorage.getItem('morse.progress.v1')); return data.profiles.find(p => p.id === data.activeId); });
try {
  // Never operate an already-running personal copy or an actual paddle companion.
  try { await fetch(APP_ORIGIN, { signal: AbortSignal.timeout(300) }); throw new Error('Quit the existing Morse app before running the smoke test.'); } catch (error) { if (error.message.startsWith('Quit ')) throw error; }
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(17373, '127.0.0.1', resolve); });
  let page = await launch();
  await page.locator('#skip-callsign').click();
  if (await page.locator('#guidance-dialog').isVisible()) await page.keyboard.press('Escape');
  assert.equal((await saved(page)).stats.xp, 0, 'smoke test must use its own empty save');
  assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, secure: isSecureContext })), { require: 'undefined', process: 'undefined', secure: true });
  checked('packaged native window opens offline with isolated renderer and secure loopback origin');
  await page.locator('#play-signal').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('morse.progress.v1')).profiles[0].round.heard);
  await page.locator('#answer').fill((await saved(page)).round.target);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('morse.progress.v1')).profiles[0].stats.solved === 1);
  await page.locator('#open-progress').click();
  assert.equal(await page.locator('.device-sync').isVisible(), false);
  assert.match(await page.locator('#callsign-help').textContent(), /on this Mac/);
  checked('real listening playback, answer checking and local-only saved-progress controls');

  // Validate the export without automating the operating system's save dialog.
  const download = await page.evaluate(async () => {
    const originalURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
    let blob, filename;
    try {
      URL.createObjectURL = value => { blob = value; return originalURL(value); };
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      document.getElementById('export-progress').click();
    } finally { URL.createObjectURL = originalURL; HTMLAnchorElement.prototype.click = originalClick; }
    return { filename, contents: await blob.text() };
  });
  assert.match(download.filename, /^morse-progress-[\d-]+\.json$/);
  assert.equal(JSON.parse(download.contents).profiles[0].stats.solved, 1);
  checked('progress export produces valid current-save JSON with the expected filename');

  const exported = await page.evaluate(() => localStorage.getItem('morse.progress.v1'));
  const imported = JSON.parse(exported); imported.profiles[0].stats.xp = 4321; imported.profiles[0].settings.tone = 770;
  await page.locator('#import-file').setInputFiles({ name: 'desktop-progress.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await page.locator('#import-confirmation').waitFor(); await page.locator('#confirm-import').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('morse.progress.v1')).profiles[0].stats.xp === 4321);
  if (await page.locator('#guidance-dialog').isVisible()) await page.keyboard.press('Escape');
  checked('confirmed progress import through the sandboxed file worker');
  await page.screenshot({ path: join(output, 'desktop-practice.png'), fullPage: true });
  await stop(); page = await launch();
  assert.equal((await saved(page)).stats.xp, 4321); assert.equal((await saved(page)).settings.tone, 770);
  checked('save and sound preferences survive a full application quit and restart');
  await page.locator('.main-nav [data-view="send"]').click();
  await page.locator('#send-connect').click();
  await page.waitForFunction(() => document.getElementById('sender').dataset.sidetone === 'muted');
  emit(true, false); await page.waitForTimeout(20); emit(false, false);
  await page.waitForFunction(() => document.getElementById('send-target-label').textContent === 'SEND');
  assert.equal(muted, false);
  emit(true, false); await page.waitForTimeout(20); emit(false, false);
  await page.locator('#send-capture[data-result="good"]').waitFor();
  assert.equal((await saved(page)).sending.clean, 1);
  assert.ok(requests.includes('/sidetone/mute') && requests.includes('/sidetone/unmute'));
  await page.locator('#send-connect').click();
  checked('actual local SSE paddle contacts, empty PUT mute/unmute acknowledgements and automatic grading');
  await page.screenshot({ path: join(output, 'desktop-send.png'), fullPage: true });
  const before = page.url();
  await page.evaluate(() => window.open('https://example.org/'));
  await page.waitForTimeout(200); assert.equal(browser.contexts()[0].pages().length, 1); assert.equal(page.url(), before);
  const foreign = await page.evaluate(async () => { try { await fetch('https://example.org/'); return 'allowed'; } catch { return 'blocked'; } });
  assert.equal(foreign, 'blocked');
  checked('foreign fetch and pop-up navigation blocked');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'smoke.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, executable, checkedAt: new Date().toISOString(), checks, rendererErrors: errors, note: process.env.MORSE_DESKTOP_TEST_CONTAINER ? 'Linux desktop under Xvfb; no-sandbox is a test-only container launch flag. Physical macOS and Apple signing acceptance were not tested here.' : 'Native desktop acceptance.' }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) { await writeFile(join(output, 'failure.log'), log); throw error; }
finally {
  await stop().catch(() => { child?.kill('SIGKILL'); });
  for (const res of clients) res.end(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
