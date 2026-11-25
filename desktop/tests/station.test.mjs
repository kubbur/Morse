import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { siteOrigin, websiteClient } from '../src/website-client.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { newProfile, newState, importState, resetListeningProgress, resetSendingProgress, sanitizeSettings, STORAGE_KEY } from '../website/public/js/progress.mjs';
import { PracticeStorage } from '../website/public/js/practice-storage.mjs';
import { Station } from '../website/public/js/station.mjs';
import { pairedProgress } from '../website/public/js/initial-merge.mjs';
import { syncProfile } from '../website/public/js/sync-data.mjs';
import { Exchange } from '../website/lib/exchange.mjs';
import { snapshot,restore } from '../scripts/backup.mjs';
import { LearnerDB } from '../src/learner-db.mjs';

const memory = (rows = {}) => ({
  getItem:k=>rows[k] ?? null,setItem:(k,v)=>{rows[k]=v},removeItem:k=>{delete rows[k]},
});
function fixture(exchange, injected) {
  const state=newState(), p=state.profiles[0], storage=new PracticeStorage(memory());
  storage.setItem(STORAGE_KEY,JSON.stringify(state));
  const cookies={};
  const transport=async(action,{body})=>{
    const [kind,op]=action.split('/');
    if(action==='scores/session') {cookies.scores ||= randomBytes(32).toString('base64url'); return {ready:true};}
    const result=kind==='scores' ? exchange.scores.request(op,cookies.scores,cookies.private,body) : exchange.private.request(op,cookies.private,body);
    if(Object.hasOwn(result,'setToken')) {cookies.private=result.setToken;delete result.setToken;}
    return result;
  };
  const station=new Station({storage,getProfile:()=>p,applyProfile:shared=>{Object.assign(p,{...shared,id:p.id,leaderboard:p.leaderboard,callsign:p.callsign});storage.setItem(STORAGE_KEY,JSON.stringify(state));},
    locks:{request:(_key,fn)=>fn()},ready:()=>true,backup:()=>storage.setItem('recovery',JSON.stringify(state)),
    onStatus:()=>{},transport:(action,payload)=>injected ? injected(action,payload,transport) : transport(action,payload)});
  station.schedule=()=>{};station.queueScores=()=>{};
  function earn(xp=20) {p.stats.xp+=xp;p.stats.total++;storage.result(p,'listen',xp);storage.setItem(STORAGE_KEY,JSON.stringify(state));}
  function share(on){storage.atomic(()=>{storage.consent(p,'TEST1',on);storage.setItem(STORAGE_KEY,JSON.stringify(state));});}
  return {p,storage,station,earn,share,cookies,transport,state};
}

test('each combination of private linking and public consent uses only its own data path',async()=>{
 for(const linked of [false,true]) for(const shared of [false,true]){
   const e=new Exchange(':memory:'), payloads=[];
   try{
     const f=fixture(e,(a,p,next)=>{payloads.push([a,p]);return next(a,p)});
     if(linked)await f.station.start('Mac');
     f.share(shared);f.earn();await f.station.flushScores();
     if(linked)await f.station.flush();
     assert.equal(e.private.get('SELECT count(*) AS n FROM saves').n,+linked);
     const board=e.scores.request('leaderboard',null,null,{});assert.equal(board.entries.length,+shared);
     if(shared)assert.equal(board.entries[0].xp,20);
     assert.equal(payloads.some(([a])=>a.startsWith('private/')),linked);
     for(const [a,p] of payloads.filter(([a])=>a.startsWith('scores/'))) {
       assert.ok(!JSON.stringify(p).includes('settings'),a);assert.ok(!JSON.stringify(p).includes('profile'),a);
     }
   }finally{e.close();}
 }
});

