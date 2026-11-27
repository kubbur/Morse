import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNative } from '../scripts/native.mjs';
import { PaddleService } from '../src/paddle-service.mjs';
import { ShackBackground } from '../src/shack-background.mjs';
import { NativeSidetone } from '../website/public/js/native-paddle.mjs';

test('isolated native helper persists volume and never arms typing, including after restart', { skip:process.platform !== 'darwin', timeout:90000 }, async () => {
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
      assert.match((await service.command('arm')).error,/starting/);
      assert.deepEqual(await service.command('status'),{});
      assert.deepEqual(await service.command('capture-position'),{sequence:0});
      assert.match((await service.command('shack-key-access')).error,/Input Monitoring/);
      assert.match((await service.command('shack-keys',{source:'keyboard',dit:'z',dah:'x',epoch:1})).error,/Input Monitoring/);
      assert.deepEqual(await service.command('shack-keys',null),{});
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
        assert.deepEqual(await service.command('sound',{wpm:80,farnsworth:1,keyer:'b',pitch:1250,rise:3,fall:9,curve:2,volume:37}),{sequence:0});
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

test('background paddle keys arm only on air and release across focus, lock, helper restart and departure',()=>{
  const commands=[],notices=[],throttling=[];
  const radio=new ShackBackground({command:async(op,keys)=>{commands.push([op,keys]);return {};},
    notify:e=>notices.push(e),throttle:x=>throttling.push(x)});
  const keys={source:'keyboard',dit:'z',dah:'x'};
  radio.available=true;
  radio.configure({listening:false,keys:null,generation:0});
  radio.configure(null);
  assert.deepEqual(throttling,[]);
  radio.configure({listening:true,keys:null,generation:1});
  radio.focused=false; radio.refresh();
  assert.deepEqual(commands,[]);
  radio.configure({listening:true,keys:{...keys,dah:'z'},generation:2});
  assert.deepEqual(commands,[]);
  radio.configure({listening:true,keys,generation:3});
  const first=radio.epoch;
  assert.deepEqual(commands.at(-1),['shack-keys',{...keys,epoch:first}]);
  radio.contact({epoch:first,mask:1,at:51,unrelated:'never forwarded'});
  assert.equal(notices.at(-1).mask,1);
  assert.equal('unrelated' in notices.at(-1),false);
  for (const [flag,off,on] of [['focused',true,false],['locked',true,false],['sleeping',true,false],['available',false,true]]) {
    const epoch=radio.epoch;
    radio[flag]=off; radio.refresh();
    assert.deepEqual(notices.at(-1),{generation:3,reset:true});
    const count=notices.length; radio.contact({epoch,mask:3,at:52});
    assert.equal(notices.length,count);
    radio[flag]=on; radio.refresh();
    assert.ok(radio.epoch>epoch);
    assert.deepEqual(commands.at(-1),['shack-keys',{...keys,epoch:radio.epoch}]);
  }
  const beforeLeave=radio.epoch;
  radio.configure({listening:false,keys:null,generation:4});
  assert.equal(throttling.at(-1),true);
  assert.deepEqual(commands.at(-1),['shack-keys',null]);
  const count=notices.length; radio.contact({epoch:beforeLeave,mask:2,at:56});
  assert.equal(notices.length,count);
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
