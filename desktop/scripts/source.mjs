import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeSource } from './native.mjs';
import { root } from './stage.mjs';

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = join(root, 'build/source/Morse');
await rm(join(root, 'build/source'), { recursive: true, force: true });
await mkdir(target, { recursive: true }); await mkdir(join(root, 'dist'), { recursive: true });
for (const item of ['package.json', 'package-lock.json', '.gitignore', '.github', 'README.md', 'RELEASE.md', 'INSTALL.txt', 'src', 'assets', 'scripts', 'tests', 'website', 'website-manifest.json']) await cp(join(root, item), join(target, item), { recursive: true });
await cp(nativeSource,join(target,'Source'),{recursive:true,filter:path=>!relative(nativeSource,path).split('/').includes('build')});
execFileSync('python3', [join(root, 'scripts/archive.py'), join(root, 'build/source'), join(root, 'dist', `Morse-${pkg.version}-source.zip`)], { stdio: 'inherit' });
const macReport = JSON.parse(await readFile(join(root, 'dist/darwin-build.json'), 'utf8').catch(() => '{"builds":[]}'));
const sourceName = `Morse-${pkg.version}-source.zip`;
const sourceHash = createHash('sha256').update(await readFile(join(root, 'dist', sourceName))).digest('hex');
await writeFile(join(root, 'dist/SHA256SUMS.txt'), [...macReport.builds.map(build => `${build.sha256}  ${build.file}`), `${sourceHash}  ${sourceName}`].join('\n') + '\n');
console.log(`Created Morse-${pkg.version}-source.zip`);
