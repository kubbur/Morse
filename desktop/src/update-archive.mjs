import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function fetchArchive(url, signal, fetcher) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !hosts.has(target.hostname))
      throw Error('Unexpected update host');
    const res = await fetcher(target, { redirect: 'manual', credentials: 'omit', signal });
    if (res.status === 200 && res.body) return res.body;
    await res.body?.cancel();
    const redirect = res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !redirect) break;
    url = new URL(redirect, target);
  }
  throw Error('Update download unavailable');
}

async function matches(path, archive) {
  let info;
  try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.size !== archive.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === archive.digest;
}

// One verified ZIP per installation, separate from learning data. Interrupted
// transfers never replace it. The single running app owns this cache.
export async function downloadArchive(directory, release, signal, fetcher = fetch) {
  const archive = release.archive, path = join(directory, 'Morse.zip');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await matches(path, archive)) return path;
  const part = join(directory, 'Morse.zip.partial');
  await rm(part, {force:true});
  try {
    const body = await fetchArchive(archive.url, signal, fetcher);
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({ transform(chunk, _, done) {
      size += chunk.length;
      if (size > archive.size) return done(Error('Unexpected update size'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(body), verify, createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== archive.size || hash.digest('hex') !== archive.digest) throw Error('Update integrity check failed');
    await rename(part, path);
    return path;
  } finally { await rm(part, {force:true}); }
}

export async function prepareMacUpdate(updater, directory, release) {
  const zip = join(directory, 'Morse.zip');
  if (!await matches(zip, release.archive)) throw Error('Cached update has changed');
  const feed = join(directory, 'release.json');
  await writeFile(feed, JSON.stringify({ url: pathToFileURL(zip).href, name: release.version,
    notes: release.notes, sha256: release.archive.digest, size: release.archive.size }), { mode: 0o600 });
  // Squirrel checks the new application against the running application's
  // signing requirement. Only hand it the feed when installation is intended.
  await new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer);
      updater.off('update-downloaded', ready); updater.off('update-not-available', missing); updater.off('error', failed);
      if (error) reject(error); else resolve();
    }
    const ready = () => finish(), missing = () => finish(Error('No installable update')), failed = error => finish(error);
    const timer = setTimeout(() => finish(Error('Update preparation timed out')), 45000);
    updater.once('update-downloaded', ready); updater.once('update-not-available', missing); updater.once('error', failed);
    try { updater.setFeedURL({ url: pathToFileURL(feed).href }); updater.checkForUpdates(); }
    catch (error) { finish(error); }
  });
}
