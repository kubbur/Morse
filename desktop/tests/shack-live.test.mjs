import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { ShackBand } from '../website/lib/shack-band.mjs';
import { LiveKeyReceiver, LiveKeySender } from '../website/public/js/shack-live.mjs';
import { ShackFeed } from '../website/public/js/shack-feed.mjs';
import { BandRadio, Receiver } from '../website/public/js/shack-radio.mjs';
import { MorseAudio } from '../website/public/js/audio.mjs';
import { PaddleConnection } from '../website/public/js/paddle.mjs';

const f=7025;
const open=(band,call,frequency=f,live=true,equipped=['0-0','1-0','2-0'])=>
  band.request('open',{call,f:frequency,qualified:true,equipped,live,lifetimeXP:5000});
const key=(edge,offset,stream='cw')=>({edge,offset,stream});

test('a key-down wakes the tuned feed before release; overlapping uploads play once and old radios hear completed marks',async()=>{
  const band=new ShackBand(), a=open(band,'TESTA'), b=open(band,'TESTB');
  const other=open(band,'TESTC',7035), old=open(band,'TESTD',f,false), monitor=open(band,'TESTR',f,true,[null,'1-0','2-0']);
  const received=[], offChannel=[];
  const listen=(room,frequency,output)=>band.subscribe({token:room.token,f:frequency,cursor:room.cursor},batch=>output.push(...batch.events),()=>{});
  const feed=listen(b,f,received); listen(other,7035,offChannel);
  const edges=(room,first,events,replyTo)=>band.request('edges',{token:room.token,f,first,edges:events,replyTo});
  const start=key('down',0), up=key('up',101);
  assert.throws(()=>edges(monitor,1,[start]),/Receive only/);
  assert.deepEqual(edges(a,1,[start]),{ack:1});
  await turn();
  assert.deepEqual(received.map(e=>e.edge),['down']);
  const rest=[up,key('down',202),key('up',502)];
  assert.equal(edges(a,1,[start,...rest]).ack,4);
  assert.equal(edges(a,2,rest.slice(0,2)).ack,4);
  assert.throws(()=>edges(a,5,[key('down',602),key('up',540)]),/Unexpected/);
  await turn();
  assert.deepEqual(received.map(e=>[e.edge,e.offset]),[['down',0],['up',101],['down',202],['up',502]]);
  assert.deepEqual(offChannel,[]);
  const legacy=band.request('poll',{token:old.token,f,cursor:old.cursor}).events;
  assert.deepEqual(legacy.map(e=>[e.type,e.offset,e.audio]),[['signal',0,[[101,0]]],['signal',202,[[300,0]]]]);
  edges(b,1,[start,up],a.id);
  await turn();
  const card=received.find(e=>e.type==='contact');
  assert.equal(card.call,'TESTA');
  edges(a,5,[key('down',603)]);
  const senderFeed=listen(a,f,[]);
  senderFeed.disconnected(); await turn();
  assert.equal(received.at(-1).edge,'cancel');
  assert.throws(()=>edges(a,6,[key('up',704)]),/expired/);
  assert.deepEqual(offChannel,[]);
  feed.close();
});

test('the first paddle packet contains both ends, and a straight key publishes only on release',async()=>{
  const pending=[], released=[];
  const tx=new LiveKeySender(packet=>new Promise(resolve=>{pending.push(packet); released.push(resolve);}),()=>assert.fail('disconnected'),()=>1234);
  try {
    tx.edge(true,900,30,40);
    const [dit,up]=pending[0].edges;
    assert.deepEqual([dit.offset,dit.duration,dit.wpm,dit.sent,dit.measured,up.offset],[0,40,30,1234,false,40]);
    tx.edge(false,940); tx.edge(true,980,30,120); tx.edge(false,1100);
    tx.edge(true,1140,30);
    assert.equal(pending.length,2);
    tx.edge(false,1202);
    assert.deepEqual(pending.map(p=>p.edges.length),[2,4,6]);
    const manual=pending[2].edges[4];
    assert.deepEqual([manual.offset,manual.duration,manual.measured],[240,62,true]);
    tx.edge(true,1250); tx.cancel(); tx.edge(false,1300);
    released[2]({ack:6}); released[0]({ack:2}); released[1]({ack:4}); await turn();
    assert.equal(tx.ack,6); assert.deepEqual(tx.pending,[]); assert.equal(pending.length,3);
  } finally {tx.close();}
});

