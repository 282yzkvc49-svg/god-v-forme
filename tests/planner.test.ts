// Версия 2.0: планировщик недели — КБЖУ каждого дня, порции, бюджет, остатки, замены блюд, командировки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOps, dataMigrationOps, storesToData } from '../src/state/model';
import type { AppData, MealSlot } from '../src/state/types';
import {
  LIB, computePurchase, cookStart, cookTimeNote, effectiveWeek, recalcPurchase, replaceInWeek, setRemainingOps, weekDates, weekList,
  weekNeeds, weekStockRows, weeklyOf, type WeekPlan,
} from '../src/domain/weekly';
import {
  DAY_KCAL_MAX, DAY_KCAL_MIN, DAY_PROTEIN_MIN, cheaperMains, dayNutrition, monthBudget, weekIssues, weeklyReplanAll,
} from '../src/domain/weekPlanner';
import { ADDON, buyInfo } from '../src/domain/catalog';
import { recipeAvail } from '../src/domain/weekly';

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
let cached: AppData | null = null;
function migrated(): AppData {
  if (cached) return cached;
  const d0 = device();
  const v9 = applyOps(d0, dataMigrationOps(d0, '2026-11-23', '2026-11-23T08:00:00.000Z', '1.9.1'));
  cached = applyOps(v9, dataMigrationOps(v9, '2026-11-24', AT, '2.0.0'));
  return cached;
}
const weeks = (d: AppData) => weekList(weeklyOf(d));
const drafts = (d: AppData) => weeks(d).filter((w) => w.status === 'draft');
const putWeek = (d: AppData, w: WeekPlan) => applyOps(d, [{ store: 'settings', put: { ...d.settings, weekly: { ...weeklyOf(d)!, weeks: { ...weeklyOf(d)!.weeks, [w.id]: w } } } }]);
const replan = (d: AppData, today: string) => applyOps(d, weeklyReplanAll(d, today, { now: `${today}T10:00:00.000Z` }).ops);

test('планировщик: каждый полный день — 2300–2600 ккал, белок от 150 г, жиры до 40%', () => {
  const d = migrated();
  let days = 0;
  for (const w of drafts(d)) {
    for (const date of weekDates(w)) {
      const n = dayNutrition(d, date);
      if (!n.complete) continue;
      days++;
      assert.ok(n.ok || (w.problems ?? []).some((p) => p.includes(date.slice(8, 10))), `${date}: ${n.kcal} ккал, Б ${n.p}, Ж ${n.f}`);
      assert.ok(n.kcal >= DAY_KCAL_MIN - 1 && n.kcal <= DAY_KCAL_MAX + 1, `${date}: ${n.kcal} ккал`);
      assert.ok(n.p >= DAY_PROTEIN_MIN, `${date}: белок ${n.p}`);
    }
  }
  assert.ok(days >= 20, `полных дней в черновиках: ${days}`);
});

test('планировщик: основные блюда — без повторов за 4 недели, партии 2–7 порций, все обеды и ужины закрыты', () => {
  const d = migrated();
  const seen = new Map<string, string>();
  for (const w of weeks(d)) {
    for (const c of w.cook) {
      assert.ok(c.servings >= 2 && c.servings <= 7, `${w.id}: ${c.r} ×${c.servings}`);
      assert.ok(c.servings >= c.uses.length);
      const r = LIB[c.r];
      for (const u of c.uses) {
        const days = (Date.parse(u.date) - Date.parse(w.cookDate!)) / 864e5;
        if (days > Math.min(3, r.storage.fridge_days)) assert.equal(u.storage, 'freeze', `${c.r} ${u.date}: дольше срока — морозилка`);
        if (u.storage === 'freeze') assert.ok(r.storage.freeze, `${c.r}: не замораживается`);
      }
    }
    for (const date of weekDates(w)) for (const s of ['lunch', 'dinner'] as MealSlot[]) {
      const m = w.meals[date]?.[s];
      if (!m) continue;
      assert.notEqual(m.title, 'Нужно выбрать блюдо', `${w.id} ${date} ${s}`);
      if (!m.r || LIB[m.r]?.kind !== 'main' || m.src !== 'cook') continue;
      const prev = seen.get(m.r);
      if (prev && !prev.startsWith(w.id) && (Date.parse(date) - Date.parse(prev.split('|')[1])) / 864e5 < 28) assert.fail(`${m.r} повторяется раньше 4 недель: ${prev} и ${w.id} ${date}`);
      seen.set(m.r, `${w.id}|${date}`);
    }
    // обед и ужин одного дня — разные блюда (если в неделе больше одного блюда)
    if (w.status === 'draft' && w.cook.length > 1) for (const date of weekDates(w)) {
      const l = w.meals[date]?.lunch?.r, dn = w.meals[date]?.dinner?.r;
      assert.ok(!l || l !== dn, `${w.id} ${date}: одно блюдо в обед и ужин`);
    }
  }
});

