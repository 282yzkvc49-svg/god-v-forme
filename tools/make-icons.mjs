// Иконки приложения из tools/icon.svg → public/*.png (через Chromium из Playwright, без прозрачности).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const svg = await fs.readFile(path.join(root, 'tools/icon.svg'), 'utf8');
const out = path.join(root, 'public');
const targets = [
  ['apple-touch-icon.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78],
  ['favicon-32.png', 32, 1],
];
const browser = await chromium.launch();
for (const [name, size, scale] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const inner = svg.replace('<g transform="translate(512 540)">', `<g transform="translate(512 540) scale(${scale})">`);
  await page.setContent(`<html><body style="margin:0;background:#1b5440">${inner.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
}
await browser.close();
console.log('icons ok');
