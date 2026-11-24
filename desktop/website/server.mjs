import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
import { SyncStore, SyncError, credential, syncCookie } from './lib/sync-store.mjs';
import { parseProgressJson } from './public/js/import-validation.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const normalizeIp = address => address?.startsWith('::ffff:') ? address.slice(7) : address;
const isLoopback = address => ['127.0.0.1', '::1'].includes(normalizeIp(address));
const FORWARDING = new Set(['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-for']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function configuration(source = process.env) {
  const mode = source.MORSE_MODE === 'local' ? 'local' : 'production';
  const publicOrigin = source.MORSE_PUBLIC_ORIGIN || 'https://morse.kubbur.digital';
  const url = new URL(publicOrigin);
  if (url.origin !== publicOrigin || url.username || url.password ||
      (mode === 'production' && url.protocol !== 'https:') ||
      (mode === 'local' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'))) {
    throw new Error('Use an exact HTTPS public origin, or explicit local mode with an http://127.0.0.1 origin.');
  }
  const legacyOrigins = (source.MORSE_LEGACY_ORIGINS || '').split(',').filter(Boolean);
  for (const origin of legacyOrigins) {
    const legacy = new URL(origin);
    if (mode !== 'production' || legacy.origin !== origin || legacy.protocol !== 'https:' || legacy.username || legacy.password)
      throw new Error('Legacy origins must be exact HTTPS origins in production mode.');
  }
  const allowedOrigins = [publicOrigin, ...legacyOrigins];
  const trustedProxyIp = source.MORSE_TRUSTED_PROXY_IP || '';
  const edgeIp = source.MORSE_EDGE_IP || '10.0.1.76';
  if ((trustedProxyIp && !isIP(trustedProxyIp)) || !isIP(edgeIp)) throw new Error('Configure individual measured IP addresses, not networks or wildcards.');
  return { mode, publicOrigin, publicHost: url.host, allowedOrigins, trustedProxyIp, edgeIp, syncPath: source.MORSE_SYNC_PATH || ':memory:' };
}

export function validateBoundary(request, config) {
  const headers = request.headers;
  const rawHeaders = request.rawHeaders || [];
  const counts = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if ([...counts].some(([name, count]) => count > 1 && (FORWARDING.has(name) || ['host', 'origin', 'forwarded', 'x-real-ip'].includes(name)))) return 'Duplicate boundary header';
  const forwardedNames = Object.keys(headers).filter(name => name.startsWith('x-forwarded-'));
  if (headers.forwarded !== undefined || headers['x-real-ip'] !== undefined || forwardedNames.some(name => !FORWARDING.has(name))) return 'Unexpected forwarding header';
  const peer = normalizeIp(request.socket.remoteAddress);
  const health = request.url === '/healthz' && request.method === 'GET' &&
    isLoopback(peer) && ['127.0.0.1:8000', 'localhost:8000'].includes(headers.host) && forwardedNames.length === 0;
  if (health) return null;
  const requestOrigin = (config.allowedOrigins || [config.publicOrigin]).find(origin => new URL(origin).host === headers.host);
  if (!requestOrigin) return 'Incorrect host';
  if (config.mode === 'local') {
    if (!isLoopback(peer) || forwardedNames.length) return 'Local access must be direct and loopback only';
  } else {
    if (!config.trustedProxyIp || peer !== config.trustedProxyIp) return 'Untrusted proxy peer';
    if (headers['x-forwarded-host'] !== headers.host || headers['x-forwarded-proto'] !== 'https' ||
        headers['x-forwarded-port'] !== '443' || headers['x-forwarded-for'] !== config.edgeIp) return 'Incorrect canonical forwarding headers';
  }
  if (!['GET', 'HEAD'].includes(request.method) && headers.origin !== requestOrigin) return 'Exact public Origin required';
  return null;
}

async function loadPublic(directory = join(ROOT, 'public'), prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const route = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, file] of await loadPublic(path, route)) files.set(name, file);
    } else if (entry.isFile() && MIME[extname(entry.name)]) {
      const content = await readFile(path);
      files.set(route, { content, compressed: content.length > 1000 ? gzipSync(content) : null, type: MIME[extname(entry.name)] });
    }
  }
  return files;
}

