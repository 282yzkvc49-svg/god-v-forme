import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, freshData, NOW } from './helpers';
import {
  BUDGET_RUB, buildInstance, collectNeeds, makePlanSettings, portionsLeft, positionOf, replanOps, templateDayAt,
} from '../src/domain/plan';
import { checkEquipment, checkInstance, checkShift } from '../src/domain/planCheck';
import { scheduledTraining, tasksForDate, thawList } from '../src/domain/tasks';
import { applyOps, dataMigrationOps, DATA_VERSION, emptyData, seedOps } from '../src/state/model';
import { seedTemplateVersions } from '../src/lib/seed';
import { addDays, diffDays, isoWeekday } from '../src/lib/dates';
import { DISHES } from '../src/domain/catalog';
import type { AppData } from '../src/state/types';

const cfg = (start: string, relax = 28) => makePlanSettings(start, relax, NOW);

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

test('дата старта: план, готовка, закупки и релакс-день переносятся по номеру дня', () => {
  for (const start of ['2026-12-07', '2026-12-09', '2027-01-15', '2027-03-28']) {
    const c = cfg(start);
    const inst = buildInstance(c, null);
    for (const r of checkInstance(inst)) assert.ok(r.ok, `${start}: ${r.title}: ${r.details.join('; ')}`);
    assert.equal(inst.planDays[0].date, start);
    assert.equal(inst.planDays[29].date, addDays(start, 29));
    assert.equal(inst.planDays.find((d) => d.relax)!.date, addDays(start, 27), 'релакс — 28-й день');
    assert.equal(inst.cookingEvents[0].date, addDays(start, -1));
    assert.equal(inst.shoppingEvents[0].date, addDays(start, -1));
    for (const e of inst.cookingEvents) {
      // утренняя готовка в будни не планируется: переносится на вечер накануне
      if (e.time === '10:00') assert.ok(isoWeekday(e.date) >= 6, `${start}: готовка ${e.date} 10:00 в будний день`);
    }
  }
  assert.equal(checkShift(cfg('2026-11-02')).ok, true);
});

test('релакс-день можно выбрать другой: один в месяц, меню сдвигается без потери порций', () => {
  const inst = buildInstance(cfg('2026-11-02', 10), null);
  assert.equal(inst.planDays.filter((d) => d.relax).length, 1);
  assert.equal(inst.planDays[9].relax, true);
  assert.equal(inst.planDays[27].relax, false, 'бывший релакс-день теперь с меню');
  for (const r of checkInstance(inst)) assert.ok(r.ok, `${r.title}: ${r.details.join('; ')}`);
  assert.equal(positionOf(27, 10), 28);
  assert.equal(templateDayAt(28, 10), 27);
  assert.equal(templateDayAt(10, 10), null);
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
    ['strength_a', 'stepper', 'strength_b', 'recovery', 'strength_a', 'stepper', 'recovery', 'strength_b']);
  assert.equal(at('2027-06-07'), diffDays('2027-06-07', '2026-11-02') / 7 * 3 % 2 === 0 ? 'strength_a' : 'strength_b');
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

test('миграция v4: план с граммовками на те же даты, отметки и галочки сохраняются, без дублей', () => {
  const d = v1State();
  const ops = dataMigrationOps(d, '2026-11-04', NOW);
  const d2 = applyOps(d, ops);
  assert.equal(d2.meta!.dataVersion, DATA_VERSION);
  assert.equal(d2.settings.plan!.startDate, '2026-11-02');
  assert.equal(d2.settings.plan!.confirmed, false, 'пользователю показывается подтверждение даты');
  assert.equal(d2.settings.training.startDate, '2026-11-02');
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