function audioClock() {
  const marks=[];
  const ctx={state:'running',currentTime:0,destination:{},
    createOscillator(){
      const mark={}; marks.push(mark);
      return {frequency:{},connect:gain=>gain,disconnect(){},start(at){mark.start=at;},stop(at=ctx.currentTime){mark.stop=at;}};
    },
    createGain(){
      return {connect(){},disconnect(){},gain:{cancelScheduledValues(){},setValueAtTime(){},linearRampToValueAtTime(){}}};
    }};
  return {ctx,marks};
}

const durationOf = mark => Math.round((mark.stop - .002 - mark.start) * 1000);
const downMark = (offset,duration,wpm,stream='cw') => ({...key('down',offset,stream),duration,wpm,measured:false});

test('a full R keeps sender spacing and individual WPM when receivers share a frequency',()=>{
  const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), settings={tone:650,volume:70,wpm:8};
  function incoming(at,peer,event) {ctx.currentTime=at/1000;rx.key(ctx,settings,{peer,...event});}
  incoming(0,'a',downMark(0,40,30));
  incoming(9,'b',downMark(0,60,20));
  incoming(101,'a',downMark(80,120,30));
  incoming(260,'a',downMark(240,40,30));
  assert.deepEqual(marks.map(m=>Math.round(m.start*1000)),[120,189,200,360]);
  assert.deepEqual(marks.map(durationOf),[40,60,120,40]);
  incoming(550,'a',key('up',280));
  assert.deepEqual(marks.map(durationOf),[40,60,120,40]);
  rx.stop(); assert.equal(rx.peers.size,0);
});

test('a lost legacy release is silent; cancel and retune clear pending and scheduled marks',()=>{
  const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), settings={tone:650,volume:70};
  const send=(peer,event)=>rx.key(ctx,settings,{peer,...event});
  send('a',key('down',0)); ctx.currentTime=.4; send('a',key('hold',0));
  assert.equal(marks.length,0);
  send('a',key('cancel',0)); send('a',key('up',40));
  assert.equal(marks.length,0);
  send('b',downMark(0,120,30)); assert.equal(rx.voices.size,1);
  rx.stop(); assert.equal(marks[0].stop,ctx.currentTime); assert.equal(rx.voices.size,0);
});

test('one sender dah is buffered once, including slow and fast keyers and speed changes',async()=>{
  const band=new ShackBand(), a=open(band,'KEY1'), b=open(band,'KEY2');
  const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), settings={tone:600,volume:50,wpm:12};
  let cursor=b.cursor;
  const tx=new LiveKeySender(async packet=>{
    const ack=band.request('edges',{token:a.token,f,...packet});
    assert.deepEqual(band.request('edges',{token:a.token,f,...packet}),ack);
    const batch=band.request('poll',{token:b.token,f,cursor}); cursor=batch.cursor;
    for (const event of batch.events) rx.key(ctx,settings,event);
    return ack;
  },()=>assert.fail('disconnected'));
  try {
    let now=0;
    for (const wpm of [5,8,20,30,80]) {
      ctx.currentTime=now/1000;
      tx.edge(true,now,wpm,1200/wpm); await turn();
      assert.equal(Math.round(marks.at(-1).start*1000-now),Math.round(3600/wpm));
      assert.equal(durationOf(marks.at(-1)),Math.round(1200/wpm));
      tx.edge(false,now+1200/wpm); now+=2000;
    }
    assert.equal(marks.length,5);
  } finally {tx.close();}
});

