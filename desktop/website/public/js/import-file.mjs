import { importState } from './progress.mjs';
import { MAX_IMPORT_BYTES, decodeProgressFile } from './import-validation.mjs';

const cancelled = () => new DOMException('Import cancelled.', 'AbortError');

export async function readProgressFile(file, { signal, timeoutMs = 10_000 } = {}) {
  if (!(file instanceof Blob) || file.size > MAX_IMPORT_BYTES) throw new Error('Choose a Morse progress file smaller than 2 MB.');
  if (signal?.aborted) throw cancelled();
  if (typeof Worker === 'undefined') {
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw cancelled();
    return importState(decodeProgressFile(buffer));
  }
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const finish = (error, state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      if (error) reject(error);
      else resolve(state);
    };
    const abort = () => finish(cancelled());
    try {
      worker = new Worker(new URL('./import-worker.mjs', import.meta.url), { type: 'module' });
      timer = setTimeout(() => finish(new Error('That progress file took too long to check. No learners were replaced.')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (data?.ok === true && data.state?.version === 1 && Array.isArray(data.state.profiles)) finish(null, data.state);
        else finish(new Error(data?.message || 'Could not read that progress file.'));
      };
      worker.onerror = event => { event.preventDefault(); finish(new Error('Could not read that progress file. Please try again.')); };
      worker.onmessageerror = () => finish(new Error('Could not read that progress file. Please try again.'));
      worker.postMessage(file);
    } catch { finish(new Error('Could not read that progress file. Please try again.')); }
  });
}
