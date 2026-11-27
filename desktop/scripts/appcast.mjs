import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './stage.mjs';

export function sparklePublicKey(key) {
  const exported = (key.type === 'public' ? key : createPublicKey(key)).export({format:'jwk'});
  if (exported.crv !== 'Ed25519') throw Error('Use an Ed25519 update key.');
  return Buffer.from(exported.x, 'base64url').toString('base64');
}

export function signedItem(archive, key, {version, build=version, url}) {
  return verifiedItem(archive, createPublicKey(key), sign(null, archive, key), {version, build, url});
}

function verifiedItem(archive, publicKey, signature, {version, build, url}) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
  if (!verify(null, archive, publicKey, signature)) throw Error('Update signature failed verification.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Morse for Mac</title><item><title>Morse ${escape(version)}</title>${/^\d+\.\d+\.\d+-dev\.[1-9]\d*$/.test(version) ? '\n<sparkle:channel>dev</sparkle:channel>' : ''}
<sparkle:version>${escape(build)}</sparkle:version><sparkle:shortVersionString>${escape(version)}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
<enclosure url="${escape(url)}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature.toString('base64')}"/>
</item></channel></rss>\n`;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const keychain = args[0] === '--keychain';
  if (keychain) args.shift();
  const pkg = JSON.parse(await readFile(join(root,'package.json')));
  const version = args[0] === '--dev-version' ? args[1] : pkg.version;
  if (args.length && !(args.length === 3 && args[0] === '--dev-version' && /^\d+\.\d+\.\d+-dev\.[1-9]\d*$/.test(version)))
    throw Error('Expected --dev-version VERSION ARCHIVE_DIRECTORY.');
  const dist = args[2] || join(root, 'dist');
  if (!/^\d+\.\d+\.\d+(?:-dev\.[1-9]\d*)?$/.test(version)) throw Error('Invalid Morse release version.');
  const pub = (await readFile(join(root,'assets/sparkle-public-key.txt'),'utf8')).trim();
  const publicKey = createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(pub,'base64').toString('base64url')}});
  let signArchive;
  if (keychain) {
    const helper = join(root,'build/MorseReleaseKey');
    if (execFileSync(helper,['public-key'],{encoding:'utf8'}).trim() !== pub) throw Error('The Morse keychain key differs from the release public key.');
    signArchive = path => Buffer.from(execFileSync(helper,['sign',path],{encoding:'utf8'}).trim(),'base64');
  } else {
    if (process.stdin.isTTY) throw Error('Use --keychain or pipe the Ed25519 PKCS#8 signing key to standard input.');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks);
    let key;
    try { key = createPrivateKey(input); } finally { input.fill(0); for (const c of chunks) c.fill(0); }
    if (sparklePublicKey(key) !== pub) throw Error('The signing key differs from the release public key.');
    signArchive = (_path, bytes) => sign(null,bytes,key);
  }
  const output=[];
  for (const arch of ['arm64','x64']) {
    const name='Morse-'+version+'-mac-'+arch+'.zip';
    const url='https://github.com/kubbur/Morse/releases/download/morse-v'+version+'/'+name;
    const zip=join(dist,name);
    // Read the Info.plist from the shipped ZIP, not a separate build directory.
    const info=execFileSync('/usr/bin/unzip',['-p',zip,'Morse.app/Contents/Info.plist']);
    const get=k=>execFileSync('/usr/bin/plutil',['-extract',k,'raw','-o','-','-'],{input:info,encoding:'utf8'}).trim();
    if (get('SUPublicEDKey')!==pub || get('CFBundleIdentifier')!=='digital.kubbur.morse' || get('CFBundleShortVersionString')!==version ||
        get('CFBundleVersion')!==version.replace(/-dev\.(\d+)$/, 'b$1') ||
        get('SUFeedURL')!=='https://github.com/kubbur/Morse/releases/latest/download/appcast-mac-'+arch+'.xml')
      throw Error('The archived '+arch+' app has a different key, feed, identifier or version.');
    const bytes = await readFile(zip);
    const item = verifiedItem(bytes,publicKey,signArchive(zip,bytes),{version,build:get('CFBundleVersion'),url});
    output.push([join(dist,'appcast-mac-'+arch+'.xml'), item]);
  }
  for (const [path,xml] of output) await writeFile(path,xml);
}
