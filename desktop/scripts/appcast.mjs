import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './stage.mjs';

export function sparklePublicKey(key) {
  const exported = (key.type === 'public' ? key : createPublicKey(key)).export({format:'jwk'});
  if (exported.crv !== 'Ed25519') throw Error('Use an Ed25519 update key.');
  return Buffer.from(exported.x, 'base64url').toString('base64');
}

export function signedItem(archive, key, {version, build=version, url}) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
  const signature = sign(null, archive, key);
  if (!verify(null, archive, createPublicKey(key), signature)) throw Error('Update signature failed verification.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Morse for Mac</title><item><title>Morse ${escape(version)}</title>
<sparkle:version>${escape(build)}</sparkle:version><sparkle:shortVersionString>${escape(version)}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
<enclosure url="${escape(url)}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature.toString('base64')}"/>
</item></channel></rss>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {version} = JSON.parse(await readFile(join(root,'package.json')));
  if (!/^\d+\.\d+\.\d+$/.test(version) || process.stdin.isTTY) throw Error('For a stable release, supply the Ed25519 PKCS#8 signing key on standard input.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  let key;
  try { key = createPrivateKey(input); } finally { input.fill(0); for (const c of chunks) c.fill(0); }
  const pub = sparklePublicKey(key), output=[];
  for (const arch of ['arm64','x64']) {
    const name='Morse-'+version+'-mac-'+arch+'.zip';
    const url='https://github.com/kubbur/Morse/releases/download/morse-v'+version+'/'+name;
    const zip=join(root,'dist',name);
    // Read the Info.plist from the shipped ZIP, not a separate build directory.
    const info=execFileSync('/usr/bin/unzip',['-p',zip,'Morse.app/Contents/Info.plist']);
    const get=k=>execFileSync('/usr/bin/plutil',['-extract',k,'raw','-o','-','-'],{input:info,encoding:'utf8'}).trim();
    if (get('SUPublicEDKey')!==pub || get('CFBundleIdentifier')!=='digital.kubbur.morse' || get('CFBundleShortVersionString')!==version ||
        get('SUFeedURL')!=='https://github.com/kubbur/Morse/releases/latest/download/appcast-mac-'+arch+'.xml')
      throw Error('The archived '+arch+' app has a different key, feed, identifier or version.');
    output.push([join(root,'dist','appcast-mac-'+arch+'.xml'), signedItem(await readFile(zip),key,{version,build:get('CFBundleVersion'),url})]);
  }
  for (const [path,xml] of output) await writeFile(path,xml);
}
