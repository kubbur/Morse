export const APP_PORT = 37473;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const WEBSITE = 'https://morse.kubbur.digital/';
export const COMPANION_ORIGIN = 'http://127.0.0.1:17373';
const companionPaths = new Map([
  ['/events', 'GET'], ['/sidetone/mute', 'PUT'], ['/sidetone/unmute', 'PUT'],
]);

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
    if (url.origin === APP_ORIGIN && ['GET', 'HEAD', 'POST'].includes(method)) return true;
    if (url.protocol === 'blob:') return url.origin === APP_ORIGIN;
    if (url.protocol === 'data:') return method === 'GET' && /^data:image\/(png|svg\+xml);/.test(value);
    return url.origin === COMPANION_ORIGIN && !url.search && companionPaths.has(url.pathname) && (companionPaths.get(url.pathname) === method || method === 'OPTIONS');
  } catch { return false; }
}

export function allowedPermission(permission, requestingOrigin, documentUrl) {
  if (!appDocument(documentUrl)) return false;
  try { if (new URL(requestingOrigin).origin !== APP_ORIGIN) return false; } catch { return false; }
  return ['loopback-network', 'local-network-access', 'screen-wake-lock', 'persistent-storage'].includes(permission);
}

export function progressExport(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'blob:' && url.origin === APP_ORIGIN;
  } catch { return false; }
}
