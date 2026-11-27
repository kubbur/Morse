import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { availableUpdate, checkUpdate } from '../src/updates.mjs';
import { channelPreference, UpdateManager, macInstaller } from '../src/update-manager.mjs';
import { signedItem, sparklePublicKey } from '../scripts/appcast.mjs';
import { bundleVersion } from '../scripts/sparkle.mjs';
import { LearnerDB } from '../src/learner-db.mjs';
import { root } from '../scripts/stage.mjs';

const bytes = Buffer.from('disposable release fixture'), digest = createHash('sha256').update(bytes).digest('hex');
const row = { tag_name:'morse-v2.0.0', body:'Local test <b>notes</b>', assets:[{name:'Morse-2.0.0-mac-arm64.zip',
  digest:'sha256:'+digest, size:bytes.length, browser_download_url:'https://example.invalid/other.zip'},{name:'appcast-mac-arm64.xml',size:750}] };
const release = availableUpdate([row],'1.9.0','arm64');
const devRow = n => ({...row, tag_name:'morse-v2.0.0-dev.'+n, prerelease:true,
  assets:[{...row.assets[0],name:'Morse-2.0.0-dev.'+n+'-mac-arm64.zip'},row.assets[1]]});
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(),'morse-mac-update-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}
test('only verified metadata for a published Morse asset enables installation',async()=>{
  assert.match(release.archive.url,/^https:\/\/github\.com\/kubbur\/Morse\/releases\/download\/morse-v2\.0\.0\/Morse-2\.0\.0-mac-arm64\.zip$/);
  assert.equal(release.notes,row.body); assert.equal(release.feedAvailable,true);
  assert.equal(availableUpdate([{...row,assets:row.assets.slice(0,1)}],'1.5.0','arm64').feedAvailable,false);
  for (const fields of [{digest:null},{size:-1},{size:1e10},{digest:'sha1:'+digest}])
    assert.equal(availableUpdate([{...row,assets:[{...row.assets[0],...fields}]}],'1.5.0','arm64').archive,null);
  assert.equal(availableUpdate([{...row,assets:{}}],'1.0.0','arm64'),null);
  assert.equal(availableUpdate([row],'1.5.0','x64'),null);
  await assert.rejects(checkUpdate('1.0.0','arm64',async()=>new Response(null,{status:503})));
});

function manager(overrides={}) {
  return new UpdateManager({version:'1.1.0',installedNotes:'Earlier notes',enabled:true,automatic:false,
    storeAutomatic(){},lookup:async()=>release,changed(){},...overrides});
}

test('each channel selects its published architecture, orders Dev build numbers, and offers older cross-channel builds as downloads', async () => {
  const rows = [row,devRow(9),devRow(10),{...devRow(11),draft:true},{...devRow(12),prerelease:false},
    {...devRow(13),assets:devRow(13).assets.slice(0,1)},{...devRow(14),assets:[{...devRow(14).assets[0],digest:null},row.assets[1]]}];
  assert.equal(availableUpdate(rows,'1.9.0','arm64').version,'2.0.0');
  assert.equal(availableUpdate(rows,'1.9.0','arm64','dev').version,'2.0.0-dev.10');
  assert.equal(availableUpdate(rows,'2.0.0-dev.10','arm64','dev'),null);
  assert.equal(availableUpdate(rows,'1.9.0','x64','dev'),null);
  assert.equal(availableUpdate(rows,'2.1.0-dev.5','arm64','stable').manualSwitch,true);
  assert.equal(availableUpdate(rows,'2.0.0-dev.10','arm64','stable').manualSwitch,true);
  assert.equal(availableUpdate(rows,'2.1.0','arm64','stable'),null);
  const urls=[];
  const fetcher=async url=>{
    urls.push(url);
    if (url.endsWith('/latest')) return Response.json(row);
    if (url.endsWith('page=1')) return Response.json([row],{headers:{link:'<https://example.invalid>; rel="next"'}});
    return Response.json([devRow(10)]);
  };
  assert.equal((await checkUpdate('1.9.0','arm64',fetcher,'stable')).version,'2.0.0');
  assert.equal((await checkUpdate('1.9.0','arm64',fetcher,'dev')).version,'2.0.0-dev.10');
  assert.deepEqual(urls.map(u=>u.replace('https://api.github.com/repos/kubbur/Morse/releases','')),['/latest','?per_page=100&page=1','?per_page=100&page=2']);
  await assert.rejects(checkUpdate('1.0.0','arm64',fetcher,'other'));
});

