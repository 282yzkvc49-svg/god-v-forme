// Сквозная проверка 11 сценариев из ТЗ на собранной версии (dist) в Chromium.
// Запуск: npm run test:e2e   (собирает dist и проверяет; скриншоты — в e2e/screens/)
import { chromium } from 'playwright';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const PORT = 4321;
const BASE = `http://localhost:${PORT}/`;
const server = await startServer(path.join(root, 'dist'), PORT);
const browser = await chromium.launch();

let failures = 0;
const results = [];
let active = null; // страница для скриншота при ошибке
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`✓ ${name} (${Date.now() - t0} мс)`);
  } catch (e) {
    failures++;
    try { await active?.screenshot({ path: path.join(shots, `FAIL-${name.slice(0, 3).replace(/\W/g, '')}.png`), fullPage: true }); } catch { /* */ }
    results.push(`✗ ${name}\n    ${String(e?.message || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const external = [];
const errors = [];
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  return page;
}
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(250);
}

const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const page = await newPage(ctx);
active = page;
const downloads = {};

await step('1. Первый запуск: онбординг и задачи сегодняшнего дня', async () => {
  await page.goto(`${BASE}?today=2026-11-02#/today`);
  await page.getByRole('button', { name: 'Понятно, начать' }).click();
  await page.getByText('Понедельник, 2 ноября').first().waitFor();
  assert(await page.getByText('Овсянка на ночь: йогурт, банан, лён, грецкий орех').count() > 0, 'нет завтрака из seed');
  assert(await page.locator('.task').count() >= 7, 'мало задач');
  await page.screenshot({ path: path.join(shots, '01-today-ipad.png'), fullPage: true });
});

await step('2. 02.11 → Силовая А → техника → подходы → завершение → сохранение после перезапуска', async () => {
  await go(page, '/day/2026-11-02');
  await page.locator('.task.k-training .task-main').click();
  await page.getByRole('heading', { name: 'Силовая А' }).waitFor();
  await page.locator('.ex-head').nth(1).click(); // присед — техника
  assert(await page.locator('.figure-frame svg.fig-svg').count() >= 2, 'нет двух кадров техники');
  await page.screenshot({ path: path.join(shots, '02-workout-technique.png'), fullPage: true });
  const sets = page.locator('.set-btn');
  const n = await sets.count();
  for (let i = 0; i < n; i++) await sets.nth(i).click();
  // вес и сложность для приседа
  const weightInput = page.getByLabel('Вес гири', { exact: true }).first();
  await weightInput.fill('12');
  await weightInput.blur();
  await page.getByRole('group', { name: 'Сложность' }).first().getByRole('button', { name: 'легко' }).click();
  await page.getByText('Таймер отдыха').or(page.getByText('Отдых')).first().waitFor();
  await page.getByRole('button', { name: /Завершить тренировку/ }).click();
  await page.getByRole('button', { name: 'нормально' }).last().click();
  await page.getByPlaceholder(/тянуло поясницу/).fill('Присед дался легко');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('.today-hero').waitFor();
  await page.waitForTimeout(600); // запись в IndexedDB завершается асинхронно
  await page.reload();
  await page.locator('.page').first().waitFor();
  await go(page, '/workout/train%3A2026-11-02');
  await page.getByText(/Тренировка отмечена выполненной/).waitFor();
  assert(await page.getByText(`${n} из ${n} подходов`).count() === 1, 'подходы не сохранились');
});

await step('3. 04.11 → готовка: блюда, продукты, пошаговые рецепты', async () => {
  await go(page, '/day/2026-11-04');
  await page.locator('.task.k-cooking .task-main').click();
  await page.getByRole('heading', { name: /Готовка, 4 ноября/ }).waitFor();
  assert(await page.getByText('Тефтели индейки').count() > 0, 'нет блюд готовки');
  assert(await page.getByText('Нужные продукты').count() === 1, 'нет продуктов');
  await page.screenshot({ path: path.join(shots, '03-cooking.png'), fullPage: true });
  await page.locator('a.chip', { hasText: 'Тефтели из индейки' }).first().click();
  await page.getByRole('heading', { name: 'Пошагово' }).waitFor();
  await page.locator('.step-item .check').first().click();
  assert(await page.locator('.step-item.on').count() === 1, 'шаг не отметился');
});

