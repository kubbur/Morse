import test from 'node:test';
import assert from 'node:assert/strict';
import { sendingTrace, timingFeedback, markFeedback } from '../website/public/js/send-trace.mjs';
import { NativeElements } from '../website/public/js/native-paddle.mjs';
import { timeline } from '../website/public/js/morse.mjs';

const speed = {wpm:30, farnsworth:30};
const edges = times => times.map((at,i)=>({down:i%2===0, at}));

test('guided straight-key hits follow measured releases, track consecutive matches and identify misses', () => {
  const feedback = (target, times) => markFeedback(sendingTrace(target, speed, edges(times), {tolerance:0.3}));
  assert.deepEqual(feedback('R', [0]), []);
  const correct = feedback('R', [3000,3040,3080,3200,3240,3280]);
  assert.deepEqual(correct.map(h => [h.label,h.streak]), [['On time',1],['On time',2],['On time',3]]);
  assert.deepEqual(feedback('EEE',[0,40,240,280,400,440]).map(h => [h.label,h.streak]),
    [['On time',1],['80 ms late',0],['On time',1]]);
  assert.equal(feedback('EE',[0,40,110,150]).at(-1).label,'50 ms early');
  assert.equal(feedback('T',[0,86]).at(-1).matched,true);
  assert.equal(feedback('E',[0,70]).at(-1).label,'30 ms long');
  assert.equal(feedback('E',[0,20]).at(-1).label,'20 ms short');
  assert.equal(feedback('R',[0,40,80,120]).at(-1).label,'Expected a dah');
  assert.equal(feedback('E',[0,40,80,120]).at(-1).label,'Extra mark');
  assert.deepEqual(feedback('',[0,40,80,200]),[]);
});

test('paddles match the chosen elements and judge hand-controlled gaps at the selected spacing speed', () => {
  const settings = {wpm:30, farnsworth:15}, options = {keyerTimed:true, tolerance:0.3};
  const from = times => sendingTrace('A E',settings,edges(times),options);
  const ideal = sendingTrace('A E',settings,[],options).expected;
  const last = ideal[2].start;
  const clean = from([0,55,100,220,last+20,last+60]);
  assert.deepEqual(markFeedback(clean).map(h=>h.label), ['Dit matched','Dah matched','Gap on time']);
  const shortGap = from([0,40,80,200,400,440]);
  assert.match(markFeedback(shortGap).at(-1).label,/ms early$/);
  assert.equal(markFeedback(shortGap).at(-1).streak,0);
  const joined = sendingTrace('<SK>',settings,[],options).expected.flatMap(m=>[m.start,m.end]);
  const prosign = sendingTrace('<SK>',settings,edges(joined),options);
  assert.ok(markFeedback(prosign).every(h=>h.matched && h.label.endsWith('matched')));
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
