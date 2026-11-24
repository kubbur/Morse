import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableUpdate, checkUpdate } from '../src/updates.mjs';
import { UpdateManager } from '../src/update-manager.mjs';
import { downloadArchive, prepareMacUpdate } from '../src/update-archive.mjs';
import { LearnerDB } from '../src/learner-db.mjs';
import { root } from '../scripts/stage.mjs';

const bytes = Buffer.from('disposable release fixture'), digest = createHash('sha256').update(bytes).digest('hex');
const row = { tag_name:'morse-v2.0.0', body:'Local test <b>notes</b>', assets:[{name:'Morse-2.0.0-mac-arm64.zip',
  digest:'sha256:'+digest, size:bytes.length, browser_download_url:'https://example.invalid/other.zip'}] };
const release = availableUpdate([row],'1.9.0','arm64');
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(),'morse-mac-update-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}
const signal = () => new AbortController().signal;

test('only verified metadata for a published Morse asset enables installation',async()=>{
  assert.match(release.archive.url,/^https:\/\/github\.com\/kubbur\/Morse\/releases\/download\/morse-v2\.0\.0\/Morse-2\.0\.0-mac-arm64\.zip$/);
  assert.equal(release.notes,row.body);
  for (const fields of [{digest:null},{size:-1},{size:1e10},{digest:'sha1:'+digest}])
    assert.equal(availableUpdate([{...row,assets:[{...row.assets[0],...fields}]}],'1.5.0','arm64').archive,null);
  assert.equal(availableUpdate([{...row,assets:{}}],'1.0.0','arm64'),null);
  assert.equal(availableUpdate([row],'1.5.0','x64'),null);
  await assert.rejects(checkUpdate('1.0.0','arm64',async()=>new Response(null,{status:503})));
});

test('an interrupted or corrupt download preserves the previous ZIP and a retry verifies the new file',async t=>{
  const dir=await temporary(t), old=Buffer.from('previous verified file');
  await writeFile(join(dir,'Morse.zip'),old);
  await writeFile(join(dir,'Morse.zip.partial'),'interrupted before restart');
  for (const body of [Buffer.alloc(bytes.length-1),Buffer.alloc(bytes.length),Buffer.alloc(bytes.length+1)]) {
    await assert.rejects(downloadArchive(dir,release,signal(),async()=>new Response(body)));
    assert.deepEqual(await readFile(join(dir,'Morse.zip')),old);
    assert.deepEqual(await readdir(dir),['Morse.zip']);
  }
  let calls=0;
  await assert.rejects(downloadArchive(dir,release,signal(),async()=>{
    calls++; return new Response(null,{status:302,headers:{location:'https://example.invalid/private'}});
  }),/host/);
  assert.equal(calls,1);
  const url='https://release-assets.githubusercontent.com/test.zip';
  const path=await downloadArchive(dir,release,signal(),async target=>target.href===url ? new Response(bytes) :
    new Response(null,{status:302,headers:{location:url}}));
  assert.deepEqual(await readFile(path),bytes);
  assert.equal(await downloadArchive(dir,release,signal(),()=>assert.fail('Verified ZIP already cached')),path);

  class FixtureUpdater extends EventEmitter {
    setFeedURL({url}) { this.feed=fileURLToPath(url); }
    checkForUpdates() { this.emit('update-downloaded'); }
  }
  const native=new FixtureUpdater();
  await prepareMacUpdate(native,dir,release);
  const feed=JSON.parse(await readFile(native.feed));
  assert.equal(fileURLToPath(feed.url),path); assert.equal(feed.sha256,digest); assert.equal(feed.size,bytes.length);
  native.checkForUpdates=()=>native.emit('error',new Error('Signature rejected'));
  await assert.rejects(prepareMacUpdate(native,dir,release),/Signature rejected/);
  await writeFile(path,Buffer.alloc(bytes.length));
  await assert.rejects(prepareMacUpdate(native,dir,release),/changed/);
});

function manager(options={}) {
  return new UpdateManager({version:'1.0.0',installedNotes:'Previous notes',enabled:true,automatic:false,
    storeAutomatic(){}, lookup:async()=>release, download:async()=>{},stage:async()=>{},changed(){},...options});
}

test('manual updates wait for an explicit restart and a successful progress save',async()=>{
  const calls=[], updates=manager({download:async()=>calls.push('download'),stage:async()=>calls.push('stage')});
  await updates.check();
  assert.equal(updates.state().available,'2.0.0'); assert.deepEqual(calls,[]);
  await updates.prepareDownload(true); assert.deepEqual(calls,['download']);
  assert.equal(await updates.installAtQuit(false,()=>assert.fail('no update on ordinary quit')),false);
  assert.equal(await updates.installAtQuit(true,()=>false),false); assert.match(updates.state().message,/saved/);
  assert.equal(await updates.installAtQuit(true,()=>{calls.push('save');return true;}),true);
  assert.deepEqual(calls,['download','save','stage']);
});

