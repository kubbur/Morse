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
