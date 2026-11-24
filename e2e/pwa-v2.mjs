// Обновление установленного PWA 1.9.1 → 2.0 так, как это будет на iPad/iPhone пользователя, и оба пути отката.
//  1. Стоит 1.9.1 (офлайн-кэш gvf-1.9.1-…), база устройства, завтрак 24.11 отмечен, есть вес.
//  2. Выложена 2.0: при открытии — переход на недельный цикл с резервной копией и отчётом «Что изменилось»,
//     история и записи на месте; новый service worker, старый кэш удалён; повторный запуск ничего не меняет.
//  3. Без интернета: «Неделя», меню 25.11 и библиотека открываются.
//  4. Откат в приложении: «Выключить недельный цикл» → меню 1.9 с сегодняшнего дня (копия), «Включить снова».
//  5. Откат сборки: снова выложена 1.9.1 → приложение на 1.9.1 открывает данные, отметки и вес на месте.
//  6. Снова 2.0 — переход 24.11 не повторяется (запасы и недели как были).
// Запуск: node e2e/pwa-v2.mjs (собирает текущую версию; 1.9.1 собирается из git один раз в .cache/)
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = { version: '1.9.1', ref: '85028e6', fixture: 'state_1.7.0_r1_2211.json' };
const oldDist = path.join(root, '.cache', `dist-${OLD.version}`);
const newDist = path.join(root, 'dist');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const NEW_VERSION = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!existsSync(path.join(newDist, 'sw.js'))) execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });
if (!existsSync(path.join(oldDist, 'sw.js'))) {
  const wt = path.join(root, '.cache', `wt-${OLD.version}`);
  await fs.rm(wt, { recursive: true, force: true });
  execSync(`git worktree prune && git worktree add --detach "${wt}" ${OLD.ref}`, { cwd: root, stdio: 'inherit' });
  await fs.symlink(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
  execSync('node scripts/build.mjs', { cwd: wt, stdio: 'inherit' });
  await fs.rm(oldDist, { recursive: true, force: true });
  await fs.cp(path.join(wt, 'dist'), oldDist, { recursive: true });
  execSync(`git worktree remove --force "${wt}"`, { cwd: root, stdio: 'inherit' });
}

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
const PORT = 4332;
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
page.on('pageerror', (e) => errors.push(`${serveDir === oldDist ? OLD.version : NEW_VERSION}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(300); };
const caches = () => page.evaluate(() => caches.keys());
const idb = (fn, arg) => page.evaluate(([src, a]) => new Promise((res, rej) => {
  const rq = indexedDB.open('god-v-forme');
  rq.onerror = () => rej(rq.error);
  rq.onsuccess = () => { const db = rq.result; const f = new Function('db', 'a', 'res', src); f(db, a, (x) => { db.close(); res(x); }); };
}), [fn, arg]);
const count = (store) => idb("const c = db.transaction(a).objectStore(a).count(); c.onsuccess = () => res(c.result);", store);
const getAll = (store) => idb("const c = db.transaction(a).objectStore(a).getAll(); c.onsuccess = () => res(c.result);", store);
const version = async () => { await go('/settings'); const t = await page.locator('tr', { hasText: 'Версия' }).innerText(); return t.replace('Версия', '').trim(); };
const switchTo = async (dir, ver, q) => {
  serveDir = dir;
  let keys = [];
  await page.goto(`${BASE}?${q}#/today`);
  // как повторные открытия приложения: ожидающая версия включается при запуске (страница перезагружается)
  for (let i = 0; i < 20; i++) {
    try {
      // новая версия скачивается в фоне (~1–2 с), включается при следующем открытии
      await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !r?.installing), null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      keys = await caches();
      if (process.env.DEBUG) console.log(i, keys.join(','), await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return JSON.stringify({ a: r?.active?.state, w: r?.waiting?.state, i: r?.installing?.state, c: !!navigator.serviceWorker.controller }); }));
      if (keys.length === 1 && keys[0].startsWith(`gvf-${ver}-`)) break;
      await page.reload();
    } catch { /* смена service worker перезагружает страницу */ }
  }
  await page.waitForLoadState('load');
  await page.locator('.page').first().waitFor();
  return keys;
};

async function step(name, fn) {
  try { await fn(); results.push(`✓ ${name}`); } catch (e) {
    failures++;
    await page.screenshot({ path: path.join(shots, `FAIL-pwa-v2-${results.length + 1}.png`), fullPage: true }).catch(() => {});
    results.push(`✗ ${name}\n    ${String(e?.message || e).split('\n').slice(0, 5).join('\n    ')}`);
  }
}

