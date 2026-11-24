import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshData, NOW } from './helpers';
import { DATA_VERSION, applyOps, dataMigrationOps } from '../src/state/model';
import { collectNeeds, currentInstanceDays, replanOps } from '../src/domain/plan';
import { scheduledTraining, tasksForDate } from '../src/domain/tasks';
import { previewChange, tripOps } from '../src/domain/planDiff';
import { applyTripMoveOps, planTripMove, planV8Ops, SPB_MOVE } from '../src/domain/tripMove';
import { TEMPLATE } from '../src/domain/catalog';
import type { AppData } from '../src/state/types';

const TODAY = '2026-11-20';
const AT = '2026-11-20T15:00:00.000Z';
const ID = (x: string) => `shop-p20261116-${x}`;
const J = (x: unknown) => JSON.stringify(x);

/**
 * Устройство на версии 1.5.0: меню «Азбука вкуса» v2 со старта 16.11, командировки 18–20.11 и 24–25.11,
 * первая основная закупка 15.11 сделана, приёмы пищи 16–19.11 отмечены, тренировки 16–17.11, вес и фото.
 */
function state150(): AppData {
  let d = freshData('2026-11-14', '2026-11-16', true);
  const spb = Object.values(d.trips).find((t) => t.city === 'Санкт-Петербург')!;
  const { trainNextDay: _x, ...old } = spb;
  d = applyOps(d, [{ store: 'trips', put: { ...old, from: '2026-11-24', to: '2026-11-25' } }]);
  d = applyOps(d, replanOps(d, d.settings.plan!, '2026-11-14').ops);
  const st = (taskId: string, date: string, kind: string) => ({ store: 'taskStatus', put: { taskId, date, kind, status: 'done', updatedAt: NOW } });
  d = applyOps(d, [
    st(`shop:${ID('m1')}`, '2026-11-15', 'shop'),
    st('cook:cook-p20261116-cook-01', '2026-11-15', 'cook'),
    ...['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'].flatMap((date) => ['breakfast', 'lunch', 'snack', 'dinner'].map((s) => st(`meal:${date}:${s}`, date, 'meal'))),
    { store: 'shoppingChecks', put: { id: `${ID('m1')}:chicken`, eventId: ID('m1'), itemId: 'chicken', bought: true, updatedAt: NOW } },
    { store: 'trainingLogs', put: { id: 'train:2026-11-16', date: '2026-11-16', templateId: 'strength_a', status: 'done', updatedAt: NOW } },
    { store: 'trainingLogs', put: { id: 'train:2026-11-17', date: '2026-11-17', templateId: 'stepper', status: 'done', updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-16', kg: 106.1, createdAt: NOW, updatedAt: NOW } },
    { store: 'photos', put: { id: 'ph1', date: '2026-11-16', createdAt: NOW } },
    { store: 'meta', put: { ...d.meta!, dataVersion: 7 } },
  ] as any);
  return d;
}

/** Каждая будущая потребность покрыта закупками не позже её даты (с учётом уже купленного). */
function uncovered(d: AppData, today: string): string[] {
  const inst = d.settings.plan!.instanceId;
  const cooks = Object.values(d.cookingEvents).filter((e) => e.instanceId === inst);
  const needs = collectNeeds(currentInstanceDays(d), cooks, Object.values(d.trips)).sort((a, b) => a.use.localeCompare(b.use));
  const shops = Object.values(d.shoppingEvents).filter((e) => e.instanceId === inst && e.kind !== 'trip');
  const out: string[] = [];
  const cum = new Map<string, number>();
  for (const n of needs) {
    cum.set(n.productId, (cum.get(n.productId) ?? 0) + n.qty);
    if (n.use < today) continue;
    const bought = shops.filter((e) => e.date <= n.date).reduce((s, e) => s + (e.lines ?? []).filter((l) => l.productId === n.productId).reduce((x, l) => x + l.buy, 0), 0);
    if (bought + 1 < cum.get(n.productId)!) out.push(`${n.productId} ${n.label}: куплено ${Math.round(bought)}, нужно ${Math.round(cum.get(n.productId)!)}`);
  }
  return out;
}

test('пересчёт с сегодняшнего дня без изменений ничего не меняет (в любой день цикла)', () => {
  const d = state150();
  for (const today of ['2026-11-16', '2026-11-20', '2026-11-23', '2026-11-27', '2026-12-01', '2026-12-07', '2026-12-13']) {
    const r = replanOps(d, d.settings.plan!, today, { keepPast: true });
    assert.equal(r.ops.length, 0, `${today}: ${J(r.changed)}`);
  }
});

test('перенос Санкт-Петербурга на 25–26.11 при запуске: только затронутые дни, готовка, закупки и тренировки', () => {
  const before = state150();
  assert.equal(uncovered(before, TODAY).length, 0);
  const ops = dataMigrationOps(before, TODAY, AT, '1.6.0');
  const d = applyOps(before, ops);
  // сначала резервная копия
  assert.equal(ops[0].store, 'backups');
  const bk = d.backups[d.settings.tripReportUnseen!];
  assert.ok(bk?.tripReport, 'отчёт ждёт показа');
  assert.equal(bk.stores.planDays.length, Object.keys(before.planDays).length);
  assert.equal(d.meta!.dataVersion, DATA_VERSION - 1, 'до 24.11 — версия 9');
  // командировки: Санкт-Петербург 25–26, Екатеринбург без изменений; старт, меню, релакс — прежние
  const spb = Object.values(d.trips).find((t) => t.city === 'Санкт-Петербург')!;
  assert.deepEqual([spb.from, spb.to, spb.trainNextDay, spb.hotelBreakfast], ['2026-11-25', '2026-11-26', true, true]);
  assert.equal(J(Object.values(d.trips).find((t) => t.city === 'Екатеринбург')), J(Object.values(before.trips).find((t) => t.city === 'Екатеринбург')));
  assert.equal(d.settings.plan!.startDate, '2026-11-16');
  assert.equal(d.settings.plan!.menuId, TEMPLATE.id);
  assert.equal(d.planDays['2026-11-29'].relax, true);
  // дни: меняются только 24 (дом), 25 («день 1 из 2»), 26 (командировка), 27–28 (порции из морозилки)
  const changedDays = Object.keys({ ...before.planDays, ...d.planDays }).filter((x) => J(before.planDays[x]) !== J(d.planDays[x])).sort();
  assert.deepEqual(changedDays, ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
  assert.ok(d.planDays['2026-11-24'].mealCards && !d.planDays['2026-11-24'].tripId, '24.11 — домашнее меню');
  for (const x of ['2026-11-25', '2026-11-26']) {
    const day = d.planDays[x];
    assert.equal(day.tripId, spb.id);
    assert.equal(day.mealCards, null);
    assert.match(day.note!, /Санкт-Петербург, день \d из 2/);
    assert.deepEqual([day.meals!.breakfast, day.meals!.lunch, day.meals!.dinner, day.meals!.snack], ['Завтрак в гостинице', 'Обед', 'Ужин', 'Перекус']);
  }
  // 24.11 обед и ужин и 27.11 — из партии 24.11; на 27–28 — из морозилки
  const cook = d.cookingEvents['cook-p20261116-cook-03'];
  assert.deepEqual([cook.date, cook.time], ['2026-11-24', '07:00']);
  const uses = cook.items!.flatMap((i) => i.uses.map((u) => `${u.date.slice(8)}${u.slot[0]}:${u.storage}`)).sort();
  assert.deepEqual(uses, ['24d:fridge', '24l:fridge', '27d:freeze', '27l:freeze', '28d:freeze', '28l:freeze']);
  assert.equal(cook.items!.reduce((s, i) => s + i.qty, 0), 6, 'порций столько же');
  for (const s of ['lunch', 'dinner'] as const) for (const x of ['2026-11-24', '2026-11-27']) assert.equal(d.planDays[x].mealCards![s].parts[0].cookEventId, cook.id, `${x} ${s}`);
  // прочие готовки не меняются, в командировку готовки нет
  const changedCooks = Object.keys({ ...before.cookingEvents, ...d.cookingEvents }).filter((x) => J(before.cookingEvents[x]) !== J(d.cookingEvents[x]));
  assert.deepEqual(changedCooks, [cook.id]);
  assert.ok(!Object.values(d.cookingEvents).some((e) => e.date === '2026-11-25' || e.date === '2026-11-26'));
  // закупки: прошедшие не меняются; 23.11 не нужна — всё к 24.11 покупается 21.11; перекусы — 25.11
  const changedShops = Object.keys({ ...before.shoppingEvents, ...d.shoppingEvents }).filter((x) => J(before.shoppingEvents[x]) !== J(d.shoppingEvents[x])).sort();
  assert.deepEqual(changedShops, [ID('m2'), ID('t1'), ID('t2'), 'shop-trip-trip-2026-11-24-spb']);
  assert.equal(d.shoppingEvents[ID('t2')], undefined);
  const t1 = d.shoppingEvents[ID('t1')];
  assert.equal(t1.date, '2026-11-21');
  for (const p of ['chicken', 'zucchini', 'pepper', 'curd']) assert.ok(t1.lines!.some((l) => l.productId === p && l.buy > 0), p);
  assert.equal(d.shoppingEvents['shop-trip-trip-2026-11-24-spb'].date, '2026-11-25');
  assert.deepEqual(uncovered(d, TODAY), [], 'еды на 24 и 27.11 и дальше хватает');
  // курица, оставшаяся с 15.11 в морозилке, — разморозить к готовке 24.11
  assert.ok(cook.thawProducts!.some((t) => t.productId === 'chicken'));
  assert.ok(!/командировк/.test(cook.timeNote ?? ''));
  // тренировки
  const plan: Record<string, string> = {
    '2026-11-18': 'Командировка (Екатеринбург): плановый отдых', '2026-11-21': 'Восстановление после командировки',
    '2026-11-23': 'Силовая Б', '2026-11-24': 'Степпер', '2026-11-25': 'Командировка (Санкт-Петербург): плановый отдых',
    '2026-11-26': 'Командировка (Санкт-Петербург): плановый отдых', '2026-11-27': 'Силовая А по самочувствию',
    '2026-11-28': 'Степпер 15–20 минут или прогулка', '2026-11-29': 'Релакс-день, отдых', '2026-11-30': 'Силовая Б',
  };
  for (const [x, label] of Object.entries(plan)) assert.equal(scheduledTraining(d, x)!.label, label, x);
  for (const x of ['2026-11-25', '2026-11-26']) {
    const tasks = tasksForDate(d, x);
    assert.ok(tasks.find((k) => k.kind === 'training')!.optional, `${x}: тренировка не обязательна`);
    assert.ok(!tasks.some((k) => k.kind === 'cooking' || k.kind === 'containers'), `${x}: без готовки`);
  }
  // записи пользователя не тронуты
  for (const s of ['taskStatus', 'trainingLogs', 'weights', 'photos', 'shoppingChecks', 'templateVersions'] as const) assert.equal(J(d[s]), J(before[s]), s);
  // отчёт
  const r = bk.tripReport!;
  assert.deepEqual(r.days.map((x) => x.date), ['2026-11-24', '2026-11-26', '2026-11-27', '2026-11-28']);
  assert.deepEqual(r.trainings.map((x) => x.date), ['2026-11-24', '2026-11-26']);
  assert.match(r.cooks[0].text, /с 26\.11 07:00 на 24\.11 07:00/);
  assert.ok(r.shops.some((x) => /23\.11/.test(x.title) && /не нужна/.test(x.text)));
  assert.deepEqual(r.confirmed, []);
  // повторно не применяется
  assert.equal(dataMigrationOps(d, TODAY, AT).length, 0);
});

test('перенос задевает уже отмеченное — ждёт подтверждения; после подтверждения отметки сохраняются', () => {
  let before = state150();
  // уже купил творог из докупки 21.11 заранее
  before = applyOps(before, [{ store: 'shoppingChecks', put: { id: `${ID('t1')}:curd`, eventId: ID('t1'), itemId: 'curd', bought: true, updatedAt: NOW } }]);
  const d = applyOps(before, dataMigrationOps(before, TODAY, AT, '1.6.0'));
  assert.equal(Object.values(d.trips).find((t) => t.city === 'Санкт-Петербург')!.from, '2026-11-24', 'без подтверждения не меняется');
  assert.ok(d.settings.tripMovePending);
  assert.equal(J(d.planDays), J(before.planDays));
  const trip = d.trips[d.settings.tripMovePending!.tripId];
  const mv = planTripMove(d, trip, d.settings.tripMovePending!, TODAY, AT);
  assert.ok(mv.conflicts.some((c) => /21\.11/.test(c)));
  const done = applyOps(d, applyTripMoveOps(d, mv, AT, '1.6.0', mv.conflicts).ops);
  assert.equal(Object.values(done.trips).find((t) => t.city === 'Санкт-Петербург')!.from, '2026-11-25');
  assert.equal(done.settings.tripMovePending, null);
  assert.ok(done.shoppingChecks[`${ID('t1')}:curd`].bought);
  assert.deepEqual(done.backups[done.settings.tripReportUnseen!].tripReport!.confirmed, mv.conflicts);
});

test('миграция не трогает командировку, если даты уже поменяли вручную или поездка прошла', () => {
  const d = state150();
  const moved = freshData('2026-11-14', '2026-11-16', true);
  assert.equal(planV8Ops(moved, TODAY, AT).length, 0, 'уже 25–26.11');
  assert.equal(planV8Ops(d, '2026-11-27', AT).length, 0, 'поездка прошла');
  assert.ok(planV8Ops(d, TODAY, AT).length > 0);
  assert.equal(SPB_MOVE.after.to, '2026-11-26');
});

test('изменение командировки в середине цикла не переписывает прошедшие закупки', () => {
  const d = state150();
  const trip = { id: 'trip-x', city: 'Казань', from: '2026-12-01', to: '2026-12-02', hotelBreakfast: false, fridge: true, canTrain: false, comment: null, createdAt: NOW, updatedAt: NOW };
  const diff = previewChange(d, tripOps(trip, null), TODAY, ['2026-12-01', '2026-12-02']);
  const after = diff.after;
  for (const id of Object.keys(d.shoppingEvents)) if (d.shoppingEvents[id].date < TODAY) assert.equal(J(after.shoppingEvents[id]), J(d.shoppingEvents[id]), id);
  for (const id of Object.keys(d.cookingEvents)) if (d.cookingEvents[id].date < TODAY) assert.equal(J(after.cookingEvents[id]), J(d.cookingEvents[id]), id);
  for (const x of Object.keys(d.planDays)) if (x < TODAY) assert.equal(J(after.planDays[x]), J(d.planDays[x]), x);
  assert.equal(after.planDays['2026-12-01'].tripId, 'trip-x');
  assert.deepEqual(uncovered(after, TODAY), []);
});