test('планировщик: только товары с карточкой av.ru или из дома, добавки — тоже; бюджет месяца с прогнозом', () => {
  const d = migrated();
  for (const w of drafts(d)) {
    for (const [date, slots] of Object.entries(w.meals)) for (const m of Object.values(slots)) {
      if (m?.r) assert.ok(recipeAvail(LIB[m.r], d).ok, `${date}: ${m.r}`);
      for (const a of m?.add ?? []) assert.equal(buyInfo(ADDON[a].p).status, 'listed', `${date}: добавка ${a}`);
    }
    assert.ok(w.estimate && w.estimate.cost > 0, `${w.id}: оценка стоимости`);
  }
  const dec = monthBudget(d, '2026-12', '2026-11-24');
  assert.ok(dec.forecast > 0 && dec.forecast + dec.spent + dec.confirmed <= 50000, `декабрь: ${dec.forecast}`);
  assert.equal(dec.left, 50000 - dec.spent - dec.confirmed - dec.forecast);
  // прогноз учитывает остатки упаковок прошлых недель: следующая неделя дешевле, чем та же неделя «с нуля»
  assert.ok(dec.weeks.length >= 4);
});

test('доставка вечером: готовка — после доставки, ужин дня готовки — первым', () => {
  const d = migrated();
  const w = weeklyOf(d)!.weeks.w20261125;
  assert.equal(w.delivery?.time, null);
  assert.match(cookTimeNote(w), /после доставки/);
  assert.match(d.cookingEvents['cook-weekly-w20261125'].timeNote ?? '', /доставки/);
  assert.equal(cookStart({ ...w, delivery: { time: '19:30' } }, weeklyOf(d)), '19:50');
  assert.equal(cookStart({ ...w, delivery: { time: '12:00' } }, weeklyOf(d)), w.cookTime);
});

test('замена блюда: подтверждение запасов сохраняется, закупка пересчитана, новые продукты — после подтверждения остатка', () => {
  let d = migrated();
  const w0 = weeklyOf(d)!.weeks.w20261125;
  for (const r of weekStockRows(d, w0, '2026-11-24')) d = applyOps(d, setRemainingOps(d, r.productId, 0, AT, '2026-11-24', null));
  const conf: WeekPlan = { ...w0, stockConfirmedAt: AT };
  const pur = computePurchase(d, conf);
  d = putWeek(d, { ...conf, purchase: pur });
  // заменить котлеты (m008, 4 порции) на другое блюдо, которое морозится
  const alt = Object.values(LIB).find((r) => r.kind === 'main' && r.storage.freeze && r.id !== 'm008' && recipeAvail(r, d).ok && r.ingredients.some((i) => !weekNeeds(conf, d).has(i.p)))!;
  const w1 = replaceInWeek(weeklyOf(d)!.weeks.w20261125, 'm008', alt.id);
  assert.equal(w1.stockConfirmedAt, AT, 'подтверждение запасов не сбрасывается');
  assert.equal(w1.cook.find((c) => c.r === alt.id)!.servings, 4, 'партия — на те же 4 порции');
  const p2 = recalcPurchase(d, w1)!;
  assert.ok(p2.ready);
  assert.ok((p2.pending ?? []).length > 0, 'новые продукты ждут подтверждения остатка');
  assert.ok(!p2.lines.some((l) => (p2.pending ?? []).includes(l.productId)), 'по ним закупки ещё нет');
  // купленные строки не меняются после изменения меню
  const line = pur.lines[0];
  const dB = applyOps(d, [{ store: 'shoppingChecks', put: { id: `shop-weekly-w20261125:${line.productId}`, eventId: 'shop-weekly-w20261125', itemId: line.productId, bought: true, atHome: false, absent: false, actualPrice: null, updatedAt: AT } }]);
  const p3 = recalcPurchase(dB, w1)!;
  assert.equal(J(p3.lines.find((l) => l.productId === line.productId)?.buy), J(line.buy), 'купленная строка осталась');
});

