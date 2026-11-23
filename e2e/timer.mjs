// Таймер отдыха на экране тренировки: панель у нижнего края на iPad (альбом и портрет) и iPhone, не перекрывает
// упражнения при прокрутке, не закрывает поля при вводе, старт / пауза / продолжить / сброс, свернуть,
// время не сбрасывается при работе с упражнениями, на других страницах панели нет.
// Запуск: node e2e/timer.mjs  (после npm run build)
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e/screens');
await fs.mkdir(shots, { recursive: true });
const PORT = 4361;
const server = await startServer(path.join(root, 'dist'), PORT);
const DATE = '2026-11-23';
const BASE = `http://localhost:${PORT}/?today=${DATE}`;
const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/state_1.6.0_2211.json'), 'utf8'));
const WORKOUT = `/workout/${encodeURIComponent(`train:${DATE}`)}?d=${DATE}`;

const VIEWPORTS = {
  'ipad-landscape': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  'ipad-portrait': { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  iphone: { ...devices['iPhone 13'] },
};

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

for (const [name, opts] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({ ...opts, locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  ctx.setDefaultTimeout(10000);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const step = async (title, fn) => {
    try { await fn(); results.push(`✓ ${name}: ${title}`); } catch (e) {
      failures++;
      await p.screenshot({ path: path.join(shots, `FAIL-timer-${name}-${results.length + 1}.png`) }).catch(() => {});
      results.push(`✗ ${name}: ${title}\n    ${String(e?.message || e).split('\n').slice(0, 4).join('\n    ')}`);
    }
  };
  const vh = opts.viewport.height;
  const dock = p.getByTestId('rest-timer');
  const box = () => dock.locator('.timer').boundingBox();
  const timeText = () => dock.locator('.t-time').innerText();

  await p.goto(`${BASE}#/settings`);
  await p.waitForTimeout(300);
  await inject(p);
  await p.goto(`${BASE}#${WORKOUT}`);
  await p.reload();
  await p.getByRole('heading', { level: 1 }).waitFor();

  await step('панель у нижнего края, в отдельном слое, с безопасной областью', async () => {
    await dock.waitFor();
    assert(await p.evaluate(() => document.querySelector('[data-testid="rest-timer"]').parentElement === document.body), 'панель — прямой потомок body');
    const b = await box();
    const tabbar = await p.locator('.tabbar').isVisible() ? (await p.locator('.tabbar').boundingBox()).height : 0;
    assert(b.y + b.height <= vh - tabbar + 1 && b.y + b.height >= vh - tabbar - 24, `внизу экрана: ${Math.round(b.y)}+${Math.round(b.height)} из ${vh}, вкладки ${Math.round(tabbar)}`);
    assert(b.height <= (name === 'iphone' ? 120 : 76), `компактная: ${Math.round(b.height)} px`);
    for (const t of ['60', '75', '90']) await dock.getByRole('button', { name: t, exact: true }).waitFor();
    assert(/^\d\d:\d\d$/.test(await timeText()), 'время в виде 01:15');
    await dock.getByRole('button', { name: 'Старт' }).waitFor();
    await dock.getByRole('button', { name: 'Свернуть таймер' }).waitFor();
    await p.screenshot({ path: path.join(shots, `16-timer-${name}.png`) });
  });

  await step('при прокрутке панель на месте и не закрывает упражнения до конца списка', async () => {
    const b0 = await box();
    await p.mouse.wheel(0, 900);
    await p.waitForTimeout(250);
    const b1 = await box();
    assert(Math.abs(b0.y - b1.y) < 1, 'положение не меняется при прокрутке');
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForTimeout(250);
    const b2 = await box();
    // последние элементы управления (сложность последнего упражнения, «Завершить тренировку») — выше панели
    const last = await p.getByRole('button', { name: /Завершить тренировку|Изменить итог/ }).boundingBox();
    assert(last.y + last.height <= b2.y - 4, `кнопка «Завершить» видна над панелью: ${Math.round(last.y + last.height)} ≤ ${Math.round(b2.y)}`);
    const segs = p.getByRole('group', { name: 'Сложность' });
    const sb = await segs.last().boundingBox();
    if (sb.y + sb.height > b2.y) {
      // прокрутить к нему — не должен оказаться под панелью
      await segs.last().scrollIntoViewIfNeeded();
      const s2 = await segs.last().boundingBox();
      assert(s2.y + s2.height <= (await box()).y, 'выбор сложности не под панелью');
    }
    await segs.last().getByRole('button').first().click({ trial: true });
    await p.screenshot({ path: path.join(shots, `16-timer-${name}-bottom.png`) });
  });

  await step('старт, пауза, продолжить, сброс', async () => {
    await dock.getByRole('button', { name: '60', exact: true }).click();
    assert(await timeText() === '01:00', 'выбрано 60 с');
    await dock.getByRole('button', { name: 'Старт' }).click();
    await p.waitForTimeout(1300);
    const t1 = await timeText();
    assert(t1 < '01:00' && t1 >= '00:57', `идёт: ${t1}`);
    await dock.getByRole('button', { name: 'Пауза' }).click();
    const t2 = await timeText();
    await p.waitForTimeout(1200);
    assert(await timeText() === t2, 'на паузе время стоит');
    await dock.getByRole('button', { name: 'Продолжить' }).click();
    await p.waitForTimeout(1200);
    assert(await timeText() < t2, 'продолжилось');
    await dock.getByRole('button', { name: 'Сбросить таймер' }).click();
    assert(await timeText() === '01:00', 'сброшено к выбранной длительности');
    await dock.getByRole('button', { name: 'Старт' }).waitFor();
  });

  await step('время не сбрасывается при работе с упражнениями; свернуть и развернуть', async () => {
    await p.evaluate(() => window.scrollTo(0, 0));
    await dock.getByRole('button', { name: '90', exact: true }).click();
    await dock.getByRole('button', { name: 'Старт' }).click();
    await p.waitForTimeout(1200);
    const t1 = await timeText();
    // открыть технику другого упражнения и отметить подход — отсчёт продолжается, не начинается заново
    await p.locator('.ex-head').nth(1).click();
    await p.getByRole('button', { name: /^Подход 1$/ }).nth(1).click();
    await p.waitForTimeout(1100);
    const t2 = await timeText();
    assert(t2 < t1, `не сбросилось: было ${t1}, стало ${t2}`);
    await dock.getByRole('button', { name: 'Свернуть таймер' }).click();
    const pill = dock.locator('.timer-pill');
    await pill.waitFor();
    const pb = await pill.boundingBox();
    assert(pb.width < 200 && pb.x > opts.viewport.width / 2, 'свёрнуто в кнопку справа');
    await pill.click();
    await dock.locator('.timer').waitFor();
    assert(await timeText() <= t2, 'после разворота время то же');
    await dock.getByRole('button', { name: 'Сбросить таймер' }).click();
  });

  await step('при вводе повторов панель не закрывает поля', async () => {
    const input = p.getByRole('textbox', { name: /Подход 1: фактически/ }).first();
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await p.waitForTimeout(200);
    assert(!(await dock.isVisible()), 'панель спрятана, пока открыта клавиатура');
    await input.fill('8');
    await p.locator('.page-head h1').click();
    await p.waitForTimeout(200);
    assert(await dock.isVisible(), 'после ввода панель вернулась');
  });

  await step('на других страницах панели нет', async () => {
    await p.evaluate(() => { location.hash = '/today'; });
    await p.waitForTimeout(300);
    assert(await dock.count() === 0, 'нет на «Сегодня»');
    await p.evaluate(() => { location.hash = '/training'; });
    await p.waitForTimeout(300);
    assert(await dock.count() === 0, 'нет на «Тренировки»');
    assert(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
}

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failures ? `\nПровалено: ${failures}` : '\nТаймер проверен');
process.exit(failures ? 1 : 0);
