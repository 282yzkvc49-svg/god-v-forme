// Обновление установленного PWA со старым офлайн-кэшем: на «iPad» стоит версия 1.7.0 (кэш gvf-1.7.0-…,
// первая редакция корректировки применена, есть вес и отметки) → на сервере новая сборка → при следующем
// открытии приложение работает на новой версии, старый кэш удалён, данные на месте, меню 22–24.11 ждёт
// подтверждения и после него показывается в днях — в том числе без интернета.
// Запуск: npm run test:pwa   (собирает текущую версию; 1.7.0 собирается из git один раз в .cache/)
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_REF = process.env.OLD_REF || '047550b';
const OLD_VERSION = '1.7.0';
const oldDist = path.join(root, '.cache', `dist-${OLD_VERSION}`);
const newDist = path.join(root, 'dist');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const NEW_VERSION = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;

if (!existsSync(path.join(oldDist, 'sw.js'))) {
  const wt = path.join(root, '.cache', `wt-${OLD_VERSION}`);
  await fs.rm(wt, { recursive: true, force: true });
  execSync(`git worktree prune && git worktree add --detach "${wt}" ${OLD_REF}`, { cwd: root, stdio: 'inherit' });
  await fs.symlink(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
  execSync('node scripts/build.mjs', { cwd: wt, stdio: 'inherit' });
  await fs.rm(oldDist, { recursive: true, force: true });
  await fs.cp(path.join(wt, 'dist'), oldDist, { recursive: true });
  execSync(`git worktree remove --force "${wt}"`, { cwd: root, stdio: 'inherit' });
}

// сервер, у которого можно «выложить» новую версию
let serveDir = oldDist;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(serveDir, decodeURIComponent(url.pathname));
  const st = await fs.stat(file).catch(() => null);
  if (!st) { res.writeHead(404); res.end(); return; }
  if (st.isDirectory()) file = path.join(file, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(await fs.readFile(file));
});
const PORT = 4331;
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}/`;

const results = [];
let failures = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
ctx.setDefaultTimeout(15000);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(300); };
const caches = () => page.evaluate(() => caches.keys());
const idbCount = (store) => page.evaluate((s) => new Promise((res, rej) => {
  const rq = indexedDB.open('god-v-forme');
  rq.onerror = () => rej(rq.error);
  rq.onsuccess = () => { const db = rq.result; const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => { db.close(); res(c.result); }; };
}), store);
const version = async () => { await go('/settings'); const t = await page.locator('tr', { hasText: 'Версия' }).innerText(); return t.replace('Версия', '').trim(); };

async function step(name, fn) {
  try { await fn(); results.push(`✓ ${name}`); } catch (e) {
    failures++;
    await page.screenshot({ path: path.join(shots, `FAIL-pwa-${results.length + 1}.png`), fullPage: true }).catch(() => {});
    results.push(`✗ ${name}\n    ${String(e?.message || e).split('\n').slice(0, 5).join('\n    ')}`);
  }
}

let before = {};
await step(`Установлена ${OLD_VERSION}: офлайн-кэш, данные устройства с первой редакцией корректировки`, async () => {
  await page.goto(`${BASE}?today=2026-11-22#/today`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/state_1.7.0_r1_2211.json'), 'utf8'));
  fixture.weights = { w1: { id: 'w1', date: '2026-11-22', kg: 81.4, note: null, createdAt: '2026-11-22T05:30:00.000Z' } };
  await page.evaluate((fx) => new Promise((res, rej) => {
    const rq = indexedDB.open('god-v-forme');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) tx.objectStore(n).clear();
      for (const [k, v] of Object.entries(fx)) if (names.includes(k)) for (const r of (k === 'settings' || k === 'meta' ? [v] : Object.values(v))) tx.objectStore(k).put(r);
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => rej(tx.error);
    };
  }), fixture);
  await page.reload();
  assert((await version()).startsWith(OLD_VERSION), 'старая версия');
  const keys = await caches();
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${OLD_VERSION}-`), `кэш старой версии: ${keys}`);
  await go('/day/2026-11-22');
  await page.getByText('Индейка с булгуром и овощами').first().waitFor();
  before = { taskStatus: await idbCount('taskStatus'), weights: await idbCount('weights'), backups: await idbCount('backups'), stock: await idbCount('stock') };
});

await step(`Выложена ${NEW_VERSION}: открытие приложения — новая версия и предпросмотр меню 22–24.11`, async () => {
  serveDir = newDist;
  // как повторное открытие приложения с экрана «Домой»
  await page.goto(`${BASE}?today=2026-11-22&open=2#/today`);
  await page.getByRole('heading', { name: 'Новое меню на 22–24 ноября' }).waitFor();
  const preview = page.getByTestId('menu-preview');
  for (const t of ['Нут с булгуром и овощами', 'Индейка с гречкой и морковью', 'Курица с рисом и брокколи']) await preview.getByText(t).first().waitFor();
  assert(await preview.getByText('Индейка с булгуром и овощами').count() === 0, 'в предпросмотре нет прежнего блюда');
  await page.screenshot({ path: path.join(shots, '15-pwa-update-preview-ipad.png'), fullPage: true });
});

