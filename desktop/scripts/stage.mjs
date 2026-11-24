import { cp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const stage = join(root, 'build/app');

export async function stageApp(target = stage) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { devDependencies, scripts, ...runtime } = pkg;
  await writeFile(join(target, 'package.json'), JSON.stringify(runtime, null, 2) + '\n');
  for (const part of ['src', 'assets', 'website']) await cp(join(root, part), join(target, part), { recursive: true, dereference: false });
  const index = join(target, 'website/public/index.html');
  const html = await readFile(index, 'utf8');
  if (!html.includes('src="/js/app.mjs"')) throw new Error('The trainer entry point changed; update desktop staging.');
  await cp(join(root, 'src/desktop-ui.mjs'), join(target, 'website/public/js/desktop-ui.mjs'));
  await writeFile(index, html.replace('src="/js/app.mjs"', 'src="/js/desktop-ui.mjs"').replace('</body>', '<script type="module" src="/js/app.mjs"></script>\n</body>'));
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stageApp();
