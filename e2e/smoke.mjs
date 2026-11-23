// Сквозная проверка 12 сценариев из ТЗ на собранной версии (dist) в Chromium.
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
ctx.setDefaultTimeout(12000);
active = page;
const downloads = {};

await step('1. Первый запуск: дата старта питания и тренировок, день с граммовками', async () => {
  await page.goto(`${BASE}?today=2026-11-02#/today`);
  await page.getByRole('heading', { name: 'Когда начинаем программу питания?' }).waitFor();
  await page.locator('.sheet').getByRole('button', { name: 'Сегодня', exact: true }).click();
  await page.getByText(/первую закупку и готовку нужно сделать сегодня до обеда/).first().waitFor();
  assert(await page.getByText(/Релакс-день/).count() > 0, 'нет релакс-дня в предпросмотре');
  await page.screenshot({ path: path.join(shots, '00-onboarding-start.png'), fullPage: true });
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('heading', { name: 'Когда начать тренировки?' }).waitFor();
  await page.locator('.sheet input[type=date]').fill('2026-11-02');
  await page.getByRole('button', { name: 'Начать', exact: true }).click();
  await page.getByText('Понедельник, 2 ноября').first().waitFor();
  assert(await page.locator('.task.k-shopping').count() === 1 && await page.locator('.task.k-cooking').count() === 1, 'старт сегодня — закупка и готовка сегодня');
  await go(page, '/day/2026-11-02');
  await page.getByText('Ночная овсянка с бананом, клубникой и орехами').first().waitFor();
  assert(await page.getByText('Хлопья овсяные «Экспресс» Nordic').count() > 0, 'нет состава с граммами');
  assert(await page.locator('.task').count() >= 7, 'мало задач');
  await page.screenshot({ path: path.join(shots, '01-day-ipad.png'), fullPage: true });
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
  // вес и сложность для приседа: только гири 12 и 16 кг
  const bells = page.getByRole('group', { name: 'Вес гири' }).first();
  assert(await bells.getByRole('button').count() === 2, 'выбор только из двух гирь');
  await bells.getByRole('button', { name: /12 кг/ }).click();
  await page.getByLabel('Подход 1: фактически').nth(1).fill('8');
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
  await page.getByRole('heading', { name: /Основная готовка, 4 ноября/ }).waitFor();
  assert(await page.getByText('Тефтели индейки, гречка, овощи').count() > 0, 'нет блюд готовки');
  assert(await page.getByText('Продукты на всю партию').count() >= 3, 'нет продуктов на партию');
  assert(await page.getByText('3 порции').count() > 0, 'порции партии');
  assert(await page.getByText(/Контейнеры: \d+/).count() === 1, 'нет контейнеров');
  await page.screenshot({ path: path.join(shots, '03-cooking.png'), fullPage: true });
  await page.locator('a', { hasText: 'Карточка рецепта' }).first().click();
  await page.getByRole('heading', { name: 'Пошагово' }).waitFor();
  await page.locator('.step-item .check').first().click();
  assert(await page.locator('.step-item.on').count() === 1, 'шаг не отметился');
});

await step('4. 15.11 → вторая закупка: количества из меню, отметки, «есть дома», бюджет', async () => {
  await go(page, '/day/2026-11-15');
  await page.locator('.task.k-shopping .task-main').click();
  await page.getByRole('heading', { name: 'Основная закупка 2' }).waitFor();
  await page.locator('.shop-item .check').nth(0).click();
  await page.locator('.shop-item .check').nth(1).click();
  assert(await page.locator('.shop-item.bought').count() === 2, 'отметки «куплено»');
  await page.locator('.shop-item button.chip', { hasText: 'есть дома' }).nth(2).click();
  assert(await page.locator('.shop-item.bought').count() === 3, '«есть дома»');
  assert(await page.getByText('Ориентир по списку').count() === 1, 'нет ориентира бюджета');
  await page.getByRole('button', { name: 'Вписать фактические цены' }).click();
  const price = page.locator('.price-input').first();
  await price.fill('799,90');
  await price.blur();
  await page.getByText(/Фактически \(1 поз\.\)/).waitFor();
  await page.screenshot({ path: path.join(shots, '04-shopping.png'), fullPage: false });
});