test('the channel selector remembers downloads and keeps each installer on its own feed', async t => {
  const dir=await temporary(t), pref=channelPreference(dir), calls=[];
  assert.equal(pref.read('stable'),'stable');
  let resolveStable;
  const dev=availableUpdate([devRow(10)],'1.9.0','arm64','dev');
  const client=manager({storeChannel:pref.write, installer:{configure:(...args)=>calls.push(args),install:()=>calls.push('install')},
    lookup:channel=>channel==='stable' ? new Promise(resolve=>{resolveStable=resolve;}) : dev});
  const previous=client.check();
  assert.ok(await client.setChannel('dev'));
  resolveStable(release); await previous;
  assert.equal(client.state().available,dev.version);
  assert.deepEqual(calls.at(-1),[false,'stable','']);
  assert.equal(client.state().installable,false);
  await client.install(async()=>true); assert.ok(!calls.includes('install'));
  assert.equal(channelPreference(dir).read('stable'),'dev');
  assert.equal(await client.setChannel('bogus'),false);
  const blocked=manager({version:'2.0.0-dev.9',channel:'dev',storeChannel:()=>{throw Error('read only');},installer:{configure:(...args)=>calls.push(args)},lookup:async()=>({...dev,manualSwitch:false})});
  await blocked.check(); assert.equal(await blocked.setChannel('stable'),false);
  assert.equal(blocked.state().channel,'dev'); assert.deepEqual(calls.at(-1),[false,'dev',dev.version]);
  assert.equal(blocked.state().installable,true);
  const separate=manager({version:'2.0.0-dev.9',channel:'stable',automatic:true,installer:{configure:(...args)=>calls.push(args)},
    lookup:async channel=>channel==='dev'?{...dev,manualSwitch:false}:{...release,manualSwitch:true}});
  await separate.check();
  assert.equal(separate.state().installable,false); assert.deepEqual(calls.at(-1),[true,'dev',dev.version]);
  const rollback=manager({channel:'dev',storeChannel:pref.write,installer:{configure(){},install:()=>assert.fail()},lookup:async()=>({...release,manualSwitch:true})});
  assert.ok(await rollback.setChannel('stable'));
  assert.equal(rollback.state().installable,false); await rollback.install(async()=>true);
  assert.equal(channelPreference(dir).read('dev'),'stable');
});

test('show the notice without installing, save before interactive installation and keep manual downloads available',async t=>{
  const calls=[], installer={configure:v=>calls.push(v),install:()=>calls.push('install')};
  const client=manager({installer});
  await client.check();
  assert.deepEqual(calls,[false]); assert.equal(client.state().installable,true);
  await client.install(async()=>false); assert.match(client.state().message,/saved/); assert.equal(client.installRequested,false);
  await client.install(async()=>{calls.push('save');return true;});
  assert.deepEqual(calls,[false,'save','install']); assert.equal(client.installRequested,true);
  const unconfigured=manager({installer:await macInstaller(await temporary(t))});
  await unconfigured.check(); assert.equal(unconfigured.state().available,'2.0.0');
  assert.equal(unconfigured.state().installable,false); assert.equal(unconfigured.state().automaticSupported,false);
});

test('automatic updates survive reopening the database, and a failed preference write restores the previous choice',async t=>{
  const file=join(await temporary(t),'profile.sqlite'), seen=[];
  const installer={configure:v=>seen.push(v),install:()=>assert.fail('settings must not install')};
  let db=new LearnerDB(file);
  manager({installer,automatic:db.automaticUpdates,storeAutomatic:v=>{db.automaticUpdates=v;}}).setAutomatic(true);
  db.close(); db=new LearnerDB(file);
  const next=manager({installer,automatic:db.automaticUpdates,storeAutomatic:()=>{throw Error();}});
  next.setAutomatic(false);
  assert.equal(next.state().automatic,true); assert.deepEqual(seen,[false,true,true,false,true]);
  assert.equal(db.load(null).raw,null); db.close();
});