test('automatic consent survives reopening the real database and stays separate from learner progress',async t=>{
  const path=join(await temporary(t),'profile.sqlite');
  let db=new LearnerDB(path); assert.equal(db.automaticUpdates,false);
  const updates=manager({storeAutomatic:value=>{db.automaticUpdates=value;}});
  updates.setAutomatic(true); await new Promise(resolve=>setImmediate(resolve));
  db.close(); db=new LearnerDB(path); assert.equal(db.automaticUpdates,true); assert.equal(db.load(null).raw,null);
  const calls=[], next=manager({automatic:db.automaticUpdates,storeAutomatic:v=>{db.automaticUpdates=v;},
    download:async()=>calls.push('fetch'), stage:async()=>calls.push('stage')});
  await next.check(); assert.deepEqual(calls,['fetch']);
  next.setAutomatic(false);
  assert.equal(await next.installAtQuit(false,()=>true),false);
  assert.deepEqual(calls,['fetch']);
  next.setAutomatic(true);
  assert.equal(await next.installAtQuit(false,()=>true),true);
  assert.deepEqual(calls,['fetch','stage']);
  db.close();
});

test('switching off during a download prevents staging and a failed native check leaves the update retryable',async()=>{
  let finish, downloads=0;
  const updates=manager({automatic:true,download:async(_release,signal)=>{
    downloads++; await new Promise((resolve,reject)=>{finish=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
  },stage:async()=>{throw Error('rejected');}});
  const pending=updates.check();
  await new Promise(resolve=>setImmediate(resolve));
  updates.setAutomatic(false); await pending;
  assert.equal(updates.state().ready,false); assert.equal(updates.wantsInstall(false),false);
  const retry=updates.prepareDownload(true); await updates.prepareDownload(true); finish(); await retry;
  assert.equal(downloads,2); assert.equal(updates.state().ready,true);
  assert.equal(await updates.installAtQuit(true,()=>true),false); assert.match(updates.state().message,/macOS/);
  const isolated=manager({enabled:false,lookup:()=>assert.fail('network used in an isolated session')});
  await isolated.check(); isolated.setAutomatic(true); assert.equal(isolated.automatic,false);
});

test('Squirrel validates an extracted disposable Mac app and rejects an altered copy',{skip:process.platform!=='darwin'},async t=>{
  const frameworks = [join(root,'node_modules/electron/dist/Electron.app/Contents/Frameworks'),
    join(root,'build/packages','Morse-darwin-'+process.arch,'Morse.app/Contents/Frameworks')].find(p=>existsSync(join(p,'Squirrel.framework')));
  if (!frameworks) { t.skip('Requires the pinned Mac Electron runtime'); return; }
  const dir=await temporary(t), installed=join(dir,'Fixture.app'), contents=join(installed,'Contents');
  const check=join(dir,'signature-check'), cache=join(dir,'cache'), extract=join(dir,'expanded');
  await mkdir(join(contents,'MacOS'),{recursive:true}); await mkdir(extract);
  await writeFile(join(contents,'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>digital.kubbur.morse.updatefixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
  execFileSync('xcrun',['clang','-x','c','-','-o',join(contents,'MacOS/Fixture')],{input:'int main(void){return 0;}'});
  execFileSync('codesign',['--force','--sign','-',installed],{stdio:'pipe'});
  execFileSync('xcrun',['clang','-fobjc-arc','-F',frameworks,'-Wl,-rpath,'+frameworks,'-framework','Squirrel','-framework','Foundation',
    join(root,'tests/fixtures/update-signature.m'),'-o',check]);
  const zip=join(dir,'fixture.zip');
  execFileSync('ditto',['-c','-k','--keepParent',installed,zip]);
  const body=await readFile(zip);
  const localRelease={...release,archive:{...release.archive,size:body.length,digest:createHash('sha256').update(body).digest('hex')}};
  await downloadArchive(cache,localRelease,signal(),async()=>new Response(body));
  const native=new EventEmitter();
  native.setFeedURL=({url})=>{native.feed=fileURLToPath(url);};
  native.checkForUpdates=()=>{void (async()=>{
    const feed=JSON.parse(await readFile(native.feed,'utf8'));
    execFileSync('ditto',['-x','-k',fileURLToPath(feed.url),extract]);
    execFileSync(check,[installed,join(extract,'Fixture.app')]);
    native.emit('update-downloaded');
  })().catch(error=>native.emit('error',error));};
  await prepareMacUpdate(native,cache,localRelease);
  await writeFile(join(extract,'Fixture.app/Contents/MacOS/Fixture'),'damaged fixture');
  assert.equal(spawnSync(check,[installed,join(extract,'Fixture.app')]).status,1);
  execFileSync('codesign',['--verify','--strict',installed]);
});
