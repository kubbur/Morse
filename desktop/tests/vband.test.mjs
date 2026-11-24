import test from 'node:test';
import assert from 'node:assert/strict';
import { VBandKeys, loadInput, saveInput } from '../website/public/js/vband.mjs';
import { SendingUI } from '../website/public/js/send-ui.mjs';
import { decodeSending } from '../website/public/js/sending.mjs';
import { PaddleService, validCommand } from '../src/paddle-service.mjs';

function event(code, extra = {}) {
  return { code, key:code.startsWith('Control') ? 'Control' : 'c', ctrlKey:true,
    target:{tagName:'BUTTON',closest:()=>null}, preventDefault(){ this.prevented=true; }, stopImmediatePropagation(){ this.stopped=true; }, ...extra };
}
const noTimers = {start:()=>1,stop:()=>{}};
const L='ControlLeft', R='ControlRight';

test('VBand distinguishes left, right and simultaneous holds, including opposite release order and keyboard location fallback',()=>{
  const changes=[], keys=new VBandKeys(mask=>changes.push(mask),assert.fail,noTimers);
  for (const [code,down] of [[L,true],[L,true],[R,true],[R,false],[L,false],[R,true],[L,true],[R,false],[L,false]]) {
    const e=event(code);
    assert.equal(keys.handle(e,down,true),true);
    assert.ok(e.prevented && e.stopped);
  }
  assert.deepEqual(changes,[1,3,1,0,2,3,1,0]);
  const fallback={key:'Control',location:2};
  keys.handle(event('Unidentified',fallback),true,true);
  keys.handle(event('',fallback),false,false);
  assert.deepEqual(changes.slice(-2),[2,0]);
  for (const e of [event('',{key:'Control',location:0}),event('AltRight'),event('KeyC'),event('ControlLeft',{repeat:true})]) keys.handle(e,true,true);
  assert.equal(changes.length,10);
});

test('shortcut, focus loss and missing key-up cancel the contact and require a release',()=>{
  let pending, stops=0;
  const masks=[], keys=new VBandKeys(mask=>masks.push(mask),()=>stops++,{start:cb=>(pending=cb),stop:()=>{}});
  keys.handle(event(L),true,true);
  const copy=event('KeyC');
  assert.equal(keys.handle(copy,true,true),false);
  assert.ok(!copy.prevented && !copy.stopped);
  assert.equal(stops,1); assert.equal(keys.mask,0);
  keys.handle(event(L,{repeat:true}),true,true);
  keys.handle(event(L),false,false);
  keys.handle(event(R),true,true); pending();
  assert.equal(stops,2); assert.equal(keys.mask,0);
  keys.handle(event(R),false,true);
  keys.handle(event(L),true,true); keys.cancel();
  keys.handle(event(L,{repeat:true}),true,true);
  keys.handle(event(L),false,false);
  keys.handle(event(R,{metaKey:true}),true,true); keys.handle(event(R),false,true);
  keys.handle(event(R),true,false); keys.handle(event(R),false,true);
  keys.handle(event(R),true,true); keys.handle(event(R),false,false);
  assert.deepEqual(masks,[1,2,1,2,0]);
});

test('stalled or discontinuous keyboard delivery clears the attempt before a stale contact can sound',()=>{
  let stopped=0; const masks=[];
  const keys=new VBandKeys(mask=>masks.push(mask),()=>stopped++,{...noTimers,now:()=>900});
  keys.handle(event(L,{timeStamp:650}),true,true); keys.handle(event(L,{timeStamp:899}),false,true);
  keys.handle(event(R,{timeStamp:899}),true,true); keys.handle(event(R,{timeStamp:1500}),false,true);
  assert.equal(stopped,2); assert.equal(keys.mask,0); assert.deepEqual(masks,[2]);
});

function replaceGlobal(t,name,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  t.after(()=>previous ? Object.defineProperty(globalThis,name,previous) : delete globalThis[name]);
}

function memoryStorage() {
  const data=new Map();
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
}

test('input choice defaults to the audio converter and survives a new UI instance on that installation',t=>{
  replaceGlobal(t,'localStorage',memoryStorage());
  assert.equal(loadInput(),'paddle');
  for (const input of ['vband','straight','keyboard','paddle']) {
    saveInput(input); assert.equal(loadInput(),input);
  }
  localStorage.setItem('morse.send-input.v1','other');
  assert.equal(loadInput(),'paddle');
});

