// Простой статический сервер для проверки сборки: node scripts/serve.mjs dist 4173
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export function startServer(root = dir, p = port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      const st = await fs.stat(file).catch(() => null);
      if (!st) { res.writeHead(404); res.end('not found'); return; }
      if (st.isDirectory()) file = path.join(file, 'index.html');
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(p, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
  console.log(`http://localhost:${port}/  (${dir})`);
}
