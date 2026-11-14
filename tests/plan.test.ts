import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, freshData, NOW } from './helpers';
import {
  BUDGET_RUB, buildInstance, collectNeeds, makePlanSettings, portionsLeft, replanOps,
} from '../src/domain/plan';
import { relaxDatesBetween } from '../src/domain/trips';
import { previewChange, tripOps } from '../src/domain/planDiff';
import { checkEquipment, checkInstance, checkShift } from '../src/domain/planCheck';
import { scheduledTraining, tasksForDate, thawList } from '../src/domain/tasks';
import { applyOps, dataMigrationOps, DATA_VERSION, emptyData, seedOps } from '../src/state/model';
import { seedTemplateVersions } from '../src/lib/seed';
import { addDays, diffDays, isoWeekday } from '../src/lib/dates';
import { DISHES } from '../src/domain/catalog';
import type { AppData } from '../src/state/types';

const cfg = (start: string) => makePlanSettings(start, NOW);

test('план 02.11: все проверки согласованности проходят, бюджет в пределах 30 000 ₽', () => {
  const inst = buildInstance(cfg('2026-11-02'), null);
  for (const c of checkInstance(inst)) assert.ok(c.ok, `${c.title}: ${c.details.join('; ')}`);
  assert.equal(inst.cookingEvents.length, 16);
  assert.ok(inst.totalCost <= BUDGET_RUB, `сумма ${Math.round(inst.totalCost)}`);
  assert.equal(inst.shoppingEvents.filter((e) => e.kind === 'main').length, 2);
  assert.equal(inst.shoppingEvents[0].date, '2026-11-01', 'первая закупка — накануне старта');
  assert.equal(inst.cookingEvents[0].date, '2026-11-01', 'первая готовка — накануне старта');
});

test('порции: число приготовленных порций = числу запланированных приёмов, ничего лишнего', () => {
  const inst = buildInstance(cfg('2026-11-02'), null);
  const planned = new Map<string, number>();
  for (const d of inst.planDays) for (const card of Object.values(d.mealCards ?? {})) for (const p of card.parts) {
    if (!p.fresh) planned.set(p.dishId, (planned.get(p.dishId) ?? 0) + p.qty);
  }
  const cooked = new Map<string, number>();
  for (const e of inst.cookingEvents) for (const it of e.items ?? []) {
    if (DISHES[it.dishId].unit === 'portion') cooked.set(it.dishId, (cooked.get(it.dishId) ?? 0) + it.qty);
    for (const u of it.uses) assert.ok(u.date >= e.date, `${it.dishId}: ${u.date} до готовки ${e.date}`);
  }
  for (const [dish, n] of cooked) assert.equal(n, planned.get(dish), dish);
  // исправленные расхождения прежней версии
  const ter = inst.cookingEvents.find((e) => e.blockId === 'd7')!.items!.find((i) => i.dishId === 'chicken_teriyaki')!;
  assert.equal(ter.qty, 4);
  assert.deepEqual(ter.uses.map((u) => `${u.date}:${u.slot}`), ['2026-11-08:lunch', '2026-11-08:dinner', '2026-11-09:lunch', '2026-11-10:dinner']);
  assert.equal(inst.cookingEvents.find((e) => e.blockId === 'd7')!.time, '10:00', 'терияки к обеду 08.11 — готовка утром');
  const chili = inst.cookingEvents.find((e) => e.blockId === 'd0')!.items!.find((i) => i.dishId === 'turkey_chili')!;
  assert.equal(chili.qty, 3);
});

test('хранение: дольше 3 дней — в морозилку с разморозкой накануне', () => {
  const inst = buildInstance(cfg('2026-11-02'), null);
  const cut = inst.cookingEvents.find((e) => e.blockId === 'd7')!.items!.find((i) => i.dishId === 'chicken_cutlets')!;
  assert.deepEqual(cut.uses.map((u) => u.storage), ['fridge', 'freeze', 'freeze']);
  assert.equal(cut.uses[1].thawOn, addDays(cut.uses[1].date, -1));
});