await step('Новый service worker включается, старый кэш удаляется', async () => {
  // при следующем открытии ожидающая версия включается сама (данные в IndexedDB не трогаются);
  // смена service worker перезагружает страницу — поэтому опрос с повторами
  let keys = [];
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(700);
    try {
      keys = await caches();
      if (keys.length === 1 && keys[0].startsWith(`gvf-${NEW_VERSION}-`)) break;
      await page.reload();
    } catch { /* страница перезагружается после смены service worker */ }
  }
  await page.waitForLoadState('load');
  await page.locator('.page').first().waitFor();
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${NEW_VERSION}-`), `остался только новый кэш: ${keys}`);
  assert((await version()).startsWith(NEW_VERSION), 'новая версия');
  assert(await idbCount('weights') === before.weights && await idbCount('taskStatus') === before.taskStatus, 'вес и отметки на месте');
});

await step('Подтверждение: резервная копия, меню перезаписано, запасы не пересозданы', async () => {
  await go('/correction');
  await page.getByLabel('Проверил меню 22–24.11 и запасы').check();
  await page.getByRole('button', { name: 'Создать резервную копию и применить' }).click();
  await page.getByRole('heading', { name: 'Меню 22–24.11 и запасы обновлены' }).waitFor();
  assert(await idbCount('backups') === before.backups + 1, 'резервная копия создана');
  assert(await idbCount('stock') === before.stock, 'запасы не пересозданы');
  assert(await idbCount('weights') === before.weights && await idbCount('taskStatus') === before.taskStatus, 'вес и отметки на месте');
  await go('/day/2026-11-22');
  await page.getByText('Нут с булгуром и овощами').first().waitFor();
  await go('/day/2026-11-23');
  await page.getByText('Индейка с гречкой и морковью').first().waitFor();
  await page.getByText('Курица с рисом и брокколи').first().waitFor();
  assert(await page.getByText('Индейка с булгуром и овощами').count() === 0, 'прежнего блюда нет');
});

await step('Без интернета — новая версия и новое меню из кэша', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.page').first().waitFor();
  await go('/day/2026-11-24');
  await page.getByText('Индейка с гречкой и морковью').first().waitFor();
  assert((await version()).startsWith(NEW_VERSION), 'офлайн — новая версия');
  await go('/cook/cook-p20261116-x2211b');
  await page.getByText(/обед 23\.11 в 12:00/).first().waitFor();
  await page.screenshot({ path: path.join(shots, '15-pwa-offline-cook-ipad.png'), fullPage: true });
  await ctx.setOffline(false);
});

await step('Нет ошибок в консоли', async () => { assert(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nОбновление PWA проверено');
process.exit(failures ? 1 : 0);
