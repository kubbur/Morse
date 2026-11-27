import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('base64');

// Only practice assets enter this manifest. Hashes also guard against a server
// update half way through a download. Cache.addAll commits the batch together.
export function practiceWorker(files) {
  const entries = [...files].filter(([path]) =>
    !path.includes('move-progress') &&
    (path.startsWith('/js/') || ['/index.html','/app.css','/shack.css','/fonts.css','/favicon.svg'].includes(path) || /\.(?:woff2|wav|png)$/.test(path))
  ).sort(([a],[b])=>a.localeCompare(b));
  const manifest = entries.map(([path,file])=>[path,'sha256-'+hash(file.content)]);
  const version = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0,24);
  return Buffer.from(`const files = new Map(${JSON.stringify(manifest)});
const prefix = 'morse-practice-v2-';
const name = prefix + '${version}';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(name).then(cache => cache.addAll([...files].map(([path,integrity]) =>
    new Request(new URL(path,self.location.origin), { integrity, cache:'reload', credentials:'omit', redirect:'error' })
  ))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== name) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!files.has(path)) return;
  event.respondWith((async () => {
    const cache = await caches.open(name);
    return (await cache.match(new URL(path,self.location.origin).href)) || fetch(request);
  })());
});\n`);
}