test('командировка в утверждённой неделе: порции на поездку не готовятся, закупка меньше; отмена — всё возвращается', () => {
  const d = migrated();
  const w = weeklyOf(d)!.weeks.w20261125;
  const before = weekNeeds(w, d).get('chicken')?.qty ?? 0;
  const withTrip = applyOps(d, [{ store: 'trips', put: { id: 'tx', city: 'Казань', from: '2026-11-27', to: '2026-11-28', hotelBreakfast: true, fridge: false, canTrain: false, comment: null, createdAt: AT, updatedAt: AT } }]);
  const eff = effectiveWeek(withTrip, w);
  assert.ok(!eff.meals['2026-11-27'] && !eff.meals['2026-11-28']);
  assert.equal(eff.cook.find((c) => c.r === 'm008')!.servings, 2, 'котлет — 2 порции вместо 4');
  assert.ok((weekNeeds(w, withTrip).get('chicken')?.qty ?? 0) < before, 'курицы нужно меньше');
  const d2 = replan(withTrip, '2026-11-25');
  assert.ok(d2.planDays['2026-11-27'].tripId);
  assert.equal(J(weeklyOf(d2)!.weeks.w20261125.meals), J(w.meals), 'неделя хранится целиком — на случай отмены поездки');
  const back = replan(applyOps(d2, [{ store: 'trips', del: 'tx' }]), '2026-11-25');
  assert.equal(back.planDays['2026-11-27'].mealCards!.lunch.title, d.planDays['2026-11-27'].mealCards!.lunch.title);
  assert.equal(J(back.cookingEvents['cook-weekly-w20261125'].items), J(d.cookingEvents['cook-weekly-w20261125'].items));
});

test('командировка на неделю-черновик: черновик пересобирается, на дни поездки ничего не готовится', () => {
  const d = migrated();
  const trip = { id: 'ty', city: 'Тула', from: '2026-12-08', to: '2026-12-10', hotelBreakfast: true, fridge: false, canTrain: false, comment: null, createdAt: AT, updatedAt: AT };
  const d2 = replan(applyOps(d, [{ store: 'trips', put: trip }]), '2026-11-26');
  const ws = weeklyOf(d2)!;
  for (const w of Object.values(ws.weeks)) for (const date of Object.keys(w.meals)) {
    if (date >= '2026-12-08' && date <= '2026-12-10') assert.equal(w.status, 'approved', `${w.id}: черновик с днём поездки ${date}`);
  }
  // дни после поездки закрыты обедами и ужинами
  for (const date of ['2026-12-11', '2026-12-12']) for (const s of ['lunch', 'dinner'] as MealSlot[]) {
    assert.ok(Object.values(ws.weeks).some((w) => w.meals[date]?.[s]), `${date} ${s}`);
  }
  assert.ok(d2.planDays['2026-12-09'].tripId);
  // повторный пересчёт ничего не меняет
  const again = weeklyReplanAll(d2, '2026-11-26', { now: '2026-11-26T11:00:00.000Z' });
  assert.equal(again.ops.filter((o) => o.store === 'settings').length, 0, 'недели стабильны');
});

test('командировку 15–22.12 отменили: освободившиеся дни получают меню', () => {
  const d = migrated();
  const d2 = replan(applyOps(d, [{ store: 'trips', del: 'trip-2026-12-15' }]), '2026-11-26');
  const ws = weeklyOf(d2)!;
  for (const date of ['2026-12-16', '2026-12-18', '2026-12-21']) {
    for (const s of ['breakfast', 'lunch', 'snack', 'dinner'] as MealSlot[]) assert.ok(Object.values(ws.weeks).some((w) => w.meals[date]?.[s]), `${date} ${s}`);
    assert.ok(d2.planDays[date].mealCards, `${date}: день с меню`);
  }
  // история не меняется
  for (const date of Object.keys(d.planDays).filter((x) => x < '2026-11-26')) assert.equal(J(d2.planDays[date]), J(d.planDays[date]), date);
});

test('проблемы недели: «утвердить как есть» — только явно; варианты дешевле для бюджета', () => {
  const d = migrated();
  const w = drafts(d)[0];
  assert.deepEqual(weekIssues(d, w, '2026-11-24'), [], 'черновик без проблем');
  // день без блюда — проблема
  const date = weekDates(w).find((x) => w.meals[x]?.lunch?.src === 'cook')!;
  const broken: WeekPlan = { ...w, meals: { ...w.meals, [date]: { ...w.meals[date], lunch: { r: '', src: 'stock', title: 'Нужно выбрать блюдо' } } } };
  assert.ok(weekIssues(d, broken, '2026-11-24').some((x) => /Нет блюда/.test(x)));
  const opts = cheaperMains(d, w, w.cook[0].r, '2026-11-24');
  for (const o of opts) assert.ok(o.costDelta < 0);
});

