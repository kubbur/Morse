import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ORIGIN, APP_PORT } from './policy.mjs';
import { configuration, createApp } from '../website/server.mjs';

export async function startLocalServer(dataDirectory) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const server = await createApp(configuration({
    MORSE_MODE: 'local', MORSE_PUBLIC_ORIGIN: APP_ORIGIN,
    MORSE_SYNC_PATH: join(dataDirectory, 'progress.sqlite'),
  }));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(APP_PORT, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  return {
    origin: APP_ORIGIN,
    async close() {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
