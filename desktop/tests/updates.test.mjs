import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { availableUpdate, checkUpdate } from '../src/updates.mjs';
import { UpdateManager, macInstaller } from '../src/update-manager.mjs';
import { signedItem, sparklePublicKey } from '../scripts/appcast.mjs';
import { bundleVersion } from '../scripts/sparkle.mjs';
import { LearnerDB } from '../src/learner-db.mjs';

const bytes = Buffer.from('disposable release fixture'), digest = createHash('sha256').update(bytes).digest('hex');
const row = { tag_name:'morse-v2.0.0', body:'Local test <b>notes</b>', assets:[{name:'Morse-2.0.0-mac-arm64.zip',
  digest:'sha256:'+digest, size:bytes.length, browser_download_url:'https://example.invalid/other.zip'},{name:'appcast-mac-arm64.xml',size:750}] };
const release = availableUpdate([row],'1.9.0','arm64');
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
