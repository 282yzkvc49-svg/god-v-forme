// Версия 2.0: многонедельный сценарий день за днём (24.11.2026 – 10.01.2027) — как пользователь будет жить с
// приложением: утверждает недели (если меню не сходится — явно, с замечаниями), подтверждает запасы, покупает,
// готовит, ест; посреди — новая командировка и отмена другой. Проверяются календарь, командировки, релакс-дни,
// тренировки, закупки, готовки, запасы, КБЖУ дней, повторы блюд и бюджет месяца.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOps, dataMigrationOps, storesToData } from '../src/state/model';
import type { Op } from '../src/state/idb';
import type { AppData, MealCard, MealCardPart, MealSlot } from '../src/state/types';
import { MEAL_SLOTS } from '../src/state/types';
import { addDays, range } from '../src/lib/dates';
import {
  LIB, computePurchase, cookEventId, dayKind, planCycles, setRemainingOps, shopEventId, weekList, weekStockRows, weeklyOf, type WeekPlan,
} from '../src/domain/weekly';
import { dayNutrition, draftWeek, weekIssues, weeklyReplanAll } from '../src/domain/weekPlanner';
import { cookStockOps, mealStockOps, stockRemaining } from '../src/domain/stock';
import { scheduledTraining } from '../src/domain/tasks';
import { tripList } from '../src/domain/trips';

const FROM = '2026-11-24';
const TO = '2027-01-10';

function device(): AppData {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/state_1.7.0_r1_2211.json', import.meta.url), 'utf8'));
  const stores: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(raw)) stores[k] = k === 'settings' || k === 'meta' ? [v] : Object.values(v as object);
  const d = storesToData(stores as any);
  d.ready = true;
  return d;
}
const at = (date: string, h = 8) => `${date}T${String(h).padStart(2, '0')}:00:00.000Z`;
const putWeek = (d: AppData, w: WeekPlan): Op => ({ store: 'settings', put: { ...d.settings, weekly: { ...weeklyOf(d)!, weeks: { ...weeklyOf(d)!.weeks, [w.id]: w } } } });

