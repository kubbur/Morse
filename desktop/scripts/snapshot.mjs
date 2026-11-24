import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { root } from './stage.mjs';

// Copy only the application, never operational files, logs or learner data.
if (!process.argv[2]) throw new Error('Usage: node scripts/snapshot.mjs /path/to/morse-website');
const source = resolve(process.argv[2]);
await mkdir(join(root, 'website'), { recursive: true });
for (const item of ['server.mjs', 'lib', 'public']) await cp(join(source, item), join(root, 'website', item), { recursive: true });
await cp(join(source, 'docs/THIRD-PARTY-LICENSES.md'), join(root, 'website/THIRD-PARTY-LICENSES.md'));
const hashes = {};
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.isFile()) hashes[relative(join(root, 'website'), path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    else throw new Error('Unexpected non-file in the website snapshot.');
  }
}
await walk(join(root, 'website'));
await writeFile(join(root, 'website-manifest.json'), JSON.stringify(hashes, null, 2) + '\n');
