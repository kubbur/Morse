import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configuration } from '../website/server.mjs';
import { Exchange, cookieNames } from '../website/lib/exchange.mjs';
import { SyncStore } from '../website/lib/sync-store.mjs';
import { websiteClient, siteOrigin } from '../src/website-client.mjs';
import { LearnerDB } from '../src/learner-db.mjs';
import { snapshot, restore } from '../scripts/backup.mjs';
import { newState, STORAGE_KEY } from '../website/public/js/progress.mjs';
import { PracticeStorage } from '../website/public/js/practice-storage.mjs';

const config=configuration({MORSE_MODE:'production',MORSE_PUBLIC_ORIGIN:siteOrigin,MORSE_TRUSTED_PROXY_IP:'192.0.2.3',MORSE_EDGE_IP:'192.0.2.2'});
// Exercise the server's actual HTTP handler, including production proxy/origin checks, without opening a port.
function handler(server) {
  return async (target, options={}) => {
    const url=new URL(target);
    assert.equal(url.origin,siteOrigin);
    assert.equal(options.redirect,'error');
    const bytes=Buffer.from(options.body || '');
    const req=Readable.from(bytes.length ? [bytes] : []);
    const headers=Object.fromEntries(new Headers(options.headers));
    Object.assign(req,{url:url.pathname,method:options.method || 'GET',socket:{remoteAddress:config.trustedProxyIp},rawHeaders:[],
      headers:{host:url.host,'x-forwarded-host':url.host,'x-forwarded-for':config.edgeIp,'x-forwarded-port':'443','x-forwarded-proto':'https','content-length':String(bytes.length),...headers}});
    return new Promise(resolve=>{
      const responseHeaders=new Headers();let status;
      server.emit('request',req,{setHeader:(k,v)=>responseHeaders.set(k,v),writeHead:(s,h)=>{status=s;for(const [k,v] of Object.entries(h || {}))responseHeaders.set(k,v);},
        end:data=>resolve(new Response(data,{status,headers:responseHeaders}))});
    });
  };
}

test('the live v1 protocol allows anonymous rankings only, regardless of requested payload',async()=>{
  const old=new SyncStore(':memory:');
  try {
    const state=newState(), p=state.profiles[0];p.stats.xp=30;
    old.request('identity',null,{callsign:'TEST1',listed:true,profile:p});
    const serve=handler(await createApp(config,{syncStore:old})), requests=[];
    const mac=websiteClient(null,null,'website',async (url,opts)=>{requests.push([url,opts]);return serve(url,opts);});
    const scope=p.id, body={profile:p};
    assert.equal((await mac('capabilities')).privateSync,false);
    for(const action of ['private/start','private/push','scores/submit','scores/session']) assert.equal((await mac(action,{scope,body})).status,503);
    const board=await mac('scores/leaderboard',{scope,body});
    assert.equal(board.status,200);assert.equal(board.entries[0].xp,30);
    assert.equal(requests.length,2);assert.equal(requests[1][1].body,'{}');
    assert.equal(requests[1][1].credentials,'omit');assert.equal(new Headers(requests[1][1].headers).has('cookie'),false);
    const offline=websiteClient(null,null,'offline',()=>assert.fail('offline profile made a request'));
    assert.equal((await offline('scores/leaderboard',{scope,body})).localOnly,true);
  } finally {old.close();}
});

