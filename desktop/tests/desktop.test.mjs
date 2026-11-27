import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ORIGIN, allowedRequest, allowedPermission, appDocument, channelForBuild, websiteProfileDirectory, progressExport } from '../src/policy.mjs';
import { bundledTrainer } from '../src/bundled-trainer.mjs';
import { stageApp, stage } from '../scripts/stage.mjs';
import { LESSONS, COURSE_LEVELS, courseStage } from '../website/public/js/lessons.mjs';
import { SENDING_LEVELS, sendingStage } from '../website/public/js/sending-course.mjs';
import { availableUpdate } from '../src/updates.mjs';
import { validCommand } from '../src/paddle-service.mjs';

test('sandbox exposes only bundled documents and explicitly needed permissions',()=>{
  assert.ok(appDocument(APP_ORIGIN+'/#send')); assert.ok(progressExport('blob:'+APP_ORIGIN+'/progress','morse-progress-2026-11-27.json'));
  assert.ok(progressExport('blob:'+APP_ORIGIN+'/code','Morse-Dev-recovery-TF3KBR-P-2026-11-27T20-30-06Z.txt'));
  assert.equal(progressExport('blob:'+APP_ORIGIN+'/code','arbitrary.txt'),false);
  for(const url of ['file:///tmp/x','http://127.0.0.1:17373/events','http://127.0.0.1:38764/api/v2/','https://morse.kubbur.digital/','https://morse-dev.kubbur.digital/','https://github.com/']) assert.equal(allowedRequest(url),false);
  assert.ok(allowedRequest(APP_ORIGIN+'/js/app.mjs'));
  assert.equal(allowedRequest(APP_ORIGIN+'/api/sync/start','POST'),false);
  for(const p of ['microphone','geolocation','media','accessibility','loopback-network']) assert.equal(allowedPermission(p,APP_ORIGIN,APP_ORIGIN),false);
  assert.ok(allowedPermission('screen-wake-lock',APP_ORIGIN,APP_ORIGIN));
  assert.equal(validCommand('keyer',{wpm:300,farnsworth:5,keyer:'a'}),false);
  assert.equal(validCommand('type','arbitrary text'),false);
});
test('the installed build selects the service and keeps earlier Dev queues outside the new profile', () => {
  assert.equal(channelForBuild('1.1.5', true), 'stable');
  assert.equal(channelForBuild('1.1.6-dev.27', true), 'dev');
  assert.equal(channelForBuild('1.1.5', false), 'dev');
  assert.equal(websiteProfileDirectory('/profiles/Morse Development', 'website', 'dev'),
    '/profiles/Morse Development/morse-dev.kubbur.digital');
  assert.equal(websiteProfileDirectory('/profiles/Morse', 'website', 'stable'), '/profiles/Morse');
  for (const mode of ['staging', 'offline']) assert.equal(websiteProfileDirectory('/test', mode, 'dev'), '/test');
});
test('every lesson and its static dependency closure is bundled on a fresh offline installation',async()=>{
  await stageApp();
  const root=join(stage,'website/public'), handle=await bundledTrainer(root);
  const get=async path=>handle(new Request(new URL(path,APP_ORIGIN)));
  const page=await get('/'); assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/connect-src 'self';/);
  const html=await page.text();
  assert.equal(html.match(/src="\/js\/app.mjs"/g).length,1);
  assert.ok(html.indexOf('/js/desktop-ui.mjs')<html.indexOf('/js/app.mjs'));
  async function visit(dir,route) {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const path=route+'/'+e.name;
      if(e.isDirectory()) await visit(join(dir,e.name),path);
      else {
        const file=await get(path); assert.equal(file.status,200,path);
        const text=await file.text();
        const paths=path.endsWith('.mjs') ? [...text.matchAll(/(?:from\s+|import\s*\(|new URL\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)].map(m=>m[1])
          : path.endsWith('.css') ? [...text.matchAll(/url\(\s*['"]?([^)'"]+)/g)].map(m=>m[1])
          : path.endsWith('.html') ? [...text.matchAll(/(?:src|href)="(\/[^"#]+\.(?:mjs|css|svg|png|woff2|wav))"/g)].map(m=>m[1]) : [];
        for(const ref of paths) { if(ref.startsWith('data:')) continue; const asset=new URL(ref,new URL(path,APP_ORIGIN)); assert.equal(asset.origin,APP_ORIGIN); assert.equal((await get(asset)).status,200,asset.href); }
      }
    }
  }
  await visit(root,'');
  assert.ok(LESSONS.length>1);
  for(let i=1;i<=COURSE_LEVELS;i++) assert.ok(courseStage(i));
  for(let i=1;i<=SENDING_LEVELS;i++) assert.ok(sendingStage(i).items.length);
  assert.equal((await get('https://example.com/js/app.mjs')).status,403);
  assert.equal((await get('/api/sync/start')).status,404);
  assert.equal(JSON.parse(await readFile(join(stage,'package.json'))).devDependencies,undefined);
});
test('update notice selects published Morse desktop version and matching CPU asset',()=>{
 const release=(tag,assets,more={})=>({tag_name:tag,assets:assets.map(name=>({name})),...more});
 const rows=[release('paddle-v9.0.0',[]),release('morse-v2.0.0',['Morse-2.0.0-mac-x64.zip']),release('morse-v1.2.0',['Morse-1.2.0-mac-arm64.zip']),release('morse-v4.0.0',['Morse-4.0.0-mac-arm64.zip'],{prerelease:true})];
 assert.equal(availableUpdate(rows,'1.1.0','arm64').version,'1.2.0');
 assert.equal(availableUpdate(rows,'1.1.0','x64').version,'2.0.0');
 assert.equal(availableUpdate(rows,'2.1.0','x64'),null);
 assert.equal(availableUpdate(rows,'1.2.0-dev.1','arm64').version,'1.2.0');
});
