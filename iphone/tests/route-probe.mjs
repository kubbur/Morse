import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped screen with device reports. Hearing and actual iOS routing
// are physical tests; the screen must never infer either from successful callbacks.
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const elements = new Map([...read('../probe.html').matchAll(/id="([^"]+)"/g)].map(([,id]) =>
  [id, {classList:{toggle(){}}, checked:false, disabled:false}]));
const status = {session:3, epoch:1, phase:'ready', outputReady:false, detail:'Wired capture'};
const row = {status, testMode:'speaker', active:1, inputs:[], outputs:[], availableInputs:[],
  rate:48000, mask:0, capturedFrames:96000, audibleFrames:0, returnedSidetoneFrames:0,
  contactPlayerRunning:1, canAdvanceRoute:true, wiredBaseline:true, routeStrategy:'wired-first multiroute'};
const commands = [];
let now = 0;
const context = vm.createContext({
  document:{hidden:false, getElementById:id=>elements.get(id), addEventListener(){}},
  setInterval(){}, performance:{now:()=>now}, localStorage:{setItem(){}},
  morsePhone:{post:async request=>{
    if (request.op === 'snapshot') return row;
    commands.push(request);
    return {};
  }}, deviceReport:row
});
const run = script => vm.runInContext(script,context);
run(read('../probe.js'));
await new Promise(resolve=>setImmediate(resolve));
await elements.get('start').onclick();

function sequence() {
  for (const mask of [0,1,0,2,0,3,0]) {
    row.mask=mask;
    run('draw(deviceReport)');
    now+=300;
    run('draw(deviceReport)');
  }
}
sequence();
await new Promise(resolve=>setImmediate(resolve));
run('draw(deviceReport)');
assert.equal(commands.filter(r=>r.name==='next-route' && r.value.baseline).length,1);
assert.equal(run('canConfirmSound()'),false);

// An output can join without restarting the wired streams. Require fresh contacts
// in the new keyer epoch, fresh microphone frames, returned marks and actual hearing.
Object.assign(row,{wiredBaseline:false,sidetoneOutput:{name:'Speaker'},sidetoneDestination:'speaker',
  outputAttempt:{target:{name:'Speaker'},listedWhenAddressed:false,startStatus:0,inputFramesBefore:96000},
  returnedSidetoneBuffers:5,returnedSidetoneFrames:100});
Object.assign(status,{epoch:2,outputReady:true});
run('draw(deviceReport)');
assert.equal(run('index'),0);
sequence();
row.returnedSidetoneFrames+=100;
assert.equal(run('canConfirmSound()'),false);
row.capturedFrames+=2400;
assert.equal(run('canConfirmSound()'),true);
assert.doesNotMatch(run('verdict()'),/^Passed/);
elements.get('heard').checked=true;
assert.match(run('verdict()'),/^Passed/);
await elements.get('heard').onchange();
assert.equal(commands.at(-1).value.epoch,2);
row.outputAttempt.startStatus=null;
assert.equal(run('canConfirmSound()'),false);
row.routesExhausted=true;
assert.doesNotMatch(run('verdict()'),/^Passed/);
console.log('PASS wired-first advance, fresh post-bind contacts and frames, hearing confirmation, rejected route.');

// Keep the same session throughout a manual output change. Pre-switch keying,
// a frozen mic and an interrupted session must never produce a passing report.
Object.assign(row,{testMode:'airpods-switch',routeStrategy:'retain wired streams through output switch',
  routesExhausted:false,wiredBaseline:false,canAdvanceRoute:false,sidetoneOutput:null,outputAttempt:null,
  sidetoneDestination:null,contactStates:[],returnedSidetoneFrames:0});
const trial=row.switchTest={inputAssignmentStatus:0,clientRate:48000,finished:'',atSwitch:null,
  before:{originalMicListed:true,originalJackListed:true,capturedFrames:96000},
  current:{sameInputQueue:true,samePlayer:true,playerPlaying:true,destinationListed:false,
    originalMicListed:true,inputQueueRunning:1,inputIdleSeconds:0,inputError:0,sidetoneError:0,capturedFrames:96000}};
await elements.get('switch-start').onclick();
sequence();
assert.equal(run('index'),0);
assert.equal(run('verdict()'),'AirPods switch unobserved.');
assert.equal(commands.filter(r=>r.name==='next-route').length,1);
row.capturedFrames=120000;
trial.atSwitch={time:12,capturedFrames:96000};
Object.assign(trial.current,{destinationListed:true,capturedFrames:row.capturedFrames});
Object.assign(row,{sidetoneOutput:{name:'AirPods Pro'},sidetoneDestination:'airpods',
  outputAttempt:{startStatus:0},returnedSidetoneFrames:100});
sequence(); // Wall time advances while input frames stay frozen.
assert.equal(run('index'),0);
for (const mask of [0,1,0,2,0,3,0]) {
  row.mask=mask;
  run('draw(deviceReport)');
  now+=300; row.capturedFrames+=14400; trial.current.capturedFrames=row.capturedFrames;
  row.returnedSidetoneFrames+=mask ? 120 : 0;
  run('draw(deviceReport)');
}
assert.equal(run('index'),7);
assert.equal(run('canConfirmSound()'),true);
assert.doesNotMatch(run('verdict()'),/^Passed/);
elements.get('heard').checked=true;
await elements.get('heard').onchange();
assert.match(run('verdict()'),/^Passed/);
assert.equal(commands.filter(r=>r.name==='confirm-output').length,1); // Only the earlier build 9 path saves settings.
elements.get('heard-pilots').checked=true;
assert.doesNotMatch(run('verdict()'),/^Passed/);
elements.get('heard-pilots').checked=false;
trial.current.originalMicListed=false;
assert.match(run('verdict()'),/absent from the listed route/);
trial.current.originalMicListed=true;
for (const bad of [{samePlayer:false},{sameInputQueue:false},{destinationListed:false},
  {inputIdleSeconds:2},{inputQueueRunning:0},{inputError:-1},{sidetoneError:-1}]) {
  const good={...trial.current};
  Object.assign(trial.current,bad);
  assert.equal(run('canConfirmSound()'),false);
  Object.assign(trial.current,good);
}
trial.inputAssignmentStatus=-50;
assert.equal(run('canConfirmSound()'),false);
trial.usedPreferredWiredInput=true;
assert.equal(run('canConfirmSound()'),true);
trial.finished='Morse entered the background.';
assert.equal(run('canConfirmSound()'),false);
assert.equal(run('verdict()'),trial.finished);
trial.finished='Stopped by tester';
elements.get('switch-volts-before').value='0.70';
elements.get('switch-volts-after').value='0.02';
await elements.get('copy').onclick();
const copied=JSON.parse(commands.at(-1).text);
assert.equal(copied.heardFromBluetooth,true);
assert.deepEqual(copied.observations.map(o=>o.mask),[0,1,0,2,0,3,0]);
assert.deepEqual(copied.meterVoltsAC,{beforeSwitch:0.7,afterSwitch:0.02});
console.log('PASS manual AirPods switch, retained streams, post-switch electrical sequence, measured voltage and hearing.');