await step('4. 16.11 → закупка: отметки и бюджет', async () => {
  await go(page, '/day/2026-11-16');
  await page.locator('.task.k-shopping .task-main').click();
  await page.getByRole('heading', { name: 'Закупка на 16–30 дни' }).waitFor();
  await page.locator('.shop-item .check').nth(0).click();
  await page.locator('.shop-item .check').nth(1).click();
  await page.getByText('2 из 51').waitFor();
  assert(await page.getByText(/14\s474\s₽/).count() > 0, 'нет ориентира бюджета');
  await page.getByRole('button', { name: 'Вписать фактические цены' }).click();
  const price = page.getByLabel('Фактическая цена: Куриная грудка');
  await price.fill('799,90');
  await price.blur();
  await page.getByText(/Фактически \(1 поз\.\)/).waitFor();
  await page.screenshot({ path: path.join(shots, '04-shopping.png'), fullPage: false });
});

await step('5. 29.11 → релакс-день без обязательных приёмов пищи', async () => {
  await go(page, '/day/2026-11-29');
  await page.getByRole('heading', { name: 'Релакс-день' }).waitFor();
  assert(await page.locator('.task.k-meal').count() === 0, 'в релакс-день есть приёмы пищи');
  assert(await page.locator('.task.k-training').count() === 0, 'в релакс-день есть тренировка');
  await page.screenshot({ path: path.join(shots, '05-relax.png'), fullPage: true });
});

await step('6. Вес 106,4 → точка на графике', async () => {
  await go(page, '/progress?tab=weight');
  assert(await page.getByText('Недостаточно данных').count() > 0, 'без данных должен быть пустой график');
  await page.locator('.card-head button', { hasText: 'Вес' }).click();
  await page.getByLabel('Вес в килограммах').fill('106,4');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.locator('.chart-svg circle.dot').first().waitFor();
  assert(await page.locator('.chart-svg circle.dot').count() === 1, 'должна быть одна точка');
  assert(await page.getByText('106,4 кг').count() > 0, 'нет текущего веса');
});

await step('7. Два фото → сравнение, без сети', async () => {
  await go(page, '/progress?tab=photos');
  const png = async (color) => {
    const p2 = await ctx.newPage();
    await p2.setContent(`<canvas id=c width=300 height=400></canvas><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='${color}';c.fillRect(0,0,300,400);</script>`);
    const b = await p2.locator('#c').screenshot();
    await p2.close();
    return b;
  };
  const before = external.length;
  await page.locator('input[type=file][accept="image/*"]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: await png('#c88') },
    { name: 'b.png', mimeType: 'image/png', buffer: await png('#88c') },
  ]);
  await page.locator('.gallery .thumb').nth(1).waitFor();
  await page.getByRole('button', { name: /Сравнить два фото/ }).click();
  await page.locator('.gallery .thumb').nth(0).click();
  await page.locator('.gallery .thumb').nth(1).click();
  await page.locator('.compare').waitFor();
  assert(external.length === before, `были внешние запросы: ${external.slice(before).join(', ')}`);
  await page.screenshot({ path: path.join(shots, '07-photos.png'), fullPage: true });
});

await step('8. Отчёт ZIP: только реальные данные, фото исключены', async () => {
  await go(page, '/analysis?tab=report');
  await page.getByRole('button', { name: 'Выгрузить отчёт за месяц' }).click();
  await page.getByText('Отчёт готов').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Сохранить или поделиться' }).click()]);
  const file = path.join(shots, dl.suggestedFilename());
  await dl.saveAs(file);
  downloads.report = file;
  assert(dl.suggestedFilename() === 'report_2026-11.zip', `имя ${dl.suggestedFilename()}`);
  const z = await JSZip.loadAsync(await fs.readFile(file));
  const names = Object.keys(z.files).sort().join(',');
  assert(names === 'manifest.json,monthly_report.json,monthly_summary.md', `файлы: ${names}`);
  const j = JSON.parse(await z.file('monthly_report.json').async('string'));
  assert(j.weights.length === 1 && j.weights[0].kg === 106.4, 'вес в отчёте');
  const done = j.workouts.filter((w) => w.status === 'done');
  assert(done.length === 1, `выполненных тренировок ${done.length}: ${JSON.stringify(j.workouts.map((w) => [w.planned_date, w.status, w.sets_marked]))}`);
  const sq = done[0].exercises.find((e) => e.exercise_id === 'goblet_squat');
  assert(sq.weight_kg_used === 12 && sq.difficulty === 'easy', 'рабочий вес/сложность');
  assert(done[0].exercises.find((e) => e.exercise_id === 'kb_row').weight_kg_used === null, 'план выдан за факт');
  assert(j.photos.length === 0, 'фото не должны попадать по умолчанию');
  assert(j.nutrition_adherence.planned === 4 && j.nutrition_adherence.done === 0 && j.nutrition_adherence.unknown === 4, `питание: ${JSON.stringify(j.nutrition_adherence)}`);
});

