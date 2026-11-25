import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { listPackage, extractFile, statFile, getRawHeader } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { root, stageApp } from './stage.mjs';
import { macInstaller } from '../src/update-manager.mjs';

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const report = JSON.parse(await readFile(join(root, 'dist/darwin-build.json'), 'utf8'));
const staged = await stageApp(join(root, 'build/audit-app'));
const sourceFiles = new Map(), checks = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else { assert.ok(entry.isFile(), 'No links or devices in app source'); sourceFiles.set(relative(staged, path).replaceAll('\\', '/'), await readFile(path)); }
  }
}
await walk(staged);
const hash = data => createHash('sha256').update(data).digest('hex');
const validateArchive = (name, arch) => JSON.parse(execFileSync('python3', [join(root, 'scripts/verify-archive.py'), join(root, 'dist', name), arch, pkg.version], { encoding: 'utf8' }));
for (const build of report.builds) {
  assert.ok(['ad-hoc', 'developer-id', 'developer-id-notarized'].includes(build.signing));
  const bundle = join(root, `build/packages/Morse-darwin-${build.architecture}/Morse.app`);
  const asar = join(bundle, 'Contents/Resources/app.asar');
  const entries = listPackage(asar).filter(path => !statFile(asar, path.replace(/^\//, '')).files).map(path => path.replace(/^\//, ''));
  assert.deepEqual(entries.sort(), [...sourceFiles.keys()].sort(), 'Packaged app includes only the intended files');
  for (const [path, data] of sourceFiles) {
    if (path === 'package.json') {
      // Packager strips the npm-only private flag from the runtime manifest.
      const expected = JSON.parse(data); delete expected.private;
      assert.deepEqual(JSON.parse(extractFile(asar, path)), expected);
    } else assert.deepEqual(extractFile(asar, path), data, `Stale app code: ${path}`);
  }
  const fuses = await getCurrentFuseWire(bundle);
  for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments, FuseV1Options.GrantFileProtocolExtraPrivileges]) assert.equal(fuses[key], 48);
  for (const key of [FuseV1Options.OnlyLoadAppFromAsar, FuseV1Options.EnableEmbeddedAsarIntegrityValidation]) assert.equal(fuses[key], 49);
  assert.equal(hash(await readFile(join(root, 'dist', build.file))), build.sha256);
  const archive = validateArchive(build.file, build.architecture);
  if (archive.sparkleFeed && process.platform === 'darwin' && build.architecture === process.arch) {
    const updater = await macInstaller(join(bundle,'Contents/Resources'));
    assert.equal(typeof updater?.configure, 'function');
    assert.equal(typeof updater?.install, 'function');
    archive.updaterModuleLoaded = true;
  }
  assert.equal(archive.asarSha256, hash(await readFile(asar)), 'Archive contains the audited app');
  assert.equal(archive.asarHeader.algorithm, 'SHA256');
  assert.equal(archive.asarHeader.hash, hash(getRawHeader(asar).headerString));
  checks.push({ file: build.file, signing: build.signing, ...archive, codeMatchesSource: true, fusesVerified: true });
}
const sourceName = `Morse-${pkg.version}-source.zip`;
checks.push({ file: sourceName, ...validateArchive(sourceName, 'source') });
const checksumLines = await readFile(join(root, 'dist/SHA256SUMS.txt'), 'utf8');
for (const line of checksumLines.trim().split('\n')) {
  const [expected, name] = line.split('  ');
  assert.equal(hash(await readFile(join(root, 'dist', name))), expected);
}
const result = { checkedAt: new Date().toISOString(), checks, macExecution: 'Must be tested on macOS; archive and signature structure checks alone do not establish Gatekeeper acceptance.' };
await writeFile(join(root, 'dist/release-checks.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
