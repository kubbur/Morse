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
import { devOrigin, invitationFromLink, serviceOrigin, stagingOrigin } from '../website/public/js/service-origin.mjs';
import { LearnerDB } from '../src/learner-db.mjs';
import { snapshot, restore } from '../scripts/backup.mjs';
import { newState, STORAGE_KEY } from '../website/public/js/progress.mjs';
import { PracticeStorage } from '../website/public/js/practice-storage.mjs';
import { purchase, sanitizeShack } from '../website/public/js/shack-model.mjs';

const config=configuration({MORSE_MODE:'production',MORSE_PUBLIC_ORIGIN:siteOrigin,MORSE_TRUSTED_PROXY_IP:'192.0.2.3',MORSE_EDGE_IP:'192.0.2.2'});
// Exercise the server's actual HTTP handler, including production proxy/origin checks, without opening a port.
function handler(server, origins = [siteOrigin]) {
  return async (target, options={}) => {
    const url=new URL(target);
    assert.ok(origins.includes(url.origin));
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

async function postExchange(serve, origin, action, body, cookie = '') {
  const response = await serve(origin + '/api/v2/' + action, {method:'POST', redirect:'error',
    headers:{Origin:origin, 'X-Morse-Sync':'2', 'Content-Type':'application/json', cookie},
    body:JSON.stringify({scope:'operator', body})});
  assert.equal(response.status, 200, action);
  return response;
}

test('Stable and Dev isolate the same callsign, private credentials and CW frequency', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'morse-separate-sites-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const db = new LearnerDB(':memory:');
  t.after(() => db.close());
  const cipher = {isAsyncEncryptionAvailable:async () => true, encryptStringAsync:async value => Buffer.from(value),
    decryptStringAsync:async bytes => ({result:bytes.toString()})};
  async function deployment(channel, origin, otherOrigin) {
    const settings = configuration({MORSE_PUBLIC_ORIGIN:origin, MORSE_TRUSTED_PROXY_IP:config.trustedProxyIp,
      MORSE_EDGE_IP:config.edgeIp, MORSE_SYNC_PATH:join(dir, channel + '.sqlite')});
    const exchange = new Exchange(settings.syncPath);
    const server = await createApp(settings, {exchange});
    t.after(() => { server.close(); exchange.close(); });
    const serve = handler(server, [origin, otherOrigin]);
    assert.equal((await serve(otherOrigin + '/api/v2/capabilities', {redirect:'error'})).status, 403);
    const request = websiteClient(db.db, cipher, 'website', (url, options) => {
      assert.equal(new URL(url).origin, origin);
      if (options.method === 'POST') assert.equal(options.headers.Origin, origin);
      return serve(url, options);
    }, channel);
    return (action, body = {}) => request(action, {scope:'operator', body});
  }
  const stable = await deployment('stable', siteOrigin, devOrigin);
  const dev = await deployment('dev', devOrigin, siteOrigin);
  const sharedCall = {callsign:'TEST1', generation:1, revision:0, visible:true, marks:{}};
  for (const [call, xp] of [[stable, 350], [dev, 2700]]) {
    assert.equal((await call('scores/session')).status, 200);
    assert.equal((await call('scores/visibility', {...sharedCall, xp})).status, 200);
  }
  assert.equal((await stable('scores/leaderboard')).entries[0].xp, 350);
  assert.equal((await dev('scores/leaderboard')).entries[0].xp, 2700);
  const names = cookieNames('operator');
  const stored = prefix => db.db.prepare('SELECT encrypted FROM credentials WHERE id=?').get(prefix + names.scores).encrypted;
  assert.notDeepEqual(stored('website:'), stored('dev-website:'));

  const profile = newState().profiles[0];
  const paired = await stable('private/start', {profile, label:'Mac', profileVersion:2});
  assert.equal(paired.status, 200);
  const {code} = await stable('private/recovery-code');
  assert.equal(code.length, 32);
  assert.equal((await dev('private/status')).connected, false);
  assert.equal((await dev('private/recover', {code})).status, 403);
  assert.ok((await dev('private/join', {profile, label:'Mac', invitation:paired.invitation})).status >= 400);
  const radio = {f:7025, call:'TEST1', equipped:['0-0','1-0','2-0'], lifetimeXP:5000};
  const station = await dev('shack/open', radio);
  assert.equal(station.activity[7025], 1);
  assert.equal((await stable('shack/open', radio)).activity[7025], 1);
  assert.ok((await stable('shack/poll', {token:station.token, f:7025})).status >= 400);
  const achievements={listen:7,send:2,qsls:2,badges:['send-first']};
  assert.equal((await dev('scores/achievements',{callsign:'TEST1',generation:1,revision:1,achievements})).status,200);
  const entry=(await dev('scores/leaderboard')).entries[0];
  assert.equal(entry.xp,2900);assert.deepEqual(entry.achievements,achievements);
  assert.equal((await stable('scores/leaderboard')).entries[0].xp,350);
  assert.equal((await dev('private/erase',{requirePublisher:true})).erased,true);
  assert.deepEqual((await dev('scores/leaderboard')).entries,[]);
  assert.equal((await stable('scores/leaderboard')).entries[0].xp,350);
  assert.equal((await stable('private/status')).connected,true);
});

test('pairing links and the live feed stay on the installed service during a Dev outage', async () => {
  const token = 'i'.repeat(43);
  for (const local of [siteOrigin, devOrigin, stagingOrigin]) {
    for (const issuer of [siteOrigin, devOrigin, stagingOrigin]) {
      assert.equal(invitationFromLink(issuer + '/#pair=' + token, local), issuer === local ? token : null);
    }
  }
  assert.equal(serviceOrigin('staging', 'dev'), stagingOrigin);
  const requests = [];
  const client = websiteClient(null, null, 'website', async (url, options) => {
    assert.equal(new URL(url).origin, devOrigin);
    requests.push(new URL(url).pathname);
    if (url.endsWith('/shack/feed')) {
      assert.equal(options.headers.Origin, devOrigin);
      return new Response('{"cursor":1}\n', {headers:{'Content-Type':'application/x-ndjson'}});
    }
    throw Error('Dev unavailable');
  }, 'dev');
  assert.deepEqual(await client('shack/poll', {body:{token, live:true}}), {cursor:1});
  client.closeBand();
  assert.equal((await client('scores/leaderboard')).status, 503);
  assert.deepEqual(requests, ['/api/v2/shack/feed', '/api/v2/capabilities']);
});

test('an older client can sync and pair without erasing Dev equipment or independent keyer speed', async t => {
  const exchange = new Exchange(':memory:');
  const server = await createApp(config, {exchange});
  t.after(() => { server.close(); exchange.close(); });
  const post = postExchange.bind(null, handler(server), siteOrigin);
  const p = newState().profiles[0];
  p.stats.xp = 5000;
  p.shack = sanitizeShack();
  assert.ok(purchase(p.shack, ['0-0','1-0','2-0'], 100, p.stats.xp));
  const response = await post('private/start', {profile:p, label:'Mac', profileVersion:2, invite:false});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const stable = await (await post('private/status', {}, cookie)).json();
  assert.equal(stable.profile.shack, undefined);
  assert.equal(stable.profile.settings.sendWpm, undefined);
  assert.equal(stable.profile.sending.settings.wpm, 30);
  const edit = structuredClone(stable.profile);
  edit.stats.xp += 20;
  edit.settings.wpm = edit.sending.settings.wpm = 35;
  await post('private/push', {base:stable.profile, profile:edit, epoch:stable.epoch, seq:stable.seq + 1}, cookie);
  const check = async () => {
    const {profile} = await (await post('private/status', {profileVersion:2}, cookie)).json();
    assert.deepEqual(profile.shack.orders, p.shack.orders);
    assert.equal(profile.settings.wpm, 35);
    assert.equal(profile.sending.settings.wpm, 15);
    assert.equal(profile.stats.xp, 5020);
  };
  await check();
  const { invitation } = await (await post('private/start', {profile:newState().profiles[0], label:'Second device', profileVersion:2})).json();
  await post('private/join', {profile:edit, label:'Mac', invitation}, cookie);
  await check();
});

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