await step('5. 29.11 → релакс-день без обязательных приёмов пищи', async () => {
  await go(page, '/day/2026-11-29');
  await page.getByRole('heading', { name: 'Релакс-день' }).waitFor();
  assert(await page.locator('.task.k-meal').count() === 0, 'в релакс-день есть приёмы пищи');
  assert(await page.locator('.task.k-cooking').count() === 0, 'в релакс-день есть готовка');
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
  await page.getByText('3 × 8, гиря 12 кг').waitFor();
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
  await page.getByText('Тефтели индейки, гречка, овощи').first().waitFor();
  await go(page, '/shop/shop-p20261102-m2');
  await page.locator('.shop-item.bought').nth(2).waitFor();
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
  await p2.goto(`${BASE}?today=2026-11-02#/today`);
  await p2.getByRole('button', { name: /есть резервная копия/ }).click();
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

async function step13(p3) {
  // база устройства, где после версии 1.2.0 новое меню так и не применили (tests/fixtures/state_1.2.0.json):
  // прежнее меню со скумбрией 28.11, 30.11, 07.12, 08.12, 09.12 и готовками 28.11, 07.12
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/state_1.2.0.json'), 'utf8'));
  await p3.evaluate((fx) => new Promise((res, rej) => {
    const rq = indexedDB.open('god-v-forme');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) tx.objectStore(n).clear();
      for (const [k, v] of Object.entries(fx)) {
        if (!names.includes(k)) continue;
        for (const r of (k === 'settings' || k === 'meta' ? [v] : Object.values(v))) tx.objectStore(k).put(r);
      }
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => rej(tx.error);
    };
  }), fixture);
  await p3.goto(`${BASE}?today=2026-11-14#/today`);
  await p3.reload();
  // при запуске новое меню применяется само (после внутренней копии) и открывается отчёт
  await p3.getByRole('heading', { name: 'Отчёт о миграции' }).waitFor();
  await p3.getByText(/Новое меню применено автоматически/).waitFor();
  await p3.getByText(/дни 28\.11, 30\.11, 07\.12, 08\.12, 09\.12; готовки 28\.11, 07\.12; закупки 15\.11, 01\.12/).waitFor();
  await p3.getByText(/Резервная копия: /).waitFor();
  await p3.screenshot({ path: path.join(shots, '13-auto-migration-iphone.png'), fullPage: true });
  // файл копии до обновления: прежний план целиком
  await p3.getByRole('button', { name: 'Файл копии до обновления' }).click();
  const [bdl] = await Promise.all([p3.waitForEvent('download'), p3.getByRole('button', { name: 'Сохранить в «Файлы»' }).click()]);
  const bf = path.join(shots, 'backup-before-update.zip');
  await bdl.saveAs(bf);
  const bz = await JSZip.loadAsync(await fs.readFile(bf));
  const bj = JSON.parse(await bz.file('backup.json').async('string'));
  assert(bj.stores.planDays.length === Object.keys(fixture.planDays).length, 'в копии все дни прежнего плана');
  assert(bj.stores.settings[0].plan.menuId === undefined, 'копия — до обновления');
  // в базе 1.2.0 Санкт-Петербург ещё 24–25.11 — перенесена на 25–26.11 при запуске, с отчётом
  await go(p3, '/trip-update');
  await p3.getByRole('heading', { name: 'Командировка перенесена: Санкт-Петербург' }).waitFor();
  await p3.getByText('Теперь 25–26 ноября (было 24–25 ноября)').waitFor();
  await p3.getByText(/переносится с 26\.11 07:00 на 24\.11 07:00/).waitFor();
  await p3.screenshot({ path: path.join(shots, '13-trip-move-iphone.png'), fullPage: true });
  for (const d of ['2026-11-28', '2026-11-30', '2026-12-07', '2026-12-08', '2026-12-09']) {
    await go(p3, `/day/${d}`);
    await p3.locator('.meal-card').first().waitFor();
    assert(await p3.getByText(/Скумбрия/).count() === 0, `${d}: скумбрии нет`);
  }
  await go(p3, '/day/2026-11-10');
  await p3.getByText(/Скумбрия \+ рис/).first().waitFor(); // отмеченный съеденным обед — история
  // экспорт всех товаров в JSON
  await go(p3, '/shopping');
  const [dl] = await Promise.all([p3.waitForEvent('download'), p3.getByRole('button', { name: 'Экспорт всех товаров в JSON' }).click()]);
  const jf = path.join(shots, 'zakupki_vse_tovary.json');
  await dl.saveAs(jf);
  const js = JSON.parse(await fs.readFile(jf, 'utf8'));
  assert(js.items.length === js.purchases.reduce((s, x) => s + x.items_count, 0) && js.items.length > 100, `позиций ${js.items.length}`);
  assert(['main', 'topup', 'trip'].every((k) => js.purchases.some((x) => x.purchase_kind === k)), 'основные, докупки и поездки');
  assert(!/скумбри|mackerel/i.test(JSON.stringify(js)), 'в экспорте нет скумбрии');
  assert(js.history_items.length > 0 && js.history_items.every((i) => !i.purchase_in_current_plan), 'закупки прежнего плана — отдельно, как история');
  assert(js.products.every((x) => /^https:\/\/av\.ru\/i\/\d+\/?$/.test(x.av_url)), 'справочник — только товары с карточками av.ru');
  assert(js.items.filter((i) => i.purchase_in_current_plan).every((i) => /^https:\/\/av\.ru\/i\/\d+\/?$/.test(i.av_url) && i.pack_label && i.purchase_date && i.purchase_title), 'ссылка, фасовка, дата и название закупки');
  // откат и ручное применение: тоже через копию и сводку замен
  await go(p3, '/menu-update');
  await p3.getByRole('button', { name: 'Вернуть прежнее меню' }).click();
  await p3.getByRole('heading', { name: '1. Резервная копия' }).waitFor();
  assert(await p3.locator('input[type=date]').first().inputValue() === '2026-11-16', 'старт по комплекту — 16.11');
  await p3.getByRole('heading', { name: '2. Сводка замен' }).waitFor();
  await p3.getByText(/Петелинка, 865 г/).waitFor();
  await p3.getByText('всё сходится').waitFor();
  await p3.getByText(/48 из 48 обедов и ужинов/).waitFor();
  await p3.getByText(/В активном меню нет скумбрии/).waitFor();
  await p3.screenshot({ path: path.join(shots, '13-menu-preview-iphone.png'), fullPage: true });
  await p3.getByRole('button', { name: 'Создать резервную копию и применить' }).click();
  await p3.getByRole('heading', { name: 'Отчёт о миграции' }).waitFor();
  await p3.getByText(/Резервная копия: /).waitFor();
  await p3.screenshot({ path: path.join(shots, '13-migration-report-iphone.png'), fullPage: true });
  await go(p3, '/today');
  await p3.waitForTimeout(300);
  assert(await p3.getByText(/Новое меню «Азбука вкуса»: старт/).count() === 0, 'после применения баннер исчез');
  // проверка товаров на av.ru: адрес, «есть в корзине», недоступный — блок, замена — пересчёт
  await go(p3, '/av-check');
  await p3.getByRole('heading', { name: 'Проверка товаров на av.ru' }).waitFor();
  await p3.getByText('Корзина ещё не проверена.').first().waitFor();
  await p3.getByLabel(/Адрес доставки выбран/).check();
  const row = (name) => p3.locator('.shop-item', { hasText: name }).first();
  await row('Филе грудки цыплёнка-бройлера').getByRole('button', { name: 'Недоступен' }).click();
  await p3.getByRole('heading', { name: /Замена: Филе грудки цыплёнка/ }).waitFor();
  await p3.locator('.sheet label', { hasText: 'Филе грудки индейки «Просто Азбука»' }).first().locator('input[type=radio]').check();
  await p3.getByText(/Граммовка в рецептах ×1,05/).waitFor();
  await p3.getByLabel(/Я проверил: этот товар есть в моей корзине/).check();
  await p3.getByRole('button', { name: 'Подтвердить замену' }).click();
  await p3.getByText(/Замена подтверждена/).first().waitFor();
  await row('Киви').getByRole('button', { name: 'Недоступен' }).click();
  await p3.locator('.sheet .btn.ghost', { hasText: 'Закрыть' }).click();
  await row('Бананы').getByRole('button', { name: 'Есть в корзине' }).click();
  await p3.getByText(/Недоступны без замены \(в закупке заблокированы\): Киви/).first().waitFor();
  await p3.screenshot({ path: path.join(shots, '13-av-check-iphone.png'), fullPage: true });
  await go(p3, '/shop/shop-p20261116-m1');
  await p3.locator('.shop-item.blocked', { hasText: 'Киви' }).waitFor();
  await p3.getByText(/замена вместо «Филе грудки цыплёнка/).first().waitFor();
  await p3.screenshot({ path: path.join(shots, '13-shop-blocked-iphone.png'), fullPage: true });
}