test('an ad hoc update has different signed code and a verifiable archive signature; a changed download or wrong key fails',
  {skip:process.platform!=='darwin'},async t=>{
  const dir=await temporary(t), {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const key=sparklePublicKey(privateKey);
  assert.equal(Buffer.from(key,'base64').length,32);
  const hashes=[];
  for(const v of ['1.1.1-dev.1','1.1.1']){
    const app=join(dir,v,'Morse.app'), contents=join(app,'Contents');
    await mkdir(join(contents,'MacOS'),{recursive:true});
    const plist={CFBundleIdentifier:'digital.kubbur.morse.updatetest',CFBundleExecutable:'Morse',CFBundlePackageType:'APPL',
      CFBundleVersion:bundleVersion(v),CFBundleShortVersionString:v,SUPublicEDKey:key};
    await writeFile(join(contents,'Info.plist'),execFileSync('plutil',['-convert','xml1','-o','-','-'],{input:JSON.stringify(plist)}));
    execFileSync('xcrun',['clang','-x','c','-','-o',join(contents,'MacOS/Morse')],{input:'int main(void){return '+hashes.length+';}'});
    execFileSync('codesign',['--force','--sign','-',app],{stdio:'pipe'});
    execFileSync('codesign',['--verify','--strict',app]);
    hashes.push(createHash('sha256').update(await readFile(join(contents,'MacOS/Morse'))).digest('hex'));
    if(v.includes('dev')) continue;
    const archive=join(dir,'candidate.zip');execFileSync('ditto',['-c','-k','--keepParent',app,archive]);
    const data=await readFile(archive), feed=signedItem(data,privateKey,{version:v,url:'https://example.invalid/test.zip'});
    const signature=Buffer.from(/sparkle:edSignature="([^"]+)"/.exec(feed)[1],'base64');
    assert.equal(verify(null,data,publicKey,signature),true);
    assert.equal(verify(null,data,generateKeyPairSync('ed25519').publicKey,signature),false);
    data[0]^=1;assert.equal(verify(null,data,publicKey,signature),false);
  }
  assert.notEqual(hashes[0],hashes[1]);
});

for (const version of ['2.0.0','2.0.1-dev.10']) test('the publisher verifies both final archives and channel for ' + version,
  {skip:process.platform!=='darwin'}, async t => {
  const dir = await temporary(t);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const pub = sparklePublicKey(publicKey), dist = join(dir,'dist');
  const dev = version.includes('-dev.'), app = dev ? 'Morse Dev.app' : 'Morse.app';
  for (const name of ['scripts','src','assets','dist','build',app+'/Contents']) await mkdir(join(dir,name),{recursive:true});
  for (const name of ['appcast.mjs','stage.mjs']) await copyFile(join(root,'scripts',name),join(dir,'scripts',name));
  await copyFile(join(root,'src/updates.mjs'),join(dir,'src/updates.mjs'));
  await writeFile(join(dir,'assets/sparkle-public-key.txt'),pub);
  await writeFile(join(dir,'package.json'),JSON.stringify({version:'2.0.0'}));
  const responses = {'public-key':pub};
  const archives = [];
  for (const arch of ['arm64','x64']) {
    const path = join(dist,`Morse-${version}-mac-${arch}.zip`);
    const info = {CFBundleIdentifier:dev?'digital.kubbur.morse.dev':'digital.kubbur.morse',CFBundleVersion:bundleVersion(version),CFBundleShortVersionString:version,
      SUPublicEDKey:pub,SUFeedURL:`https://github.com/kubbur/Morse/releases/latest/download/appcast-mac-${arch}.xml`};
    const plist = execFileSync('/usr/bin/plutil',['-convert','xml1','-o','-','-'],{input:JSON.stringify(info)});
    await writeFile(join(dir,app,'Contents/Info.plist'),plist);
    execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',join(dir,app),path]);
    responses[basename(path)] = sign(null, await readFile(path), privateKey).toString('base64');
    archives.push({path,feed:join(dist,`appcast-mac-${arch}.xml`)});
  }
  // Return only precomputed public signatures. The fixture never touches the login Keychain.
  const helper = join(dir,'build/MorseReleaseKey');
  const setResponses = values => writeFile(helper,`#!${process.execPath}\nconsole.log(${JSON.stringify(values)}[process.argv.at(-1).split('/').pop()]);\n`,{mode:0o755});
  const args = version.includes('-dev.') ? ['--dev-version',version,dist] : [];
  const publish = () => execFileSync(process.execPath,[join(dir,'scripts/appcast.mjs'),'--keychain',...args],{stdio:'pipe'});
  await setResponses({...responses, [basename(archives[1].path)]:responses[basename(archives[0].path)]});
  assert.throws(publish,/Update signature failed verification/);
  for (const {feed} of archives) await assert.rejects(readFile(feed),{code:'ENOENT'});
  await setResponses(responses);
  publish();
  for (const {path,feed} of archives) {
    const xml = await readFile(feed,'utf8');
    assert.equal(xml.includes('<sparkle:channel>dev</sparkle:channel>'),version.includes('-dev.'));
    assert.equal(xml.includes('<sparkle:belowVersion>1.1.6b31</sparkle:belowVersion>'),dev);
    if (dev) assert.ok(xml.includes('<link>https://github.com/kubbur/Morse/releases/download/morse-v'+version+'/'+basename(path)+'</link>'));
    assert.ok(xml.includes('/download/morse-v'+version+'/'));
    const signature = Buffer.from(/sparkle:edSignature="([^"]+)"/.exec(xml)[1],'base64');
    assert.ok(verify(null,await readFile(path),publicKey,signature));
  }
});