function trainer(t,native) {
  const nodes=new Map();
  const element=()=>({dataset:{},listeners:{},append(){},replaceChildren(){},addEventListener(name,fn){this.listeners[name]=fn;},
    focus(){},blur(){},querySelector:selector=>node(selector),hidden:false,value:''});
  const node=id=>{ if (!nodes.has(id)) nodes.set(id,element()); return nodes.get(id); };
  const doc={...element(),hidden:false,hasFocus:()=>true,querySelector:()=>null,createElement:element,getElementById:node};
  replaceGlobal(t,'document',doc); replaceGlobal(t,'window',element());
  replaceGlobal(t,'localStorage',memoryStorage()); replaceGlobal(t,'sessionStorage',memoryStorage());
  replaceGlobal(t,'morseMac',native);
  replaceGlobal(t,'requestAnimationFrame',()=>1);
  replaceGlobal(t,'ResizeObserver',class { observe(){} });
  saveInput('vband');
  const profile={id:'test',settings:{},sending:{level:1,settings:{wpm:30,farnsworth:30,keyer:'a',reverse:false}}};
  const ui=new SendingUI({getProfile:()=>profile,persist:()=>true,active:()=>true});
  ui.heard=true;
  return {ui,doc,node,profile};
}

test('browser VBand runs the local keyer and swaps once, without opening the audio bridge',t=>{
  const {ui,doc,profile}=trainer(t,undefined);
  assert.equal(ui.source,'vband');
  ui.updateActivity();
  assert.equal(ui.connection.enabled,false); assert.equal(ui.connection.source,null);
  let now=0;
  replaceGlobal(t,'performance',{now:()=>now});
  const edges=[];
  ui.edge=(edge,local)=>{assert.equal(local,true);edges.push(edge);};
  const key=(code,down,fields)=>doc.listeners[down?'keydown':'keyup'](event(code,fields));
  for (const reversed of [false,true]) {
    profile.sending.settings.reverse=reversed;
    const dit=reversed?R:L,dah=reversed?L:R;
    key(dit,true);now+=5;key(dit,false);now+=5;key(dah,true);now+=5;key(dah,false);
    now+=500;ui.keyer.advance(now);
    assert.equal(decodeSending(edges,profile.sending.settings).decoded,'A');
    edges.length=0; ui.keyer=null; now+=100;
  }
  const edit={tagName:'INPUT',closest:()=>({})};
  key(L,true,{target:edit});key(L,false,{target:edit});
  assert.equal(edges.length,0);
  assert.equal(ui.connection.source,null);
});

test('Mac VBand forwards raw physical masks to the selected native session, switches to the converter, and fences old events',async t=>{
  const calls=[];let deliver;
  const api={onPaddle:fn=>{deliver=fn;},paddle:async(op,value)=>{ calls.push([op,value]);return {}; }};
  const {ui,doc,node}=trainer(t,api);
  ui.renderInput=()=>{}; ui.render=()=>{}; ui.abort=()=>{ui.vband.cancel();};
  ui.updateMute=()=>{}; ui.renderExercise=()=>{};
  ui.migrationPending=false;
  ui.connection.resolveMigration=()=>ui.connection.configure(ui.settings);
  ui.connection.setActive(true);
  const status={type:'status',source:'vband',phase:'ready',outputReady:true,output:'speakers',epoch:42,session:5};
  deliver(status); await Promise.resolve();
  assert.equal(ui.connection.acceptsVBand,true);
  ui.getProfile().sending.settings.reverse=true;
  for (const [code,down] of [[L,true],[R,true],[L,false],[R,false]]) doc.listeners[down?'keydown':'keyup'](event(code));
  assert.deepEqual(calls.filter(([op])=>op==='vband').map(([,v])=>v),[1,3,2,0].map(mask=>({mask,epoch:42,session:5})));
  assert.equal(ui.keyer,undefined);
  const edges=[]; ui.edge=e=>edges.push(e);
  const mark={type:'element',rate:48000,session:5,epoch:42,seq:1,frame:0,kind:0};
  deliver(mark);deliver({...mark,seq:2,frame:8,kind:1});deliver({...mark,seq:3,frame:1928,kind:2});
  assert.equal(edges.length,2);
  node('send-source').value='paddle';node('send-source').listeners.change();
  deliver(status);deliver({...mark,seq:4,frame:2950,kind:1});
  assert.equal(edges.length,2);
  assert.ok(calls.some(([op,val])=>op==='input' && val==='paddle'));
  assert.equal(loadInput(),'paddle');assert.equal(ui.connection.acceptsVBand,false);
});

test('native USB commands require a two-contact mask and the current helper session',async()=>{
  const v={mask:1,epoch:5,session:1};
  for (const field of [{mask:4},{mask:-1},{epoch:undefined},{session:0}]) assert.equal(validCommand('vband',{...v,...field}),false);
  const service=new PaddleService('unused','unused',()=>{},true);
  service.generation=2;service.input='vband';
  assert.match((await service.command('vband',v)).error,/interrupted/);
  assert.equal(validCommand('input','vband'),true); assert.equal(validCommand('input','anything'),false);
});