test('закупки: потребности покрыты, скоропортящееся — докупкой, ничего не покупается после нужной даты', () => {
  const inst = buildInstance(cfg('2026-11-02'), null);
  const needs = collectNeeds(inst.planDays, inst.cookingEvents);
  const total = new Map<string, number>();
  for (const n of needs) total.set(n.productId, (total.get(n.productId) ?? 0) + n.qty);
  const bought = new Map<string, number>();
  for (const e of inst.shoppingEvents) for (const l of e.lines!) {
    bought.set(l.productId, (bought.get(l.productId) ?? 0) + l.buy);
    assert.ok(l.buy >= 0 && l.leftover >= 0 && l.need >= 0);
    for (const n of l.needs) assert.ok(n.date >= e.date);
  }
  for (const [pid, q] of total) assert.ok((bought.get(pid) ?? 0) + 1e-6 >= q, pid);
  assert.ok(inst.shoppingEvents.some((e) => e.kind === 'topup'), 'есть небольшие докупки свежего');
  const m1 = inst.shoppingEvents[0];
  const chicken = m1.lines!.find((l) => l.productId === 'chicken_breast')!;
  assert.ok(chicken.freezeNow > 0 && chicken.notes.some((n) => /заморозить/.test(n)), 'курица к готовке 08.11 — заморозить в день покупки');
});

test('дата старта: меню, готовка и закупки переносятся; релакс-день — календарный (последнее воскресенье)', () => {
  for (const start of ['2026-12-07', '2026-12-09', '2027-01-15', '2027-03-28']) {
    const c = cfg(start);
    const inst = buildInstance(c, null);
    for (const r of checkInstance(inst)) assert.ok(r.ok, `${start}: ${r.title}: ${r.details.join('; ')}`);
    assert.equal(inst.planDays[0].date, start);
    assert.equal(inst.planDays[29].date, addDays(start, 29));
    const relax = inst.planDays.filter((d) => d.relax).map((d) => d.date);
    assert.deepEqual(relax, relaxDatesBetween({ relaxOverrides: {} }, start, addDays(start, 29)), 'релакс — последнее воскресенье месяца');
    for (const r of relax) assert.equal(isoWeekday(r), 7);
    if (!relax.includes(addDays(start, -1))) assert.equal(inst.cookingEvents[0].date, addDays(start, -1));
    assert.equal(inst.shoppingEvents[0].date, inst.cookingEvents[0].date);
    for (const e of inst.cookingEvents) {
      // утренняя готовка в будни не планируется: переносится на вечер накануне
      if (e.time === '10:00') assert.ok(isoWeekday(e.date) >= 6, `${start}: готовка ${e.date} 10:00 в будний день`);
      assert.ok(!relax.includes(e.date), `${start}: готовка в релакс-день ${e.date}`);
    }
  }
  assert.equal(checkShift(cfg('2026-11-02'), { trips: [], relaxOverrides: {}, today: null }).ok, true);
});

test('релакс-день можно выбрать другой: один в месяц, меню идёт дальше без потери порций', () => {
  const inst = buildInstance(cfg('2026-11-02'), { trips: [], relaxOverrides: { '2026-11': '2026-11-21' }, today: null });
  assert.equal(inst.planDays.filter((d) => d.relax).length, 1);
  assert.equal(inst.planDays.find((d) => d.date === '2026-11-21')!.relax, true);
  assert.equal(inst.planDays.find((d) => d.date === '2026-11-29')!.relax, false, 'последнее воскресенье теперь с меню');
  for (const r of checkInstance(inst)) assert.ok(r.ok, `${r.title}: ${r.details.join('; ')}`);
  assert.ok(!inst.cookingEvents.some((e) => e.date === '2026-11-21'), 'в релакс-день не готовим');
});

test('старт сегодня: первая закупка и готовка — сегодня до обеда', () => {
  const inst = buildInstance(cfg('2026-11-04'), '2026-11-04');
  assert.equal(inst.cookingEvents[0].date, '2026-11-04');
  assert.match(inst.cookingEvents[0].timeNote ?? '', /сегодня/);
  assert.equal(inst.shoppingEvents[0].date, '2026-11-04');
});

