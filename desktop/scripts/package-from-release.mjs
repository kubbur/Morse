// Package offline using the verified Electron runtimes from Morse 1.0.0.
// This path signs ad hoc. Developer ID and notarization use package.mjs.
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPackage, getRawHeader } from '@electron/asar';
import { sign } from '@electron/osx-sign';
import { MacApp } from '../node_modules/@electron/packager/dist/mac.js';
import plist from 'plist';
import { stageApp, root } from './stage.mjs';
import { buildNative } from './native.mjs';
import { addSparkle, bundleVersion } from './sparkle.mjs';
import { macIdentity } from '../src/updates.mjs';

const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const identity = macIdentity(pkg.version);
const appFile = identity.name + '.app';
if (process.platform !== 'darwin' || pkg.devDependencies.electron !== '45.4.1' || !process.argv[2])
  throw new Error('Use this on a Mac with Electron 45.4.1 and the original release ZIP directory.');
if (!pkg.version.includes('-dev.') && !(/^\d+\.\d+\.\d+$/.test(pkg.version) && process.argv[3] === '--ad-hoc-release'))
  throw new Error('For a stable ad hoc build, pass --ad-hoc-release after the original ZIP directory.');
if (process.env.MORSE_SIGN_IDENTITY || process.env.MORSE_NOTARY_PROFILE)
  throw new Error('Use npm run package:mac for Developer ID signing or notarization.');
const originals = resolve(process.argv[2]);
const hashes = {
  arm64: 'f93164412fb765d82439034783b48da27904e379b3e76f7ced0c2a47def6da7b',
  x64: '2099b85d7542db8ee6076cf4889a4a1e4bb2e6f096d99d7b20c22cff9c19832a',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (program,args) => execFileSync(program,args,{stdio:'inherit'});
const builds = [];
const build = join(root,'build');
const dist = join(root,'dist');
await mkdir(build,{recursive:true});
await mkdir(dist,{recursive:true});
const work = await mkdtemp(join(build,'cached-runtime-'));
const stage = await stageApp(join(work,'input'));
const manifest = JSON.parse(await readFile(join(stage,'package.json'),'utf8'));
delete manifest.private;
await writeFile(join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');

for (const [arch,hash] of Object.entries(hashes)) {
  const original = join(originals,'Morse-1.0.0-mac-'+arch+'.zip');
  if (digest(await readFile(original)) !== hash) throw new Error('Original '+arch+' runtime checksum mismatch.');
  const directory = join(work,arch);
  const bundle = join(directory,appFile);
  await mkdir(directory);
  run('ditto',['-x','-k',original,directory]);
  if (identity.name !== 'Morse') {
    await rename(join(directory,'Morse.app'),bundle);
    const contents = join(bundle,'Contents');
    await rename(join(contents,'MacOS/Morse'),join(contents,'MacOS',identity.name));
    for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
      const oldName = 'Morse Helper' + suffix, newName = identity.name + ' Helper' + suffix;
      const path = join(contents,'Frameworks',newName+'.app','Contents');
      await rename(join(contents,'Frameworks',oldName+'.app'),join(path,'..'));
      await rename(join(path,'MacOS',oldName),join(path,'MacOS',newName));
      const helperFile = join(path,'Info.plist'), helper = plist.parse(await readFile(helperFile,'utf8'));
      helper.CFBundleName = helper.CFBundleName.replace(/^Morse/,identity.name);
      helper.CFBundleIdentifier = identity.id + '.helper';
      helper.CFBundleDisplayName = helper.CFBundleExecutable = newName;
      await writeFile(helperFile,plist.build(helper));
    }
  }
  const asar = join(bundle,'Contents/Resources/app.asar');
  await createPackage(stage,asar);
  const integrity = {'Resources/app.asar':{algorithm:'SHA256',hash:digest(getRawHeader(asar).headerString)}};
  const infoPath = join(bundle,'Contents/Info.plist');
  const info = plist.parse(await readFile(infoPath,'utf8'));
  Object.assign(info,{
    CFBundleIdentifier:identity.id, CFBundleName:identity.name, CFBundleDisplayName:identity.name, CFBundleExecutable:identity.name,
    CFBundleShortVersionString:pkg.version, CFBundleVersion:bundleVersion(pkg.version),
    NSMicrophoneUsageDescription:'Read the two paddle contacts through the wired headset adapter.',
    ElectronAsarIntegrity:integrity,
  });
  await writeFile(infoPath,plist.build(info));
  const framework = join(bundle,'Contents/Frameworks/Electron Framework.framework');
  const context = {renamedAppPath:bundle,frameworkBundlePath:framework,opts:{electronVersion:'45.4.1'},asarIntegrity:integrity};
  if (!await MacApp.prototype.setIntegrityDigest.call(context)) throw new Error('Electron framework integrity metadata missing.');
  await MacApp.prototype.resetFrameworkAdHocSignature.call(context);
  buildNative(join(bundle,'Contents/Helpers/MorseKeyer'),[arch==='arm64' ? 'arm64' : 'x86_64']);
  await addSparkle(bundle,arch);
  await sign({app:bundle,identity:'-',identityValidation:false,gatekeeperAssess:false,platform:'darwin',type:'distribution',
    optionsForFile:()=>({entitlements:join(root,'assets/entitlements.plist'),hardenedRuntime:false})});
  run('codesign',['--verify','--deep','--strict',bundle]);

  // Archive only the new bundle and install note. Retain a copy at the path
  // used by the existing packaged smoke and release verification scripts.
  const output = join(root,'build/packages',identity.name+'-darwin-'+arch);
  await mkdir(output,{recursive:true});
  const standalone = join(work,'candidate-'+arch);
  await mkdir(standalone);
  run('ditto',[bundle,join(standalone,appFile)]);
  const name = 'Morse-'+pkg.version+'-mac-'+arch+'.zip';
  const archive = join(dist,name);
  run('python3',[join(root,'scripts/archive.py'),standalone,archive,join(root,'INSTALL.txt')]);
  const installed=join(output,appFile), previous=join(work,'previous-'+arch+'.app');
  // ditto merges directories and would leave a native updater from an earlier build.
  let retained=false;
  try { await rename(installed,previous); retained=true; } catch (error) { if (error.code!=='ENOENT') throw error; }
  try { await rename(bundle,installed); }
  catch (error) { if (retained) await rename(previous,installed); throw error; }
  builds.push({architecture:arch,file:name,sha256:digest(await readFile(archive)),signing:'ad-hoc'});
}
await writeFile(join(dist,'darwin-build.json'),JSON.stringify({
  name:identity.name,version:pkg.version,electron:pkg.devDependencies.electron,platform:'darwin',
  method:'verified release runtime, rebuilt ASAR and helper',builds,
},null,2)+'\n');
await rm(work,{recursive:true});
