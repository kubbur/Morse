import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { root } from './stage.mjs';
import { nativeSource } from './native.mjs';

const version = '2.10.1';
const filename = 'Sparkle-' + version + '.tar.xz';
const digest = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27';
const release = 'https://github.com/sparkle-project/Sparkle/releases/download/' + version + '/' + filename;

export const bundleVersion = version => version.replace(/-dev\.(\d+)$/, 'b$1');

async function sdk() {
  const cache = join(root, 'build', 'sparkle-' + version);
  const framework = join(cache, 'Sparkle.framework');
  try { await access(join(framework,'Sparkle')); return cache; } catch { /* First build on this machine. */ }
  await mkdir(dirname(cache), { recursive: true });
  const tmp = await mkdtemp(join(dirname(cache), 'sparkle-sdk-'));
  try {
    const archive = join(tmp, filename);
    if (process.env.MORSE_SPARKLE_ARCHIVE) await copyFile(process.env.MORSE_SPARKLE_ARCHIVE, archive);
    else execFileSync('/usr/bin/curl', ['--fail','--location','--proto','=https','--proto-redir','=https','--silent','--show-error','--output',archive,release]);
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== digest)
      throw new Error('The Sparkle distribution does not match the pinned SHA-256.');
    execFileSync('/usr/bin/tar', ['-xf',archive,'-C',tmp,'./Sparkle.framework','./LICENSE']);
    await rm(archive);
    await rename(tmp, cache);
    return cache;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

export async function addSparkle(bundle, arch, {publicKey, feedURL} = {}) {
  const resources = join(bundle, 'Contents', 'Resources');
  if (!publicKey) {
    const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    const keyFile = /^\d+\.\d+\.\d+$/.test(pkg.version) ? join(root,'assets/sparkle-public-key.txt') : process.env.MORSE_UPDATE_PUBLIC_KEY_FILE;
    if (!keyFile) return;
    publicKey = (await readFile(keyFile,'utf8')).trim();
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || Buffer.from(publicKey,'base64').length !== 32)
    throw new Error('Expected a base64-encoded 32-byte Sparkle public key.');
  const source = await sdk();
  const frameworks = join(bundle, 'Contents', 'Frameworks');
  execFileSync('/usr/bin/ditto', [join(source,'Sparkle.framework'), join(frameworks,'Sparkle.framework')]);
  await copyFile(join(source,'LICENSE'), join(resources,'LICENSE.sparkle.txt'));
  const includes = process.env.NODE_INCLUDE_DIR || resolve(dirname(process.execPath), '../include/node');
  execFileSync('/usr/bin/xcrun', ['clang','-O2','-fobjc-arc','-mmacosx-version-min=13.0','-arch',arch==='x64'?'x86_64':'arm64',
    '-I',includes,'-F',frameworks,'-bundle','-undefined','dynamic_lookup','-Wl,-rpath,@loader_path/../Frameworks',
    '-framework','Cocoa','-framework','Sparkle',join(nativeSource,'MorseUpdater.m'),join(nativeSource,'MorseUpdateFeed.m'),'-o',join(resources,'MorseUpdater.node')]);
  const plist = join(bundle,'Contents','Info.plist');
  const settings = {
    SUPublicEDKey: ['string', publicKey],
    SUFeedURL: ['string', feedURL || 'https://github.com/kubbur/Morse/releases/latest/download/appcast-mac-'+arch+'.xml'],
    SUEnableAutomaticChecks: ['bool','NO'],
    SUAutomaticallyUpdate: ['bool','NO'],
    SUVerifyUpdateBeforeExtraction: ['bool','YES'],
    SUScheduledCheckInterval: ['integer','21600'],
  };
  for (const [key,[type,value]] of Object.entries(settings))
    execFileSync('/usr/bin/plutil',['-replace',key,'-'+type,value,plist]);
}
