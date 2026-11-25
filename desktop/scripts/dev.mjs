import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root,stageApp,stage } from './stage.mjs';
import { buildNative } from './native.mjs';
import electron from 'electron';
await stageApp();
buildNative(join(root,'build/native/MorseKeyer'));
const local = process.argv.includes('--staging');
const child=spawn(electron,[stage,'--morse-isolated',local ? '--morse-staging' : '--morse-website',
  '--user-data-dir='+join(root,local ? 'build/dev-profile' : 'build/dev-website-profile')],{stdio:'inherit'});
child.on('exit',(code,signal)=>{process.exitCode=signal?1:code;});