await step('9. Импорт plan_update.json → «Было → Станет» → применить → история', async () => {
  await go(page, '/analysis?tab=import');
  await page.locator('input[type=file][accept*=json]').setInputFiles(path.join(root, 'examples/plan_update_example.json'));
  await page.getByRole('heading', { name: 'Было → Станет' }).waitFor();
  assert(await page.locator('.diff-line').count() > 3, 'нет строк сравнения');
  await page.screenshot({ path: path.join(shots, '09-import-diff.png'), fullPage: true });
  await page.getByRole('button', { name: /Применить выбранные/ }).click();
  await page.getByRole('heading', { name: 'Импорт планов' }).waitFor();
  await go(page, '/day/2026-12-02');
  await page.getByText('Силовая Б').first().waitFor();
  await go(page, '/day/2026-11-02');
  assert(await page.locator('.task.k-training .status-tag.done').count() === 1, 'история тренировки 02.11 исчезла');
  await go(page, '/workout/train%3A2026-12-04');
  await page.getByText('3 × 8, ориентир 12–16 кг').waitFor();
});

await step('10. Офлайн: приложение, техника, меню и чек-листы доступны', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForTimeout(400);
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.page').first().waitFor();
  await go(page, '/exercise/kb_rdl');
  assert(await page.locator('svg.fig-svg').count() >= 2, 'нет схем офлайн');
  await go(page, '/nutrition?d=2026-11-05');
  await page.getByText('Тефтели из индейки + булгур + кабачок + морковь').first().waitFor();
  await go(page, '/shop/shop-2026-11-16');
  await page.getByText('2 из 51').waitFor();
  await ctx.setOffline(false);
});

await step('11. Резервная копия → восстановление на «другом устройстве»', async () => {
  await go(page, '/analysis?tab=backup');
  await page.getByRole('button', { name: 'Создать резервную копию' }).click();
  await page.getByText(/Проверено:/).waitFor({ timeout: 20000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Сохранить в «Файлы»' }).click()]);
  const file = path.join(shots, 'backup.zip');
  await dl.saveAs(file);
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, hasTouch: true, locale: 'ru-RU' });
  const p2 = await newPage(ctx2);
  active = p2;
  await p2.goto(`${BASE}?today=2026-11-02#/analysis?tab=backup`);
  await p2.getByRole('button', { name: 'Понятно, начать' }).click();
  await p2.locator('.card', { hasText: 'Восстановить из копии' }).locator('input[type=file]').setInputFiles(file);
  await p2.getByText('Целостность проверена').waitFor();
  await p2.getByRole('button', { name: 'Восстановить' }).click();
  await p2.waitForTimeout(500);
  await go(p2, '/progress?tab=photos');
  await p2.locator('.gallery .thumb').nth(1).waitFor();
  await go(p2, '/progress?tab=weight');
  await p2.getByText('106,4 кг').first().waitFor();
  await go(p2, '/workout/train%3A2026-11-02');
  await p2.getByText(/Тренировка отмечена выполненной/).waitFor();
  await p2.screenshot({ path: path.join(shots, '11-restored-iphone.png'), fullPage: true });
  await go(p2, '/today');
  await p2.screenshot({ path: path.join(shots, '11-today-iphone.png'), fullPage: false });
  await ctx2.close();
});

await step('Нет ошибок в консоли и внешних запросов', async () => {
  const real = errors.filter((e) => !/Failed to load resource.*(ERR_INTERNET_DISCONNECTED|net::ERR_FAILED)/.test(e));
  assert(real.length === 0, `ошибки: ${real.slice(0, 5).join(' | ')}`);
  assert(external.length === 0, `внешние запросы: ${external.slice(0, 5).join(', ')}`);
});

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nВсе сценарии пройдены');
process.exit(failures ? 1 : 0);
