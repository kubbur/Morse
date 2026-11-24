import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
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
let context;
async function launch() {
  context=await chromium.launchPersistentContext(join(temporary,'profile'),{
    executablePath:executable, headless:false, timeout:20000,
    args:['--morse-isolated','--disable-gpu','--disable-background-networking'],
    ignoreDefaultArgs:['--no-sandbox'], chromiumSandbox:true,
    env:{...process.env,XDG_CONFIG_HOME:join(temporary,'config'),XDG_CACHE_HOME:join(temporary,'cache')},
  });
  const page=await Promise.race([new Promise(resolve=>{
    const timer=setInterval(()=>{
      const p=context.pages().find(p=>p.url().startsWith(APP_ORIGIN));
      if (p) {clearInterval(timer);resolve(p);}
    },100); timer.unref();
  }),new Promise((_,reject)=>setTimeout(()=>reject(Error('Morse window unavailable')),15000).unref())]);
  page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#play-signal').waitFor();
  return page;
}
async function stop() { if(context) { await context.close(); context=null; } }
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
  await page.locator('.main-nav [data-view="send"]').click();
  await page.locator('#send-listen').click();
  await page.waitForFunction(()=>document.getElementById('send-target-label').textContent==='SEND');
  await page.keyboard.down('z');await page.waitForTimeout(15);await page.keyboard.up('z');
  await page.locator('#send-capture[data-result="good"]').waitFor();
  checked('bundled private helper responds, sending lesson grades keyboard input');
  const before = page.url();
  await page.evaluate(() => window.open('https://example.org/'));
  await page.waitForTimeout(200); assert.equal(context.pages().filter(p=>p.url().startsWith(APP_ORIGIN)).length, 1); assert.equal(page.url(), before);
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
