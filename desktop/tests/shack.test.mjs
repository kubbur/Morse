import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { configuration, createApp } from '../website/server.mjs';
import { Exchange } from '../website/lib/exchange.mjs';
import { newProfile, sanitizeState } from '../website/public/js/progress.mjs';
import { mergeProgress, syncProfile, hasLocalChanges } from '../website/public/js/sync-data.mjs';
import { sanitizeShack, mergeShack, purchase, equip, wallet, balances, sellBadge, installed, receiving, assembled, invested, canTransmit, certify, alphabet, qualificationCredit, shackUnlocked, tiers, equipmentSnapshot, qslCount, QSL_XP, localLifetimeXP } from '../website/public/js/shack-model.mjs';
import { ShackUI } from '../website/public/js/shack-ui.mjs';
import { decodeSending } from '../website/public/js/sending.mjs';
import { SendingUI } from '../website/public/js/send-ui.mjs';
import { NativeElements } from '../website/public/js/native-paddle.mjs';
import { bench, shop, air, logbook, activity } from '../website/public/js/shack-views.mjs';
import { readFile } from 'node:fs/promises';
import { operatorAchievements, validAchievements } from '../website/public/js/operator-achievements.mjs';
import { practiceKey, courseStage } from '../website/public/js/lessons.mjs';

test('existing, live and beacon QSLs pay once and keep their XP after the recording ages out',()=>{
  const card={at:1,from:'TEST1',f:7031};
  const p=newProfile(), base=syncProfile(p);
  const a=structuredClone(base), b=structuredClone(base);
  a.shack=sanitizeShack({cards:{shared:card,'RVK-2026-11-27':{...card,beacon:true}}});
  b.shack=sanitizeShack({cards:{shared:{...card,mine:[[90,0]]},other:{...card,from:'TEST2'}}});
  const merged=mergeProgress(base,a,b);
  assert.equal(qslCount(merged.shack),3);
  assert.equal(localLifetimeXP(merged),3*QSL_XP);
  assert.equal(localLifetimeXP(mergeProgress(base,a,merged)),300);
  assert.equal(localLifetimeXP(syncProfile(merged)),300);
  const many=Object.fromEntries(Array.from({length:83},(_,i)=>['qsl-'+i,{...card,at:i+1}]));
  const full=sanitizeShack({cards:many});
  assert.equal(Object.keys(full.cards).length,80);
  assert.equal(qslCount(full),83);
  assert.equal(qslCount(mergeShack(full,{cards:{'qsl-0':card}})),83);
  assert.equal(qslCount(sanitizeShack({cards:{bad:{...card,at:0}}})),0);
});

test('operator milestones count cleared course levels once across copy modes and show earned badges',()=>{
  const p=newProfile();
  p.settings.courseLevel=187;
  p.sending.level=96;
  assert.deepEqual(operatorAchievements(p),{listen:0,send:0,qsls:0,badges:[]});
  for (const [n,copyMode,mastered] of [[1,'flexible',true],[1,'head',true],[2,'head',true],[3,'flexible',false]]) {
    const stage=courseStage(n);
    const key=practiceKey({...p.settings,courseLevel:n,copyMode,courseCount:stage.letterCount,level:stage.maxLength});
    p.stats.mastery[key]={mastered};
  }
  p.sending.records={1:{mastered:true},2:{mastered:false}};
  p.sending.clean=1;
  const summary=operatorAchievements(p);
  assert.equal(summary.listen,2);assert.equal(summary.send,1);
  assert.ok(summary.badges.includes('send-first'));assert.ok(validAchievements(summary));
  assert.equal(validAchievements({...summary,callsign:'TEST1'}),false);
  assert.equal(validAchievements({...summary,badges:['unknown']}),false);
});

