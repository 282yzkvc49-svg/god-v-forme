// Сборка приложения: esbuild → dist/ (плоская папка, все пути относительные).
//   node scripts/build.mjs            — обычная сборка для GitHub Pages
//   node scripts/build.mjs --single   — один HTML-файл для быстрого просмотра (без офлайна)
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const single = process.argv.includes('--single');
const outdir = path.join(root, process.env.OUT_DIR || (single ? 'dist-single' : 'dist'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: single ? 'iife' : 'esm',
  target: ['safari16', 'es2020'],
  jsx: 'automatic',
  loader: { '.json': 'json' },
  outdir,
  entryNames: single ? 'app' : 'app-[hash]',
  assetNames: '[name]-[hash]',
  write: false,
  legalComments: 'none',
  charset: 'utf8',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')),
    __DEV__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warning',
});

let jsFile = '';
let cssFile = '';
let jsText = '';
let cssText = '';
for (const f of result.outputFiles) {
  const name = path.basename(f.path);
  if (name.endsWith('.js')) { jsFile = name; jsText = f.text; }
  if (name.endsWith('.css')) { cssFile = name; cssText = f.text; }
  if (!single) await fs.writeFile(path.join(outdir, name), f.contents);
}

const template = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const version = `${pkg.version}`;

if (single) {
  // Один файл: стили и скрипт внутри, без manifest и service worker.
  const icon = await fs.readFile(path.join(root, 'public', 'apple-touch-icon.png'));
  const iconUri = `data:image/png;base64,${icon.toString('base64')}`;
  let html = template
    .replace(/<link rel="manifest"[^>]*>\n?/, '')
    .replace(/href="apple-touch-icon\.png"/g, `href="${iconUri}"`)
    .replace(/<link rel="icon"[^>]*>\n?/, `<link rel="icon" href="${iconUri}">\n`)
    .replace('<!--CSS-->', () => `<style>${cssText}</style>`)
    .replace('<!--JS-->', () => `<script>window.__SINGLE_FILE__=true;</script><script>${jsText.replace(/<\/script/gi, '<\\/script')}</script>`)
    .replace(/%VERSION%/g, version);
  await fs.writeFile(path.join(outdir, 'index.html'), html);
  console.log(`single-file: ${path.relative(root, outdir)}/index.html (${(html.length / 1024).toFixed(0)} КБ)`);
  process.exit(0);
}

// public/ → dist/ (иконки, manifest)
for (const name of await fs.readdir(path.join(root, 'public'))) {
  await fs.copyFile(path.join(root, 'public', name), path.join(outdir, name));
}

const html = template
  .replace('<!--CSS-->', `<link rel="stylesheet" href="${cssFile}">`)
  .replace('<!--JS-->', `<script type="module" src="${jsFile}"></script>`)
  .replace(/%VERSION%/g, version);
await fs.writeFile(path.join(outdir, 'index.html'), html);

// service worker: список всех файлов + версия кэша по хэшу содержимого
const files = (await fs.readdir(outdir)).filter((n) => n !== 'sw.js').sort();
const hash = createHash('sha256');
for (const n of files) hash.update(n).update(await fs.readFile(path.join(outdir, n)));
const cacheName = `gvf-${version}-${hash.digest('hex').slice(0, 10)}`;
const assets = ['./', ...files.map((n) => `./${n}`)];
const sw = (await fs.readFile(path.join(root, 'scripts', 'sw-template.js'), 'utf8'))
  .replace('__CACHE__', cacheName)
  .replace('__ASSETS__', JSON.stringify(assets, null, 2));
await fs.writeFile(path.join(outdir, 'sw.js'), sw);

const total = (await Promise.all(files.map((n) => fs.stat(path.join(outdir, n))))).reduce((s, st) => s + st.size, 0);
console.log(`dist: ${files.length + 1} файлов, ${(total / 1024).toFixed(0)} КБ, кэш ${cacheName}`);
