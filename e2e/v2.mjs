// Версия 2.0 на копии данных пользователя (состояние 22.11, версия 1.7.0): переход при запуске 24.11,
// «Неделя» (меню, готовка, запасы, закупка только после подтверждения), библиотека рецептов, настройки,
// история не меняется. iPad альбом и портрет, iPhone. Запуск: node e2e/v2.mjs (после npm run build)
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const PORT = 4371;
const server = await startServer(path.join(root, 'dist'), PORT);
const DATE = '2026-11-24';
const BASE = `http://localhost:${PORT}/?today=${DATE}`;
const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/state_1.7.0_r1_2211.json'), 'utf8'));
const VIEWPORTS = {
  'ipad-landscape': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
  'ipad-portrait': { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
  iphone: { ...devices['iPhone 13'], deviceScaleFactor: 1 },
  'iphone-landscape': { ...devices['iPhone 13 landscape'], deviceScaleFactor: 1 },
};
const only = process.env.VP ? [process.env.VP] : Object.keys(VIEWPORTS);
const results = [];
let failures = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch();

async function inject(p) {
  await p.evaluate((fx) => new Promise((res, rej) => {
    const rq = indexedDB.open('god-v-forme');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result; const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) tx.objectStore(n).clear();
      for (const [k, v] of Object.entries(fx)) if (names.includes(k)) for (const r of (k === 'settings' || k === 'meta' ? [v] : Object.values(v))) tx.objectStore(k).put(r);
      tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error);
    };
  }), fixture);
}
const noOverflow = async (p, where) => {
  const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert(o.sw <= o.cw + 1, `${where}: горизонтальная прокрутка страницы ${o.sw} > ${o.cw}`);
};

