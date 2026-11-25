const releases = 'https://api.github.com/repos/kubbur/Morse/releases';
const releaseBase = 'https://github.com/kubbur/Morse/releases';
const maxZipSize = 512 * 1024 * 1024;
const versionParts = v => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
export function availableUpdate(rows, current, arch) {
  const installed = versionParts(current.split('-')[0]);
  if (!installed || !Array.isArray(rows) || !['arm64','x64'].includes(arch)) return null;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let best = null;
  for (const row of rows) {
    const match = /^morse-v(\d+\.\d+\.\d+)$/.exec(row?.tag_name);
    if (!match || row.draft || row.prerelease) continue;
    const version = match[1], parts = versionParts(version);
    const difference = compare(parts, installed);
    if (difference < 0 || difference === 0 && !current.includes('-') || best && compare(parts, best.parts) <= 0) continue;
    const filename = `Morse-${version}-mac-${arch}.zip`;
    const asset = Array.isArray(row.assets) && row.assets.find(a => a?.name === filename);
    if (!asset) continue;
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1];
    const archive = digest && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxZipSize
      ? { url: `${releaseBase}/download/morse-v${version}/${filename}`, digest, size: asset.size } : null;
    const notes = typeof row.body === 'string' ? row.body.trim().slice(0, 16000) : '';
    const feedAvailable = row.assets.some(a=>a?.name==='appcast-mac-'+arch+'.xml' && Number.isSafeInteger(a.size) && a.size>0);
    best = { version, parts, feedAvailable, url: `${releaseBase}/tag/morse-v${version}`, notes, archive };
  }
  if (!best) return null;
  const { parts, ...release } = best;
  return release;
}
export async function checkUpdate(version, arch, fetcher = fetch) {
  const response = await fetcher(releases + '?per_page=30', { redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Release check unavailable');
  return availableUpdate(await response.json(), version, arch);
}
