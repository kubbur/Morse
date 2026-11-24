import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNative } from '../scripts/native.mjs';
import { PaddleService } from '../src/paddle-service.mjs';
import { NativeSidetone } from '../website/public/js/native-paddle.mjs';

test('isolated native helper persists volume and never arms typing, including after restart', { skip:process.platform !== 'darwin', timeout:20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(),'morse-helper-'));
  const binary = join(dir,'MorseKeyer');
  const settings = join(dir,'preferences');
  const original = join(settings,'paddle-before-merge.plist');
  const fixture = '<?xml version="1.0"?><plist version="1.0"><dict><key>sidetoneVolume</key><integer>62</integer><key>sidetoneSettings</key><dict><key>wpm</key><integer>27</integer></dict><key>paddlesSwapped</key><true/></dict></plist>';
  let service;
  try {
    await mkdir(settings);
    await writeFile(original,fixture,{flag:'wx'});
    buildNative(binary,[process.arch === 'arm64' ? 'arm64' : 'x86_64']);
    for (const fresh of [true,false]) {
      service = new PaddleService(binary,settings,()=>{},true);
      service.start();
      assert.deepEqual(await service.command('status'),{});
      assert.equal(service.status.source,'off');
      assert.deepEqual(await service.command('input','vband'),{});
      const usbEpoch=service.status.epoch;
      assert.equal(service.status.source,'vband');
      for (const [op,value] of [['calibrate'],['automatic'],['sample',false]]) {
        assert.match((await service.command(op,value)).error,/audio converter/);
      }
      assert.deepEqual(await service.command('input','paddle'),{});
      assert.ok(service.status.epoch>usbEpoch);
      assert.match((await service.command('vband',{epoch:usbEpoch,mask:1,session:service.status.session})).error,/interrupted/);
      assert.equal(service.status.source,'paddle');
      assert.deepEqual(await service.command('input','vband'),{});
      assert.match((await service.command('vband',{epoch:usbEpoch,mask:3,session:service.status.session})).error,/interrupted/);
      assert.deepEqual(await service.command('vband-release'),{});
      assert.deepEqual(await service.command('input','off'),{});
      assert.equal(service.status.legacyWpm,27);
      assert.ok(service.status.reverse);
      if (fresh) {
        assert.equal(service.status.volume,62);
        assert.deepEqual(await service.command('word-spaces',true),{});
        assert.deepEqual(await service.command('sound',{wpm:80,farnsworth:1,keyer:'b',pitch:1250,rise:3,fall:9,curve:2,volume:37}),{});
      }
      assert.deepEqual(await service.command('status'),{});
      assert.deepEqual([service.status.wpm,service.status.spacing,service.status.pitch,service.status.rise,service.status.fall,
        service.status.curve,service.status.volume,service.status.wordSpaces,service.status.sharedSound],[80,1,1250,3,9,2,37,true,true]);
      assert.equal(service.status.typing,false);
      assert.match((await service.command('arm',process.pid)).error,/Invalid paddle command/);
      assert.match((await service.command('arm')).error,/ready paddle/);
      assert.equal(service.status.canArm,false);
      assert.equal(service.status.typing,false);
      await service.stop();
      assert.equal(await readFile(original,'utf8'),fixture);
    }
  } finally { await service?.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('lost helper and stale sidetone acknowledgements require a new mute acknowledgement',async()=>{
  const replies=[],states=[];
  const tone=new NativeSidetone({paddle:()=>new Promise(resolve=>replies.push(resolve))},s=>states.push(s));
  assert.equal(await tone.setMuted(true),false);
  tone.setAvailable(true);
  const old=tone.setMuted(false);
  tone.setAvailable(false);tone.setAvailable(true);
  const fresh=tone.setMuted(false);
  replies[0]({});assert.equal(await old,false);
  assert.equal(tone.confirmed,null);
  replies[1]({});assert.equal(await fresh,true);
  assert.equal(tone.confirmed,false);assert.deepEqual(states,['sending']);
});