test('остаток порций уменьшается при отметке приёма пищи, история не удаляется', () => {
  let d = freshData();
  const e = Object.values(d.cookingEvents).find((x) => x.blockId === 'd0')!;
  const it = e.items!.find((i) => i.dishId === 'chicken_lemon_paprika')!;
  assert.equal(portionsLeft(d, e, it).left, 3);
  d = apply(d, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-02:lunch', date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } }]);
  assert.deepEqual(portionsLeft(d, e, it), { total: 3, eaten: 1, left: 2 });
  assert.equal(it.uses.length, 3);
});

test('смена даты старта не удаляет и не переносит отметки, вес, фото и тренировки', () => {
  let d = freshData('2026-10-25');
  d = apply(d, [
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-03:lunch', date: '2026-11-03', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'cook:cook-p20261102-d0', date: '2026-11-01', kind: 'cooking', status: 'done', updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } },
    { store: 'photos', put: { id: 'ph1', date: '2026-11-02', pose: 'front', width: 1, height: 1, bytes: 1, type: 'image/jpeg', createdAt: NOW } },
    { store: 'trainingLogs', put: { id: 'train:2026-11-02', plannedDate: '2026-11-02', date: '2026-11-02', templateId: 'strength_a', templateVersionId: 'strength_a@seed', status: 'done', exercises: [], updatedAt: NOW } },
  ]);
  const before = JSON.stringify([d.taskStatus, d.weights, d.photos, d.trainingLogs]);
  const res = replanOps(d, cfg('2026-11-16'), '2026-11-10');
  const d2 = applyOps(d, res.ops);
  assert.equal(JSON.stringify([d2.taskStatus, d2.weights, d2.photos, d2.trainingLogs]), before);
  assert.ok(!res.ops.some((o) => ['taskStatus', 'weights', 'photos', 'trainingLogs', 'photoBlobs'].includes(o.store)));
  assert.equal(d2.planDays['2026-11-03'].templateDay, 2, 'прошедший день с отметкой — история прежнего плана');
  assert.equal(d2.planDays['2026-11-16'].dayNumber, 1);
  assert.equal(d2.planDays['2026-11-12'], undefined, 'будущие дни прежнего плана без отметок убраны');
  assert.ok(d2.cookingEvents['cook-p20261102-d0'], 'прошедшая готовка осталась в истории');
  assert.equal(d2.settings.plan!.startDate, '2026-11-16');
  assert.equal(tasksForDate(d2, '2026-11-02').find((t) => t.kind === 'training')!.templateId, 'strength_a', 'тренировки не зависят от плана питания');
});

test('расписание тренировок своё: пн/ср/пт силовые А/Б по очереди, вт/сб степпер', () => {
  const d = freshData();
  const at = (date: string) => scheduledTraining(d, date)!.templateId;
  assert.deepEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map(at),
    ['strength_a', 'stepper', 'strength_b', 'recovery', 'strength_a', 'stepper', 'rest', 'strength_b']);
  const relaxStrength = relaxDatesBetween(d.settings, '2026-11-02', '2027-06-06').filter((x) => [1, 3, 5].includes(isoWeekday(x))).length;
  assert.equal(at('2027-06-07'), (diffDays('2027-06-07', '2026-11-02') / 7 * 3 - relaxStrength) % 2 === 0 ? 'strength_a' : 'strength_b');
  const d2 = applyOps(d, replanOps(d, cfg('2026-11-20'), '2026-11-01').ops);
  assert.equal(scheduledTraining(d2, '2026-11-04')!.templateId, 'strength_b', 'смена старта питания не сдвигает тренировки');
});

test('разморозка: накануне готовки рыбы и замороженных порций — задача вечером', () => {
  const d = freshData();
  const list = thawList(d, '2026-11-10'); // 11.11 вечером готовка форели — достать 10.11
  assert.ok(list.some((x) => /форели/i.test(x)), list.join('; '));
  const list2 = thawList(d, '2026-11-11'); // 12.11 обед — котлеты из морозилки
  assert.ok(list2.some((x) => /котлеты/i.test(x)), list2.join('; '));
  assert.ok(tasksForDate(d, '2026-11-10').some((t) => t.kind === 'thaw'));
});