test('lost public acknowledgement, pending consent, in-flight cancellation and stale retries',async()=>{
 const e=new Exchange(':memory:'); let fail=true,hold=null,resume=null;
 try{
   const f=fixture(e,async(a,p,next)=>{
     const result=await next(a,p);
     if(a==='scores/submit' && fail){fail=false;throw Error('response lost');}
     if(a==='scores/prepare' && hold){hold();await new Promise(r=>{resume=r;});}
     return result;
   });
   f.share(true);f.earn();await f.station.flushScores();
   assert.equal(f.storage.row().scores.length,1);await f.station.flushScores();
   assert.equal(e.private.get('SELECT sum(xp) AS xp FROM score_results').xp,20);
   f.earn();f.share(false);assert.equal(f.storage.row().scores.length,0);
   f.earn();f.share(true);f.earn();
   const started=new Promise(r=>{hold=r;});
   const pending=f.station.flushScores();await started;
   const old={generation:f.storage.row().generation,results:[...f.storage.row().scores]};
   f.share(false);resume();await pending;await f.station.flushScores();
   assert.throws(()=>e.scores.request('submit',f.cookies.scores,null,old),/Sharing changed/);
   assert.equal(e.private.get('SELECT sum(xp) AS xp FROM score_results').xp,20);
   const other=fixture(e);other.share(true);other.earn();await other.station.flushScores();
   assert.match(other.station.scoreError,/claimed/);assert.equal(e.private.get('SELECT count(*) AS n FROM saves').n,0);
 }finally{e.close();}
});

test('pairing keeps disjoint learning records, concurrent offline work and a lost private acknowledgement',async()=>{
 const e=new Exchange(':memory:'); let lose=false;
 try{
   const a=fixture(e), b=fixture(e,async(action,p,next)=>{const r=await next(action,p);if(lose && action==='private/push'){lose=false;throw Error('response lost');}return r;});
   a.p.listening.records['flexible:1']={letters:9,passed:true,covered:['E']};a.earn();
   b.p.listening.records['head:1']={letters:7,passed:true,covered:['T']};b.earn();
   const offer=await a.station.start('Browser');await b.station.join(offer.invitation,'Mac');
   const claim=(await a.station.request('status')).invite.claim;await a.station.approve(claim);
   await b.station.flush();await a.station.flush();
   assert.equal(a.p.stats.xp,40);assert.equal(b.p.stats.xp,40);assert.ok(a.p.listening.records['flexible:1'] && a.p.listening.records['head:1']);
   a.earn();b.earn();await a.station.flush();lose=true;await assert.rejects(b.station.flush(),/response lost/);
   await b.station.flush();await a.station.flush();assert.equal(a.p.stats.xp,80);assert.equal(b.p.stats.xp,80);
 }finally{e.close();}
});

test('private recovery opens last synced profile in a clean device and revocation blocks the old credential',async()=>{
 const e=new Exchange(':memory:');
 try{
   const a=fixture(e),b=fixture(e);a.earn();await a.station.start('Mac');
   const {code}=await a.station.request('recovery-code');
   await assert.rejects(b.station.recover('TEST1'),/not accepted/);
   await b.station.recover(code);assert.equal(b.p.stats.xp,20);
   const old=(await b.station.request('status')).devices.find(d=>!d.current);
   await b.station.disconnect(old.id);a.earn();await assert.rejects(a.station.flush(),/no longer paired/);
   assert.equal((await b.station.request('status')).profile.stats.xp,20);
   assert.equal(e.private.get('SELECT count(*) AS n FROM stations').n,0);
 }finally{e.close();}
});