await step('12–13. Ноябрь 2026: старт 16.11, командировки, релакс 29.11, меню «Азбука вкуса» с av.ru; база 1.2.0 со скумбрией → обновление при запуске, экспорт товаров JSON', async () => {
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: true, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg' });
  const p3 = await newPage(ctx3);
  active = p3;
  await p3.goto(`${BASE}?today=2026-11-14#/today`);
  await p3.getByRole('heading', { name: 'Когда начинаем программу питания?' }).waitFor();
  assert(await p3.locator('.sheet input[type=date]').inputValue() === '2026-11-16', 'дата старта по умолчанию — 16.11');
  assert(await p3.getByText(/Екатеринбург/).count() > 0 && await p3.getByText(/Санкт-Петербург/).count() > 0, 'командировки в предпросмотре старта');
  await p3.getByRole('button', { name: 'Дальше' }).click();
  await p3.getByRole('heading', { name: 'Когда начать тренировки?' }).waitFor();
  assert(await p3.locator('.sheet input[type=date]').inputValue() === '2026-11-16', 'тренировки — с 16.11');
  await p3.getByRole('button', { name: 'Начать', exact: true }).click();
  await p3.waitForTimeout(400);
  await go(p3, '/day/2026-11-16');
  await p3.getByText('Силовая А').first().waitFor();
  await go(p3, '/day/2026-11-19');
  await p3.getByRole('heading', { name: /Командировка: Екатеринбург/ }).waitFor();
  assert(await p3.getByText(/день 2 из 3/).count() >= 1, 'день 2 из 3');
  assert(await p3.getByText(/Гостиница, завтрак включён/).count() > 0, 'завтрак в гостинице');
  assert(await p3.locator('.trip-variant').count() === 12, '4 приёма × 3 варианта');
  assert(await p3.getByText(/Командировка \(Екатеринбург\): плановый отдых/).count() > 0, 'тренировка — плановый отдых');
  const lunch = p3.locator('.meal-card', { hasText: 'Обед' }).first();
  await lunch.getByRole('button', { name: 'Выбрал другое подходящее блюдо' }).click();
  await lunch.locator('textarea').fill('суп и курица с овощами');
  await lunch.getByRole('button', { name: 'Сохранить: другое блюдо' }).click();
  await lunch.getByText('другое подходящее блюдо', { exact: true }).waitFor();
  await p3.screenshot({ path: path.join(shots, '12-trip-day-iphone.png'), fullPage: true });
  // Санкт-Петербург — 25–26.11 (перенесена с 24–25.11)
  for (const [d, city] of [['2026-11-18', 'Екатеринбург'], ['2026-11-20', 'Екатеринбург'], ['2026-11-25', 'Санкт-Петербург'], ['2026-11-26', 'Санкт-Петербург']]) {
    await go(p3, `/day/${d}`);
    await p3.getByRole('heading', { name: `Командировка: ${city}` }).waitFor();
  }
  for (const d of ['2026-11-17', '2026-11-23', '2026-11-24', '2026-11-27', '2026-11-21']) {
    await go(p3, `/day/${d}`);
    await p3.waitForTimeout(150);
    assert(await p3.getByRole('heading', { name: /Командировка:/ }).count() === 0, `${d} — не командировка`);
  }
  assert(await p3.getByText('Восстановление после командировки').count() > 0, '21.11 — восстановление после командировки');
  await go(p3, '/day/2026-11-24');
  await p3.getByText('Курица в йогуртовом соусе, булгур, кабачки').first().waitFor();
  assert(await p3.getByText(/Степпер/).count() > 0, '24.11 — степпер');
  await go(p3, '/day/2026-11-27');
  await p3.getByText('Силовая А по самочувствию').first().waitFor();
  await go(p3, '/day/2026-11-28');
  await p3.getByText('Курица с нутом, кабачком и рисом').first().waitFor();
  await go(p3, '/recipe/D05');
  await p3.getByText('Филе грудки цыплёнка-бройлера охлаждённое «Петелинка», Россия').first().waitFor();
  assert(await p3.locator('a[href="https://av.ru/i/572843"]').count() > 0, 'ссылка на индивидуальную карточку av.ru');
  assert(await p3.getByText(/уп\./).count() > 0, 'доля упаковки');
  await p3.screenshot({ path: path.join(shots, '12-av-recipe-iphone.png'), fullPage: true });
  await go(p3, '/recipes');
  await p3.waitForTimeout(200);
  assert(await p3.getByText(/Скумбрия|Горбуша гриль/).count() === 0, 'прежних блюд нет в списке рецептов');
  assert(await p3.getByRole('heading', { name: 'Обеды' }).count() === 1 && await p3.getByRole('heading', { name: 'Ужины' }).count() === 1, 'рецепты по приёмам пищи');
  await go(p3, '/day/2026-11-29');
  await p3.getByText(/Релакс/).first().waitFor();
  await go(p3, '/shopping');
  await p3.getByRole('heading', { name: 'Перекусы в командировки' }).waitFor();
  await p3.screenshot({ path: path.join(shots, '12-shopping-iphone.png'), fullPage: true });
  await go(p3, '/shop/shop-p20261116-m1');
  await p3.getByText(/не собранная корзина/).waitFor();
  assert(await p3.locator('.av-link a').count() >= 30, 'у позиций — ссылки на av.ru');
  await p3.screenshot({ path: path.join(shots, '12-av-shop-iphone.png'), fullPage: true });
  await go(p3, '/trips');
  await p3.getByRole('button', { name: /Новая командировка/ }).click();
  await p3.locator('.sheet input').first().fill('Казань');
  const dates = p3.locator('.sheet input[type=date]');
  await dates.nth(0).fill('2026-12-26');
  await dates.nth(1).fill('2026-12-28');
  await p3.getByRole('button', { name: 'Показать изменения' }).click();
  await p3.getByText(/Релакс-день .* попадает на командировку/).waitFor();
  await p3.getByText(/Домашних приёмов пищи станет/).waitFor();
  await p3.screenshot({ path: path.join(shots, '12-new-trip-preview-iphone.png'), fullPage: true });
  await p3.getByRole('button', { name: 'Отмена' }).click();
  await p3.waitForTimeout(200);
  assert(await p3.getByText('Казань').count() === 0, 'без подтверждения командировка не добавлена');
  await step13(p3);
  await ctx3.close();
});

