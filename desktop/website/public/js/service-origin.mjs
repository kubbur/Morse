export const stableOrigin = 'https://morse.kubbur.digital';
export const devOrigin = 'https://morse-dev.kubbur.digital';
export const stagingOrigin = 'http://127.0.0.1:38764';

export function serviceOrigin(mode, channel = 'stable') {
  if (mode === 'staging') return stagingOrigin;
  return channel === 'dev' ? devOrigin : stableOrigin;
}

export function invitationFromLink(value, ownOrigin) {
  const prefix = ownOrigin + '/#pair=';
  if (!value.startsWith(prefix)) return null;
  const invitation = value.slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(invitation) ? invitation : null;
}