test('recovery from the earlier v2 website settles, preserves playback choices and resumes full sync after upgrade', async t => {
  const server = new Exchange(':memory:');
  t.after(() => server.close());
  const browser = fixture(server);
  browser.earn(40);
  await browser.station.start('Browser');
  const {code} = await browser.station.request('recovery-code');
  let legacy = true, pushes = 0, loseAck = false;
  const mac = fixture(server, async (action, payload, send) => {
    const result = await send(action, payload);
    if (legacy && result.profile) {
      delete result.profile.sending.settings.continueMode;
      delete result.profile.sending.settings.pauseSeconds;
    }
    if (action === 'private/push') {
      pushes++;
      if (loseAck) { loseAck = false; throw Error('Connection lost after commit'); }
    }
    return result;
  });
  const phases = [];
  mac.station.onStatus = status => phases.push(status.message);
  mac.p.sending.settings.pauseSeconds = 5;
  await mac.station.recover(code);
  assert.equal(mac.p.stats.xp, 40);
  assert.equal(mac.p.sending.settings.pauseSeconds, 5);
  assert.equal(mac.station.status.localPlaybackOnly, true);
  phases.length = 0;
  await mac.station.flush(); await mac.station.flush();
  assert.deepEqual([...new Set(phases)], ['Progress synced']);
  assert.equal(pushes, 0);

  mac.p.sending.settings.continueMode = 'manual';
  mac.earn(10); loseAck = true;
  await assert.rejects(mac.station.flush(), /Connection lost/);
  assert.ok(mac.station.meta().pending);
  // A newer edit while the original request awaits a receipt must survive replay.
  mac.p.sending.settings.pauseSeconds = 7;
  await mac.station.flush();
  assert.equal(mac.p.sending.settings.pauseSeconds, 7);
  assert.equal(mac.station.status.message, 'Changes waiting to upload');
  await mac.station.flush(); await mac.station.flush();
  assert.equal(pushes, 3);
  assert.equal(mac.station.status.message, 'Progress synced');
  assert.equal(mac.station.meta().base.sending.settings.pauseSeconds, undefined);
  assert.equal(mac.p.sending.settings.continueMode, 'manual');
  assert.equal((await browser.station.request('status')).profile.stats.xp, 50);

  legacy = false;
  browser.p.settings.goal = 25;
  await browser.station.flush();
  await mac.station.flush();
  assert.equal(mac.station.status.localPlaybackOnly, false);
  assert.equal(mac.p.settings.goal, 25);
  assert.equal(mac.p.sending.settings.pauseSeconds, 7);
  mac.p.sending.settings.pauseSeconds = 8;
  await mac.station.flush(); await browser.station.flush();
  assert.equal(browser.p.sending.settings.pauseSeconds, 8);
  assert.equal(browser.p.stats.xp, 50);
  assert.equal(mac.station.status.message, 'Progress synced');
});

