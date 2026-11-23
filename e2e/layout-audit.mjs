// Проверка вёрстки: на iPad (альбом и портрет), iPhone и компьютере ни один элемент не выходит за край экрана
// и не обрезается контейнером. Запуск: node e2e/layout-audit.mjs  (после npm run build)
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e/screens/layout');
await fs.mkdir(shots, { recursive: true });
const PORT = 4351;
const server = await startServer(path.join(root, 'dist'), PORT);
const BASE = `http://localhost:${PORT}/?today=2026-11-23`;
const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/state_1.6.0_2211.json'), 'utf8'));
fixture.taskStatus['meal:2026-11-23:breakfast'] = { taskId: 'meal:2026-11-23:breakfast', date: '2026-11-23', kind: 'meal', status: 'done', updatedAt: '2026-11-23T06:30:00.000Z' };

const VIEWPORTS = {
  'ipad-landscape': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true },
  'ipad-portrait': { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true },
  'ipad-pro-landscape': { viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1, hasTouch: true },
  'ipad-mini-portrait': { viewport: { width: 744, height: 1133 }, deviceScaleFactor: 1, hasTouch: true },
  iphone: { ...devices['iPhone 13'], deviceScaleFactor: 1 },
  'iphone-se': { ...devices['iPhone SE'], deviceScaleFactor: 1 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  'desktop-narrow': { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
};
const PAGES = (process.env.PAGES || '/today,/calendar,/day/2026-11-23,/training,/workout/train:2026-11-23?d=2026-11-23,/nutrition,/recipes,/shopping,/shopping?tab=stock,/cook/cook-p20261116-x2311,/progress,/analysis,/correction,/settings').split(',');

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

// элементы, которые выходят за экран или обрезаны предком с overflow ≠ visible (кроме прокручиваемых областей)
const audit = () => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const label = (el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${t ? ` «${t}»` : ''}`;
  };
  for (const el of document.querySelectorAll('.app *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    // внутри горизонтально прокручиваемых областей (таблицы, сегменты) — допустимо
    let p = el.parentElement, scroller = false, clip = null;
    while (p && p !== document.body) {
      const ps = getComputedStyle(p);
      if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 1) { scroller = true; break; }
      if (!clip && /(hidden|clip)/.test(ps.overflowX)) clip = p;
      p = p.parentElement;
    }
    if (scroller) continue;
    if (r.right > vw + 1 || r.left < -1) { out.push(`за экраном (${Math.round(r.left)}–${Math.round(r.right)} из ${vw}): ${label(el)}`); continue; }
    if (clip) {
      const c = clip.getBoundingClientRect();
      if (r.right > c.right + 1.5 && el.children.length === 0) out.push(`обрезано ${label(clip)} на ${Math.round(r.right - c.right)} px: ${label(el)}`);
    }
    // выходит за свою карточку, заметку или строку задачи (даже если на экране помещается)
    const box = el.parentElement?.closest('.card, .note, .kpi, .task, .banner, .sheet');
    if (box && !el.matches('.card, .note, .kpi, .task, .banner, .sheet')) {
      const c = box.getBoundingClientRect();
      if (r.right > c.right + 1.5 || r.left < c.left - 1.5) out.push(`выходит за ${label(box)} на ${Math.round(Math.max(r.right - c.right, c.left - r.left))} px: ${label(el)}`);
    }
  }
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) out.unshift(`горизонтальная прокрутка страницы: ${sw} > ${vw}`);
  return Array.from(new Set(out)).slice(0, 12);
};

// шире системного шрифта iPad: если вёрстка выдерживает DejaVu Sans, выдержит и SF Pro
const WIDE_FONT = process.env.WIDE !== '0';
if (process.env.WIDTHS) {
  for (const w of process.env.WIDTHS.split(',')) {
    const [a, b] = w.split('x').map(Number);
    VIEWPORTS[`w${a}x${b}`] = { viewport: { width: a, height: b }, deviceScaleFactor: 1, hasTouch: true };
  }
}
const browser = await chromium.launch();
let problems = 0;
const only = process.env.VP ? process.env.VP.split(',') : process.env.WIDTHS ? Object.keys(VIEWPORTS).filter((k) => k.startsWith('w')) : Object.keys(VIEWPORTS);
for (const name of only) {
  const ctx = await browser.newContext({ ...VIEWPORTS[name], locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  const p = await ctx.newPage();
  if (WIDE_FONT) await ctx.addInitScript(() => { addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = ':root{--font:"DejaVu Sans",sans-serif!important;--font-round:"DejaVu Sans",sans-serif!important} body,button,input,select,textarea{font-family:"DejaVu Sans",sans-serif!important}'; document.head.appendChild(st); }); });
  await p.goto(`${BASE}#/settings`);
  await p.waitForTimeout(300);
  await inject(p);
  await p.reload();
  await p.waitForTimeout(400);
  for (const route of PAGES) {
    const [hash, q] = route.split('?');
    await p.evaluate((h) => { location.hash = h; }, route);
    await p.waitForTimeout(350);
    const found = await p.evaluate(audit);
    if (found.length) { problems += found.length; console.log(`✗ ${name} ${route}\n    ${found.join('\n    ')}`); }
    if (process.env.SHOTS) await p.screenshot({ path: path.join(shots, `${name}${hash.replace(/[/:]/g, '_')}${q ? '_' + q.replace(/=/g, '-') : ''}.png`), fullPage: true });
  }
  await ctx.close();
}
await browser.close(); server.close();
console.log(problems ? `\nПроблем: ${problems}` : 'Вёрстка: ничего не выходит за край и не обрезается');
process.exit(problems ? 1 : 0);