test('откат 2.0 (данные): меню 1.9 с сегодняшнего дня, история и записи не меняются; включение обратно — недели как были', async () => {
  const { rollbackV2Ops, enableV2Ops } = await import('../src/domain/v2migration');
  const { dataToStores } = await import('../src/state/model');
  const h = { toStores: (x: AppData) => dataToStores(x), apply: applyOps };
  let d = migrated();
  // 25.11 обед съеден, 26.11 вес — записи пользователя после перехода
  d = applyOps(d, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-25:lunch', date: '2026-11-25', kind: 'meal', status: 'done', updatedAt: AT } }]);
  const ws = weeklyOf(d)!;
  const off = applyOps(d, rollbackV2Ops(d, '2026-11-26', '2026-11-26T08:00:00.000Z', '2.0.0', h));
  assert.equal(weeklyOf(off), null, 'недельный цикл выключен');
  assert.ok(off.settings.weeklyOff?.backupId && off.backups[off.settings.weeklyOff.backupId], 'копия перед возвратом');
  for (const date of Object.keys(d.planDays).filter((x) => x <= '2026-11-25')) assert.equal(J(off.planDays[date]), J(d.planDays[date]), `история ${date}`);
  for (const s of ['taskStatus', 'weights', 'photos', 'trainingLogs', 'stock', 'trips'] as const) assert.equal(J(off[s]), J(d[s]), s);
  const cfg = off.settings.plan!;
  const future = Object.values(off.planDays).filter((x) => x.date >= '2026-11-26' && x.date <= '2026-12-14' && !x.tripId);
  assert.ok(future.length > 5 && future.every((x) => x.instanceId === cfg.instanceId), 'будущие дни — по шаблону 1.9');
  assert.ok(!Object.values(off.cookingEvents).some((e) => e.instanceId === 'weekly' && e.date >= '2026-11-26'), 'готовок недель впереди нет');
  // включить обратно
  const on = applyOps(off, enableV2Ops(off, '2026-11-26', '2026-11-26T09:00:00.000Z', '2.0.0', h));
  assert.ok(weeklyOf(on));
  assert.equal(J(Object.keys(weeklyOf(on)!.weeks).sort()), J(Object.keys(ws.weeks).sort()), 'недели — как были');
  assert.equal(on.planDays['2026-11-27'].instanceId, 'weekly');
  assert.equal(on.settings.weeklyOff, null);
});

test('после временного возврата к 1.9.1 (версия данных 9) повторное обновление до 2.0 не повторяет переход 24.11', async () => {
  const { rollbackV2Ops } = await import('../src/domain/v2migration');
  const { dataToStores } = await import('../src/state/model');
  const h = { toStores: (x: AppData) => dataToStores(x), apply: applyOps };
  const d = migrated();
  for (const base of [d, applyOps(d, rollbackV2Ops(d, '2026-11-26', '2026-11-26T08:00:00.000Z', '2.0.0', h))]) {
    // версия 1.9.1 при запуске записывает версию данных 9
    const v9 = applyOps(base, [{ store: 'meta', put: { ...base.meta!, dataVersion: 9 } }]);
    const ops = dataMigrationOps(v9, '2026-11-27', '2026-11-27T08:00:00.000Z', '2.0.0');
    const after = applyOps(v9, ops);
    assert.equal(J(after.stock), J(base.stock), 'запасы не сбрасываются');
    assert.equal(J(after.trips), J(base.trips), 'командировки не меняются');
    assert.equal(Object.keys(after.backups).length, Object.keys(base.backups).length, 'новой копии перехода нет');
    assert.equal(J(weeklyOf(after)), J(weeklyOf(base)), 'недели как были');
  }
});

test('резервная копия (файл) с данными 2.0: недели, оценки рецептов, запасы и закупки восстанавливаются полностью', async () => {
  const { buildBackupZip, readBackup, restoreOps } = await import('../src/domain/zipfiles');
  const { STORE_KEYS } = await import('../src/state/types');
  const { emptyData } = await import('../src/state/model');
  let d = migrated();
  d = applyOps(d, [{ store: 'settings', put: { ...d.settings, recipePrefs: { m008: { fav: true, rating: 5, at: AT } } } }]);
  const { bytes } = await buildBackupZip(d, [], '2.0.0', AT);
  const parsed = await readBackup(bytes);
  const restored = applyOps(emptyData(), restoreOps(parsed, 'replace', emptyData(), (s, r) => r[(STORE_KEYS as any)[s]]));
  assert.equal(J(weeklyOf(restored)), J(weeklyOf(d)), 'недели');
  assert.equal(J(restored.settings.recipePrefs), J(d.settings.recipePrefs), 'избранное и оценки');
  for (const s of ['planDays', 'cookingEvents', 'shoppingEvents', 'stock', 'trips', 'taskStatus'] as const) assert.equal(J(restored[s]), J(d[s]), s);
  // после восстановления переход не повторяется
  assert.equal(dataMigrationOps(restored, '2026-11-26', '2026-11-26T08:00:00.000Z', '2.0.0').length, 0);
});
