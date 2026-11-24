export const MAX_IMPORT_BYTES = 2_000_000;
const MAX_DEPTH = 24;
const MAX_NODES = 500_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const unsupported = () => new Error('That progress file contains unsupported or excessively complex data.');

export function parseProgressJson(raw, { maxBytes = MAX_IMPORT_BYTES, maxNodes = MAX_NODES } = {}) {
  if (typeof raw !== 'string' || raw.length > maxBytes || new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error('Choose a Morse progress file smaller than 2 MB.');
  }
  // Check nesting before native parsing. Brackets inside quoted JSON strings
  // are data, including escaped quotes and backslashes.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      if (++depth > MAX_DEPTH) throw unsupported();
    } else if (c === '}' || c === ']') depth--;
  }
  let root;
  try { root = JSON.parse(raw); }
  catch { throw new Error('That file is not valid JSON.'); }
  const pending = [root];
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > maxNodes) throw unsupported();
    if (typeof value === 'number' && !Number.isFinite(value)) throw unsupported();
    if (!value || typeof value !== 'object') continue;
    const keys = Object.keys(value);
    if (nodes + pending.length + keys.length > maxNodes) throw unsupported();
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw unsupported();
      pending.push(value[key]);
    }
  }
  return root;
}

export function decodeProgressFile(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_IMPORT_BYTES) throw new Error('Choose a Morse progress file smaller than 2 MB.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('That file is not valid UTF-8 JSON.'); }
}
