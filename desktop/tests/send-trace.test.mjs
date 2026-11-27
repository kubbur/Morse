import test from 'node:test';
import { gradeSending } from '../website/public/js/sending.mjs';
import { sendingStage } from '../website/public/js/sending-course.mjs';

import assert from 'node:assert/strict';
import { sendingTrace, timingFeedback, markFeedback } from '../website/public/js/send-trace.mjs';
import { NativeElements } from '../website/public/js/native-paddle.mjs';
import { timeline } from '../website/public/js/morse.mjs';

test('the visual trace and Send grade agree at both edges of the slow letter window',()=>{
  const settings={wpm:10,farnsworth:10},stage=sendingStage(43);
  for(const [gap,accepted] of [[239,false],[240,true],[495,true],[564,true],[565,false],[600,false]]) {
    const input=[0,120,120+gap,240+gap].map((at,i)=>({down:i%2===0,at}));
    assert.equal(markFeedback(sendingTrace('EE',settings,input,{keyerTimed:true,tolerance:stage.tolerance})).at(-1).matched,accepted,String(gap));
    assert.equal(gradeSending(input,'EE',settings,stage,{keyerTimed:true}).passed,accepted,String(gap));
  }
});

const speed = {wpm:30, farnsworth:30};
const edges = times => times.map((at,i)=>({down:i%2===0, at}));

test('guided straight-key hits follow measured releases, track consecutive matches and identify misses', () => {
  const feedback = (target, times) => markFeedback(sendingTrace(target, speed, edges(times), {tolerance:0.3}));
  assert.deepEqual(feedback('R', [0]), []);
  const correct = feedback('R', [3000,3040,3080,3200,3240,3280]);
  assert.deepEqual(correct.map(h => [h.label,h.streak]), [['Perfect',1],['Perfect',2],['Perfect',3]]);
  assert.deepEqual(feedback('EEE',[0,40,240,280,400,440]).map(h => [h.label,h.streak]),
    [['Perfect',1],['80 ms late',0],['Perfect',1]]);
  assert.equal(feedback('EE',[0,40,110,150]).at(-1).label,'50 ms early');
  assert.equal(feedback('T',[0,86]).at(-1).label,'On time');
  assert.equal(feedback('E',[0,70]).at(-1).label,'30 ms long');
  assert.equal(feedback('E',[0,20]).at(-1).label,'20 ms short');
  assert.equal(feedback('R',[0,40,80,120]).at(-1).label,'Expected a dah');
  assert.equal(feedback('E',[0,40,80,120]).at(-1).label,'Extra mark');
  assert.deepEqual(feedback('',[0,40,80,200]),[]);
});

test('precision cues have a tighter window than a lesson pass and assess both the mark and its preceding gap', () => {
  const last = (target, times, settings = speed) => markFeedback(sendingTrace(target, settings, edges(times), {tolerance:0.3})).at(-1);
  assert.equal(last('T',[0,134.4]).perfect,true);
  assert.equal(last('T',[0,134.5]).label,'On time');
  assert.equal(last('EE',[0,40,145.6,185.6]).perfect,true);
  assert.equal(last('EE',[0,40,145.5,185.5]).label,'On time');
  assert.equal(last('EE',[0,40,160,210]).label,'On time');
  assert.equal(last('E',[0,19],{wpm:80,farnsworth:80}).perfect,true);
  assert.equal(last('E',[0,19.1],{wpm:80,farnsworth:80}).perfect,false);
  assert.equal(last('T',[0,765],{wpm:5,farnsworth:5}).perfect,true);
  assert.equal(last('T',[0,766],{wpm:5,farnsworth:5}).perfect,false);
  assert.equal(last('R',[0,40,80,120]).perfect,false);
});