test('shop receipts, equipped windows, upgrades and independent XP survive saves',()=>{
  const p=newProfile(),s=p.shack=sanitizeShack({converted:5000});p.stats.xp=5000;
  assert.equal(purchase(s,['0-0','1-0','2-0'],10),true);
  assert.equal(assembled(s),false); assert.equal(wallet(s),0);
  for(const i of [0,1,2]) assert.equal(equip(s,`${i}-0`,i,20),true);
  assert.equal(assembled(s),true);assert.equal(equip(s,'0-1',0),false);
  assert.equal(equip(s,'0-0',1),false);assert.equal(purchase(s,['1-1'],30),false);
  s.converted=p.stats.xp=13333;assert.equal(purchase(s,['0-1','1-1','2-1'],30),true);
  assert.equal(invested(s),13333);assert.equal(wallet(s),0);
  equip(s,'0-1',0,40);
  assert.deepEqual(s.orders['0-0'],{at:10,version:2});equip(s,'',0,50);
  const restored=sanitizeState({version:1,activeId:p.id,profiles:[p]}).profiles[0];
  assert.equal(restored.stats.xp,13333);assert.equal(restored.shack.equipped[0].id,'');
  assert.deepEqual(restored.shack.orders,s.orders);assert.equal(assembled(restored.shack),false);
});
test('two offline wallets merge without double selling, converting or overspending',()=>{
  const p=newProfile();p.stats.xp=8333;p.shack=sanitizeShack({converted:8333,sold:['first']});
  const a=structuredClone(p),b=structuredClone(p);
  purchase(a.shack,['1-1'],10);purchase(b.shack,['2-2'],20);equip(b.shack,'2-2',2,30);
  const merged=mergeProgress(p,a,b),reverse=mergeProgress(p,b,a);
  assert.deepEqual(merged.shack,reverse.shack);assert.equal(wallet(merged.shack),25);
  assert.equal(merged.shack.equipped[2].id,'');assert.equal(merged.shack.sold.length,1);
});
test('an older website acknowledgment retains local equipment without retrying an unchanged save',()=>{
  const p=newProfile();p.stats.xp=300;p.shack=sanitizeShack({converted:300});
  const local=syncProfile(p),base=structuredClone(local);delete base.shack;
  assert.equal(hasLocalChanges({base,legacyShack:true},local),false);
  assert.equal(hasLocalChanges({base},local),true);
  local.stats.xp++;
  assert.equal(hasLocalChanges({base,legacyShack:true},local),true);
});
test('established training and an experienced operator check award qualification once across devices',()=>{
  const base=newProfile();
  for(const c of alphabet) base.stats.characters[c]={correct:1,seen:1};
  const a=structuredClone(base),b=structuredClone(base);
  for(const p of [a,b]){
    p.shack=sanitizeShack({sent:alphabet});
    assert.equal(certify(p),true);assert.equal(certify(p),false);
  }
  const merged=mergeProgress(base,a,b);
  assert.equal(merged.credits[qualificationCredit],300);assert.equal(merged.stats.xp,300);
});
test('calling and open channels in a speed group require the same equipped station',()=>{
  for (let f=7020;f<=7050;f++) {
    const starter=f>=7024 && f<=7028;
    const price=starter ? 5000 : f>=7029 && f<=7038 ? 13333 : 25000;
    assert.equal(canTransmit(f,price-1),false,'under-equipped at '+f);
    assert.equal(canTransmit(f,price),true,'equipped at '+f);
  }
});
test('band activity lists the three calling frequencies and keeps occupied working channels off the list',()=>{
  const counts=Object.fromEntries(Array.from({length:17},(_,i)=>[7023+i,1]));
  const html=activity({f:7033,band:{state:'live',activity:counts}});
  assert.deepEqual([...html.matchAll(/data-f="(\d+)"/g)].map(match=>Number(match[1])),[7023,7026,7031,7036,7039]);
  for (const pace of ['8–12 WPM','12–25 WPM','25+ WPM']) assert.ok(html.includes(pace));
});
test('two independent room sessions exchange actual timings, distinct frequencies and signed QSLs over the HTTP handler',async()=>{
  const exchange=new Exchange(':memory:'), origin='http://127.0.0.1:3000';
  const server=await createApp(configuration({MORSE_MODE:'local',MORSE_PUBLIC_ORIGIN:origin}),{exchange});
  async function request(action,body) {
    const bytes=Buffer.from(JSON.stringify({scope:'band',body}));
    const req=Readable.from([bytes]);
    Object.assign(req,{url:'/api/v2/shack/'+action,method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3000',origin,'content-type':'application/json','content-length':String(bytes.length),'x-morse-sync':'2'}});
    let code;
    return new Promise(resolve=>server.emit('request',req,{writeHead:n=>code=n,setHeader(){},end:data=>resolve({code,...JSON.parse(data)})}));
  }
  try{
    const open=(call,f,invested=25000,qualified=true,lifetimeXP=25000)=>request('open',{call,f,invested,qualified,lifetimeXP});
    assert.equal((await open('TEST',7025,5000,false,4999)).code,403);
    assert.equal((await request('open',{call:'TEST',f:7025,equipped:['0-0','1-0','2-0']})).code,403);
    const a=await open('TF3KBR',7025,5000,false,5000),b=await open('EA5CW',7025),other=await open('TF2RX',7035,5000,false);
    assert.equal(a.code,200);assert.equal(b.activity[7025],2);
    const first=[[95,90],[281,0]],second=[[120,0]],tx={token:a.token,f:7025,seq:1,stream:'aa',offset:0,audio:first};
    assert.equal((await request('send',tx)).ack,1);assert.equal((await request('send',tx)).ack,1);
    const heard=await request('poll',{token:b.token,f:7025,cursor:b.cursor});
    assert.equal(heard.events.length,1);assert.deepEqual(heard.events[0].audio,[[100,100],[300,0]]);
    assert.equal((await request('poll',{token:other.token,f:7035,cursor:0})).events.length,0);
    assert.equal((await request('send',{...tx,token:other.token,f:7035})).code,403);
    await request('send',{...tx,token:b.token,audio:second,replyTo:heard.events[0].peer});
    const card=(await request('poll',{token:a.token,f:7025,cursor:a.cursor})).events.find(e=>e.type==='contact');
    assert.equal(card.call,'EA5CW');assert.deepEqual(card.audio,second);
    assert.equal((await request('sign',{token:a.token,card:card.card,f:7025,audio:first})).code,200);
    const returned=await request('poll',{token:b.token,f:7025,cursor:heard.cursor});
    assert.deepEqual(returned.events.find(e=>e.type==='signature').audio,first);
    await request('leave',{token:a.token});assert.equal((await request('send',tx)).code,410);
    await request('leave',{token:b.token});
    const activity=await request('poll',{token:other.token,f:7035,cursor:returned.cursor});
    assert.equal(activity.activity[7025] || 0,0);
    assert.equal((await request('sign',{token:b.token,card:card.card,f:7025,audio:second})).code,200);
    const signatures=token=>request('signatures',{cards:[{card:card.card,token}]});
    assert.deepEqual((await signatures(a.token)).signatures,[{card:card.card,f:7025,audio:second}]);
    assert.deepEqual((await signatures(b.token)).signatures,[{card:card.card,f:7025,audio:first}]);
    assert.deepEqual((await signatures(other.token)).signatures,[]);
    assert.equal((await request('sign',{token:other.token,card:card.card,f:7025,audio:first})).code,400);
  }finally{exchange.close();}
});
test('the native sample-clock feeds free keying before the first lesson prompt, without grading',()=>{
  const delivered=[],ui=Object.create(SendingUI.prototype);
  Object.assign(ui,{active:()=>true,usable:()=>true,getProfile:()=>({sending:{}}),source:'straight',down:false,heard:false,
    keyTarget:{edge:e=>delivered.push(e),reset(){}},tone:{set(){}}});
  const stream=new NativeElements({edge:(e,duration)=>ui.edge(e,false,duration),idle(){},interrupt(){}});
  for (const [seq,kind,frame,frames] of [[1,0,0,0],[2,1,4800,4800],[3,2,9600,0]]) stream.receive({type:'element',epoch:1,seq,kind,rate:48000,frame,frames});
  assert.deepEqual(delivered,[{down:true,at:100,duration:100},{down:false,at:200}]);assert.equal(ui.heard,false);assert.equal(ui.result,undefined);
});
test('recorded signatures decode against the start of the recording even hours into a native keyer session',()=>{
  const ui=Object.create(ShackUI.prototype);
  Object.assign(ui,{edges:[],message(){}});
  const epoch=3600000;
  for(const [down,offset] of [[true,0],[false,100],[true,200],[false,500]]) ui.onKey('signature',{down,at:epoch+offset});
  assert.deepEqual(ui.edges.map(e=>e.at),[0,100,200,500]);
  assert.equal(decodeSending(ui.edges,{wpm:12,farnsworth:12}).decoded,'A');
});
test('Progress routes target real practice views; Workbench contains only owned gear and On air has no synthetic transmit buttons',async()=>{
  const html=await readFile(new URL('../website/public/index.html',import.meta.url),'utf8');
  assert.match(html,/data-view="practice">Practise listening/);assert.match(html,/data-view="send">Practise sending/);
  assert.match(html,/id="progress-return" data-view="practice"/);
  const ui={p:newProfile(),slot:0,s:sanitizeShack({converted:5000}),f:7025,xp:()=>5000,badges:()=>[],band:{state:'off',activity:{}}};
  const fresh=bench(ui);assert.doesNotMatch(fresh,/data-act="(?:buy|bundle|convert|sell)"/);assert.doesNotMatch(fresh,/data-portrait/);
  purchase(ui.s,['0-0'],10);assert.match(bench(ui),/data-portrait="0-0"/);
  assert.match(shop(ui),/data-act="buy"/);assert.doesNotMatch(air(ui),/Hold to key|Call CQ|data-key=/i);
  assert.match(logbook(ui),/QSL wall/);
});

test('checkout spends earned XP once, uses existing badge credit first and migrates old wallets',()=>{
  const s=sanitizeShack({converted:6000});
  assert.deepEqual(balances(s,6000),{xp:6000,spent:0,credits:0});
  const starter=['0-0','1-0','2-0'];
  assert.equal(purchase(s,starter,10,6000),true);
  assert.equal(purchase(s,starter,10,6000),true);
  assert.deepEqual(balances(s,6000),{xp:1000,spent:5000,credits:0});
  sellBadge(s,'send-first',10);
  assert.deepEqual(balances(s,6000),{xp:1000,spent:5000,credits:35});
  assert.equal(purchase(s,['0-1'],20,6000),true);
  assert.deepEqual(balances(sanitizeShack(s),6020),{xp:221,spent:5799,credits:0});
  const legacy=sanitizeShack({converted:800,sold:['send-first'],orders:{'1-0':1,'0-0':1,'2-0':1}});
  assert.deepEqual(balances(legacy,800),{xp:535,spent:265,credits:0});
  const beforeUpgrade=structuredClone(legacy);
  assert.equal(purchase(legacy,['0-1'],20,5000),true);
  assert.deepEqual(balances(legacy,5000),{xp:3901,spent:1099,credits:0});
  assert.deepEqual(mergeShack(legacy,beforeUpgrade),mergeShack(beforeUpgrade,legacy));
  assert.deepEqual(balances(mergeShack(beforeUpgrade,legacy),5000),balances(legacy,5000));
  const fresh=sanitizeShack();
  assert.equal(purchase(fresh,['0-0'],10,4999),false);
  assert.equal(purchase(fresh,starter,10,4999),false);
  assert.equal(purchase(fresh,starter,10,5000),true);
  assert.deepEqual(balances(fresh,5000),{xp:0,spent:5000,credits:0});
  assert.equal(shackUnlocked(4999),false);assert.equal(shackUnlocked(5000),true);
});
test('tier totals and the most expensive station survive the public equipment snapshot',()=>{
  assert.deepEqual(tiers.map(([,prices])=>prices.reduce((sum,p)=>sum+p,0)),[5000,13333,25000,83333,416667,1666667]);
  const s=sanitizeShack(), top=['0-5','1-5','2-5'];
  assert.equal(purchase(s,top,1,1666667),true);
  top.forEach((id,i)=>equip(s,id,i,2));
  const restored=sanitizeShack(equipmentSnapshot(s));
  assert.equal(installed(restored),1666667);assert.equal(wallet(restored),0);
});
test('receiver needs radio and antenna, the transmitter also needs the equipped key and tier',()=>{
  const exchange=new Exchange(':memory:'), band=exchange.band;
  try {
    const gear=['0-0','1-0','2-0'], f=7025;
    const open=(equipped,frequency=f)=>band.request('open',{call:'TEST1',f:frequency,lifetimeXP:5000,equipped});
    const send=(r,frequency=f)=>band.request('send',{token:r.token,f:frequency,seq:1,stream:'pulse',offset:0,audio:[[90,0]]});
    assert.throws(()=>open([gear[0],null,gear[2]]),/radio and antenna/);
    assert.throws(()=>open([gear[0],gear[1],null]),/radio and antenna/);
    const rx=open([null,gear[1],gear[2]]),tx=open(gear);
    send(tx);
    assert.equal(band.request('poll',{token:rx.token,f,cursor:rx.cursor}).events.length,1);
    assert.throws(()=>send(rx),/Receive only/);
    assert.throws(()=>send(open(gear,7030),7030),/Receive only/);
    for (const freq of [7031,7036]) assert.equal(send(open(['0-1','1-1','2-1'],freq),freq).ack,1);
    const s=sanitizeShack({converted:25000});
    purchase(s,gear,1);purchase(s,['0-2','1-2','2-2'],2);
    for(const [i,id] of gear.entries()) equip(s,id,i,3);
    assert.equal(installed(s),5000);assert.equal(invested(s),25000);assert.equal(receiving(s),true);
    for(const i of [0,1,2]) equip(s,i+'-2',i,4);
    assert.equal(installed(s),25000);assert.equal(send(open(s.equipped.map(slot=>slot.id),7050),7050).ack,1);
  } finally {exchange.close();}
});
