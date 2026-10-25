// Сборка превью и скриншот: node tools/preview/render-figures.mjs [out.png] [light|dark]
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.resolve(process.argv[2] || path.join(root, 'e2e/screens/figures.png'));
const scheme = process.argv[3] || 'light';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'figs-'));
// viewBox считаем той же функцией, что и в приложении
await fs.writeFile(path.join(tmp, 'vb.tsx'), `
import { FIGURES } from '${root}/src/figures/poses';
import { computeViewBoxForPreview } from '${root}/src/figures/ExerciseFigure';
(window as any).vbs = Object.fromEntries(Object.entries(FIGURES).map(([k, d]) => [k, computeViewBoxForPreview(d)]));
`);
await esbuild.build({
  entryPoints: [path.join(tmp, 'vb.tsx'), path.join(root, 'tools/preview/figures.tsx')], bundle: true, outdir: tmp, entryNames: '[name]', format: 'iife', jsx: 'automatic',
  define: { __APP_VERSION__: '"preview"', __BUILD_ID__: '"p"', __DEV__: 'true', 'process.env.NODE_ENV': '"development"' }, logLevel: 'warning',
});
await fs.writeFile(path.join(tmp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="figures.css"></head><body><script>window.COLS=${process.env.COLS || 2}</script><div id="root"></div><script src="vb.js"></script><script src="figures.js"></script></body></html>`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto('file://' + path.join(tmp, 'index.html'));
await page.waitForTimeout(300);
await fs.mkdir(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