test('silent probes only reach opted-in stations on the frequency, including receive-only stations',()=>{
  let now=10000;
  const band=new ShackBand(()=>now), station=(call,gear,frequency=f)=>band.request('open',{
    call,f:frequency,equipped:gear,invested:5000,lifetimeXP:5000,qualified:true,live:true,probes:true,
  });
  const a=station('PROBE1'), b=station('PROBE2',[null,'1-0','2-0']), old=open(band,'OLD1'), elsewhere=station('OTHER',undefined,7035);
  const sample=sent=>band.request('probe',{token:a.token,f,sent});
  const read=(room,frequency=f)=>band.request('poll',{token:room.token,f:frequency,cursor:room.cursor}).events;
  sample(0); sample(1); now+=400; sample(400);
  assert.deepEqual(read(b).map(e=>[e.type,e.peer,e.sent]),[['probe',a.id,0],['probe',a.id,400]]);
  assert.deepEqual([read(a),read(old),read(elsewhere,7035)],[[],[],[]]);
  assert.equal(band.sessions.get(b.token).heard,undefined);
  assert.throws(()=>sample(-1),/Invalid timing probe/);
  assert.throws(()=>band.request('probe',{token:old.token,f,sent:10}),/Invalid timing probe/);
});

test('tuning measures each peer before keying and holds the chosen delay until the next over',async t=>{
  let now=10000, next, cursor=0;
  t.mock.method(performance,'now',()=>now);
  t.mock.method(Math,'random',()=>0);
  t.mock.timers.enable({apis:['setTimeout']});
  const probes=[], heard=[], rx=new LiveKeyReceiver(), {ctx,marks}=audioClock();
  const radio=new BandRadio(async(action,body)=>{
    if (action==='open') return {f,token:'rx',live:true,probes:body.probes,serverTime:now,cursor:0,activity:{[f]:1}};
    if (action==='poll') return new Promise(resolve=>{next=resolve;});
    if (action==='probe') probes.push(body.sent);
    return {};
  },()=>{},event=>{
    heard.push(event);
    if (event.type==='key') rx.key(ctx,{tone:600,volume:60},event);
  });
  t.after(()=>{radio.close();next({});});
  await radio.tune({call:'LISTEN',f,invested:300});
  async function frame(at,events=[],count=3) {
    now=at; ctx.currentTime=now/1000;
    next({cursor:++cursor,serverTime:now,activity:{[f]:count},events:events.map(e=>({...e,f,at:now}))});
    await turn();
  }
  const probe=(peer,sent)=>({type:'probe',peer,sent});
  const mark=(peer,offset,sent,wpm,stream='cw')=>({type:'key',peer,sent,...downMark(offset,1200/wpm,wpm,stream)});
  await frame(10000,[],1); assert.equal(probes.length,0);
  for (const sent of [0,400,800,1200]) {
    now=11000+sent;
    if (sent) {t.mock.timers.tick(400); await turn();}
    await frame(now,[probe('a',55000+sent)]);
    if (!sent) {t.mock.timers.tick(0); await turn();}
    await frame(now+(sent===400?120:0),[probe('b',sent)]);
  }
  assert.equal(probes.length,4); assert.deepEqual(heard,[]);
  // A's note spent 40 ms of its 120 ms budget in transit. B starts at 20 WPM.
  await frame(13000,[mark('a',0,56960,30),mark('b',0,2000,20)]);
  assert.deepEqual(marks.map(m=>Math.round(m.start*1000)),[13080,13180]);
  assert.deepEqual(marks.map(durationOf),[40,60]);
  await frame(13720,[probe('a',57600)]);
  await frame(14000,[mark('a',1000,57960,30)]);
  assert.equal(Math.round(marks.at(-1).start*1000),14080);
  await frame(21200,[mark('a',0,65200,20,'next')]);
  assert.equal(Math.round(marks.at(-1).start*1000),21380);

  await frame(21300,[],1); t.mock.timers.tick(10000); await turn();
  assert.equal(probes.length,4);
});

test('a late legacy release cannot stretch a 40 ms dit or close the gap to the next mark',()=>{
  const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), settings={tone:650,volume:65,wpm:30};
  function send(at,edge,offset) {ctx.currentTime=at/1000;rx.key(ctx,settings,{peer:'a',...key(edge,offset)});}
  send(0,'down',0); assert.equal(marks.length,0);
  send(160,'up',40);
  assert.equal(durationOf(marks[0]),40);
  send(161,'down',80); send(205,'up',200);
  assert.deepEqual(marks.map(durationOf),[40,120]);
  assert.equal(Math.round((marks[1].start-marks[0].start)*1000),80);
});

