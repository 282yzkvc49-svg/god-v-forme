// Обновление установленного PWA со старым офлайн-кэшем — как на iPad пользователя 23.11: стоит версия 1.8.1
// (кэш gvf-1.8.1-…), корректировку меню 22–24.11 не подтверждали, поэтому в календаре 23.11 — тефтели и говядина
// с булгуром; завтрак 23.11 уже отмечен «съеден», есть вес. На сервере новая сборка → при следующем открытии
// приложение работает на новой версии, старый кэш удалён, меню 22–24.11 применено миграцией данных при запуске
// (с резервной копией), отметки и вес на месте, всё видно и без интернета.
// Вторая проверка (OLD=1.7.0): устройство с первой редакцией корректировки (индейка с булгуром).
// Запуск: npm run test:pwa   (собирает текущую версию; старая собирается из git один раз в .cache/)
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = {
  '1.8.1': { ref: 'd163d14', fixture: 'state_1.6.0_2211.json', before: { lunch: 'Тефтели индейки, гречка, овощи', dinner: 'Говядина с булгуром и шампиньонами' } },
  '1.7.0': { ref: '047550b', fixture: 'state_1.7.0_r1_2211.json', before: { lunch: 'Индейка с булгуром и овощами', dinner: 'Куриное филе с рисом и брокколи' } },
};
const OLD_VERSION = process.env.OLD || '1.8.1';
const CASE = CASES[OLD_VERSION];
const oldDist = path.join(root, '.cache', `dist-${OLD_VERSION}`);
const newDist = path.join(root, 'dist');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const NEW_VERSION = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;

if (!existsSync(path.join(oldDist, 'sw.js'))) {
  const wt = path.join(root, '.cache', `wt-${OLD_VERSION}`);
  await fs.rm(wt, { recursive: true, force: true });
  execSync(`git worktree prune && git worktree add --detach "${wt}" ${CASE.ref}`, { cwd: root, stdio: 'inherit' });
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
const dayTitles = async (date) => {
  await go(`/day/${date}`);
  await page.locator('.task.k-meal').first().waitFor();
  return page.locator('.task.k-meal .task-sub').allInnerTexts();
};
await step(`Установлена ${OLD_VERSION}: офлайн-кэш; меню 23.11 — прежнее, завтрак 23.11 отмечен`, async () => {
  await page.goto(`${BASE}?today=2026-11-23#/today`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures', CASE.fixture), 'utf8'));
  fixture.weights = { w1: { id: 'w1', date: '2026-11-22', kg: 81.4, note: null, createdAt: '2026-11-22T05:30:00.000Z' } };
  fixture.taskStatus['meal:2026-11-23:breakfast'] = { taskId: 'meal:2026-11-23:breakfast', date: '2026-11-23', kind: 'meal', status: 'done', updatedAt: '2026-11-23T06:40:00.000Z' };
  if (OLD_VERSION === '1.8.1') fixture.settings.correctionReportUnseen = null;
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
  // как на скриншоте пользователя: календарь 23.11 со старыми блюдами
  const t = await dayTitles('2026-11-23');
  assert(t.includes(CASE.before.lunch) && t.includes(CASE.before.dinner), `до обновления: ${t.join(' | ')}`);
  await page.screenshot({ path: path.join(shots, `15-pwa-before-${OLD_VERSION}-day23.png`), fullPage: true });
  before = { taskStatus: await idbCount('taskStatus'), weights: await idbCount('weights'), backups: await idbCount('backups'), stock: await idbCount('stock') };
});

await step(`Выложена ${NEW_VERSION}: при открытии меню 22–24.11 применяется само — отчёт об изменениях`, async () => {
  serveDir = newDist;
  // как повторное открытие приложения с экрана «Домой»
  await page.goto(`${BASE}?today=2026-11-23&open=2#/today`);
  await page.getByRole('heading', { name: 'Меню 22–24.11 и запасы обновлены' }).waitFor();
  await page.getByText(/Применено автоматически при обновлении приложения/).waitFor();
  const preview = page.getByTestId('menu-preview');
  for (const t of ['Нут с булгуром и овощами', 'Индейка с гречкой и морковью', 'Курица с рисом и брокколи']) await preview.getByText(t).first().waitFor();
  assert(await idbCount('backups') === before.backups + 1, 'резервная копия перед миграцией');
  assert(await idbCount('weights') === before.weights, 'вес на месте');
  await page.screenshot({ path: path.join(shots, `15-pwa-update-${OLD_VERSION}-report.png`), fullPage: true });
});

await step('Календарь 23 и 24.11 в существующей базе: новые блюда, отметка завтрака сохранена', async () => {
  const t23 = await dayTitles('2026-11-23');
  assert(JSON.stringify(t23) === JSON.stringify(['Овсяный стакан с грушей и миндалём', 'Индейка с гречкой и морковью', 'Творог с киви и хлебцами', 'Курица с рисом и брокколи']), `23.11: ${t23.join(' | ')}`);
  assert(await page.locator('.task.k-meal.is-done', { hasText: 'Завтрак' }).count() === 1, 'завтрак 23.11 остаётся выполненным');
  assert(await page.locator('.task.k-meal.is-done').count() === 1, 'новые блюда не отмечены сами');
  await page.screenshot({ path: path.join(shots, `15-pwa-after-${OLD_VERSION}-day23.png`), fullPage: true });
  const t24 = await dayTitles('2026-11-24');
  assert(t24[1] === 'Индейка с гречкой и морковью' && t24[3] === 'Курица с рисом и брокколи', `24.11: ${t24.join(' | ')}`);
  for (const old of ['Тефтели индейки', 'Говядина с булгуром', 'Индейка с булгуром']) assert(!t23.concat(t24).some((x) => x.includes(old)), `нет «${old}»`);
  const t22 = await dayTitles('2026-11-22');
  assert(t22[1] === 'Пропущен' && t22[3] === 'Нут с булгуром и овощами', `22.11: ${t22.join(' | ')}`);
});

await step('Новый service worker включается, старый кэш удаляется, данные на месте', async () => {
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
  assert(await idbCount('weights') === before.weights, 'вес на месте');
  assert(await idbCount('taskStatus') >= before.taskStatus, 'отметки не пропали');
  // повторный запуск ничего не меняет
  const b = await idbCount('backups');
  await page.reload();
  await page.locator('.page').first().waitFor();
  assert(await idbCount('backups') === b, 'миграция однократная');
  const t23 = await dayTitles('2026-11-23');
  assert(t23[1] === 'Индейка с гречкой и морковью', 'после перезапуска меню то же');
});

await step('Без интернета — новая версия и новое меню из кэша', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.page').first().waitFor();
  const t24 = await dayTitles('2026-11-24');
  assert(t24[1] === 'Индейка с гречкой и морковью', 'офлайн — новое меню');
  assert((await version()).startsWith(NEW_VERSION), 'офлайн — новая версия');
  await go('/cook/cook-p20261116-x2211b');
  await page.getByText(/обед 23\.11 в 12:00/).first().waitFor();
  await page.screenshot({ path: path.join(shots, `15-pwa-offline-cook-${OLD_VERSION}.png`), fullPage: true });
  await ctx.setOffline(false);
});

await step('Нет ошибок в консоли', async () => { assert(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nОбновление PWA проверено');
process.exit(failures ? 1 : 0);
