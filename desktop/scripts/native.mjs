import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const nativeSource = existsSync(join(root, '../Source/MorseEngine.m')) ? join(root, '../Source') : join(root, 'Source');
export function buildWindows(target, checks = false) {
  if (process.platform !== 'win32') throw new Error('Build the Windows x64 helper on Windows with Visual Studio C++ and LLVM installed.');
  const objects = join(root, 'build', checks ? 'windows-test-objects' : 'windows-objects');
  mkdirSync(objects, { recursive:true }); mkdirSync(dirname(target), { recursive:true });
  execFileSync(process.env.ComSpec || 'cmd.exe', ['/d','/c','windows-native.cmd'], {
    cwd: join(root,'scripts'), stdio:'inherit', windowsHide:true,
    env: {...process.env, MORSE_OBJECTS:objects, MORSE_SOURCE:nativeSource, MORSE_BINARY:target, MORSE_CHECK:checks ? '1' : '0'},
  });
}
export function buildNative(target, archs = ['arm64', 'x86_64'], checks = false) {
  mkdirSync(dirname(target), { recursive: true });
  const files = checks ? ['tests/NativeChecks.m', 'PaddleBridge.m'] : ['PaddleService.m', 'MorseEngine.m'];
  const args = ['clang', ...archs.flatMap(arch => ['-arch', arch]), '-mmacosx-version-min=13.0', '-std=gnu11',
    '-fobjc-arc', '-fblocks', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    ...['AppKit','AVFoundation','CoreAudio','AudioToolbox','AudioUnit','CoreGraphics'].flatMap(f => ['-framework', f]),
    ...[...files, 'VBandTarget.m', 'DevicePreferences.m', 'MorseTyping.c', 'TypingKeys.m', 'Sidetone.c'].map(f => join(nativeSource, f)), '-o', target];
  execFileSync('/usr/bin/xcrun', args, { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['-s', '-', '--timestamp=none', '--force', target], { stdio: 'inherit' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checks = process.argv.includes('--check');
  const windows=process.platform==='win32';
  const target = join(root, 'build/native', (checks ? 'NativeChecks' : 'MorseKeyer')+(windows ? '.exe' : ''));
  if (windows) buildWindows(target,checks);
  else buildNative(target, undefined, checks);
  if (checks) execFileSync(target, [], { stdio: 'inherit' });
}