let before = {};
let history = {};
await step(`Установлена ${OLD.version}: офлайн-кэш, база устройства, завтрак 24.11 отмечен, есть вес`, async () => {
  await page.goto(`${BASE}?today=2026-11-24#/today`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const fx = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures', OLD.fixture), 'utf8'));
  fx.weights = { w1: { id: 'w1', date: '2026-11-24', kg: 81.2, note: null, createdAt: '2026-11-24T05:30:00.000Z' } };
  fx.taskStatus['meal:2026-11-24:breakfast'] = { taskId: 'meal:2026-11-24:breakfast', date: '2026-11-24', kind: 'meal', status: 'done', updatedAt: '2026-11-24T06:40:00.000Z' };
  await idb(`const names = Array.from(db.objectStoreNames); const tx = db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    for (const [k, v] of Object.entries(a)) if (names.includes(k)) for (const r of (k === 'settings' || k === 'meta' ? [v] : Object.values(v))) tx.objectStore(k).put(r);
    tx.oncomplete = () => res(true);`, fx);
  await page.reload();
  assert((await version()).startsWith(OLD.version), 'версия 1.9.1');
  const keys = await caches();
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${OLD.version}-`), `кэш 1.9.1: ${keys}`);
  const meta = (await getAll('meta'))[0];
  assert(meta.dataVersion === 9, `данные 1.9.1: версия ${meta.dataVersion}`);
  before = { taskStatus: await count('taskStatus'), weights: await count('weights'), backups: await count('backups'), photos: await count('photos'), trainingLogs: await count('trainingLogs') };
  // снимок истории до обновления: дни питания по 24.11, отметки, тренировки, вес, фото, замеры, запасы, командировки
  const pick = (rows, f) => JSON.stringify(rows.filter(f).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
  history = {
    days: pick(await getAll('planDays'), (x) => x.date <= '2026-11-24'),
    marks: pick(await getAll('taskStatus'), () => true),
    trainingLogs: pick(await getAll('trainingLogs'), () => true),
    weights: pick(await getAll('weights'), () => true),
    photos: pick(await getAll('photos'), () => true),
    measurements: pick(await getAll('measurements'), () => true),
    stockKeys: JSON.stringify((await getAll('stock')).map((x) => x.productId).sort()),
    pastCooks: pick(await getAll('cookingEvents'), (x) => x.date < '2026-11-24'),
    trips: (await getAll('trips')).map((t) => `${t.from}–${t.to}`).sort().join(', '),
  };
  await page.screenshot({ path: path.join(shots, '30-pwa-v2-before.png'), fullPage: true });
});

await step(`Выложена ${NEW_VERSION}: переход на недельный цикл с копией и отчётом; записи на месте`, async () => {
  serveDir = newDist;
  await page.goto(`${BASE}?today=2026-11-24&open=2#/today`);
  await page.getByRole('heading', { name: 'Что изменилось в версии 2.0' }).waitFor();
  const backups = await getAll('backups');
  assert(backups.some((b) => b.id.startsWith('v2-')), 'резервная копия перехода');
  assert(backups.length === before.backups + 1, `копий: ${backups.length}`);
  assert(await count('weights') === before.weights && await count('photos') === before.photos, 'вес и фото на месте');
  assert(await count('taskStatus') === before.taskStatus, 'отметки на месте');
  const pick = (rows, f) => JSON.stringify(rows.filter(f).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
  assert(pick(await getAll('planDays'), (x) => x.date <= '2026-11-24') === history.days, 'история питания по 24.11 — без изменений');
  assert(pick(await getAll('taskStatus'), () => true) === history.marks, 'отметки — без изменений');
  assert(pick(await getAll('trainingLogs'), () => true) === history.trainingLogs, 'тренировки — без изменений');
  assert(pick(await getAll('weights'), () => true) === history.weights, 'вес — без изменений');
  assert(pick(await getAll('photos'), () => true) === history.photos, 'фото — без изменений');
  assert(pick(await getAll('measurements'), () => true) === history.measurements, 'замеры — без изменений');
  assert(pick(await getAll('cookingEvents'), (x) => x.date < '2026-11-24') === history.pastCooks, 'прошедшие готовки — без изменений');
  const stockKeys = (await getAll('stock')).map((x) => x.productId);
  assert(JSON.parse(history.stockKeys).every((k) => stockKeys.includes(k)), 'все позиции запасов на месте');
  const trips = (await getAll('trips')).map((t) => `${t.from}–${t.to}`).sort().join(', ');
  assert(trips === '2026-11-18–2026-11-20, 2026-12-01–2026-12-02, 2026-12-15–2026-12-22', `командировки по вашему сообщению 24.11: ${trips} (было: ${history.trips})`);
  await page.screenshot({ path: path.join(shots, '31-pwa-v2-report.png'), fullPage: true });
  // файл копии до обновления: сохраняется и читается обратно — в нём данные до перехода (неделя 2.0 ещё не создана)
  await page.getByRole('button', { name: 'Файл копии до обновления' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сохранить в «Файлы»' }).click();
  const file = await dl;
  assert(/god-v-forme_backup_do-2\.0_.*\.zip$/.test(file.suggestedFilename()), `имя файла: ${file.suggestedFilename()}`);
  const zipPath = path.join(root, '.cache', file.suggestedFilename());
  await file.saveAs(zipPath);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
  const bj = JSON.parse(await zip.file('backup.json').async('string'));
  const st = bj.stores ?? bj;
  const set = (st.settings ?? [])[0] ?? {};
  assert(!set.weekly, 'в копии — данные до перехода (без недель 2.0)');
  assert((st.weights ?? []).length === before.weights && (st.taskStatus ?? []).length === before.taskStatus, 'в копии — вес и отметки');
});

await step('Новый service worker, старый кэш удалён, повторный запуск ничего не меняет', async () => {
  const keys = await switchTo(newDist, NEW_VERSION, 'today=2026-11-24');
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${NEW_VERSION}-`), `только новый кэш: ${keys}`);
  assert((await version()).startsWith(NEW_VERSION), 'версия 2.0');
  const b = await count('backups');
  await page.reload();
  await page.locator('.page').first().waitFor();
  assert(await count('backups') === b, 'переход однократный');
  await go('/day/2026-11-24');
  await page.locator('.task.k-meal.is-done', { hasText: 'Завтрак' }).waitFor();
});

await step('Без интернета: «Неделя», меню 25.11, рецепт из библиотеки', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.page').first().waitFor();
  await go('/week');
  await page.locator('a.week-card').first().waitFor();
  await go('/day/2026-11-25');
  await page.getByText('Курица с паприкой, булгуром, перцем и кабачком').first().waitFor();
  await go('/lib/m008');
  await page.getByRole('heading', { name: 'Ингредиенты' }).waitFor();
  await page.screenshot({ path: path.join(shots, '32-pwa-v2-offline.png'), fullPage: true });
  await ctx.setOffline(false);
});

await step('Откат в приложении: недельный цикл выключен (копия) → меню 1.9; включить снова — недели как были', async () => {
  await page.goto(`${BASE}?today=2026-11-26#/settings`);
  await page.getByRole('button', { name: 'Выключить недельный цикл…' }).click();
  const b = await count('backups');
  await page.getByRole('button', { name: 'Выключить', exact: true }).click();
  await page.getByRole('heading', { name: 'Недельный цикл (версия 2.0) выключен' }).waitFor();
  assert(await count('backups') === b + 1, 'копия перед возвратом');
  const days = await getAll('planDays');
  const d27 = days.find((d) => d.date === '2026-11-27');
  assert(d27 && d27.instanceId !== 'weekly', `27.11 — меню 1.9: ${d27?.instanceId}`);
  assert(days.find((d) => d.date === '2026-11-24')?.mealCards, '24.11 — история на месте');
  assert(await count('weights') === before.weights, 'вес на месте');
  await page.screenshot({ path: path.join(shots, '33-pwa-v2-rolled-back.png'), fullPage: true });
  await page.getByRole('button', { name: 'Включить снова' }).click();
  await page.getByRole('heading', { name: 'Недельный цикл (версия 2.0)' }).waitFor();
  const d27b = (await getAll('planDays')).find((d) => d.date === '2026-11-27');
  assert(d27b?.instanceId === 'weekly', '27.11 — снова по неделе');
});

await step(`Откат сборки: снова выложена ${OLD.version} — приложение открывает данные 2.0, отметки и вес на месте`, async () => {
  const keys = await switchTo(oldDist, OLD.version, 'today=2026-11-26');
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${OLD.version}-`), `кэш 1.9.1: ${keys}`);
  assert((await version()).startsWith(OLD.version), 'версия 1.9.1');
  await go('/day/2026-11-24');
  await page.locator('.task.k-meal.is-done', { hasText: 'Завтрак' }).waitFor();
  await go('/today');
  await page.locator('.page').first().waitFor();
  assert(await count('weights') === before.weights, 'вес на месте');
  await page.screenshot({ path: path.join(shots, '34-pwa-v2-back-to-191.png'), fullPage: true });
});

await step(`Снова ${NEW_VERSION}: переход 24.11 не повторяется — запасы, недели и копии как были`, async () => {
  const stock = JSON.stringify((await getAll('stock')).map((s) => [s.productId, s.moves.length]));
  const b = await count('backups');
  const keys = await switchTo(newDist, NEW_VERSION, 'today=2026-11-26');
  assert(keys.length === 1 && keys[0].startsWith(`gvf-${NEW_VERSION}-`), `кэш 2.0: ${keys}`);
  assert(await count('backups') === b, 'новой копии перехода нет');
  assert(JSON.stringify((await getAll('stock')).map((s) => [s.productId, s.moves.length])) === stock, 'запасы не сброшены');
  await go('/week');
  await page.locator('a.week-card').first().waitFor();
});

await step('Нет ошибок на страницах', async () => { assert(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nОбновление 1.9.1 → 2.0 и откат проверены');
process.exit(failures ? 1 : 0);