test('an existing 1.1.1 journal with missing playback defaults polls without a new upload', async t => {
  const server = new Exchange(':memory:');
  t.after(() => server.close());
  const f = fixture(server);
  await f.station.start('Mac');
  const journal = f.station.meta();
  delete journal.base.sending.settings.continueMode;
  delete journal.base.sending.settings.pauseSeconds;
  delete journal.localPlayback;
  f.station.save(journal);
  const requests = [];
  f.station.requestImpl = async (action, payload) => {
    requests.push(action);
    const answer = await f.transport(action, payload);
    delete answer.profile.sending.settings.continueMode;
    delete answer.profile.sending.settings.pauseSeconds;
    return answer;
  };
  await f.station.flush(); await f.station.flush();
  assert.deepEqual(requests, ['private/status','private/status']);
  assert.equal(f.station.status.message, 'Progress synced');
  assert.equal(f.station.status.localPlaybackOnly, true);
});
test('sqlite backup restores offline in a separate database after source changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'morse-restore-'));
 const source=join(dir,'source.sqlite');
 let e=new Exchange(source),copy;
 try{
   const f=fixture(e);f.earn();await f.station.start('Browser');f.share(true);await f.station.flushScores();f.earn();await f.station.flush();await f.station.flushScores();
   const {code}=await f.station.request('recovery-code');
   const backup=await snapshot(source,join(dir,'snapshots'));
   f.earn();await f.station.flush();e.close();e=null;
   const recovered=await restore(backup,join(dir,'new-server'));copy=new Exchange(recovered);
   await assert.rejects(restore(backup,join(dir,'new-server')),{code:'EEXIST'});
   assert.equal(copy.private.get('PRAGMA integrity_check').integrity_check,'ok');
   assert.deepEqual(copy.private.all('PRAGMA foreign_key_check'),[]);
   const b=fixture(copy);await b.station.recover(code);
   assert.equal(b.p.stats.xp,40);assert.equal(copy.scores.request('leaderboard',null,null,{}).entries[0].xp,20);
 }finally{e?.close();copy?.close();await rm(dir,{recursive:true,force:true});}
});
test('all legacy learners migrate once and completed result plus outbox survive abrupt process exit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'morse-learners-')),path=join(dir,'learner.sqlite');
 let db;
 try{
   const state=newState();state.profiles.push(newProfile('Other learner'));state.profiles[1].stats.xp=91;
   const legacy=JSON.stringify(state);db=new LearnerDB(path);
   assert.equal(db.load(legacy).raw,legacy);assert.equal(db.load(legacy).revision,1);
   const raw=JSON.parse(legacy);raw.profiles[0].stats.xp=20;const id=randomUUID();raw.delivery={version:1,learners:{[raw.activeId]:{scores:[{id,kind:'listen',xp:20}],generation:1}}};
   db.close();db=null;
   const module=new URL('../src/learner-db.mjs',import.meta.url).href;
   const code=`import { LearnerDB } from ${JSON.stringify(module)}; const db=new LearnerDB(process.argv[1]); db.save(process.argv[2],1); process.kill(process.pid,'SIGKILL');`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',code,path,JSON.stringify(raw)]);
   assert.equal(child.signal,'SIGKILL');db=new LearnerDB(path);
   const saved=JSON.parse(db.load(legacy).raw);
   assert.equal(saved.profiles[1].stats.xp,91);assert.equal(saved.profiles[0].stats.xp,20);
   assert.equal(saved.delivery.learners[saved.activeId].scores[0].id,id);
   assert.equal(db.db.prepare('SELECT raw FROM originals').get().raw,legacy);
   assert.deepEqual(importState(legacy),importState(legacy));
   assert.throws(()=>db.save(legacy,1),/newer save/);
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('overlapping legacy baselines retain independent mastery and count subsequent work once',()=>{
 const a=newProfile(),b=newProfile();
 a.stats.xp=100;b.stats.xp=90;
 a.sending.records[1]={attempts:1,good:1,mastered:true,covered:['E']};
 b.sending.records[2]={attempts:1,good:1,mastered:true,covered:['T']};
 const afterA=structuredClone(a),afterB=structuredClone(b);
 afterA.stats.xp+=20;afterB.stats.xp+=8;
 const result=pairedProgress(afterA,afterB,a,b);
 assert.equal(result.profile.stats.xp,128);
 assert.ok(result.profile.sending.records[1].mastered && result.profile.sending.records[2].mastered);
});
test('offline practice after a pairing request is preserved even if approval changes the epoch',async()=>{
 const e=new Exchange(':memory:');try{
  const a=fixture(e),b=fixture(e);a.earn();b.earn();
  const offer=await a.station.start('Web');await b.station.join(offer.invitation,'Mac');
  b.earn();await a.station.approve((await a.station.request('status')).invite.claim);
  await b.station.flush();await a.station.flush();
  assert.equal(a.p.stats.xp,60);assert.equal(b.p.stats.xp,60);
 }finally{e.close();}
});
test('repeated absolute import never becomes score XP and public historical import is one-time',async()=>{
 const e=new Exchange(':memory:');try{
  const f=fixture(e);f.share(true);await f.station.start('Mac');await f.station.flushScores();
  f.earn();await f.station.flush();await f.station.flushScores();
  for(let i=0;i<2;i++){f.p.stats.xp=700;f.storage.setItem(STORAGE_KEY,JSON.stringify(f.state));f.station.replace('import');await f.station.flush();}
  assert.equal((await f.station.request('status')).profile.stats.xp,700);
  assert.equal(e.scores.request('leaderboard',null,null,{}).entries[0].xp,20);
  const req={id:randomUUID(),xp:80,generation:f.storage.row().generation};
  const submit=body=>e.scores.request('history',f.cookies.scores,f.cookies.private,body);
  submit(req);submit(req);assert.throws(()=>submit({...req,id:randomUUID()}),/already imported/);
  assert.equal(e.scores.request('leaderboard',null,null,{}).entries[0].xp,100);
  f.share(false);await f.station.flushScores();assert.equal(e.scores.request('leaderboard',null,null,{}).entries[0].xp,100);
 }finally{e.close();}
});

test('an imported modern save and its original retain unique subsequent XP',async()=>{
 const e=new Exchange(':memory:');
 try {
   const a=fixture(e), b=fixture(e);
   a.earn();
   const copy=structuredClone(a.p);
   Object.assign(b.p,copy,{id:b.p.id});
   b.storage.row().foundation=syncProfile(copy);
   b.earn(); a.earn();
   const invite=await a.station.start('Original');
   await b.station.join(invite.invitation,'Restored copy');
   await a.station.approve((await a.station.request('status')).invite.claim);
   await b.station.flush(); await a.station.flush();
   assert.equal(a.p.stats.xp,60);
   assert.equal(b.p.stats.xp,60);
   assert.equal(Object.keys(a.p.credits).length,2);
 } finally { e.close(); }
});

test('disabling sharing fences a submit already sent and revocation blocks its publisher',async()=>{
 const e=new Exchange(':memory:');
 let sent, release;
 const started=new Promise(resolve=>{sent=resolve;});
 const blocked=new Promise(resolve=>{release=resolve;});
 try {
   const f=fixture(e,async(a,p,next)=>{
     if (a==='scores/submit') { sent(); await blocked; }
     return next(a,p);
   });
   f.share(true); f.earn();
   const task=f.station.flushScores();
   await started;
   f.share(false); f.station.consentChanged();
   release(); await task; await f.station.flushScores();
   assert.equal(e.private.get('SELECT count(*) AS n FROM score_results').n,0);
   await f.station.start('Mac'); f.share(true); await f.station.flushScores();
   const restored=fixture(e);
   await restored.station.recover((await f.station.request('recovery-code')).code);
   await restored.station.disconnect((await restored.station.request('status')).devices.find(x=>!x.current).id);
   f.earn(); await f.station.flushScores(); assert.match(f.station.scoreError,/revoked/);
 } finally { release(); e.close(); }
});

test('scoped journals keep two learners separate on a shared installation',()=>{
 const state=newState();const second=newProfile();
 state.profiles.push(second);
 const store=new PracticeStorage(memory());store.setItem(STORAGE_KEY,JSON.stringify(state));
 const a=store.forLearner(state.activeId), b=store.forLearner(second.id);
 const key='morse.devices.v1';
 a.setItem(key,'first'); b.setItem(key,'second');
 assert.equal(a.getItem(key),'first');assert.equal(b.getItem(key),'second');
 b.removeItem(key);assert.equal(a.getItem(key),'first');
 assert.equal(store.owner,state.activeId);
});

test('staging client, HTTP handler and encrypted credential boundary agree on both routes',async()=>{
 const e=new Exchange(':memory:'), db=new LearnerDB(':memory:');
 // Exercise the credential API contract with a disposable cipher. Keychain is a Mac acceptance test.
 const cipher={isAsyncEncryptionAvailable:async()=>true, encryptStringAsync:async s=>Buffer.from(s).map(n=>n^170),
   decryptStringAsync:async s=>({result:Buffer.from(s).map(n=>n^170).toString()})};
 const fetcher=async(url,options)=>{
   const bytes=Buffer.from(options.body);
   const req=Readable.from([bytes]);
   Object.assign(req,{url:new URL(url).pathname,method:options.method,headers:{'content-length':String(bytes.length),...Object.fromEntries(new Headers(options.headers))}});
   const headers=new Headers();let status,output;
   await e.handle(req,{setHeader:(k,v)=>headers.set(k,v),writeHead:(s,h)=>{status=s;for(const [k,v] of Object.entries(h))headers.set(k,v);},end:s=>{output=s;}});
   return new Response(output,{status,headers});
 };
 try {
   const client=websiteClient(db.db,cipher,'staging',fetcher);
   const p=newProfile(), scope=p.id;
   const call=(action,body={})=>client(action,{scope,body});
   assert.equal((await call('scores/session')).status,200);
   assert.equal((await call('scores/consent',{generation:1,callsign:'TEST1',enabled:true})).status,200);
   const record={id:randomUUID(),kind:'listen',xp:20,day:new Date().toISOString().slice(0,10)};
   assert.equal((await call('scores/submit',{generation:1,results:[record]})).status,200);
   assert.equal((await call('scores/leaderboard')).entries[0].xp,20);
   assert.equal(e.private.get('SELECT count(*) AS n FROM saves').n,0);
   assert.equal((await call('private/start',{profile:p,foundation:p,label:'Web'})).status,200);
   const status=await call('private/status');assert.equal(status.connected,true);
   assert.equal(status.setToken,undefined);
   assert.equal(db.db.prepare('SELECT count(*) AS n FROM credentials').get().n,2);
   assert.equal((await client('private/status',{scope:randomUUID(),body:{}})).connected,false);
 } finally {db.close();e.close();}
});

test('recovery at the device limit revokes only the device explicitly selected with ownership proof',async()=>{
 const e=new Exchange(':memory:');
 try {
   const owner=fixture(e);owner.earn();await owner.station.start('Original Mac');
   const {code}=await owner.station.request('recovery-code');
   for (let i=1;i<8;i++) await fixture(e).station.recover(code);
   const next=fixture(e),devices=await next.station.recover(code);
   assert.equal(devices.length,8);assert.equal(e.private.get('SELECT count(*) AS n FROM devices').n,8);
   const selected=devices.find(d=>d.label==='Original Mac');
   await assert.rejects(next.station.recover('X'.repeat(32),selected.id),/not accepted/);
   await next.station.recover(code,selected.id);
   assert.equal(next.p.stats.xp,20);
   assert.equal(e.private.get('SELECT count(*) AS n FROM devices').n,8);
   owner.earn();await assert.rejects(owner.station.flush(),/no longer paired/);
 } finally { e.close(); }
});

test('listening reset survives delayed sending work and a lost acknowledgement on the staging store', async()=>{
  const e=new Exchange(':memory:');
  try {
    const mac=fixture(e), web=fixture(e);
    mac.p.settings=sanitizeSettings({...mac.p.settings,courseLevel:20});
    mac.p.sending.level=12; mac.earn(30);
    await mac.station.start('Mac');
    await web.station.recover((await mac.station.request('recovery-code')).code);
    const oldBase=structuredClone(web.station.meta());
    Object.assign(mac.p,resetListeningProgress(mac.p)); mac.station.replace('reset-listen'); await mac.station.flush();
    web.p.sending.level=13; web.earn(10);
    const request={base:oldBase.base,profile:syncProfile(web.p),seq:oldBase.seq+1,epoch:oldBase.epoch};
    const first=await web.station.request('push',request), retry=await web.station.request('push',request);
    assert.equal(first.profile.settings.courseLevel,1); assert.equal(first.profile.sending.level,13);
    assert.equal(first.profile.stats.xp,40); assert.deepEqual(retry.profile,first.profile);
    await mac.station.flush();
    assert.equal(mac.p.sending.level,13); assert.equal(mac.p.stats.xp,40);
    // The other device can still reset sending across the old epoch. Its
    // stale listening cursor must not revive levels already reset on the Mac.
    const next={...request,seq:request.seq+1,replace:true,reason:'reset-send',profile:syncProfile(resetSendingProgress(web.p))};
    const last=await web.station.request('push',next);
    assert.equal(last.profile.settings.courseLevel,1); assert.equal(last.profile.sending.level,1);
    assert.equal(last.profile.stats.xp,40);
  } finally {e.close();}
});

test('offline listening and sending resets retain both scopes until acknowledged', async()=>{
  for (const order of [['reset-send','reset-listen'],['reset-listen','reset-send']]) {
    const e=new Exchange(':memory:');
    try {
      const f=fixture(e); f.p.settings=sanitizeSettings({...f.p.settings,courseLevel:15}); f.p.sending.level=9; f.earn(10);
      await f.station.start('Mac');
      for (const reason of order) {
        Object.assign(f.p,reason==='reset-listen' ? resetListeningProgress(f.p) : resetSendingProgress(f.p));
        f.station.replace(reason);
      }
      assert.equal(f.station.meta().replacementReason,'reset');
      await f.station.flush(); const {profile}=await f.station.request('status');
      assert.equal(profile.settings.courseLevel,1); assert.equal(profile.sending.level,1); assert.equal(profile.stats.xp,10);
    } finally {e.close();}
  }
});

test('recovery codes require a private connection and rotation retires the earlier code',async()=>{
  const e=new Exchange(':memory:');
  try {
    const a=fixture(e), b=fixture(e);
    a.share(true); a.earn(20); await a.station.flushScores();
    await assert.rejects(a.station.request('recovery-code'),/Link this device/);
    const linked=await a.station.start('Mac',{invite:false});
    assert.ok(linked.connected); assert.equal(linked.invitation,undefined); assert.ok(!linked.invite);
    const old=await a.station.request('recovery-code'), current=await a.station.request('recovery-code');
    await assert.rejects(b.station.recover(old.code),/not accepted/);
    await b.station.recover(current.code);
    assert.equal(b.state.profiles.length,1); assert.equal(b.p.stats.xp,20);
  } finally {e.close();}
});
