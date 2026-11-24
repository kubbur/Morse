import { importState } from './progress.mjs';
import { MAX_IMPORT_BYTES, decodeProgressFile } from './import-validation.mjs';

self.onmessage = async ({ data: file }) => {
  try {
    if (!(file instanceof Blob) || file.size > MAX_IMPORT_BYTES) throw new Error('Choose a Morse progress file smaller than 2 MB.');
    const state = importState(decodeProgressFile(await file.arrayBuffer()));
    self.postMessage({ ok: true, state });
  } catch (error) {
    self.postMessage({ ok: false, message: error.message || 'Could not read that progress file.' });
  } finally { self.close(); }
};