test('многонедельный сценарий: 24.11 – 10.01, утверждение, запасы, закупки, готовки, поездки', { timeout: 600000 }, () => {
  const d0 = device();
  let d = applyOps(d0, dataMigrationOps(d0, '2026-11-23', at('2026-11-23'), '1.9.1'));
  d = applyOps(d, dataMigrationOps(d, FROM, at(FROM), '2.0.0'));
  const log: string[] = [];
  const replan = (today: string, h = 9) => { d = applyOps(d, weeklyReplanAll(d, today, { now: at(today, h) }).ops); };
  const accepted: string[] = [];
  const boughtByMonth: Record<string, number> = {};
  for (const today of range(FROM, TO)) {
    // поездки меняются по ходу: 05.12 добавлена 09–10.12, 10.12 отменена 15–22.12
    if (today === '2026-12-05') { d = applyOps(d, [{ store: 'trips', put: { id: 'trip-x', city: 'Тула', from: '2026-12-09', to: '2026-12-10', hotelBreakfast: true, fridge: false, canTrain: false, comment: null, createdAt: at(today), updatedAt: at(today) } }]); replan(today); log.push('05.12: добавлена поездка 09–10.12'); }
    if (today === '2026-12-10') { d = applyOps(d, [{ store: 'trips', del: 'trip-2026-12-15' }]); replan(today); log.push('10.12: отменена поездка 15–22.12'); }
    // в уже купленной и приготовленной неделе: поездка 30–31.12 добавлена 29.12 — порции остаются запасом; 30.12 отменена
    if (today === '2026-12-29') {
      d = applyOps(d, [{ store: 'trips', put: { id: 'trip-y', city: 'Казань', from: '2026-12-30', to: '2026-12-31', hotelBreakfast: true, fridge: false, canTrain: false, comment: null, createdAt: at(today), updatedAt: at(today) } }]);
      replan(today);
      assert.ok(d.planDays['2026-12-30'].tripId, '30.12 — поездка');
      const w = weekList(weeklyOf(d)!).find((x) => x.meals['2026-12-30'])!;
      assert.ok(w.status === 'approved' && w.meals['2026-12-30'], 'неделя хранит меню 30.12 на случай отмены');
      log.push('29.12: поездка 30–31.12 в приготовленной неделе');
    }
    if (today === '2026-12-30') {
      d = applyOps(d, [{ store: 'trips', del: 'trip-y' }]);
      replan(today);
      assert.ok(d.planDays['2026-12-30'].mealCards && !d.planDays['2026-12-30'].tripId, '30.12 — снова дома, меню вернулось');
      log.push('30.12: поездка отменена');
    }
    // черновики на 4 недели вперёд (как кнопка «Составить черновики»)
    const ws = weeklyOf(d)!;
    const lastCovered = weekList(ws).flatMap((w) => Object.keys(w.meals)).sort().slice(-1)[0] ?? today;
    if (lastCovered < addDays(today, 14)) {
      for (const c of planCycles(d, addDays(lastCovered, 1) > today ? lastCovered : today, addDays(today, 28), ws.shopDay)) {
        const cov = new Set(weekList(weeklyOf(d)!).flatMap((w) => Object.entries(w.meals).flatMap(([dt, s]) => Object.keys(s).map((x) => `${dt}|${x}`))));
        const cyc = { ...c, slots: c.slots.filter((s) => !cov.has(`${s.date}|${s.slot}`)), fresh: c.fresh.filter((s) => !cov.has(`${s.date}|${s.slot}`)), gap: c.gap.filter((s) => !cov.has(`${s.date}|${s.slot}`)) };
        if (!cyc.slots.length || weeklyOf(d)!.weeks[`w${c.cookDate.replace(/-/g, '')}`]) continue;
        const w = draftWeek(d, cyc, { now: at(today), today });
        d = applyOps(d, [putWeek(d, w)]);
      }
      replan(today);
    }
    // день закупки и готовки: утвердить (с замечаниями — явно), подтвердить запасы, купить всё, приготовить
    for (const w0 of weekList(weeklyOf(d)!)) {
      if (w0.shopDate !== today || dayKind(d, today) === 'trip') continue;
      let w = w0;
      if (w.status === 'draft') {
        const issues = [...weekIssues(d, w, today), ...(w.problems ?? []).filter((p) => /бюджет|морозилк|повторяется/.test(p))];
        if (issues.length) accepted.push(`${w.id}: ${issues.join(' ')}`);
        w = { ...w, status: 'approved', approvedAt: at(today), acceptedProblems: issues.length ? issues : null };
        d = applyOps(d, [putWeek(d, w)]);
      }
      // запасы: подтверждаются по учёту (пользователь проверил — совпало)
      const rows = weekStockRows(d, w, today);
      for (const r of rows) d = applyOps(d, setRemainingOps(d, r.productId, r.usable, at(today, 10), today, 'проверено'));
      w = { ...w, stockConfirmedAt: at(today, 10) };
      const pur = computePurchase(d, w);
      assert.ok(pur.ready && !(pur.pending ?? []).length, `${w.id}: закупка без неподтверждённого`);
      w = { ...w, purchase: pur };
      d = applyOps(d, [putWeek(d, w)]);
      // купить всё
      const ev = shopEventId(w);
      const ops: Op[] = [];
      for (const l of pur.lines) {
        ops.push({ store: 'shoppingChecks', put: { id: `${ev}:${l.productId}`, eventId: ev, itemId: l.productId, bought: true, atHome: false, absent: false, actualPrice: null, updatedAt: at(today, 11) } });
        const rec = d.stock[l.productId] ?? { productId: l.productId, location: 'fridge', moves: [], confirmedAt: null, expiresOn: null, note: null, updatedAt: at(today, 11) };
        ops.push({ store: 'stock', put: { ...rec, moves: [...rec.moves, { id: `buy-${ev}-${l.productId}`, date: today, kind: 'purchase', qty: l.buy, source: `shop:${ev}`, note: null, confirmed: true, at: at(today, 11) }], updatedAt: at(today, 11) } as any });
        boughtByMonth[today.slice(0, 7)] = (boughtByMonth[today.slice(0, 7)] ?? 0) + l.cost;
      }
      ops.push({ store: 'taskStatus', put: { taskId: `shop:${ev}`, date: today, kind: 'shopping', status: 'done', updatedAt: at(today, 11) } as any });
      d = applyOps(d, ops);
      replan(today, 12);
    }
    // готовка этого дня
    for (const e of Object.values(d.cookingEvents)) {
      if (e.date !== today || e.instanceId !== 'weekly' || d.taskStatus[`cook:${e.id}`]?.status === 'done') continue;
      assert.notEqual(dayKind(d, today), 'trip', `готовка ${e.id} в день поездки`);
      const st = cookStockOps(d, e, true, at(today, 18));
      d = applyOps(d, [...st.ops, { store: 'taskStatus', put: { taskId: `cook:${e.id}`, date: today, kind: 'cooking', status: 'done', updatedAt: at(today, 18) } as any }]);
    }
    // приёмы пищи — съедены
    const day = d.planDays[today];
    if (day?.mealCards && !day.tripId) for (const s of MEAL_SLOTS) {
      const key = `meal:${today}:${s}`;
      if (d.taskStatus[key] && d.taskStatus[key].status !== 'planned') continue;
      if (day.mealCards[s]?.cancelled) continue;
      d = applyOps(d, [...mealStockOps(d, today, s, 'done', at(today, 20)), { store: 'taskStatus', put: { taskId: key, date: today, kind: 'meal', status: 'done', updatedAt: at(today, 20) } as any }]);
    }
  }

  // ---- проверки
  const trips = tripList(d);
  assert.ok(trips.some((t) => t.id === 'trip-x') && !trips.some((t) => t.id === 'trip-2026-12-15'));
  const mains = new Map<string, string>();
  let full = 0;
  for (const date of range('2026-11-25', '2027-01-06')) {
    const kind = dayKind(d, date, trips);
    const pd = d.planDays[date];
    assert.ok(pd, `${date}: день в календаре`);
    if (kind === 'trip') {
      assert.ok(pd.tripId, `${date}: командировка`);
      assert.ok(!Object.values(d.cookingEvents).some((e) => e.date === date && e.instanceId === 'weekly'), `${date}: нет готовки в поездке`);
      const tr = scheduledTraining(d, date);
      assert.ok(!tr || !/strength/.test(tr.templateId), `${date}: нет обязательной силовой в поездке (${tr?.templateId})`);
      continue;
    }
    if (kind === 'relax') { assert.ok(pd.relax, `${date}: релакс-день`); continue; }
    assert.ok(pd.mealCards, `${date}: меню`);
    for (const s of ['lunch', 'dinner'] as MealSlot[]) {
      const c: MealCard | undefined = pd.mealCards![s];
      assert.ok(c && !c.cancelled && c.title !== 'Нужно выбрать блюдо', `${date} ${s}: ${c?.title}`);
      const lib = c!.parts.find((p: MealCardPart) => p.dishId.startsWith('lib-'))?.dishId.slice(4);
      if (lib && LIB[lib]?.kind === 'main' && date > '2026-11-30') {
        const prev = mains.get(lib);
        if (prev) assert.ok((Date.parse(date) - Date.parse(prev)) / 864e5 < 8 || (Date.parse(date) - Date.parse(prev)) / 864e5 >= 28, `${lib}: ${prev} и ${date} — повтор раньше 4 недель`);
        if (!prev || (Date.parse(date) - Date.parse(prev)) / 864e5 >= 8) mains.set(lib, date);
      }
    }
    const n = dayNutrition(d, date);
    if (n.complete && date > '2026-12-02') {
      full++;
      const wk = weekList(weeklyOf(d)!).find((w) => w.meals[date]);
      assert.ok(n.ok || (wk?.acceptedProblems ?? []).length > 0, `${date}: ${n.kcal} ккал, Б ${n.p}, Ж ${n.f}`);
    }
  }
  assert.ok(full >= 20, `полных дней: ${full}`);
  // запасы не уходят в минус, все отмеченные готовки и закупки — на месте
  for (const pid of Object.keys(d.stock)) assert.ok(stockRemaining(d, pid) >= -0.01, `${pid}: ${stockRemaining(d, pid)}`);
  // бюджет: покупки по месяцам в пределах 50 000 ₽ (командировки — вне бюджета)
  for (const [m, rub] of Object.entries(boughtByMonth)) assert.ok(rub <= 50000, `${m}: ${Math.round(rub)} ₽`);
  // каждая утверждённая неделя с прошедшим днём закупки — куплена и приготовлена
  for (const w of weekList(weeklyOf(d)!)) {
    if (!w.cookDate || w.cookDate > TO || dayKind(d, w.cookDate) === 'trip') continue;
    assert.equal(w.status, 'approved', `${w.id}: утверждена`);
    assert.equal(d.taskStatus[`cook:${cookEventId(w)}`]?.status, 'done', `${w.id}: приготовлено`);
  }
  console.log(`  бюджет по месяцам: ${Object.entries(boughtByMonth).map(([m, r]) => `${m} ${Math.round(r)} ₽`).join(', ')}; утверждено с замечаниями: ${accepted.length}; ${log.join('; ')}`);
});
