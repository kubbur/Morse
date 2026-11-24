import test from 'node:test';
import assert from 'node:assert/strict';
import { sendingTrace, timingFeedback } from '../website/public/js/send-trace.mjs';
import { NativeElements } from '../website/public/js/native-paddle.mjs';
import { timeline } from '../website/public/js/morse.mjs';

const speed = {wpm:30, farnsworth:30};
const edges = times => times.map((at,i)=>({down:i%2===0, at}));

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
