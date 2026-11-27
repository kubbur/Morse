const releases = 'https://api.github.com/repos/kubbur/Morse/releases';
const releaseBase = 'https://github.com/kubbur/Morse/releases';
const maxZipSize = 512 * 1024 * 1024;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.([1-9]\d*))?$/;

export const isChannel = value => value === 'stable' || value === 'dev';

export function macIdentity(version) {
  return version.includes('-dev.')
    ? {name:'Morse Dev', id:'digital.kubbur.morse.dev'}
    : {name:'Morse', id:'digital.kubbur.morse'};
}

function parts(version) {
  const match = versionPattern.exec(version);
  if (!match) return null;
  const values = match.slice(1).map(v => v === undefined ? Infinity : Number(v));
  return values.slice(0, match[4] === undefined ? 3 : 4).every(Number.isSafeInteger) ? values : null;
}

function compare(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function latestRelease(rows, arch, channel) {
  if (!Array.isArray(rows) || !['arm64','x64'].includes(arch) || !isChannel(channel)) return null;
  let best;
  for (const row of rows) {
    if (row?.draft || typeof row?.tag_name !== 'string' || !row.tag_name.startsWith('morse-v')) continue;
    const version = row.tag_name.slice(7);
    const parsed = parts(version);
    const dev = channel === 'dev';
    if (!parsed || dev !== Number.isFinite(parsed[3]) || !!row.prerelease !== dev ||
        best && compare(parsed, best.parts) <= 0 || !Array.isArray(row.assets)) continue;
    const filename = 'Morse-' + version + '-mac-' + arch + '.zip';
    const asset = row.assets.find(a => a?.name === filename);
    if (!asset) continue;
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1];
    const archive = digest && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxZipSize
      ? {url:releaseBase + '/download/' + row.tag_name + '/' + filename, digest, size:asset.size} : null;
    const feedAvailable = row.assets.some(a => a?.name === 'appcast-mac-' + arch + '.xml' && Number.isSafeInteger(a.size) && a.size > 0);
    if (dev && (!archive || !feedAvailable)) continue;
    best = {parts:parsed, version, archive, feedAvailable, url:releaseBase + '/tag/' + row.tag_name,
      notes:typeof row.body === 'string' ? row.body.trim().slice(0,16000) : ''};
  }
  return best;
}

function candidate(release, current, channel) {
  const installed = parts(current);
  if (!release || !installed) return null;
  const {parts:target, ...details} = release;
  const difference = compare(target, installed);
  const changing = (channel === 'dev') !== Number.isFinite(installed[3]);
  if (!difference || difference < 0 && !changing) return null;
  return {...details, manualSwitch:changing};
}

export function availableUpdate(rows, current, arch, channel = 'stable') {
  return candidate(latestRelease(rows, arch, channel), current, channel);
}

export async function checkUpdate(version, arch, fetcher = fetch, channel = 'stable') {
  if (!isChannel(channel)) throw Error('Unknown update channel');
  const options = {redirect:'error', credentials:'omit', headers:{Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(10000)};
  async function read(url) {
    const response = await fetcher(url, options);
    if (!response.ok) throw Error('Release check unavailable');
    return response;
  }
  if (channel === 'stable') {
    const row = await (await read(releases + '/latest')).json();
    return availableUpdate([row], version, arch, channel);
  }
  // GitHub lists new releases first. A draft, incomplete upload or unrelated tag
  // must not hide an earlier published Dev build. Construct every URL locally.
  for (let page = 1; ; page++) {
    const response = await read(releases + '?per_page=100&page=' + page);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw Error('Invalid release list');
    const release = latestRelease(rows, arch, channel);
    if (release) return candidate(release, version, channel);
    if (!response.headers.get('link')?.includes('rel="next"')) return null;
  }
}