test('paddles match the chosen elements and judge hand-controlled gaps at the selected spacing speed', () => {
  const settings = {wpm:30, farnsworth:15}, options = {keyerTimed:true, tolerance:0.3};
  const from = times => sendingTrace('A E',settings,edges(times),options);
  const ideal = sendingTrace('A E',settings,[],options).expected;
  const last = ideal[2].start;
  const clean = from([0,55,100,220,last+20,last+60]);
  assert.deepEqual(markFeedback(clean).map(h=>[h.label,h.timed,h.perfect]), [
    ['Dit matched',false,false],['Dah matched',false,false],['Perfect gap',true,true],
  ]);
  assert.equal(markFeedback(from([0,40,80,200,last+50,last+90])).at(-1).label,'Gap on time');
  const shortGap = from([0,40,80,200,400,440]);
  assert.match(markFeedback(shortGap).at(-1).label,/ms early$/);
  assert.equal(markFeedback(shortGap).at(-1).streak,0);
  const joined = sendingTrace('<SK>',settings,[],options).expected.flatMap(m=>[m.start,m.end]);
  const prosign = sendingTrace('<SK>',settings,edges(joined),options);
  assert.ok(markFeedback(prosign).every(h=>h.matched && !h.timed && !h.perfect && h.label.endsWith('matched')));
  assert.equal(timingFeedback(prosign,true),'');
});

test('the ghost and measured marks share the first press and show signed gap and duration errors',()=>{
  const trace = sendingTrace('A A',speed,edges([1200,1240,1280,1400,1640,1680,1720,1840]));
  const rounded = marks => marks.map(m=>[Math.round(m.start),Math.round(m.end)]);
  assert.deepEqual(rounded(trace.expected),[[0,40],[80,200],[480,520],[560,680]]);
  assert.deepEqual(rounded(trace.actual),[[0,40],[80,200],[440,480],[520,640]]);
  assert.match(timingFeedback(trace,true),/mark 3 started 40 ms early/i);
  assert.match(timingFeedback(sendingTrace('EE',speed,edges([0,40,210,250])),true),/50 ms late/);
  assert.match(timingFeedback(sendingTrace('T',speed,edges([0,70])),true),/50 ms too short/);
  assert.match(timingFeedback(sendingTrace('E',speed,edges([0,70])),true),/30 ms too long/);
  assert.match(timingFeedback(sendingTrace('A',speed,edges([0,40])),true),/1 of 2/);
});

test('plot uses native audio frames at any clock origin, including unfinished input and an interrupted stream',()=>{
  let captured=[], interrupts=0, seq=0;
  const native=new NativeElements({edge:e=>captured.push(e),idle(){},interrupt(){captured=[];interrupts++;}});
  const origin=780000, emit=(kind,ms,epoch=1)=>native.receive({type:'element',seq:seq++,kind,frame:origin+ms*48,epoch,rate:48000});
  emit(0,0); emit(1,1);emit(2,41);emit(1,81);
  let trace=sendingTrace('A',speed,captured);
  assert.deepEqual(trace.actual,[{start:0,end:40},{start:80,end:null}]);
  emit(2,201);
  assert.match(timingFeedback(sendingTrace('A',speed,captured),true),/matched/);
  seq++;emit(0,230);
  assert.equal(interrupts,1); assert.deepEqual(sendingTrace('',speed,captured).actual,[]);
  trace=sendingTrace('',speed,edges([1000,1120]));
  assert.deepEqual(trace.expected,[]); assert.equal(timingFeedback(trace,true),'');
});

test('targets use lesson playback timings at WPM boundaries, with extended spacing and joined prosigns',()=>{
  for (const settings of [{wpm:5,farnsworth:1},{wpm:30,farnsworth:10},{wpm:80,farnsworth:80}]) {
    const reference=timeline('A R <SK>',settings);
    const events=reference.tones.flatMap(t=>[t.start*1000,(t.start+t.duration)*1000]);
    const trace=sendingTrace('A R <SK>',settings,edges(events));
    assert.deepEqual(trace.expected,trace.actual);
    assert.equal(trace.dit,1200/settings.wpm);
    assert.match(timingFeedback(trace,true),/matched/);
    assert.ok(trace.duration > events.at(-1));
  }
});
