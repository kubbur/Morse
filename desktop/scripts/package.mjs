import { buildNative, buildWindows } from './native.mjs';
import { addSparkle, bundleVersion } from './sparkle.mjs';
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { sign } from '@electron/osx-sign';
import { notarize } from '@electron/notarize';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root, stageApp } from './stage.mjs';

const platform = process.argv[2] || 'darwin';
const architectures = (process.argv[3] || (platform==='win32' ? 'x64' : 'arm64,x64')).split(',');
if (!['darwin', 'linux','win32'].includes(platform) || architectures.some(arch => !(platform==='win32' ? ['x64'] : ['arm64','x64']).includes(arch))) throw new Error('Unsupported build target.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const out = join(root, 'build/packages');
const dist = join(root, 'dist'); await mkdir(dist, { recursive: true });
const input = await stageApp(join(root, `build/app-${platform}`)), results = [];
for (const arch of architectures) {
  const [directory] = await packager({
    dir: input, out, platform, arch, name: 'Morse', executableName: 'Morse',
    appBundleId: 'digital.kubbur.morse', appCategoryType: 'public.app-category.education',
    appVersion: pkg.version, buildVersion: bundleVersion(pkg.version), electronVersion: pkg.devDependencies.electron,
    overwrite: true, prune: false, asar: true, icon: join(root, platform==='win32' ? 'assets/icon.ico' : 'assets/icon.icns'),
    extendInfo: { NSMicrophoneUsageDescription: 'Read the two paddle contacts through the wired headset adapter.' },
    download: { cacheRoot: process.env.ELECTRON_CACHE || join(root, 'build/downloads') },
  });
  const bundle = join(directory, platform==='darwin' ? 'Morse.app' : platform==='win32' ? 'Morse.exe' : 'Morse');
  if (platform==='win32') buildWindows(join(directory,'resources/MorseKeyer.exe'));
  if (platform === 'darwin') {
    buildNative(join(bundle,'Contents/Helpers/MorseKeyer'),[arch==='x64'?'x86_64':'arm64']);
    // Keep the download to the app and install note. Required runtime notices
    // travel inside the app, including when it is moved to Applications.
    await rename(join(directory, 'LICENSE'), join(bundle, 'Contents/Resources/LICENSE.electron.txt'));
    await rename(join(directory, 'LICENSES.chromium.html'), join(bundle, 'Contents/Resources/LICENSES.chromium.html'));
    await rm(join(directory, 'version'));
  }
  await flipFuses(bundle, {
    version: FuseVersion.V1, resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin',
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  let signing = 'not-applicable';
  if (platform === 'darwin') {
    if (process.platform === 'darwin') {
      await addSparkle(bundle,arch);
      const identity = process.env.MORSE_SIGN_IDENTITY || '-';
      await sign({ app: bundle, identity, platform: 'darwin', type: 'distribution',
        identityValidation: identity !== '-', gatekeeperAssess: false,
        optionsForFile: () => ({ entitlements: join(root, 'assets/entitlements.plist'), hardenedRuntime: identity !== '-' }),
      });
      signing = identity === '-' ? 'ad-hoc' : 'developer-id';
      if (process.env.MORSE_NOTARY_PROFILE) {
        if (identity === '-') throw new Error('Notarization requires a Developer ID identity.');
        await notarize({ appPath: bundle, keychainProfile: process.env.MORSE_NOTARY_PROFILE });
        signing = 'developer-id-notarized';
      }
    } else if (process.env.MORSE_RCODESIGN) {
      const entitlements = join(root, 'assets/entitlements.plist');
      const helpers = ['Morse Helper', 'Morse Helper (Renderer)', 'Morse Helper (GPU)', 'Morse Helper (Plugin)'];
      const scopes = helpers.flatMap(helper => ['--entitlements-xml-file', `Contents/Frameworks/${helper}.app:${entitlements}`]);
      execFileSync(process.env.MORSE_RCODESIGN, ['sign', '--timestamp-url', 'none', '--entitlements-xml-file', entitlements, ...scopes, bundle], { stdio: 'inherit' });
      signing = 'ad-hoc';
    } else throw new Error('Mac bundles need signing. Build on macOS or supply MORSE_RCODESIGN for an ad-hoc test build.');
    const name = `Morse-${pkg.version}-mac-${arch}.zip`, path = join(dist, name);
    execFileSync('python3', [join(root, 'scripts/archive.py'), directory, path, join(root, 'INSTALL.txt')], { stdio: 'inherit' });
    results.push({ architecture: arch, file: name, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), signing, fuses: await getCurrentFuseWire(bundle) });
  } else if (platform==='win32') {
    const name=`Morse-${pkg.version}-windows-${arch}.zip`, path=join(dist,name);
    execFileSync('python',[join(root,'scripts/archive.py'),directory,path,join(root,'WINDOWS.txt')],{stdio:'inherit'});
    results.push({architecture:arch,file:name,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),signing:'unsigned',fuses:await getCurrentFuseWire(bundle)});
  } else results.push({ architecture: arch, executable: `build/packages/Morse-${platform}-${arch}/Morse`, fuses: await getCurrentFuseWire(bundle) });
}
const report = { name: 'Morse', version: pkg.version, electron: pkg.devDependencies.electron, platform, createdAt: new Date().toISOString(), builds: results };
const reportDirectory = platform === 'linux' ? join(root, 'build/test-results') : dist;
await mkdir(reportDirectory, { recursive: true });
await writeFile(join(reportDirectory, `${platform}-build.json`), JSON.stringify(report, null, 2) + '\n');
if (platform !== 'linux') await writeFile(join(dist, platform==='win32' ? 'SHA256SUMS-windows.txt' : 'SHA256SUMS.txt'), results.map(r => `${r.sha256}  ${r.file}`).join('\n') + '\n');
console.log(JSON.stringify(report, null, 2));