export async function createApp(config = configuration(), { log = console.warn, syncStore } = {}) {
  const files = await loadPublic();
  const store = syncStore || new SyncStore(config.syncPath);
  const rates = new Map();
  let inflight = 0;
  function allowed(key, limit) {
    const minute = Math.floor(Date.now() / 60000);
    if (rates.size > 2000) for (const [k, v] of rates) if (v.minute !== minute) rates.delete(k);
    const record = rates.get(key)?.minute === minute ? rates.get(key) : { minute, count: 0 };
    rates.set(key, record);
    return ++record.count <= limit;
  }
  let lastPeerLog = '';
  const handle = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.mode === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), screen-wake-lock=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; script-src-attr 'none'; worker-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:17373/events http://127.0.0.1:17373/sidetone/mute http://127.0.0.1:17373/sidetone/unmute; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const reject = (status, message) => {
      // No rejected request needs a body. Close instead of draining an upload
      // or allowing its remaining bytes to become another keep-alive request.
      res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    const reason = validateBoundary(req, config);
    if (reason) {
      if (reason === 'Untrusted proxy peer' && lastPeerLog !== req.socket.remoteAddress) {
        lastPeerLog = req.socket.remoteAddress;
        log(`Rejected untrusted proxy peer: ${normalizeIp(req.socket.remoteAddress)}. Measure and configure MORSE_TRUSTED_PROXY_IP.`);
      }
      return reject(403, 'Forbidden');
    }
    if (req.url.startsWith('/api/sync/')) {
      const match = /^\/api\/sync\/(status|start|join|approve|cancel|disconnect|push|identity|leaderboard|erase)$/.exec(req.url);
      if (!match) return reject(404, 'Not found');
      if (req.method !== 'POST') return reject(405, 'Use POST');
      if (req.headers['x-morse-sync'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'Forbidden');
      if (req.headers.expect !== undefined) return reject(417, 'Request expectations are not supported.');
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return reject(415, 'JSON required');
      if (req.headers['transfer-encoding'] !== undefined || !/^\d+$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) > 2050000) return reject(413, 'Save too large');
      const token = credential(req, config);
      const authenticated = token ? store.device(token) : null;
      const identity = authenticated?.id || 'unpaired';
      const action = match[1];
      if (!allowed('global', 2400) || !allowed(identity, authenticated ? 120 : 240) || ['start', 'join', 'identity'].includes(action) && !allowed(`pair:${identity}`, 10)) {
        res.setHeader('Retry-After', '60');
        return reject(429, 'Please wait a minute before trying again.');
      }
      if (inflight >= 4) return reject(503, 'Sync is busy. Your progress stays saved locally.');
      inflight++;
      let finished = false, size = 0;
      const chunks = [];
      const release = () => { if (!finished) { finished = true; inflight--; } };
      req.on('error', release);
      req.on('close', release);
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 2050000) { release(); reject(413, 'Save too large'); req.destroy(); }
        else chunks.push(chunk);
      });
      req.on('end', () => {
        release();
        if (res.writableEnded) return;
        let body;
        try {
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          body = parseProgressJson(raw, { maxBytes: 2050000 });
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
        } catch { return reject(400, 'Invalid sync data.'); }
        try {
          const result = store.request(action, token, body);
          if (Object.hasOwn(result, 'setToken')) { res.setHeader('Set-Cookie', syncCookie(config, result.setToken)); delete result.setToken; }
          else if (token && result.connected) res.setHeader('Set-Cookie', syncCookie(config, token));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (error) {
          if (error instanceof SyncError) return reject(error.status, error.message);
          if (error.code?.startsWith('ERR_SQLITE')) return reject(503, 'Sync is unavailable. Your progress stays saved locally.');
          return reject(400, 'Invalid saved progress.');
        }
      });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return reject(405, 'Method not allowed.');
    }
    if (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0) return reject(413, 'Request bodies are not accepted.');
    if (req.headers.expect !== undefined) return reject(417, 'Request expectations are not supported.');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reject(400, 'Invalid request target');
    let path;
    try { path = decodeURIComponent(req.url.split('?')[0]); } catch { return reject(400, 'Invalid path'); }
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(req.method === 'HEAD' ? undefined : '{"status":"ok","application":"morse","version":"1.0.0"}');
    }
    if (path === '/') path = '/index.html';
    const file = files.get(path);
    if (!file) return reject(404, 'Not found');
    const compressed = file.compressed && /(?:^|[,\s])gzip(?:[,\s;]|$)/.test(req.headers['accept-encoding'] || '');
    const body = compressed ? file.compressed : file.content;
    res.setHeader('Vary', 'Accept-Encoding');
    if (compressed) res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const server = http.createServer({
    maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 5000,
  }, handle);
  // Avoid Node's automatic 100 Continue response: this static app accepts no uploads.
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.maxConnections = 128;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.on('close', () => { if (!syncStore) store.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration();
  const port = Number(process.env.PORT || (config.mode === 'local' ? new URL(config.publicOrigin).port || 3000 : 8000));
  const host = config.mode === 'local' ? '127.0.0.1' : '0.0.0.0';
  const server = await createApp(config);
  server.listen(port, host, () => console.log(`Morse listening on ${host}:${port}; public origin ${config.publicOrigin}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
