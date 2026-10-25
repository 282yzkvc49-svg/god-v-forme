// Режим разработки: пересборка при изменениях и локальный сервер http://localhost:5173
// (service worker в этом режиме не регистрируется, чтобы не мешал кэш).
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist-dev');
await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });
for (const name of await fs.readdir(path.join(root, 'public'))) {
  await fs.copyFile(path.join(root, 'public', name), path.join(outdir, name));
}
const template = await fs.readFile(path.join(root, 'index.html'), 'utf8');
await fs.writeFile(
  path.join(outdir, 'index.html'),
  template
    .replace('<!--CSS-->', '<link rel="stylesheet" href="app.css">')
    .replace('<!--JS-->', '<script type="module" src="app.js"></script>')
    .replace(/%VERSION%/g, 'dev')
);

const ctx = await esbuild.context({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'esm',
  target: ['safari16', 'es2020'],
  jsx: 'automatic',
  outdir,
  entryNames: 'app',
  sourcemap: 'inline',
  charset: 'utf8',
  define: { __APP_VERSION__: '"dev"', __BUILD_ID__: '"dev"', __DEV__: 'true', 'process.env.NODE_ENV': '"development"' },
});
await ctx.watch();
const { port } = await ctx.serve({ servedir: outdir, port: 5173, host: '0.0.0.0' });
console.log(`Открой http://localhost:${port}/ (с iPad в той же сети — http://<IP компьютера>:${port}/)`);