test('a measured straight key spends capture time inside the buffer and preserves long hand-sent marks',()=>{
  for (const duration of [35,95,181,730]) {
    const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), settings={tone:650,volume:65};
    ctx.currentTime=duration/1000;
    rx.key(ctx,settings,{peer:'a',...downMark(0,duration,20),measured:true});
    assert.equal(Math.round(marks[0].start*1000),Math.max(180,duration+4));
    assert.equal(durationOf(marks[0]),duration);
  }
});

test('a faster next transmission cannot overtake a note already buffered at the old speed',()=>{
  const {ctx,marks}=audioClock(), rx=new LiveKeyReceiver(), settings={tone:650,volume:65};
  rx.key(ctx,settings,{peer:'a',...downMark(0,240,5,'slow')});
  ctx.currentTime=.3;
  rx.key(ctx,settings,{peer:'a',...downMark(0,15,80,'fast'),previous:'slow',gap:60});
  assert.deepEqual(marks.map(m=>Math.round(m.start*1000)),[720,1020]);
  assert.deepEqual(marks.map(durationOf),[240,15]);
});

test('the relay rejects incomplete or inconsistent timed pairs without advancing the sequence',()=>{
  const band=new ShackBand(), a=open(band,'TX1'), b=open(band,'RX1'), old=open(band,'OLD1',f,false);
  const down={...downMark(0,40,30),sent:100};
  const edges=list=>band.request('edges',{f,token:a.token,first:1,edges:list});
  assert.throws(()=>edges([down]),/matching release/);
  assert.throws(()=>edges([down,key('up',120)]),/matching release/);
  assert.throws(()=>edges([{...down,wpm:0},key('up',40)]),/Invalid/);
  assert.deepEqual(edges([down,key('up',40)]),{ack:2});
  assert.deepEqual(edges([down,key('up',40)]),{ack:2});
  const events=room=>band.request('poll',{token:room.token,f,cursor:0}).events;
  assert.deepEqual(events(b).map(e=>[e.edge,e.offset,e.duration]),[['down',0,40],['up',40,undefined]]);
  assert.deepEqual(events(old).map(e=>e.audio),[[[40,0]]]);
});

test('a long over keeps the same audio clock when sender offsets roll over on the wire',async()=>{
  let now=0;
  const band=new ShackBand(()=>now), a=open(band,'KEY1'), b=open(band,'KEY2');
  const rx=new LiveKeyReceiver(), {ctx,marks}=audioClock(), down=[];
  let cursor=b.cursor;
  const tx=new LiveKeySender(async packet=>{
    const ack=band.request('edges',{token:a.token,f,...packet});
    const batch=band.request('poll',{token:b.token,f,cursor}); cursor=batch.cursor;
    for (const event of batch.events) {
      if (event.edge==='down') down.push(event);
      rx.key(ctx,{tone:600,volume:65},event);
    }
    return ack;
  },()=>assert.fail('disconnected'));
  async function edge(at,pressed) {
    now=at+(at<115000?10:30); ctx.currentTime=now/1000;
    tx.edge(pressed,at); await turn();
  }
  try {
    for (let at=0;at<=120000;at+=5000) {await edge(at,true); await edge(at+40,false);}
    assert.notEqual(down.at(-1).stream,down.at(-2).stream);
    assert.equal(down.at(-1).previous,down.at(-2).stream);
    assert.equal(down.at(-1).gap,4960);
    assert.equal(Math.round(marks.at(-1).start*1000),120130);
    await edge(130000,true); await edge(130040,false);
    assert.equal(down.at(-1).gap,undefined);
    assert.equal(Math.round(marks.at(-1).start*1000),130150);
  } finally {tx.close();}
});