test('upgrade a restored website database, adopt its browser, pair a Mac and continue on both',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'morse-site-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const before=join(dir,'old.sqlite'), old=new SyncStore(before);
  const web=newState().profiles[0], desk=newState().profiles[0];
  web.stats.xp=90; desk.sending.level=4;
  const legacy=old.request('identity',null,{profile:web,callsign:'TEST1',listed:true});
  const backup=await snapshot(before,join(dir,'snapshots'));old.close();
  const e=new Exchange(await restore(backup,join(dir,'candidate'))), db=new LearnerDB(':memory:');
  try {
    const serve=handler(await createApp(config,{exchange:e}));
    const cipher={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async v=>Buffer.from(v).map(n=>n^213),
      decryptStringAsync:async bytes=>({result:Buffer.from(bytes).map(n=>n^213).toString()})};
    const mac=websiteClient(db.db,cipher,'website',serve);
    const call=(action,body={})=>mac(action,{scope:desk.id,body});
    assert.equal((await mac('capabilities')).privateSync,true);
    assert.equal((await call('scores/leaderboard')).entries[0].xp,90);
    const cookies=new Map([['__Host-morse_sync',legacy.setToken]]);
    async function browser(action,body={}) {
      const res=await serve(siteOrigin+'/api/v2/private/'+action,{method:'POST',redirect:'error',headers:{Origin:siteOrigin,'X-Morse-Sync':'2','Content-Type':'application/json',cookie:[...cookies].map(([key,v])=>key+'='+v).join('; ')},
        body:JSON.stringify({scope:web.id,body})});
      assert.equal(res.status,200); const set=res.headers.get('set-cookie');
      if (set) { const [key,value]=set.split(';')[0].split('='); cookies.set(key,value); }
      return res.json();
    }
    const approvedBrowser=await browser('adopt');assert.equal(approvedBrowser.profile.stats.xp,90);
    const invitation=await browser('start',{label:'Browser',profile:web,foundation:web,invite:true});
    const joined=await call('private/join',{label:'Mac',profile:desk,foundation:desk,invitation:invitation.invitation});
    const pending=await browser('status');
    assert.equal(joined.status,200,joined.error);assert.ok(joined.waiting);assert.ok(pending.invite);
    assert.equal(joined.waiting.code,pending.invite.code);
    await browser('approve',{claim:pending.invite.claim});
    const synced=await call('private/status');
    assert.equal(synced.profile.stats.xp,90);assert.equal(synced.profile.sending.level,4);
    const local=structuredClone(synced.profile);local.stats.xp+=10;
    const payload={seq:synced.seq+1,epoch:synced.epoch,base:synced.profile,profile:local};
    await call('private/push',payload);await call('private/push',payload);
    assert.equal((await browser('status')).profile.stats.xp,100);
    assert.equal((await call('scores/leaderboard')).entries[0].xp,90);
    assert.ok(db.db.prepare('SELECT id FROM credentials').all().every(r=>r.id.startsWith('website:')));
    assert.equal(db.db.prepare('SELECT encrypted FROM credentials WHERE id=?').get(cookieNames(desk.id).private),undefined);
    assert.equal((await call('scores/session')).status,200);
    const state=await call('scores/listing',{callsign:'TEST1'});
    assert.equal(state.status,200); assert.equal(state.xp,90);
    const show=await call('scores/visibility',{callsign:'TEST1',generation:1,revision:state.revision,visible:true,xp:40,marks:{}});
    assert.equal(show.status,200,show.error); assert.equal(show.xp,100,'The linked website owns the higher total');
    assert.equal((await call('scores/leaderboard')).entries[0].xp,100);
    const hide=await call('scores/visibility',{callsign:'TEST1',generation:2,revision:show.revision,visible:false});
    assert.equal(hide.status,200,hide.error); assert.deepEqual((await call('scores/leaderboard')).entries,[]);
    assert.equal((await browser('status')).profile.stats.xp,100);
    const original=new SyncStore(before);
    try {assert.equal(original.request('status',legacy.setToken,{}).profile.stats.xp,90);}
    finally {original.close();}
  } finally {db.close();e.close();}
});

test('first website-capable Mac launch retains its original and requires a choice for accumulated public results',()=>{
  const state=newState(), p=state.profiles[0], db=new LearnerDB(':memory:');
  const disk={getItem:()=>null,setItem(){}};
  const mac={syncMode:'website',loadSave:old=>db.load(old,true),save:(raw,rev)=>({revision:db.save(raw,rev)})};
  try {
    p.callsign='TEST1';p.leaderboard=true;
    const old={version:1,learners:{[p.id]:{generation:3,scores:[{id:crypto.randomUUID(),kind:'listen',xp:10,day:'2026-11-23'}],private:null}}};
    const previous=JSON.stringify({...state,delivery:old});db.save(previous,0);
    let storage=new PracticeStorage(disk,mac);storage.setItem(STORAGE_KEY,JSON.stringify(state));
    assert.equal(storage.row().scores.length,0);assert.equal(storage.row().previousScores[0].xp,10);
    assert.equal(db.db.prepare('SELECT raw FROM originals WHERE id=?').get('before-website-v2').raw,previous);
    p.stats.xp+=15;storage.result(p,'send',15);storage.setItem(STORAGE_KEY,JSON.stringify(state));storage=new PracticeStorage(disk,mac);
    assert.equal(storage.row().scores.length,1);storage.decidePreviousScores(p,true);storage.decidePreviousScores(p,true);
    assert.equal(storage.row().scores.length,2);
    storage.consent(p,p.callsign,false);assert.equal(storage.row().scores.length,0);
  } finally {db.close();}
});
