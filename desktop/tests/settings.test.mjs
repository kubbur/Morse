import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, stageApp } from '../scripts/stage.mjs';
import { newProfile, newState, importState, STORAGE_KEY } from '../website/public/js/progress.mjs';
import { previousSounds, nativeSound } from '../website/public/js/shared-sound.mjs';
import { PracticeStorage } from '../website/public/js/practice-storage.mjs';
import { syncProfile } from '../website/public/js/sync-data.mjs';
import { KeyTone } from '../website/public/js/send-ui.mjs';
import { envelopeAt, rampGain } from '../website/public/js/morse.mjs';

function oldSave() {
  const state=newState(), p=state.profiles[0];
  delete p.soundVersion;
  p.settings={...p.settings,courseLevel:20,tone:574};
  Object.assign(p.sending.settings,{wpm:24,farnsworth:18,keyer:'b'});
  p.sending.level=9; p.stats.xp=70; p.guidance.welcomed=true;
  const other=newProfile('Old save'); other.stats.xp=11; state.profiles.push(other);
  return state;
}

test('old speeds remain selectable after repeated imports and private sync omits the local choice',()=>{
  const original=oldSave(), state=importState(JSON.stringify(original)), p=state.profiles[0];
  assert.deepEqual(importState(JSON.stringify(state)),state);
  assert.deepEqual(p.previousTiming,{wpm:24,farnsworth:18});
  assert.equal(p.settings.tone,550);
  const options=previousSounds(p,{hasTone:true,hasVolume:true,wpm:80,spacing:1,pitch:1777,rise:1,fall:30,curve:2,volume:0});
  assert.deepEqual(options.map(x=>x.label),['Listen','Send','Paddle']);
  assert.deepEqual(nativeSound({...options[2].settings,keyer:'b'}),{wpm:80,farnsworth:1,keyer:'b',pitch:1800,rise:1,fall:30,curve:2,volume:0});
  assert.equal(syncProfile(p).previousTiming,undefined);
  assert.equal(previousSounds(p,{hasTone:false,hasVolume:false}).length,2);
  assert.equal(state.profiles.length,2); assert.equal(p.stats.xp,70);
});

test('the original learner data survives a failed pre-migration backup and is backed up once on retry',()=>{
  const original=oldSave(), raw=JSON.stringify({...original,delivery:{version:1,learners:{}}});
  const values=new Map([[STORAGE_KEY,raw]]); let blocked=true;
  const store=new PracticeStorage({ getItem:key=>values.get(key) || null,
    setItem(key,value){if(blocked && key.endsWith('before-shared-sound')) throw Error('full');values.set(key,value);} });
  const migrated=JSON.stringify(importState(JSON.stringify(original)));
  assert.throws(()=>store.setItem(STORAGE_KEY,migrated),/full/);
  assert.equal(values.get(STORAGE_KEY),raw);
  blocked=false;store.setItem(STORAGE_KEY,migrated);
  const backup=values.get(STORAGE_KEY+'.before-shared-sound');
  assert.deepEqual(JSON.parse(backup),original);
  store.setItem(STORAGE_KEY,migrated); assert.equal(values.get(STORAGE_KEY+'.before-shared-sound'),backup);
});

test('keyboard sidetone uses the selected envelope and releases from the level reached on a short tap',async t=>{
  const events=[];
  class Context {
    currentTime=0; destination={};
    async resume(){} async suspend(){}
    createOscillator(){return {frequency:{},connect(x){return x;},start(){},stop(){},disconnect(){}};}
    createGain(){return {connect(){},disconnect(){},gain:{cancelScheduledValues(){},setValueAtTime(value,at){events.push({value,at});},
      linearRampToValueAtTime(value,at){events.push({value,at});}}};}
  }
  const saved=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});
  t.after(()=>saved ? Object.defineProperty(globalThis,'AudioContext',saved) : delete globalThis.AudioContext);
  for(const curve of ['smooth','linear','exponential']) {
    const note=new KeyTone(), settings={curve,rise:12,fall:6,volume:50,tone:800};
    await note.set(true,settings); note.context.currentTime=.003; events.length=0;
    await note.set(false,settings);
    const amplitude=.115*rampGain(.25,curve);
    assert.ok(Math.abs(events[0].value-amplitude)<1e-10);
    assert.ok(Math.abs(events.at(-1).at-.009)<1e-10); assert.equal(events.at(-1).value,0);
    if(curve!=='linear') assert.ok(Math.abs(events[12].value-amplitude*rampGain(.5,curve))<1e-10);
    assert.equal(envelopeAt(.003,.05,12,6,curve),rampGain(.25,curve));
    note.release();
  }
});

test('Mac and browser settings, course reset and recovery controls in an offline WebKit view',{skip:process.platform!=='darwin',timeout:390000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'morse-settings-view-'));
  try {
    const binary=join(dir,'view'), fixtures=join(root,'tests/fixtures');
    execFileSync('xcrun',['clang','-fobjc-arc','-Wno-deprecated-declarations','-framework','WebKit','-framework','AppKit','-framework','Foundation',join(fixtures,'settings-view.m'),'-o',binary]);
    const staged=await stageApp(join(dir,'staged')), setup=await readFile(join(fixtures,'settings-bootstrap.js'),'utf8');
    const cases = [
      ...['browser','mac-local','mac-staging','mac-website'].map(mode => [mode, 'settings-scenario.js']),
      ...['browser','mac-website'].map(mode => [mode, 'sending-controls-scenario.js']),
      ['browser','sending-feedback-scenario.js'],
    ];
    for(const [mode, scenario] of cases) await t.test(mode+' '+scenario,async()=>{
      const bootstrap=join(dir,mode+'.js');
      await writeFile(bootstrap,'window.fixture='+JSON.stringify({mode,state:oldSave()})+';\n'+setup);
      const base=mode==='browser' ? root : staged;
      execFileSync(binary,[join(base,'website/public'),bootstrap,join(fixtures,scenario)],{timeout:60000,stdio:'pipe'});
    });
  } finally {await rm(dir,{recursive:true,force:true});}
});
