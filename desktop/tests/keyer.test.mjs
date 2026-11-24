import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { root } from '../scripts/stage.mjs';
import { buildNative } from '../scripts/native.mjs';
import { PaddleKeyer } from '../website/public/js/paddle.mjs';
import { decodeSending } from '../website/public/js/sending.mjs';
import { NativeElements } from '../website/public/js/native-paddle.mjs';

test('native PCM, scoring stream, text decoder and keyboard keyer share contact fixtures',{skip:process.platform!=='darwin'},()=>{
 const bin=join(root,'build/checks/NativeChecks'); buildNative(bin,[process.arch==='arm64'?'arm64':'x86_64'],true);
 const latency=execFileSync(bin,['--input-latency'],{encoding:'utf8'});
 assert.match(latency,/VBand at 48000 Hz/);
 const converterRows=latency.split('\n').filter(line=>line.startsWith('Audio converter at '));
 assert.equal(converterRows.length,6);
 for (const [rate,frames] of [[48000,128],[44100,256],[48000,512]]) {
   for (const side of ['dit','dah']) assert.ok(converterRows.some(line=>line.startsWith(`Audio converter at ${rate} Hz, ${frames}-frame render, ${side},`)));
 }
 const dir=mkdtempSync(join(tmpdir(),'morse-cal-check-'));
 try {
   for (const op of ['fresh','save','restore','reset-input','verify-reset']) {
     execFileSync(bin,['--preferences',join(dir,'fixture.plist'),op]);
   }
 } finally { rmSync(dir,{recursive:true,force:true}); }
 for(const [wpm,mode,contacts,text] of [
   [30,'a',[[0,1],[10,3],[90,0]],'A'],[30,'b',[[0,1],[10,3],[90,0]],'R'],
   [30,'a',[[0,1],[2,0],[10,2],[12,0],[110,1],[112,0]],'R'],
   [5,'a',[[0,2],[2,0],[3,1],[4,0]],'N'],[60,'b',[[0,1],[1,0],[2,2],[4,0]],'A'],
   [30,'a',[[0,1],[1,0],[130,1],[132,0],[391,1],[392,0]],'EE E'],
   [30,'b',[[0,3],[10,0]],'A'],[30,'a',[[0,3],[10,0]],'E'],
 ]) {
   const raw=execFileSync(bin,['--vector',String(wpm),mode,contacts.map(x=>x.join(':')).join(',')],{encoding:'utf8'});
   const native=JSON.parse(raw), edges=[];
   for (const reverse of [false,true]) {
     const physical=contacts.map(([at,mask])=>[at,reverse ? ((mask&1)<<1)|((mask&2)>>1) : mask].join(':')).join(',');
     const keyed=execFileSync(bin,[reverse?'--vband-reversed':'--vband',String(wpm),mode,physical],{encoding:'utf8'});
     assert.deepEqual(JSON.parse(keyed),native,'VBand PCM count, element times and typed characters');
   }
   const browser=new PaddleKeyer({wpm, mode,onEdge:e=>edges.push(e)});
   for(const [at,mask] of contacts) browser.contacts(!!(mask&1),!!(mask&2),at);
   browser.advance(4000);
   assert.deepEqual(native.edges,edges,JSON.stringify(contacts));
   assert.ok(native.audible>0); assert.equal(native.typed.toUpperCase(),text);
   assert.equal(decodeSending(edges,{wpm,farnsworth:wpm}).decoded,text);
 }
});
test('gaps, clock resets, dropped key-up and new sessions invalidate partial exercises',()=>{
 for(const fault of [{seq:5},{frame:1},{rate:44100},{epoch:2},{kind:0}]) {
  let aborts=0;const edges=[];
  const stream=new NativeElements({edge:e=>edges.push(e),idle:()=>{},interrupt:()=>aborts++});
  const row={type:'element',epoch:1,rate:48000,kind:0,frame:0,seq:1};
  stream.receive(row);stream.receive({...row,kind:1,frame:100,seq:2});
  stream.receive({...row,kind:2,frame:2020,seq:3,...fault});
  assert.equal(aborts,1); assert.equal(edges.length,1);
 }
});