test('оборудование шаблонов: только 12 и 16 кг', () => {
  assert.equal(checkEquipment(seedTemplateVersions(NOW).map((v) => v.template)).ok, true);
  const bad = seedTemplateVersions(NOW).map((v) => v.template);
  bad[0] = { ...bad[0], items: [{ ...bad[0].items[1], kettlebellKg: 14 }] };
  assert.equal(checkEquipment(bad).ok, false);
});

function v1State(): AppData {
  // данные первой версии: стартовый план 02.11 без граммовок, отметки и галочки
  let d = applyOps(emptyData(), seedOps(NOW, '2026-10-30'));
  const { plan: _p, training: _t, ...oldSettings } = d.settings as any;
  d = applyOps(d, [
    { store: 'settings', put: { ...oldSettings, onboarded: true } },
    { store: 'meta', put: { ...d.meta!, dataVersion: 3 } },
    { store: 'planDays', put: { date: '2026-11-02', source: 'seed', dayNumber: 1, relax: false, meals: { breakfast: 'Овсянка', lunch: 'Курица', snack: 'Йогурт', dinner: 'Чили' }, training: { templateId: 'strength_a', label: 'Силовая А' } } },
    { store: 'planDays', put: { date: '2026-11-29', source: 'seed', dayNumber: 28, relax: true, meals: null, training: null } },
    { store: 'cookingEvents', put: { id: 'cook-2026-11-01', date: '2026-11-01', eventType: 'meal_prep', title: 'Готовка', sourceText: '', forDaysText: '', forDates: [], storage: '', dishes: [], source: 'seed' } },
    { store: 'cookingEvents', put: { id: 'cook-2026-11-29', date: '2026-11-29', eventType: 'relax_day', title: 'Релакс', sourceText: '', forDaysText: '', forDates: [], storage: '', dishes: [], source: 'seed' } },
    { store: 'shoppingEvents', put: { id: 'shop-2026-11-01', date: '2026-11-01', title: 'Закупка', items: [], source: 'seed' } },
    { store: 'shoppingEvents', put: { id: 'shop-2026-11-16', date: '2026-11-16', title: 'Закупка 2', items: [], source: 'seed' } },
    { store: 'taskStatus', put: { taskId: 'cook:cook-2026-11-01', date: '2026-11-01', kind: 'cooking', status: 'done', updatedAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'shop:shop-2026-11-01', date: '2026-11-01', kind: 'shopping', status: 'done', updatedAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-02:lunch', date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'shoppingChecks', put: { id: 'shop-2026-11-01:p01', eventId: 'shop-2026-11-01', itemId: 'p01', bought: true, actualPrice: 800, updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } },
  ]);
  return d;
}

test('миграция v3 → v5: граммовки, затем старт 16.11 с командировками; отметки и галочки сохраняются, без дублей', () => {
  const d = v1State();
  const ops = dataMigrationOps(d, '2026-11-04', NOW);
  const d2 = applyOps(d, ops);
  assert.equal(d2.meta!.dataVersion, DATA_VERSION);
  assert.equal(d2.settings.plan!.startDate, '2026-11-16');
  assert.equal(d2.settings.plan!.confirmed, false, 'пользователю показывается подтверждение даты');
  assert.equal(d2.settings.training.startDate, '2026-11-16');
  assert.equal(Object.keys(d2.trips).length, 2);
  assert.ok(d2.planDays['2026-11-02'].mealCards, 'у дня появились карточки с граммовками');
  assert.equal(d2.planDays['2026-11-02'].training, null, 'тренировки — по своему расписанию');
  assert.equal(d2.taskStatus['meal:2026-11-02:lunch'].status, 'done');
  assert.equal(d2.taskStatus['cook:cook-p20261102-d0'].status, 'done', 'отметка готовки перенесена');
  assert.equal(d2.taskStatus['shop:shop-p20261102-m1'].status, 'done', 'отметка закупки перенесена');
  assert.equal(d2.shoppingChecks['shop-p20261102-m1:chicken_breast'].bought, true, 'галочка «куплено» перенесена');
  assert.equal(d2.weights.w1.kg, 106.4);
  assert.equal(d2.cookingEvents['cook-2026-11-01'], undefined, 'старые события заменены, без дублей');
  assert.equal(d2.shoppingEvents['shop-2026-11-16'], undefined);
  assert.equal(Object.values(d2.cookingEvents).filter((e) => e.date === '2026-11-01').length, 1);
  assert.equal(dataMigrationOps(d2, '2026-11-04', NOW).length, 0, 'повторная миграция ничего не меняет');
  assert.ok(checkInstance(buildInstance(d2.settings.plan!, null)).every((c) => c.ok));
});

test('свежая установка: план появляется только после выбора даты старта', () => {
  const d = freshData('2026-11-04', null);
  assert.equal(Object.keys(d.planDays).length, 0);
  assert.equal(d.settings.plan, null);
  const d2 = applyOps(d, replanOps(d, cfg('2026-11-05'), '2026-11-04').ops);
  assert.equal(Object.keys(d2.planDays).length, 30);
  assert.equal(d2.settings.plan!.startDate, '2026-11-05');
});


// ------------------------------------------------------------------ ноябрь 2026: старт 16.11 и командировки

function v4State(): AppData {
  // установленное приложение версии 1.1: план со стартом 02.11, отметки до 14.11
  let d = freshData('2026-10-30', '2026-11-02');
  d = applyOps(d, [
    { store: 'meta', put: { ...d.meta!, dataVersion: 4 } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-03:breakfast', date: '2026-11-03', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'trainingLogs', put: { id: 'train:2026-11-04', plannedDate: '2026-11-04', date: '2026-11-04', templateId: 'strength_b', templateVersionId: 'strength_b@seed', status: 'done', exercises: [], updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-09', kg: 106.1, createdAt: NOW } },
    { store: 'photos', put: { id: 'ph1', date: '2026-11-09', pose: 'front', width: 1, height: 1, bytes: 1, type: 'image/jpeg', createdAt: NOW } },
    { store: 'customTasks', put: { id: 'c26', date: '2026-11-26', title: 'Командировка в СПб', kind: 'custom', createdAt: NOW } },
    { store: 'customTasks', put: { id: 'c27', date: '2026-11-27', title: 'Позвонить маме', kind: 'custom', createdAt: NOW } },
  ]);
  return d;
}

test('ноябрь 2026: 12 пунктов проверки после обновления', () => {
  const before = v4State();
  const d = applyOps(before, dataMigrationOps(before, '2026-11-14', NOW));
  const day = (x: string) => d.planDays[x];
  const tasks = (x: string) => tasksForDate(d, x);
  // 1. старт 16.11, первый цикл 16.11–15.12
  assert.equal(d.settings.plan!.startDate, '2026-11-16');
  assert.equal(d.settings.training.startDate, '2026-11-16');
  assert.equal(day('2026-11-16').dayNumber, 1);
  assert.equal(day('2026-12-15').dayNumber, 30);
  assert.equal(day('2026-12-16'), undefined);
  // 2–3. командировки строго на 18–20.11 и 24–25.11, на 26.11 — ничего командировочного
  const trip = (x: string) => day(x)?.tripId ? d.trips[day(x)!.tripId!].city : null;
  assert.deepEqual(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].map(trip), [null, 'Екатеринбург', 'Екатеринбург', 'Екатеринбург', null]);
  assert.deepEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].map(trip), [null, 'Санкт-Петербург', 'Санкт-Петербург', null]);
  assert.equal(d.customTasks.c26, undefined, 'старое событие командировки на 26.11 убрано');
  assert.ok(d.customTasks.c27, 'другие задачи на эти дни не тронуты');
  assert.ok(!tasks('2026-11-26').some((t) => t.tripId), '26.11 — не командировка');
  // 4. завтраки в гостинице
  for (const t of Object.values(d.trips)) assert.equal(t.hotelBreakfast, true);
  assert.equal(day('2026-11-19').meals!.breakfast, 'Завтрак в гостинице');
  // 5. в командировках нет обязательных тренировок; календарь 16–30.11 как задан
  for (const x of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25']) {
    const t = tasks(x).find((k) => k.kind === 'training')!;
    assert.ok(t.optional && t.tripId, `${x}: плановый отдых`);
  }
  const plan: Record<string, string> = {
    '2026-11-16': 'Силовая А', '2026-11-17': 'Степпер', '2026-11-21': 'Восстановление после командировки', '2026-11-22': 'Отдых',
    '2026-11-23': 'Силовая Б', '2026-11-26': 'Восстановление после командировки', '2026-11-27': 'Силовая А по самочувствию',
    '2026-11-28': 'Степпер 15–20 минут или прогулка', '2026-11-29': 'Релакс-день, отдых', '2026-11-30': 'Силовая Б',
  };
  for (const [x, label] of Object.entries(plan)) assert.equal(scheduledTraining(d, x)!.label, label, x);
  for (const x of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25']) assert.match(scheduledTraining(d, x)!.label, /Командировка/);
  assert.equal(scheduledTraining(d, '2026-12-02')!.templateId, 'strength_a', 'дальше — обычная схема А/Б');
  // 6. на командировочные дни не расходуются домашние порции, нет готовки и домашних закупок
  for (const e of Object.values(d.cookingEvents)) {
    if (e.instanceId !== d.settings.plan!.instanceId) continue;
    assert.ok(!['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25', '2026-11-29'].includes(e.date), `готовка ${e.date}`);
    for (const it of e.items ?? []) for (const u of it.uses) assert.ok(!day(u.date)?.tripId, `${it.dishId}: порция на ${u.date}`);
  }
  for (const x of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25']) assert.equal(day(x).mealCards, null);
  // 15.11 — подготовка к первому этапу; 22.11 и раньше — готовка к 23.11; 29.11 — без готовки
  const cooks = Object.values(d.cookingEvents).filter((e) => e.instanceId === d.settings.plan!.instanceId);
  assert.ok(cooks.some((e) => e.date === '2026-11-15'), 'готовка 15.11');
  assert.ok(cooks.some((e) => e.date >= '2026-11-21' && e.date <= '2026-11-22' && e.items!.some((i) => i.uses.some((u) => u.date === '2026-11-23'))), 'блюда к 23.11 готовятся 21–22.11');
  // 7. порции соответствуют расписанию
  const inst = buildInstance(d.settings.plan!, { trips: Object.values(d.trips), relaxOverrides: d.settings.relaxOverrides, today: '2026-11-14' });
  for (const c of checkInstance(inst)) assert.ok(c.ok, `${c.title}: ${c.details.join('; ')}`);
  // готовая еда не ждёт в холодильнике всю поездку
  for (const e of cooks) for (const it of e.items ?? []) for (const u of it.uses) {
    if (u.date > '2026-11-20' && e.date < '2026-11-18' || u.date > '2026-11-25' && e.date < '2026-11-24') assert.equal(u.storage === 'pantry' ? 'freeze' : u.storage, 'freeze', `${it.dishId} ${u.date}`);
  }
  // 8. закупки по фактическому меню: нет домашних продуктов на дни командировок, перекусы — отдельно
  const needs = collectNeeds(inst.planDays, inst.cookingEvents, inst.ctx.trips);
  for (const n of needs) assert.ok(!inst.ctx.trips.some((t) => t.from <= n.date && n.date <= t.to), `${n.productId} нужен ${n.date}`);
  assert.equal(inst.shoppingEvents.filter((e) => e.kind === 'main').length, 2);
  assert.equal(inst.shoppingEvents.filter((e) => e.kind === 'trip').length, 2);
  assert.ok(inst.totalCost <= BUDGET_RUB, `домашние закупки ${Math.round(inst.totalCost)}`);
  for (const e of inst.shoppingEvents) for (const l of e.lines ?? []) {
    assert.ok(l.productId && l.needs.length && l.needs.every((n) => n.date >= e.date) && l.buy >= 0, `${e.id}: ${JSON.stringify(l)}`);
  }
  // 9. релакс-день 29.11 и при смене даты старта не уезжает на 13.12
  assert.equal(day('2026-11-29').relax, true);
  const moved = applyOps(d, replanOps(d, makePlanSettings('2026-11-18', NOW), '2026-11-14').ops);
  assert.equal(moved.planDays['2026-11-29'].relax, true);
  assert.notEqual(moved.planDays['2026-12-13']?.relax, true);
  for (const x of ['2026-11-18', '2026-11-24']) assert.ok(moved.planDays[x].tripId, 'командировки не сдвинулись');
  // 10. программа продолжается после 30 дней
  assert.ok(scheduledTraining(d, '2027-03-01'), 'тренировки на год вперёд');
  const next = buildInstance(makePlanSettings('2026-12-16', NOW), { trips: Object.values(d.trips), relaxOverrides: d.settings.relaxOverrides, today: null });
  for (const c of checkInstance(next)) assert.ok(c.ok, `следующий цикл: ${c.title}`);
  assert.ok(next.planDays.some((x) => x.date === '2026-12-27' && x.relax), 'релакс в декабре — последнее воскресенье');
  // 11. прежние данные сохранены
  assert.equal(d.taskStatus['meal:2026-11-03:breakfast'].status, 'done');
  assert.ok(d.planDays['2026-11-03']?.mealCards, 'прошедший день с отметкой — история');
  assert.ok(d.planDays['2026-11-10'], 'прошедшие дни прежнего плана не удаляются');
  assert.equal(d.trainingLogs['train:2026-11-04'].status, 'done');
  assert.equal(d.weights.w1.kg, 106.1);
  assert.ok(d.photos.ph1);
  assert.equal(dataMigrationOps(d, '2026-11-14', NOW).length, 0);
  // 12. даты — календарные строки без часовых поясов (переход через месяц и смену времени)
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2027-03-27', 2), '2027-03-29');
  assert.equal(diffDays('2026-12-15', '2026-11-16'), 29);
});

