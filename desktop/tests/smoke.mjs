import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ORIGIN } from '../src/policy.mjs';
import { root } from '../scripts/stage.mjs';

const executable = process.env.MORSE_DESKTOP_EXECUTABLE || (process.platform === 'darwin' ? join(root, `build/packages/Morse-darwin-${process.arch}/Morse.app/Contents/MacOS/Morse`) : join(root, 'build/packages/Morse-linux-x64/Morse'));
const temporary = await mkdtemp(join(tmpdir(), 'morse-desktop-smoke-'));
const output = join(root, 'build/test-results'); await mkdir(output, { recursive: true });
const checks = [], errors=[];
const checked=message=>{checks.push(message); console.log('PASS '+message);};
let child, browser;
async function launch() {
  const args = ['--morse-isolated', '--disable-gpu', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(temporary,'profile')}`];
  child = spawn(executable, args, { stdio: ['ignore','pipe','pipe'],
    env: {...process.env, XDG_CONFIG_HOME:join(temporary,'config'), XDG_CACHE_HOME:join(temporary,'cache')},
  });
  let log = '', endpoint, startError;
  const capture = chunk => {
    log = (log + chunk).slice(-20000);
    endpoint ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f-]+)/i.exec(log)?.[1];
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', error => { startError = error; });
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (startError) throw startError;
    if (child.exitCode !== null || child.signalCode) throw Error(`Morse exited during launch (${child.signalCode || child.exitCode}). ${log.slice(-1200)}`);
    if (endpoint) {
      const url = new URL(endpoint);
      const response = await fetch(`http://${url.host}/json/list`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (response?.ok) ready = (await response.json()).some(t => t.url === APP_ORIGIN + '/' && t.type === 'page');
    }
    if (!ready) await delay(100);
  }
  if (!ready) throw Error(`Morse did not open the practice window. Debugger announced: ${!!endpoint}. ${log.slice(-1200)}`);
  // Electron publishes Chromium's debugger endpoint after launch. Its first
  // empty frame is replaced when the bundled trainer commits navigation.
  browser = await chromium.connectOverCDP(endpoint, {timeout:15000});
  const page = browser.contexts()[0].pages().find(p => p.url() === APP_ORIGIN + '/');
  assert.ok(page, 'Bundled practice page is available');
  page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#play-signal').waitFor();
  return page;
}
async function stop() {
  if (child && child.exitCode === null && !child.signalCode && child.pid) {
    const ended = once(child,'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 10000);
    try {
      const [code, signal] = await ended;
      assert.equal(signal, null, 'Morse must quit through its normal lifecycle');
      assert.equal(code, 0);
    } finally { clearTimeout(timer); }
  }
  await browser?.close(); browser = null; child = null;
}
const saved=page=>page.evaluate(()=>{const data=JSON.parse(window.morseMac.loadSave(null).raw);return data.profiles.find(p=>p.id===data.activeId);});
try {
  let page=await launch();
  await page.locator('#skip-callsign').click();
  if(await page.locator('#guidance-dialog').isVisible()) await page.keyboard.press('Escape');
  assert.equal((await saved(page)).stats.xp,0);
  assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process,isSecureContext]),['undefined','undefined',true]);
  checked('fresh isolated offline profile and sandboxed practice window');
  await page.locator('#play-signal').click();
  await page.waitForFunction(()=>JSON.parse(morseMac.loadSave(null).raw).profiles[0].round.heard);
  await page.locator('#answer').fill((await saved(page)).round.target);
  await page.waitForFunction(()=>JSON.parse(morseMac.loadSave(null).raw).profiles[0].stats.solved===1);
  await page.locator('#open-progress').click();
  assert.equal(await page.locator('.device-sync').isVisible(),true);
  checked('bundled listening lesson and local result write without a network connection');
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

  const exported = await page.evaluate(() => morseMac.loadSave(null).raw);
  const imported = JSON.parse(exported); imported.profiles[0].stats.xp = 4321; imported.profiles[0].settings.tone = 770;
  await page.locator('#import-file').setInputFiles({ name: 'desktop-progress.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await page.locator('#import-confirmation').waitFor(); await page.locator('#confirm-import').click();
  await page.waitForFunction(() => JSON.parse(morseMac.loadSave(null).raw).profiles[0].stats.xp === 4321);
  if (await page.locator('#guidance-dialog').isVisible()) await page.keyboard.press('Escape');
  checked('confirmed progress import through the sandboxed file worker');
  await page.screenshot({ path: join(output, 'desktop-practice.png'), fullPage: true });
  await stop(); page = await launch();
  assert.equal((await saved(page)).stats.xp, 4321); assert.equal((await saved(page)).settings.tone, 750);
  checked('save and sound preferences survive a full application quit and restart');
  await page.locator('.main-nav [data-view="send"]').click();
  assert.equal(await page.locator('#send-connect').isVisible(),false);
  await page.locator('#send-setup summary').click();
  assert.deepEqual(await page.locator('#send-setup input').evaluateAll(nodes=>nodes.map(n=>n.id)),['send-wpm','send-farnsworth','send-pitch','send-volume']);
  await page.locator('#send-pitch').focus(); await page.keyboard.press('ArrowRight');
  assert.equal((await saved(page)).settings.tone,800);
  await page.locator('.main-nav [data-view="practice"]').click();
  assert.equal(await page.locator('#summary-tone').innerText(),'800 Hz');
  assert.equal(await page.locator('#send-pitch').isVisible(),false);
  assert.equal(await page.locator('.main-nav [data-view="practice"]').innerText(),'Listen');
  await page.locator('.main-nav [data-view="lab"]').click();
  await page.locator('#lab-curve').selectOption('exponential');
  assert.equal((await saved(page)).settings.curve,'exponential');
  const helper=await page.evaluate(()=>morseMac.paddle('status'));
  assert.equal(helper.error,undefined);
  assert.equal(await page.locator('#send-source').inputValue(),'paddle');
  await page.locator('#send-source').selectOption('vband');
  assert.match(await page.locator('#send-connection').innerText(),/Left Control sends dit.*Right Control sends dah/);
  assert.equal(await page.locator('#native-start').isVisible(),false);
  await stop(); page=await launch();
  await page.locator('.main-nav [data-view="lab"]').click();
  assert.equal(await page.locator('#send-source').inputValue(),'vband');
  await page.locator('#send-source').selectOption('paddle');
  assert.equal(await page.locator('#native-start').isVisible(),true);
  checked('adapter selection survives quit and relaunch, and calibration is available for the audio converter');
  await page.locator('#send-source').selectOption('keyboard');
  await page.locator('#paddle-dot-key').fill('j');
  await page.locator('#paddle-dash-key').fill('k');
  await page.locator('#paddle-bindings button').click();
  await page.locator('#show-paddle-buttons').uncheck();
  await page.locator('#send-pause').press('End');
  await page.locator('#send-continue-mode').selectOption('manual');
  await stop(); page=await launch();
  await page.locator('.main-nav [data-view="lab"]').click();
  assert.equal(await page.locator('#paddle-dot-key').inputValue(),'J');
  assert.equal(await page.locator('#paddle-dash-key').inputValue(),'K');
  assert.equal(await page.locator('#send-continue-mode').inputValue(),'manual');
  assert.equal(await page.locator('#send-pause').inputValue(),'15');
  await page.locator('.main-nav [data-view="send"]').click();
  assert.equal(await page.locator('#send-key-controls').isVisible(),false);
  await page.locator('#send-listen').click();
  await page.waitForFunction(()=>document.getElementById('send-target-label').textContent==='SEND');
  await page.keyboard.down('j');await page.waitForTimeout(15);await page.keyboard.up('j');
  await page.locator('#send-capture[data-result="good"]').waitFor();
  checked('custom paddle keys, hidden buttons and sending pace survive relaunch and grade keyboard input');
  const before = page.url();
  await page.evaluate(() => window.open('https://example.org/'));
  await page.waitForTimeout(200); assert.equal(page.context().pages().filter(p=>p.url().startsWith(APP_ORIGIN)).length, 1); assert.equal(page.url(), before);
  const foreign = await page.evaluate(async () => { try { await fetch('https://example.org/'); return 'allowed'; } catch { return 'blocked'; } });
  assert.equal(foreign, 'blocked');
  checked('foreign fetch and pop-up navigation blocked');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'smoke.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, executable, checkedAt: new Date().toISOString(), checks, rendererErrors: errors, note: process.env.MORSE_DESKTOP_TEST_CONTAINER ? 'Linux desktop under Xvfb; no-sandbox is a test-only container launch flag. Physical macOS and Apple signing acceptance were not tested here.' : 'Isolated packaged UI; hardware and permission grants were not exercised.' }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await stop();
  await rm(temporary,{recursive:true,force:true});
}