test('a legacy sender’s recorded R preserves both gaps across two polls',()=>{
  const rx=new Receiver(()=>({tone:550,volume:65})), {ctx,marks}=audioClock();
  rx.audio.context=ctx;
  for (const [arrival,offset,length] of [[3.271,0,101],[3.875,202,301],[3.875,604,101]]) {
    ctx.currentTime=arrival;
    rx.play([[length,0]],'legacy',offset);
  }
  assert.deepEqual(marks.slice(1).map((m,i)=>Math.round((m.start-marks[i].stop+.002)*1000)),[101,101]);
});

test('resuming a stalled feed cuts obsolete audio and accepts fresh edges',async()=>{
  const heard=[], station={call:'TEST1',f,invested:300};
  let finish;
  const radio=new BandRadio(async(action,body)=>{
    if (action==='open') return {token:'one',id:'A',live:true,cursor:0,serverTime:5000,activity:{}};
    if (action==='poll' && !body.cursor) return {cursor:2,serverTime:5002,activity:{},events:[
      {type:'key',peer:'B',f,at:2000,...key('down',0)},
      {type:'key',peer:'C',f,at:5001,...key('down',0)},
    ]};
    if (action==='poll') return new Promise(resolve=>{finish=resolve;});
    return {};
  },()=>{},e=>heard.push(e));
  await radio.tune(station); await turn();
  assert.deepEqual(heard.map(e=>[e.peer,e.edge]),[['B','cancel'],['C','down']]);
  radio.close(); finish({cursor:3,activity:{},events:[{type:'key',peer:'B',f,...key('down',0)}]}); await turn();
  assert.equal(heard.at(-1).type,'silence');
});

test('one streaming response delivers split and coalesced lines and cancels cleanly',async()=>{
  let controller, requests=0, signal;
  const feed=new ShackFeed(async(_url,opts)=>{
    requests++;signal=opts.signal;
    const body=new ReadableStream({start(c){controller=c; signal.addEventListener('abort',()=>c.close(),{once:true});}});
    return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
  });
  const room={f,token:'test',cursor:0,live:true}, first=feed.next(room);
  await turn();
  controller.enqueue(new TextEncoder().encode('{"cursor":1'));
  controller.enqueue(new TextEncoder().encode('}\n{"cursor":2}\n'));
  assert.deepEqual(await first,{cursor:1}); assert.deepEqual(await feed.next(room),{cursor:2});
  assert.equal(requests,1);
  const waiting=feed.next(room);
  feed.close(room.token);
  await assert.rejects(waiting,/disconnected/); assert.ok(signal.aborted);
});

test('a quiet tuned receiver stays awake and resumes normal audio idling after listening stops',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let suspended=0;
  const audio=new MorseAudio();
  audio.context={state:'running',sampleRate:48000,destination:{},resume:async()=>{},suspend:async()=>{suspended++;},
    createBuffer(){},createBufferSource(){return {connect(){},start(){},stop(){},disconnect(){}};}};
  const original=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:class {}});
  t.after(()=>original ? Object.defineProperty(globalThis,'AudioContext',original) : delete globalThis.AudioContext);
  await audio.unlock(); audio.setListening(true);
  t.mock.timers.tick(90000); assert.equal(suspended,0);
  audio.setListening(false); t.mock.timers.tick(60001); assert.equal(suspended,1);
});

test('the browser companion delivers on-air paddle presses on arrival and uses the practice buffer again after exit',()=>{
  let clock=0; const contacts=[];
  const connection=new PaddleConnection({now:()=>clock,onContacts:(...row)=>contacts.push(row),timers:{setTimeout:()=>1}});
  const receive=(seq,dit,timeMs)=>connection.receive(JSON.stringify({v:1,status:'ready',seq,dit,dah:false,timeMs}));
  connection.setLiveKeying(true);
  receive(1,true,500); assert.deepEqual(contacts,[[true,false,500]]);
  clock=50; connection.tick(); assert.deepEqual(contacts.at(-1),[null,null,534]);
  connection.setLiveKeying(false); contacts.length=0; receive(2,false,550);
  assert.equal(contacts.length,0);
  clock=155; connection.tick(); assert.deepEqual(contacts[0],[false,false,550]);
});
