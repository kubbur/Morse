import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { addSparkle, bundleVersion } from '../scripts/sparkle.mjs';
import { nativeSource } from '../scripts/native.mjs';
import { sparklePublicKey, signedItem } from '../scripts/appcast.mjs';
import { root } from '../scripts/stage.mjs';

const checkOnly=process.argv.includes('--verify-bundles');
const fileFeed=process.argv.includes('--file-feed');
const devChannel=process.argv.includes('--dev-channel');
const incoming=devChannel ? '2.0.0-dev.1' : '2';
const arch=process.argv.find(a=>['arm64','x64'].includes(a)) || process.arch;
const cpu=arch==='arm64'?'arm64':'x86_64';
const dir=await mkdtemp(join(tmpdir(),'morse-sparkle-fixture-'));
const id='digital.kubbur.morse.upgradetest.'+randomUUID().toLowerCase();
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
let appcast, archive, child, server, stderr='';
const run=(tool,args)=>execFileSync(tool,args,{stdio:'pipe'});
const get=(file,name)=>execFileSync('plutil',['-extract',name,'raw','-o','-',file],{encoding:'utf8'}).trim();
try {
  let origin=fileFeed ? pathToFileURL(dir).href : 'http://127.0.0.1:1';
  if (!checkOnly && !fileFeed) {
    assert.equal(arch,process.arch);
    server=createServer((req,res)=>{
      const data=req.url==='/appcast.xml' ? appcast : req.url==='/Morse.zip' ? archive : null;
      if (!data){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':req.url.endsWith('.xml')?'application/rss+xml':'application/zip','Content-Length':data.length});
      res.end(data);
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    origin='http://127.0.0.1:'+server.address().port;
  }
  const hashes=[];
  const name=devChannel?'Morse Dev':'Morse';
  const locations=['installed','incoming'].map(n=>join(dir,n,name+'.app'));
  for(const [index,bundle] of locations.entries()) {
    const contents=join(bundle,'Contents'), plist=join(contents,'Info.plist');
    for(const sub of ['Resources','Frameworks','MacOS']) await mkdir(join(contents,sub),{recursive:true});
    const version=index===1 ? incoming : devChannel ? '1.1.6-dev.31' : '1';
    const info={CFBundleIdentifier:id,CFBundleName:'Morse update fixture',CFBundleExecutable:'Fixture',CFBundlePackageType:'APPL',
      CFBundleVersion:bundleVersion(version),CFBundleShortVersionString:version,MorseFixtureState:dir,LSUIElement:true,
      MorseFixtureIncoming:incoming,MorseFixtureDev:devChannel,
      NSAppTransportSecurity:{NSAllowsLocalNetworking:true}};
    await writeFile(plist,execFileSync('plutil',['-convert','xml1','-o','-','-'],{input:JSON.stringify(info)}));
    await addSparkle(bundle,arch,{publicKey:sparklePublicKey(publicKey),feedURL:origin+'/appcast.xml'});
    const binary=join(contents,'MacOS/Fixture');
    run('xcrun',['clang','-O2','-fobjc-arc','-arch',cpu,'-mmacosx-version-min=13.0','-framework','Cocoa','-F',join(contents,'Frameworks'),'-framework','Sparkle',
      '-Wl,-rpath,@executable_path/../Frameworks','-lsqlite3','-I',nativeSource,join(nativeSource,'MorseUpdateFeed.m'),join(root,'tests/fixtures/sparkle-upgrade.m'),'-o',binary]);
    // The framework already has a vendor signature. Ad hoc sign our new native code and both different outer bundles.
    const addon=join(contents,'Resources/MorseUpdater.node');
    run('codesign',['--force','--sign','-','--timestamp=none',addon]);
    run('codesign',['--force','--sign','-','--timestamp=none',bundle]);
    run('codesign',['--verify','--deep','--strict',bundle]);
    run('lipo',[addon,'-verify_arch',cpu]);
    if (arch===process.arch) {
      run(process.execPath,['--input-type=commonjs','-e',
        "const m=require(process.argv[1]); require('node:assert/strict').ok(typeof m.configure==='function' && typeof m.install==='function')",addon]);
    }
    assert.equal(get(plist,'SUPublicEDKey'),sparklePublicKey(publicKey));
    hashes.push(createHash('sha256').update(await readFile(binary)).digest('hex'));
  }
  assert.notEqual(hashes[0],hashes[1]);
  const sibling=join(dir,'installed',devChannel?'Morse.app':'Morse Dev.app');
  run('ditto',[locations[0],sibling]);
  const siblingPlist=join(sibling,'Contents/Info.plist');
  run('plutil',['-replace','CFBundleIdentifier','-string',id+'.sibling',siblingPlist]);
  run('codesign',['--force','--sign','-','--timestamp=none',sibling]);
  const siblingSignature=await readFile(join(sibling,'Contents/_CodeSignature/CodeResources'));
  const path=join(dir,'Morse.zip');
  run('ditto',['-c','-k','--keepParent',locations[1],path]);
  archive=await readFile(path);
  appcast=Buffer.from(signedItem(archive,privateKey,{version:incoming,build:bundleVersion(incoming),url:origin+'/Morse.zip'}));
  const signature=Buffer.from(/sparkle:edSignature="([^"]+)"/.exec(String(appcast))[1],'base64');
  assert.ok(verify(null,archive,publicKey,signature));
  console.log(cpu+' · two signed app versions, packaged updater, feed and Ed25519 archive signature verified');
  if (fileFeed) await writeFile(join(dir,'appcast.xml'),appcast);
  if (!checkOnly) {
    child=spawn(join(locations[0],'Contents/MacOS/Fixture'),[],{stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1200);});
    const limit=Date.now()+90000;
    let relaunched=false;
    while(Date.now()<limit) {
      if (child.signalCode || (child.exitCode!==null && child.exitCode!==0)) throw Error('Sparkle host stopped: '+(child.signalCode || child.exitCode)+' '+stderr);
      try {relaunched=(await readFile(join(dir,'relaunched'),'utf8'))==='2';} catch(e) {if(e.code!=='ENOENT')throw e;}
      if(relaunched) break;
      await delay(250);
    }
    assert.ok(relaunched,'Updated fixture failed to relaunch: '+stderr);
    assert.equal(get(join(locations[0],'Contents/Info.plist'),'CFBundleVersion'),bundleVersion(incoming));
    run('codesign',['--verify','--deep','--strict',locations[0]]);
    console.log('Sparkle installed the second bundle in place and relaunched it with its saved 37 XP.');
  }
  assert.deepEqual(await readFile(join(sibling,'Contents/_CodeSignature/CodeResources')),siblingSignature);
  run('codesign',['--verify','--deep','--strict',sibling]);
} finally {
  if (child && child.exitCode===null && !child.signalCode) child.kill();
  if (server?.listening) await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
}