test('новая командировка: предпросмотр показывает изменения, конфликт с релакс-днём не удаляет задачи', () => {
  const before = v4State();
  const d = applyOps(before, dataMigrationOps(before, '2026-11-14', NOW));
  const trip = { id: 'trip-x', city: 'Казань', from: '2026-12-26', to: '2026-12-28', hotelBreakfast: false, fridge: true, canTrain: true, comment: null, createdAt: NOW, updatedAt: NOW };
  const diff = previewChange(d, tripOps(trip, null), '2026-11-14', ['2026-12-26', '2026-12-27', '2026-12-28']);
  assert.deepEqual(diff.conflicts.relax, ['2026-12-27'], 'релакс-день декабря попадает на поездку');
  assert.ok(diff.trainings.length > 0, 'видно, какие тренировки станут отдыхом');
  assert.equal(Object.keys(d.trips).length, 2, 'до подтверждения ничего не меняется');
  const after = applyOps(d, diff.ops);
  assert.equal(after.trips['trip-x'].city, 'Казань');
  assert.ok(Object.keys(after.taskStatus).length >= Object.keys(d.taskStatus).length, 'отметки не удалены');
  const inst = buildInstance(after.settings.plan!, { trips: Object.values(after.trips), relaxOverrides: after.settings.relaxOverrides, today: '2026-11-14' });
  for (const c of checkInstance(inst)) assert.ok(c.ok, `${c.title}: ${c.details.join('; ')}`);
  assert.equal(after.planDays['2026-12-26'].tripId, 'trip-x', 'командировка вне цикла тоже с командировочным меню');
});

test('свежая установка в ноябре 2026 (второе устройство): командировки, старт 16.11, релакс 29.11', () => {
  const d = freshData('2026-11-14', '2026-11-16', true);
  assert.deepEqual(Object.values(d.trips).map((t) => `${t.city} ${t.from}–${t.to}`).sort(), ['Екатеринбург 2026-11-18–2026-11-20', 'Санкт-Петербург 2026-11-24–2026-11-25']);
  assert.equal(d.settings.training.startDate, '2026-11-16');
  assert.equal(d.planDays['2026-11-19'].tripId, 'trip-2026-11-18-ekb');
  assert.equal(d.planDays['2026-11-29'].relax, true);
  assert.equal(scheduledTraining(d, '2026-11-16')!.label, 'Силовая А');
  // после командировок свежая установка их не добавляет
  const later = freshData('2026-12-20', '2026-12-21', true);
  assert.equal(Object.keys(later.trips).length, 0);
});
