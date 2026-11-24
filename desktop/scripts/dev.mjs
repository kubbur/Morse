import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root,stageApp,stage } from './stage.mjs';
import { buildNative } from './native.mjs';
import electron from 'electron';
await stageApp();
buildNative(join(root,'build/native/MorseKeyer'));
const child=spawn(electron,[stage,'--morse-isolated','--morse-staging','--user-data-dir='+join(root,'build/dev-profile')],{stdio:'inherit'});
child.on('exit',(code,signal)=>{process.exitCode=signal?1:code;});
