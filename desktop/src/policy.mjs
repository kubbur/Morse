import { join } from 'node:path';
import { devOrigin } from '../website/public/js/service-origin.mjs';

export const APP_PORT = 37473;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const PADDLE_GUIDE_URL = 'https://github.com/kubbur/Morse/tree/main/docs/assembly';

export function channelForBuild(version, packaged) {
  return !packaged || version.includes('-dev.') ? 'dev' : 'stable';
}

// Older Dev releases used Stable. An origin-specific directory also isolates the renderer's saved data and pending uploads on rollback.
export function websiteProfileDirectory(directory, mode, channel) {
  return mode === 'website' && channel === 'dev' ? join(directory, new URL(devOrigin).hostname) : directory;
}

export function appDocument(value) {
  try {
    const url = new URL(value);
    return url.origin === APP_ORIGIN && !url.username && !url.password && !url.search && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}

export function allowedRequest(value, method = 'GET') {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.origin === APP_ORIGIN && ['GET', 'HEAD'].includes(method)) return true;
    if (url.protocol === 'blob:') return url.origin === APP_ORIGIN;
    if (url.protocol === 'data:') return method === 'GET' && /^data:image\/(png|svg\+xml);/.test(value);
    return false;
  } catch { return false; }
}

export function allowedPermission(permission, requestingOrigin, documentUrl) {
  if (!appDocument(documentUrl)) return false;
  try { if (new URL(requestingOrigin).origin !== APP_ORIGIN) return false; } catch { return false; }
  return ['screen-wake-lock', 'persistent-storage'].includes(permission);
}

export function progressExport(value, filename) {
  try {
    const url = new URL(value);
    return url.protocol === 'blob:' && url.origin === APP_ORIGIN &&
      (/^morse-progress-[\d-]+\.json$/.test(filename) ||
       /^Morse(?:-Dev)?-recovery-(?:[A-Z0-9-]{2,16}|no-callsign)-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.txt$/.test(filename));
  } catch { return false; }
}