async function injectState(p, file) {
  const fixture = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  await p.evaluate((fx) => new Promise((res, rej) => {
    const rq = indexedDB.open('god-v-forme');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) tx.objectStore(n).clear();
      for (const [k, v] of Object.entries(fx)) {
        if (!names.includes(k)) continue;
        for (const r of (k === 'settings' || k === 'meta' ? [v] : Object.values(v))) tx.objectStore(k).put(r);
      }
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => rej(tx.error);
    };
  }), fixture);
}

await step('14. 22.11: меню 22–24.11 применяется при запуске (миграция v9) → отчёт; «Мои запасы», «Приготовлено»', async () => {
  const ctx4 = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  ctx4.setDefaultTimeout(12000);
  const p4 = await newPage(ctx4);
  active = p4;
  await p4.goto(`${BASE}?today=2026-11-22#/today`);
  await p4.waitForTimeout(400);
  await injectState(p4, 'tests/fixtures/state_1.6.0_2211.json');
  await p4.goto(`${BASE}?today=2026-11-22#/today`);
  await p4.reload();
  // база с версией данных 8: меню 22–24.11 применяется при запуске (миграция v9, с резервной копией) и открывается отчёт
  await p4.getByRole('heading', { name: 'Меню 22–24.11 и запасы обновлены' }).waitFor();
  await p4.getByText(/Применено автоматически при обновлении приложения/).waitFor();
  await p4.getByText(/Резервная копия перед изменениями/).waitFor();
  assert(await p4.getByRole('button', { name: 'Создать резервную копию и применить' }).count() === 0, 'подтверждать не нужно');
  await p4.getByRole('heading', { name: 'Какие блюда изменены' }).waitFor();
  const preview = p4.getByTestId('menu-preview');
  await preview.getByRole('heading', { name: 'Меню на 22, 23 и 24 ноября' }).waitFor();
  assert(await preview.locator('tr').count() === 12, '12 приёмов пищи 22–24.11');
  for (const t of ['Нут с булгуром и овощами', 'Индейка с гречкой и морковью', 'Курица с рисом и брокколи', 'Пропущен', 'Овсяный стакан с грушей и миндалём', 'Творог с киви и хлебцами', 'Тосты с авокадо, яйцами и томатами']) await preview.getByText(t, { exact: true }).first().waitFor();
  assert(await preview.getByText(/^замена$/).count() === 0, 'завтраки и перекусы — существующие');
  assert(await p4.getByText('Индейка с булгуром и овощами').count() === 0, 'прежнего блюда нет');
  const check = p4.getByTestId('stock-check');
  assert(await check.locator('tbody tr').count() === 10, '10 продуктов к новым блюдам');
  await check.getByText(/На 22–24\.11 закупка не нужна/).waitFor();
  await p4.getByText(/небольшая закупка к 27–28\.11/).waitFor();
  await p4.screenshot({ path: path.join(shots, '14-correction-report-ipad.png'), fullPage: true });
  // день 22.11: обед пропущен, ужин — нут с булгуром; 23.11 — индейка с гречкой и курица с рисом
  await go(p4, '/day/2026-11-22');
  await p4.getByText('Пропущен', { exact: true }).first().waitFor();
  await p4.getByText('Нут с булгуром и овощами').first().waitFor();
  await go(p4, '/day/2026-11-23');
  await p4.getByText('Индейка с гречкой и морковью').first().waitFor();
  await p4.getByText('Курица с рисом и брокколи').first().waitFor();
  // рецепт — один, в списке без дублей
  await go(p4, '/recipes');
  assert(await p4.getByText('Нут с булгуром и овощами', { exact: true }).count() === 1, 'рецепт нута — один');
  assert(await p4.getByText('Индейка с булгуром и овощами').count() === 0, 'прежний рецепт убран из списка');
  // «Мои запасы»
  await go(p4, '/shopping?tab=stock');
  await p4.getByRole('heading', { name: 'Морозилка' }).waitFor();
  const turkeyRow = p4.getByRole('row', { name: /^Филе грудки индейки/ });
  assert((await turkeyRow.innerText()).includes('714'), 'индейка: 894 − 180 = 714 г');
  assert(await p4.getByText('требует подтверждения').count() > 0, 'расчётные остатки помечены');
  await p4.screenshot({ path: path.join(shots, '14-stock-ipad.png'), fullPage: true });
  // готовка 22.11: граммовки и распределение → проверить продукты → «Приготовлено» → индейка списана
  await go(p4, '/cook/cook-p20261116-x2211b');
  await p4.getByText(/обед 23\.11 в 12:00, обед 24\.11 в 12:00/).first().waitFor();
  await p4.getByText(/куриное филе \(360 г\) из морозилки в холодильник/).first().waitFor();
  await p4.getByRole('heading', { name: 'Перед готовкой — проверьте продукты' }).waitFor();
  await p4.screenshot({ path: path.join(shots, '14-cook-2211-ipad.png'), fullPage: true });
  await p4.getByLabel('Проверил продукты').check();
  await p4.getByRole('button', { name: 'Приготовлено' }).click();
  await p4.waitForTimeout(400);
  await go(p4, '/shopping?tab=stock');
  assert((await p4.getByRole('row', { name: /^Филе грудки индейки/ }).innerText()).includes('354'), 'после готовки индейки 714 − 360 = 354 г');
  await p4.getByRole('heading', { name: 'Готовая еда' }).waitFor();
  assert(await p4.getByText(/Индейка с гречкой и морковью/).count() >= 2, 'порции в готовой еде');
  // вечером 22.11 — переложить курицу к готовке 23.11
  await go(p4, '/today');
  await p4.getByText('Разморозка на завтра').first().waitFor();
  // календарь: готовка 21.11 отменена
  await go(p4, '/calendar?d=2026-11-21&m=2026-11-21');
  assert(await p4.locator('.i-cook.cancelled').count() > 0, 'отменённая готовка видна в календаре');
  await ctx4.close();
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