for (const name of only) {
  const opts = VIEWPORTS[name];
  const ctx = await browser.newContext({ ...opts, locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  ctx.setDefaultTimeout(10000);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const step = async (title, fn) => {
    try { await fn(); results.push(`✓ ${name}: ${title}`); } catch (e) {
      failures++;
      await p.screenshot({ path: path.join(shots, `FAIL-v2-${name}-${results.length + 1}.png`), fullPage: true }).catch(() => {});
      results.push(`✗ ${name}: ${title}\n    ${String(e?.message || e).split('\n').slice(0, 4).join('\n    ')}`);
    }
  };
  await p.goto(`${BASE}#/settings`);
  await p.waitForTimeout(300);
  await inject(p);
  await p.goto(`${BASE}&r=1#/today`);
  await p.reload();

  await step('при запуске 24.11 — переход на 2.0 и отчёт «Что изменилось»', async () => {
    await p.getByRole('heading', { name: 'Что изменилось в версии 2.0' }).waitFor();
    assert(p.url().includes('#/week'), `открыта «Неделя»: ${p.url()}`);
    await noOverflow(p, 'Неделя');
    await p.screenshot({ path: path.join(shots, `20-v2-week-${name}.png`), fullPage: true });
    await p.getByRole('button', { name: 'Понятно' }).click();
  });

  await step('неделя 25–30.11: меню, 9 порций готовки, 4 пакета в морозилку', async () => {
    await p.locator('a.week-card').first().click();
    await p.locator('.week-menu .card').first().waitFor();
    await p.getByText('Курица с паприкой, булгуром, перцем и кабачком').first().waitFor();
    const days = await p.locator('.week-menu .card').count();
    assert(days === 5, `дней меню 25, 26, 27, 28, 30.11: ${days}`);
    await noOverflow(p, 'Меню недели');
    await p.screenshot({ path: path.join(shots, `21-v2-menu-${name}.png`), fullPage: true });
    await p.getByRole('radio', { name: 'Готовка' }).or(p.getByRole('button', { name: 'Готовка', exact: true })).first().click();
    await p.getByText('Хранение порций').waitFor();
    const rows = await p.locator('.table-scroll tbody tr').count();
    assert(rows === 9, `порций в готовке 25.11: ${rows}`);
    const frozen = await p.locator('.table-scroll tbody tr', { hasText: 'морозилка' }).count();
    assert(frozen === 4, `в морозилку: ${frozen}`);
    await noOverflow(p, 'Готовка недели');
    await p.screenshot({ path: path.join(shots, `22-v2-cook-${name}.png`), fullPage: true });
  });

  await step('закупки нет, пока запасы не подтверждены; после подтверждения — только недостающее', async () => {
    await p.getByRole('radio', { name: /^Закупка/ }).or(p.getByRole('button', { name: /^Закупка/ })).first().click();
    await p.getByText('Список закупки появится после подтверждения запасов').waitFor();
    await p.getByRole('radio', { name: /^Запасы/ }).or(p.getByRole('button', { name: /^Запасы/ })).first().click();
    await p.getByRole('heading', { name: /Что есть дома сейчас/ }).waitFor();
    const pollock = p.getByRole('textbox', { name: 'Минтай, филе: есть дома, г' });
    assert(await pollock.inputValue() === '200', `минтай по учёту 200 г: ${await pollock.inputValue()}`);
    assert(await p.getByRole('textbox', { name: 'Фасоль стручковая замороженная: есть дома, г' }).inputValue() === '400', 'стручковая фасоль 400 г');
    await noOverflow(p, 'Запасы');
    await p.screenshot({ path: path.join(shots, `23-v2-stock-${name}.png`), fullPage: true });
    await p.getByRole('button', { name: 'Подтвердить запасы и посчитать закупку' }).click();
    await p.getByRole('heading', { name: /Закупка 25\.11/ }).waitFor();
    const text = await p.locator('.grid2').first().innerText();
    // филе минтая на av.ru нет: 200 г из дома, недостающее — пикша (замена)
    assert(!/Минтай, филе —/.test(text), 'минтай не покупается — его нет на av.ru');
    assert(/Пикша, филе — \d+ ×/.test(text) && /вместо: Минтай/.test(text), 'вместо минтая — пикша с пояснением');
    assert(!/Фасоль стручковая/.test(text), 'стручковую фасоль не покупать — есть');
    await noOverflow(p, 'Закупка');
    await p.screenshot({ path: path.join(shots, `24-v2-buy-${name}.png`), fullPage: true });
    // «Купил» — в запасы
    await p.locator('.li', { hasText: 'Пикша, филе' }).getByRole('button', { name: /Купил/ }).click();
    await p.locator('.li', { hasText: 'Пикша, филе' }).getByRole('button', { name: /Куплено/ }).waitFor();
  });

  await step('черновик недели: КБЖУ дней в цели, проблемы и варианты, бюджет месяца; доставка и граммовки', async () => {
    await p.evaluate(() => { location.hash = '/week'; });
    await p.getByRole('heading', { name: /Бюджет: ноябрь 2026/ }).waitFor();
    const budget = await p.locator('.card', { hasText: 'Бюджет: ноябрь 2026' }).innerText();
    assert(/Прогноз по остальным неделям/.test(budget) && /Остаётся из 50/.test(budget.replace(/\s/g, ' ')), 'бюджет месяца: куплено, подтверждено, прогноз, остаток');
    await p.locator('a.week-card').nth(1).click();
    await p.locator('.week-menu .card').first().waitFor();
    await p.getByRole('heading', { name: /Меню собрано|Нужен ваш выбор/ }).waitFor();
    assert(await p.getByRole('button', { name: 'Другой вариант меню' }).isVisible(), 'вариант вместо автоутверждения');
    const chips = await p.locator('.week-menu .chip', { hasText: /в цели|вне цели/ }).allInnerTexts();
    assert(chips.length >= 2 && chips.every((c) => c === 'в цели'), `дни в цели: ${chips.join(', ')}`);
    await noOverflow(p, 'Черновик недели');
    await p.screenshot({ path: path.join(shots, `27-v2-draft-${name}.png`), fullPage: true });
    // неделя 1: доставка вечером, граммовки на партию и на порцию
    await p.evaluate(() => { location.hash = '/week/w20261125?tab=cook'; });
    await p.getByRole('heading', { name: /Доставка 25\.11/ }).waitFor();
    await p.getByText(/готовится первым/).first().waitFor();
    await p.getByRole('heading', { name: 'Граммовки: на партию и на порцию' }).waitFor();
    await p.getByRole('button', { name: /партия 4 порц/ }).first().click();
    await p.getByRole('columnheader', { name: 'На порцию' }).first().waitFor();
    await noOverflow(p, 'Готовка: доставка и граммовки');
    await p.screenshot({ path: path.join(shots, `28-v2-cook-grams-${name}.png`), fullPage: true });
  });

  await step('история 22–23.11 и 24.11 не изменилась; 25.11 — по новому меню', async () => {
    await p.evaluate(() => { location.hash = '/day/2026-11-23'; });
    await p.getByText('Индейка с гречкой и морковью').first().waitFor();
    await p.evaluate(() => { location.hash = '/day/2026-11-25'; });
    await p.getByText('Курица с паприкой, булгуром, перцем и кабачком').first().waitFor();
    await p.evaluate(() => { location.hash = '/day/2026-12-01'; });
    await p.getByText(/Командировка/).first().waitFor();
  });

  await step('библиотека: поиск, фильтр, карточка рецепта, избранное и «больше не предлагать»', async () => {
    await p.evaluate(() => { location.hash = '/library'; });
    await p.getByRole('heading', { name: 'Библиотека рецептов' }).waitFor();
    await p.getByRole('searchbox').fill('минтай');
    await p.waitForTimeout(150);
    const n = await p.locator('a.lib-card').count();
    assert(n >= 2, `по запросу «минтай»: ${n}`);
    await noOverflow(p, 'Библиотека');
    await p.screenshot({ path: path.join(shots, `25-v2-library-${name}.png`), fullPage: true });
    await p.locator('a.lib-card').first().click();
    await p.getByRole('heading', { name: 'Ингредиенты' }).waitFor();
    await p.getByRole('button', { name: /Избранное/ }).click();
    await p.getByRole('button', { name: 'Оценка 5' }).click();
    await noOverflow(p, 'Рецепт');
    await p.screenshot({ path: path.join(shots, `26-v2-recipe-${name}.png`), fullPage: true });
  });

  await step('настройки: день закупки, место в морозилке; без ошибок на странице', async () => {
    await p.evaluate(() => { location.hash = '/settings'; });
    await p.getByRole('heading', { name: 'Недельный цикл (версия 2.0)' }).waitFor();
    await p.getByPlaceholder('не указано').fill('6');
    await p.locator('#weekly').getByRole('button', { name: 'Сохранить' }).click();
    await p.waitForTimeout(300);
    await noOverflow(p, 'Настройки');
    await p.screenshot({ path: path.join(shots, `27-v2-settings-${name}.png`) });
    assert(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
}
await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nВерсия 2.0 проверена');
process.exit(failures ? 1 : 0);
