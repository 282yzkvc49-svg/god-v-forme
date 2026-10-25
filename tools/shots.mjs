import { chromium } from 'playwright';
import { startServer } from '../scripts/serve.mjs';
const OUT = process.argv[2];
const today = process.argv[3] || '2026-11-02';
const routes = (process.argv[4] || 'today').split(',');
const vp = process.argv[5] === 'phone' ? { width: 390, height: 844 } : { width: 1180, height: 820 };
const scheme = process.argv[6] || 'light';
const server = await startServer(new URL('../dist', import.meta.url).pathname, 4180);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: scheme, hasTouch: process.argv[5] === 'phone' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text()); });
await page.goto(`http://localhost:4180/?today=${today}#/today`);
await page.waitForSelector('.page', { timeout: 10000 });
// закрыть онбординг
const ob = page.getByRole('button', { name: 'Понятно, начать' });
if (await ob.count()) await ob.click();
for (const r of routes) {
  await page.evaluate((h) => { location.hash = h; }, r.startsWith('/') ? r : '/' + r);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}-${r.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true });
}
await browser.close();
server.close();
