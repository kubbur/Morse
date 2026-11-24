import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './stage.mjs';

const svg = await readFile(join(root, 'assets/icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: process.env.MORSE_ICON_CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
  const entries = [];
  for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    await page.setViewportSize({ width: size, height: size });
    const png = await page.screenshot({ omitBackground: true });
    const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
    entries.push(header, png);
    if (size === 1024) await writeFile(join(root, 'assets/icon.png'), png);
  }
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + entries.reduce((n, v) => n + v.length, 0), 4);
  await writeFile(join(root, 'assets/icon.icns'), Buffer.concat([header, ...entries]));
} finally { await browser.close(); }
