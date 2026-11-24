import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { APP_ORIGIN } from './policy.mjs';

const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.json': 'application/json' };
const policy = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

// Intercept only this Electron partition. Keeping the previous HTTP origin
// lets Chromium expose the installed learner's old localStorage for migration.
export async function bundledTrainer(directory) {
  const files = new Map();
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), route = prefix + '/' + entry.name;
      if (entry.isDirectory()) await walk(path, route);
      else if (entry.isFile() && types[extname(path)]) files.set(route, { path, type: types[extname(path)] });
    }
  }
  await walk(directory, '');
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== APP_ORIGIN || !['GET','HEAD'].includes(request.method)) return new Response(null, { status: 403 });
    const file = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : await readFile(file.path), { headers: {
      'Content-Type': file.type, 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    } });
  };
}
