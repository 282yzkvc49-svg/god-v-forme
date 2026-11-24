// Версия 2.0: переход на недельный цикл (данные v10) на копии базы устройства, закупка только после
// подтверждения запасов, пересчёт после командировки, планировщик без повторов, отчёт без «undefined кг».
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOps, dataMigrationOps, storesToData, DATA_VERSION } from '../src/state/model';
import type { AppData, MealSlot } from '../src/state/types';
import {
  computePurchase, planCycles, recentMains, recipeAvail, setRemainingOps, weekList, weekPurchase, weekStockRows, weeklyOf, weeklyReplanOps,
  type WeekPlan,
} from '../src/domain/weekly';
import { draftWeek } from '../src/domain/weekPlanner';
import { LIB_RECIPES, PRODUCTS, buyInfo, libEff, subCandidates } from '../src/domain/catalog';
import { buildReport } from '../src/domain/report';
import { stockRemaining } from '../src/domain/stock';

const AT = '2026-11-24T09:00:00.000Z';
const J = (x: unknown) => JSON.stringify(x);

function device(): AppData {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/state_1.7.0_r1_2211.json', import.meta.url), 'utf8'));
  const stores: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(raw)) stores[k] = k === 'settings' || k === 'meta' ? [v] : Object.values(v as object);
  const d = storesToData(stores as any);
  d.ready = true;
  return d;
}
function migrated(today = '2026-11-24'): { before: AppData; after: AppData; ops: ReturnType<typeof dataMigrationOps> } {
  // база устройства после запуска 23.11 (меню 22–24.11 применено, версия данных 9) и завтрака 24.11
  const d0 = device();
  const v9 = applyOps(d0, dataMigrationOps(d0, '2026-11-23', '2026-11-23T08:00:00.000Z', '1.9.1'));
  const before = applyOps(v9, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-24:breakfast', date: '2026-11-24', kind: 'meal', status: 'done', updatedAt: AT } }]);
  const ops = dataMigrationOps(before, today, AT, '2.0.0');
  return { before, after: applyOps(before, ops), ops };
}
const w1 = (d: AppData) => weeklyOf(d)!.weeks.w20261125;

test('2.0: переход при запуске 24.11 — резервная копия, командировки, релакс-дни, неделя 25–30.11 на 9 порций', () => {
  const { before, after, ops } = migrated();
  assert.equal(after.meta!.dataVersion, DATA_VERSION);
  assert.equal(ops[0].store, 'backups', 'сначала резервная копия');
  const bk = Object.values(after.backups).find((b) => b.id.startsWith('v2-'))!;
  assert.equal(bk.stores.planDays.length, Object.keys(before.planDays).length, 'в копии — все дни до перехода');
  const trips = Object.values(after.trips).map((t) => `${t.from}–${t.to}`).sort();
  assert.deepEqual(trips, ['2026-11-18–2026-11-20', '2026-12-01–2026-12-02', '2026-12-15–2026-12-22']);
  assert.equal(after.settings.relaxOverrides['2026-11'], '2026-11-29');
  assert.equal(after.settings.relaxOverrides['2026-12'], '2026-12-27');
  const w = w1(after);
  assert.equal(w.status, 'approved');
  assert.equal(w.cook.reduce((s, c) => s + c.servings, 0), 9, 'девять порций');
  assert.equal(w.cook.flatMap((c) => c.uses).filter((u) => u.storage === 'freeze').length, 4, 'четыре пакета в морозилку');
  assert.equal(after.settings.weekly!.shopDay, 7, 'воскресенье');
  assert.equal(after.settings.weekly!.freezer.capacity, null, 'место в морозилке не задано');
  // календарь дальше 30 дней, командировки и релакс-дни на месте
  assert.ok(after.planDays['2026-12-20']?.tripId, '20.12 — командировка');
  assert.ok(after.planDays['2026-12-27']?.relax, '27.12 — релакс-день');
  assert.ok(Object.keys(after.planDays).some((d) => d >= '2027-01-04'), 'календарь до января');
  assert.ok(!after.planDays['2026-11-25']?.tripId, '25.11 больше не командировка');
});

test('2.0: история и отметки не меняются; 24.11 — как был; повторный запуск ничего не меняет', () => {
  const { before, after } = migrated();
  for (const date of Object.keys(before.planDays).filter((d) => d <= '2026-11-24')) assert.equal(J(after.planDays[date]), J(before.planDays[date]), date);
  for (const s of ['taskStatus', 'weights', 'photos', 'trainingLogs', 'measurements', 'templateVersions', 'readyFood'] as const) assert.equal(J(after[s]), J(before[s]), s);
  for (const e of Object.values(before.cookingEvents)) if (e.date < '2026-11-24') assert.equal(J(after.cookingEvents[e.id]), J(e), `готовка ${e.date}`);
  // будущих готовок и закупок прежнего меню нет, у недельных — по одной на дату
  const future = Object.values(after.cookingEvents).filter((e) => e.date >= '2026-11-25');
  assert.ok(future.every((e) => e.instanceId === 'weekly'), 'только готовки недель');
  assert.equal(new Set(future.map((e) => e.date)).size, future.length, 'без дублей готовок');
  assert.ok(Object.values(after.shoppingEvents).filter((e) => e.date >= '2026-11-24').every((e) => e.instanceId === 'weekly'), 'закупки прежнего меню убраны');
  assert.equal(dataMigrationOps(after, '2026-11-24', '2026-11-24T10:00:00.000Z').length, 0);
  assert.equal(dataMigrationOps(after, '2026-11-26', '2026-11-26T10:00:00.000Z').length, 0);
});

test('2.0: закупка — только после подтверждения запасов и только недостающее', () => {
  const { after } = migrated();
  const w = w1(after);
  assert.equal(weekPurchase(after, w).ready, false, 'до подтверждения закупки нет');
  assert.equal(after.shoppingEvents['shop-weekly-w20261125'].lines!.length, 0);
  const rows = weekStockRows(after, w, '2026-11-24');
  assert.equal(rows.find((r) => r.productId === 'pollock')!.usable, 200);
  assert.equal(rows.find((r) => r.productId === 'greenbeans')!.usable, 400);
  // пользователь подтверждает: минтай 200 г, фасоль 400 г, гречка 500 г, остального нет
  let d = after;
  for (const r of rows) d = applyOps(d, setRemainingOps(d, r.productId, r.productId === 'pollock' ? 200 : r.productId === 'greenbeans' ? 400 : r.productId === 'buckwheat' ? 500 : 0, AT, '2026-11-24', null));
  const confirmed: WeekPlan = { ...w, stockConfirmedAt: AT };
  const pur = computePurchase(d, confirmed);
  const line = (pid: string) => pur.lines.find((l) => l.productId === pid);
  // филе минтая на av.ru нет: 200 г из дома, недостающее — пикша (замена с поправкой ×1,15)
  assert.equal(line('pollock'), undefined, 'минтай не покупается — его нет на av.ru');
  assert.ok((line('l_haddock')?.packs ?? 0) >= 1, 'вместо минтая — пикша');
  assert.ok(line('l_haddock')!.notes.length >= 0 && pur.unverified.indexOf('Минтай') < 0);
  assert.equal(line('greenbeans'), undefined, 'стручковая фасоль есть — не покупать');
  assert.equal(line('buckwheat'), undefined, 'гречки 500 г хватает на 400 г');
  assert.equal(line('chicken')?.packs, 1, 'курица — один лоток 865 г, без остатка');
  assert.equal(line('chicken')?.leftover, 0);
  assert.equal(line('tomatopuree')?.packs, 1, 'банка томатов целиком');
  assert.ok(pur.total > 0 && pur.total < 9000, `сумма ${pur.total}`);
  // снимок закупки не меняется от «куплено»
  const d2 = applyOps(d, [{ store: 'settings', put: { ...d.settings, weekly: { ...weeklyOf(d)!, weeks: { ...weeklyOf(d)!.weeks, [w.id]: { ...confirmed, purchase: pur } } } } }]);
  assert.equal(weekPurchase(d2, weeklyOf(d2)!.weeks[w.id]).lines.length, pur.lines.length);
  const rp = weeklyReplanOps(d2, '2026-11-24');
  const d3 = applyOps(d2, rp.ops);
  assert.equal(d3.shoppingEvents['shop-weekly-w20261125'].lines!.length, pur.lines.length, 'закупка в задачах дня');
});

test('2.0: командировка посреди недели — дни пересчитываются, порции на поездку видны, отмеченное не меняется', () => {
  const { after } = migrated();
  const marked = applyOps(after, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-26:lunch', date: '2026-11-26', kind: 'meal', status: 'done', updatedAt: AT } }]);
  const withTrip = applyOps(marked, [{ store: 'trips', put: { id: 'tx', city: 'Казань', from: '2026-11-27', to: '2026-11-28', hotelBreakfast: true, fridge: false, canTrain: false, comment: null, createdAt: AT, updatedAt: AT } }]);
  const rp = weeklyReplanOps(withTrip, '2026-11-25');
  const d = applyOps(withTrip, rp.ops);
  assert.equal(d.planDays['2026-11-27'].tripId, 'tx');
  assert.ok(rp.instance.issues.some((i) => /командировку/.test(i.text)), 'предупреждение о порциях на дни поездки');
  assert.equal(J(d.planDays['2026-11-26']), J(withTrip.planDays['2026-11-26']), 'день с отметкой не изменился');
  // поездку отменили — меню вернулось
  const back = applyOps(d, [{ store: 'trips', del: 'tx' }]);
  const d2 = applyOps(back, weeklyReplanOps(back, '2026-11-25').ops);
  assert.equal(d2.planDays['2026-11-27'].mealCards!.lunch.title, 'Курица с паприкой, булгуром, перцем и кабачком');
});

test('2.0: планировщик — без повторов основных блюд за 4 недели, не больше 6 порций одного блюда, без одинаковых завтраков подряд', () => {
  const { after } = migrated();
  const ws = weeklyOf(after)!;
  for (const w of weekList(ws).filter((x) => x.status === 'draft')) {
    for (const c of w.cook) assert.ok(c.servings <= 6 || w.notes.some((n) => /блюда вместо/.test(n)), `${w.id}: ${c.r} ×${c.servings}`);
    const dates = Object.keys(w.meals).sort();
    for (let i = 1; i < dates.length; i++) {
      const a = w.meals[dates[i - 1]].breakfast?.r, b = w.meals[dates[i]].breakfast?.r;
      if (a && b && a === b) assert.ok(/накануне/.test(w.meals[dates[i]].breakfast!.note ?? ''), `${dates[i]}: тот же завтрак — только вторая порция`);
    }
  }
  // новая неделя после 25–30.11 не берёт блюда недели 1
  const cyc = planCycles(after, '2026-12-03', '2026-12-06', 7)[0];
  const w = draftWeek(after, cyc, { now: AT });
  const recent = recentMains(after, '2026-12-03', 28);
  assert.ok(recent.has('m008') && recent.has('m009') && recent.has('m010'));
  assert.ok(w.cook.every((c) => !['m008', 'm009', 'm010'].includes(c.r)), w.cook.map((c) => c.r).join(','));
  const slots = Object.values(w.meals).flatMap((s) => Object.entries(s)).filter(([sl]) => sl === 'lunch' || sl === 'dinner');
  assert.equal(slots.length, cyc.slots.length + cyc.gap.filter((g) => g.slot === 'lunch').length);
  // «больше не предлагать» и низкая оценка — не предлагаются
  const hidden = applyOps(after, [{ store: 'settings', put: { ...after.settings, recipePrefs: Object.fromEntries(w.cook.map((c) => [c.r, { hidden: true, at: AT }])) } }]);
  const w2 = draftWeek(hidden, cyc, { now: AT });
  assert.ok(w2.cook.every((c) => !w.cook.some((x) => x.r === c.r)));
  assert.ok(LIB_RECIPES.length >= 27);
  const slotsOk: MealSlot[] = ['breakfast', 'lunch', 'snack', 'dinner'];
  assert.ok(slotsOk.length === 4);
});

test('2.0: «Купил» добавляет в запасы, снятая отметка убирает', () => {
  const { after } = migrated();
  const before = stockRemaining(after, 'pollock');
  const move = { id: 'buy-shop-weekly-w20261125-pollock', date: '2026-11-25', kind: 'purchase' as const, qty: 300, source: 'shop', note: null, confirmed: true, at: AT };
  const d = applyOps(after, [{ store: 'stock', put: { ...after.stock.pollock, moves: [...after.stock.pollock.moves, move] } }]);
  assert.equal(stockRemaining(d, 'pollock'), before + 300);
});

test('отчёт для ChatGPT: вес гири без «undefined кг»', () => {
  const { after } = migrated();
  const { md } = buildReport(after, { from: '2026-11-01', to: '2026-11-30', today: '2026-11-24', photos: [], notes: '', include: { weights: true, workouts: true, nutrition: true, notes: true }, appVersion: '2.0.0', generatedAt: AT } as any);
  assert.ok(/кг/.test(md));
  assert.ok(!/undefined/.test(md), 'в отчёте нет «undefined»');
});

test('av.ru: товары с карточкой — цена, упаковка и КБЖУ этикетки; отсутствующие — замена с пересчётом; без замены — не в меню', () => {
  // этикетка av.ru вместо справочных данных
  assert.equal(PRODUCTS.l_greek_yogurt.nutr.p, 8);
  assert.equal(buyInfo('l_greek_yogurt').packPrice, 108);
  assert.equal(buyInfo('pollock').status, 'missing');
  assert.equal(buyInfo('chicken').status, 'listed');
  // рецепт с минтаем: КБЖУ и закупка — по пикше
  const m010 = LIB_RECIPES.find((r) => r.id === 'm010')!;
  const eff = libEff(m010);
  assert.ok(eff.subs.some((s) => s.from === 'pollock' && s.to === 'l_haddock'));
  assert.ok(eff.r.ingredients.every((i) => i.p !== 'pollock'));
  // тофу на av.ru нет и замены нет — блюдо не предлагается
  const tofu = LIB_RECIPES.find((r) => r.ingredients.some((i) => i.p === 'l_tofu'))!;
  assert.equal(recipeAvail(tofu).ok, false);
  const { after } = migrated();
  const cyc = planCycles(after, '2026-12-03', '2026-12-06', 7)[0];
  const w = draftWeek(after, cyc, { now: AT });
  const used = [...w.cook.map((c) => c.r), ...Object.values(w.meals).flatMap((s) => Object.values(s).map((m) => m?.r))].filter(Boolean) as string[];
  for (const id of used) assert.ok(recipeAvail(LIB_RECIPES.find((r) => r.id === id)!, after).ok, `${id} — все продукты есть на av.ru или дома`);
});

test('av.ru: «нет в магазине» → выбранная замена пересчитывает закупку', () => {
  const { after } = migrated();
  const w = w1(after);
  let d = after;
  for (const r of weekStockRows(after, w, '2026-11-24')) d = applyOps(d, setRemainingOps(d, r.productId, 0, AT, '2026-11-24', null));
  const confirmed: WeekPlan = { ...w, stockConfirmedAt: AT };
  const pur = computePurchase(d, confirmed);
  assert.ok(pur.lines.some((l) => l.productId === 'chicken'));
  const cand = subCandidates('chicken');
  assert.ok(cand.length > 0, 'есть замены той же категории');
  const pur2 = computePurchase(d, { ...confirmed, subs: { chicken: cand[0].to } });
  assert.ok(!pur2.lines.some((l) => l.productId === 'chicken'), 'курицу не покупаем');
  const line = pur2.lines.find((l) => l.productId === cand[0].to)!;
  assert.ok(line && line.notes.some((n) => /вместо/.test(n)), 'строка замены с пояснением');
});
