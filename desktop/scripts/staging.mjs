import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './stage.mjs';
import { createApp, configuration } from '../website/server.mjs';
import { Exchange } from '../website/lib/exchange.mjs';

process.umask(0o077);
const origin='http://127.0.0.1:38764';
const dir=join(root,'build/staging');
await mkdir(dir,{recursive:true,mode:0o700});
const exchange=new Exchange(join(dir,'trainer.sqlite'));
const server=await createApp(configuration({MORSE_MODE:'local',MORSE_PUBLIC_ORIGIN:origin}),{exchange});
server.on('close',()=>exchange.close());
server.listen(38764,'127.0.0.1',()=>console.log('Morse staging at '+origin));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close());
