import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, freshData, NOW } from './helpers';
import {
  BUDGET_RUB, buildInstance, buyByDate, collectNeeds, makePlanSettings, menuUpdatePending, portionsLeft, replanOps,
  type PlanContext,
} from '../src/domain/plan';
import { relaxDatesBetween } from '../src/domain/trips';
import { previewChange, tripOps } from '../src/domain/planDiff';
import { checkActiveData, checkEquipment, checkInstance, checkSeedPlan, checkShift, checkUserData } from '../src/domain/planCheck';
import { scheduledTraining, tasksForDate, thawList } from '../src/domain/tasks';
import { applyOps, dataMigrationOps, DATA_VERSION, emptyData, menuUpdateOps, NOV_2026_TRIPS, rollbackMenuOps, seedOps } from '../src/state/model';
import { alternativesFor, basketState, isBlocked, makeSub, orderProductIds, productCheckOps } from '../src/domain/avCheck';
import { SEED_RECIPES, seedTemplateVersions } from '../src/lib/seed';
import { addDays, diffDays, isoWeekday } from '../src/lib/dates';
import { DISHES, PRODUCTS, TEMPLATE, applyProductSubs, dishNutrition, ingredientLines } from '../src/domain/catalog';
import type { AppData } from '../src/state/types';

const cfg = (start: string) => makePlanSettings(start, NOW);
const TRIPS = NOV_2026_TRIPS.map((t) => ({ ...t, createdAt: NOW, updatedAt: NOW }));
const NOV: PlanContext = { trips: TRIPS, relaxOverrides: { '2026-11': '2026-11-29' }, today: '2026-11-14' };
const nov = () => buildInstance(cfg('2026-11-16'), NOV);
const okAll = (checks: { ok: boolean; title: string; details: string[] }[], tag = '') => {
  for (const c of checks) assert.ok(c.ok, `${tag}${c.title}: ${c.details.join('; ')}`);
};

// ------------------------------------------------------------------ комплект «Азбука вкуса» на 16.11–15.12

test('16.11 с командировками: все проверки плана и комплекта проходят, бюджет ≤ 50 000 ₽', () => {
  const inst = nov();
  okAll(checkInstance(inst));
  okAll(checkSeedPlan(inst));
  assert.equal(BUDGET_RUB, 50000);
  assert.ok(inst.totalCost <= BUDGET_RUB, `сумма ${Math.round(inst.totalCost)}`);
  assert.equal(inst.cookingEvents.length, 8);
});

test('календарь как в комплекте: 30 дней, 24 домашних, 5 командировочных, релакс 29.11; рецепты по ID', () => {
  const inst = nov();
  const cycle = inst.planDays.filter((d) => d.date >= '2026-11-16' && d.date <= '2026-12-15');
  assert.equal(cycle.length, 30);
  assert.equal(cycle.filter((d) => d.mealCards).length, 24);
  assert.equal(cycle.filter((d) => d.tripId).length, 5);
  assert.deepEqual(cycle.filter((d) => d.relax).map((d) => d.date), ['2026-11-29']);
  for (const c of TEMPLATE.source!.calendar) {
    const d = inst.planDays.find((x) => x.date === c.date)!;
    if (c.type !== 'home') continue;
    for (const s of ['breakfast', 'lunch', 'snack', 'dinner'] as const) assert.equal(d.mealCards![s].parts[0].dishId, c.meals![s], `${c.date} ${s}`);
  }
});

test('партии: 8 готовок с датами, порциями и назначениями комплекта; 48 обедов и ужинов без потерь и лишних порций', () => {
  const inst = nov();
  assert.deepEqual(inst.cookingEvents.map((e) => e.date), TEMPLATE.source!.cooking.map((c) => c.date));
  let n = 0;
  for (const sc of TEMPLATE.source!.cooking) {
    const ce = inst.cookingEvents.find((e) => e.blockId === sc.id)!;
    for (const si of sc.items) {
      const it = ce.items!.find((i) => i.dishId === si.dish)!;
      assert.equal(it.qty, si.servings);
      assert.equal(it.uses.length, si.servings);
      assert.deepEqual(it.uses.map((u) => [u.date, u.slot]), si.uses);
      n += it.qty;
    }
  }
  assert.equal(n, 48);
  // партия готова — отдельно от «съедено»; остаток не уходит в минус
  const e = inst.cookingEvents[0];
  const it = e.items!.find((i) => i.dishId === 'L01')!;
  let d = freshData('2026-11-14', '2026-11-16', true);
  const ce = Object.values(d.cookingEvents).find((x) => x.blockId === 'cook-01')!;
  assert.deepEqual(portionsLeft(d, ce, it), { total: 2, eaten: 0, left: 2 });
  for (const date of ['2026-11-16', '2026-11-17', '2026-11-18']) d = apply(d, [{ store: 'taskStatus', put: { taskId: `meal:${date}:lunch`, date, kind: 'meal', status: 'done', updatedAt: NOW } }]);
  assert.deepEqual(portionsLeft(d, ce, it), { total: 2, eaten: 2, left: 0 });
});

test('время готовки: накануне старта — вечером, в выходные — утром, в будни с обедом из партии — 07:00 с пояснением', () => {
  const inst = nov();
  const at = (date: string) => inst.cookingEvents.find((e) => e.date === date)!;
  assert.equal(at('2026-11-15').time, '17:00');
  assert.equal(at('2026-11-21').time, '10:00');
  assert.equal(at('2026-12-06').time, '10:00');
  for (const date of ['2026-11-26', '2026-11-30', '2026-12-03', '2026-12-09']) {
    assert.equal(at(date).time, '07:00', date);
    assert.match(at(date).timeNote ?? '', /Обед на сегодня — из этой партии/);
  }
  assert.match(at('2026-11-26').timeNote!, /накануне вы в командировке/);
  assert.match(at('2026-11-26').timeNote!, /минтай.*из замороженного/i, 'разморозить заранее некому');
  assert.match(at('2026-11-30').timeNote!, /релакс-день/);
  assert.match(at('2026-12-03').timeNote!, /накануне вечером/);
});

test('закупки: основные 15.11 и 29.11, докупки свежего 21.11, 23.11, 06.12, 12.12; ничего не покупается позже нужного', () => {
  const inst = nov();
  const home = inst.shoppingEvents.filter((e) => e.kind !== 'trip');
  assert.deepEqual(home.map((e) => `${e.kind} ${e.date}`), [
    'main 2026-11-15', 'topup 2026-11-21', 'topup 2026-11-23', 'main 2026-11-29', 'topup 2026-12-06', 'topup 2026-12-12',
  ]);
  // к утренней готовке в будни — накануне; после поездки — последний день дома до неё
  assert.equal(buyByDate(TRIPS, { date: '2026-11-26', time: '07:00' }), '2026-11-23');
  assert.equal(buyByDate(TRIPS, { date: '2026-11-30', time: '07:00' }), '2026-11-29');
  assert.equal(buyByDate(TRIPS, { date: '2026-11-21', time: '10:00' }), '2026-11-21');
  const needs = collectNeeds(inst.planDays, inst.cookingEvents, TRIPS);
  const total = new Map<string, number>();
  for (const n of needs) total.set(n.productId, (total.get(n.productId) ?? 0) + n.qty);
  const bought = new Map<string, number>();
  for (const e of home) for (const l of e.lines!) {
    bought.set(l.productId, (bought.get(l.productId) ?? 0) + l.buy);
    assert.ok(l.buy >= 0 && l.leftover >= 0 && l.need >= 0);
    for (const n of l.needs) {
      assert.ok(n.date >= e.date, `${l.productId}: нужен ${n.date}, закупка ${e.date}`);
      assert.ok(!TRIPS.some((t) => t.from <= e.date && e.date <= t.to), 'закупка не в командировке');
      const p = PRODUCTS[l.productId];
      if (p.storage === 'fridge' && !p.freezable && l.buy > 0 && l.fromStock === 0) assert.ok(diffDays(n.use!, e.date) <= p.shelf_days, `${p.name}: ${e.date} → ${n.use}`);
    }
    if (l.packs != null) assert.equal(l.buy, l.packs * PRODUCTS[l.productId].pack.size, 'основные закупки — упаковками av.ru');
  }
  for (const [pid, q] of total) assert.ok((bought.get(pid) ?? 0) + 1e-6 >= q, pid);
  // охлаждённое мясо на дальние готовки — заморозить в день покупки; хлеб — тоже
  const m2 = home.find((e) => e.date === '2026-11-29')!;
  assert.ok(m2.lines!.find((l) => l.productId === 'chicken')!.freezeNow > 0);
  assert.ok(home[0].lines!.find((l) => l.productId === 'bread')!.notes.some((x) => /заморозить/.test(x)));
  // докупка свежего — поштучно, а не упаковками
  const banana = home.find((e) => e.date === '2026-12-06')!.lines!.find((l) => l.productId === 'banana')!;
  assert.equal(banana.packs, null);
  // перекусы в командировки — отдельные списки вне домашнего бюджета
  assert.equal(inst.shoppingEvents.filter((e) => e.kind === 'trip').length, 2);
  assert.ok(inst.tripCost > 0);
});

test('хранение: рыба — в день готовки или на следующий, готовое — до 3 дней, дальше — морозилка; разморозка накануне', () => {
  const inst = nov();
  for (const e of inst.cookingEvents) for (const it of e.items!) for (const u of it.uses) {
    const gap = diffDays(u.date, e.date);
    if (u.storage === 'fridge') assert.ok(gap <= DISHES[it.dishId].storage.days, `${it.dishId} ${u.date}`);
  }
  // при старте 18.11 часть порций пережидает поездку — в морозилку
  const shifted = buildInstance(cfg('2026-11-18'), NOV);
  okAll(checkInstance(shifted));
  okAll(checkSeedPlan(shifted));
  assert.ok(shifted.cookingEvents.some((e) => e.items!.some((i) => i.uses.some((u) => u.storage === 'freeze'))));
  // 06.12: фарш и курица из морозилки — задача разморозить 05.12 вечером
  const d = freshData('2026-11-14', '2026-11-16', true);
  const list = thawList(d, '2026-12-05');
  assert.ok(list.some((x) => /Фарш из мякоти говядины/.test(x)), list.join('; '));
  assert.ok(tasksForDate(d, '2026-12-05').some((t) => t.kind === 'thaw'));
});

test('цикл без поездок: меню идёт по кругу целыми партиями, проверки проходят', () => {
  for (const start of ['2026-12-16', '2027-01-15', '2027-03-28']) {
    const inst = buildInstance(cfg(start), null);
    okAll(checkInstance(inst), `${start}: `);
    okAll(checkSeedPlan(inst), `${start}: `);
    assert.equal(inst.planDays[0].date, start);
    assert.equal(inst.planDays[29].date, addDays(start, 29));
    const relax = inst.planDays.filter((d) => d.relax).map((d) => d.date);
    assert.deepEqual(relax, relaxDatesBetween({ relaxOverrides: {} }, start, addDays(start, 29)), 'релакс — последнее воскресенье месяца');
    for (const r of relax) assert.equal(isoWeekday(r), 7);
    assert.equal(inst.planDays.filter((d) => d.mealCards).length, 30 - relax.length, 'в каждый домашний день — меню');
    assert.ok(inst.totalCost <= BUDGET_RUB, `${start}: ${Math.round(inst.totalCost)}`);
    for (const e of inst.cookingEvents) {
      assert.ok(!relax.includes(e.date), `${start}: готовка в релакс-день ${e.date}`);
      if (e.time === '07:00') assert.ok(isoWeekday(e.date) <= 5 && e.timeNote, `${start}: ${e.date}`);
    }
  }
  assert.equal(checkShift(cfg('2026-11-16'), NOV).ok, true);
});

test('релакс-день можно выбрать другой: один в месяц, меню идёт дальше без потери порций', () => {
  const inst = buildInstance(cfg('2026-11-16'), { ...NOV, relaxOverrides: { '2026-11': '2026-11-22' } });
  assert.equal(inst.planDays.find((d) => d.date === '2026-11-22')!.relax, true);
  assert.equal(inst.planDays.find((d) => d.date === '2026-11-29')!.relax, false, 'последнее воскресенье теперь с меню');
  okAll(checkInstance(inst));
  assert.ok(!inst.cookingEvents.some((e) => e.date === '2026-11-22'), 'в релакс-день не готовим');
});

test('старт сегодня: первая закупка и готовка — сегодня до обеда', () => {
  const inst = buildInstance(cfg('2026-11-16'), { ...NOV, today: '2026-11-16' });
  assert.equal(inst.cookingEvents[0].date, '2026-11-16');
  assert.match(inst.cookingEvents[0].timeNote ?? '', /сегодня/);
  assert.equal(inst.shoppingEvents[0].date, '2026-11-16');
});

test('смена даты старта не удаляет и не переносит отметки, вес, фото и тренировки', () => {
  let d = freshData('2026-10-25');
  d = apply(d, [
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-03:lunch', date: '2026-11-03', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'cook:cook-p20261102-cook-01', date: '2026-11-01', kind: 'cooking', status: 'done', updatedAt: NOW } },
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
  assert.ok(d2.cookingEvents['cook-p20261102-cook-01'], 'прошедшая готовка осталась в истории');
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

test('оборудование шаблонов: только 12 и 16 кг', () => {
  assert.equal(checkEquipment(seedTemplateVersions(NOW).map((v) => v.template)).ok, true);
  const bad = seedTemplateVersions(NOW).map((v) => v.template);
  bad[0] = { ...bad[0], items: [{ ...bad[0].items[1], kettlebellKg: 14 }] };
  assert.equal(checkEquipment(bad).ok, false);
});

// ------------------------------------------------------------------ данные пользователя и обновление меню

function v1State(): AppData {
  // данные первой версии: стартовый план 02.11 без граммовок, отметки и галочки
  let d = applyOps(emptyData(), seedOps(NOW, '2026-10-30'));
  const { plan: _p, training: _t, ...oldSettings } = d.settings as any;
  d = applyOps(d, [
    { store: 'settings', put: { ...oldSettings, onboarded: true } },
    { store: 'meta', put: { ...d.meta!, dataVersion: 3 } },
    { store: 'planDays', put: { date: '2026-11-02', source: 'seed', dayNumber: 1, relax: false, meals: { breakfast: 'Овсянка', lunch: 'Курица', snack: 'Йогурт', dinner: 'Чили' }, training: { templateId: 'strength_a', label: 'Силовая А' } } },
    { store: 'cookingEvents', put: { id: 'cook-2026-11-01', date: '2026-11-01', eventType: 'meal_prep', title: 'Готовка', sourceText: '', forDaysText: '', forDates: [], storage: '', dishes: [], source: 'seed' } },
    { store: 'shoppingEvents', put: { id: 'shop-2026-11-16', date: '2026-11-16', title: 'Закупка 2', items: [], source: 'seed' } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-02:lunch', date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } },
  ]);
  return d;
}

test('миграция с первой версии: план с граммовками, командировки, отметки и вес сохраняются, без дублей', () => {
  const d = v1State();
  const d2 = applyOps(d, dataMigrationOps(d, '2026-11-04', NOW));
  assert.equal(d2.meta!.dataVersion, DATA_VERSION);
  assert.ok(d2.planDays['2026-11-02'].mealCards, 'у дня появились карточки с граммовками');
  assert.equal(d2.settings.training.startDate, '2026-11-16');
  assert.equal(Object.keys(d2.trips).length, 2);
  assert.equal(d2.taskStatus['meal:2026-11-02:lunch'].status, 'done');
  assert.equal(d2.weights.w1.kg, 106.4);
  assert.equal(d2.cookingEvents['cook-2026-11-01'], undefined, 'старые события заменены, без дублей');
  assert.equal(d2.shoppingEvents['shop-2026-11-16'], undefined);
  assert.equal(dataMigrationOps(d2, '2026-11-04', NOW).length, 0, 'повторная миграция ничего не меняет');
});

test('свежая установка: план появляется только после выбора даты старта', () => {
  const d = freshData('2026-11-04', null);
  assert.equal(Object.keys(d.planDays).length, 0);
  assert.equal(d.settings.plan, null);
  const d2 = applyOps(d, replanOps(d, cfg('2026-11-05'), '2026-11-04').ops);
  assert.equal(Object.keys(d2.planDays).length, 30);
  assert.equal(d2.settings.plan!.startDate, '2026-11-05');
  assert.equal(d2.settings.plan!.menuId, TEMPLATE.id);
  assert.equal(menuUpdatePending(d2), false);
});

function v4State(): AppData {
  // установленное приложение версии 1.1/1.2: прежнее меню, план со стартом 02.11, отметки до 14.11
  let d = freshData('2026-10-30', '2026-11-02');
  const old = d.settings.plan!;
  d = applyOps(d, [
    { store: 'meta', put: { ...d.meta!, dataVersion: 4 } },
    { store: 'settings', put: { ...d.settings, plan: { ...old, menuId: undefined } } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-03:breakfast', date: '2026-11-03', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'trainingLogs', put: { id: 'train:2026-11-04', plannedDate: '2026-11-04', date: '2026-11-04', templateId: 'strength_b', templateVersionId: 'strength_b@seed', status: 'done', exercises: [], updatedAt: NOW } },
    { store: 'weights', put: { id: 'w1', date: '2026-11-09', kg: 106.1, createdAt: NOW } },
    { store: 'photos', put: { id: 'ph1', date: '2026-11-09', pose: 'front', width: 1, height: 1, bytes: 1, type: 'image/jpeg', createdAt: NOW } },
    { store: 'customTasks', put: { id: 'c26', date: '2026-11-26', title: 'Командировка в СПб', kind: 'custom', createdAt: NOW } },
    { store: 'customTasks', put: { id: 'c27', date: '2026-11-27', title: 'Позвонить маме', kind: 'custom', createdAt: NOW } },
  ]);
  // прежнее меню со скумбрией: прошедшие дни (без отметок и с отметкой), будущий день, закупки
  const mk = { title: 'Скумбрия + салат', parts: [{ dishId: 'mackerel', qty: 1, fresh: false, cookEventId: null, storage: null, thawOn: null }] };
  const day9 = d.planDays['2026-11-09'], day10 = d.planDays['2026-11-10'], day28 = d.planDays['2026-11-28'];
  const line = (productId: string) => ({ productId, need: 340, fromStock: 0, buy: 500, packs: 1, cost: 325, leftover: 160, freezeNow: 0, notes: [], needs: [] });
  d = applyOps(d, [
    { store: 'planDays', put: { ...day9, mealCards: { ...day9.mealCards!, dinner: mk } } },
    { store: 'planDays', put: { ...day10, mealCards: { ...day10.mealCards!, lunch: mk, dinner: mk } } },
    { store: 'planDays', put: { ...day28, mealCards: { ...day28.mealCards!, dinner: mk } } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-10:lunch', date: '2026-11-10', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'shoppingEvents', put: { id: 'old-shop', date: '2026-11-08', title: 'Докупка', kind: 'topup', items: [], lines: [line('mackerel_fillet'), line('potato'), line('tomato')], source: 'seed' } },
    { store: 'shoppingChecks', put: { id: 'old-shop:mackerel_fillet', eventId: 'old-shop', itemId: 'mackerel_fillet', bought: true, updatedAt: NOW } },
    { store: 'shoppingChecks', put: { id: 'old-shop:potato', eventId: 'old-shop', itemId: 'potato', bought: true, updatedAt: NOW } },
    { store: 'shoppingEvents', put: { id: 'old-shop-2', date: '2026-11-12', title: 'Докупка', kind: 'topup', items: [], lines: [line('mackerel_fillet')], source: 'seed' } },
  ]);
  return d;
}

test('обновление меню при запуске: сначала резервная копия, затем новое меню; отчёт показывается один раз', () => {
  const before = v4State();
  const ops = dataMigrationOps(before, '2026-11-14', NOW, '1.5.0');
  const d = applyOps(before, ops);
  assert.equal(menuUpdatePending(d), false, 'новое меню применено без кнопки');
  assert.equal(d.settings.plan!.startDate, '2026-11-16');
  assert.equal(d.settings.plan!.menuId, TEMPLATE.id);
  assert.equal(Object.keys(d.trips).length, 2, 'командировки добавлены');
  assert.equal(d.customTasks.c26, undefined, 'старое событие командировки на 26.11 убрано');
  assert.ok(d.customTasks.c27);
  // резервная копия — до изменения плана, в той же транзакции
  const bi = ops.findIndex((o) => o.store === 'backups');
  assert.ok(bi >= 0 && ops.findIndex((o) => o.store === 'planDays') > bi, 'копия раньше изменений плана');
  const bk = d.backups[d.settings.menuReportUnseen!];
  assert.ok(bk, 'отчёт ждёт показа');
  assert.equal(bk.stores.planDays.length, Object.keys(before.planDays).length, 'в копии все дни прежнего плана');
  assert.equal(bk.stores.weights.length, 1);
  assert.equal(bk.fromMenu, null);
  assert.equal(bk.toMenu, TEMPLATE.id);
  assert.equal(bk.appVersion, '1.5.0');
  assert.equal(bk.report!.auto, true);
  assert.equal(d.planDays['2026-11-16'].mealCards!.lunch.parts[0].dishId, 'L01');
  const inst = buildInstance(d.settings.plan!, { trips: Object.values(d.trips), relaxOverrides: d.settings.relaxOverrides, today: '2026-11-14' });
  okAll(checkInstance(inst));
  okAll(checkSeedPlan(inst));
  // прежние данные: отметки, тренировки, вес, фото
  assert.equal(d.taskStatus['meal:2026-11-03:breakfast'].status, 'done');
  assert.equal(d.trainingLogs['train:2026-11-04'].status, 'done');
  assert.equal(d.weights.w1.kg, 106.1);
  assert.ok(d.photos.ph1);
  assert.ok(checkUserData(d).every((c) => c.ok));
  assert.equal(dataMigrationOps(d, '2026-11-14', NOW).length, 0, 'повторно не применяется');
  // ручное применение (например, после отката) — тоже с копией первой операцией
  const res = menuUpdateOps(before, '2026-11-16', '2026-11-14', NOW, '1.5.0');
  assert.equal(res.ops[0].store, 'backups');
  assert.equal(res.report.auto, false);
});

test('скумбрия: убрана из активных и неотмеченных старых данных, отмеченное осталось историей; проверка активных данных', () => {
  const before = v4State();
  assert.equal(checkActiveData(before, '2026-11-14').ok, false, 'до миграции в будущих днях прежнего меню есть скумбрия');
  const after = applyOps(before, dataMigrationOps(before, '2026-11-14', NOW));
  const report = after.backups[after.settings.menuReportUnseen!].report!;
  const check = checkActiveData(after, '2026-11-14');
  assert.ok(check.ok, check.details.join('; '));
  assert.deepEqual(report.mackerelDates!.days, ['2026-11-28']);
  // 09.11 — день прежнего меню без отметок: день остаётся, убран только ужин со скумбрией
  assert.equal(after.planDays['2026-11-09'].mealCards!.dinner.title, 'Блюдо прежнего меню удалено');
  assert.equal(JSON.stringify(after.planDays['2026-11-09'].mealCards!.lunch), JSON.stringify(before.planDays['2026-11-09'].mealCards!.lunch), 'остальные приёмы дня не меняются');
  // 10.11 обед со скумбрией отмечен съеденным — история
  assert.equal(after.planDays['2026-11-10'].mealCards!.lunch.parts[0].dishId, 'mackerel');
  assert.equal(after.planDays['2026-11-10'].mealCards!.dinner.title, 'Блюдо прежнего меню удалено', 'неотмеченный ужин со скумбрией убран');
  assert.equal(after.taskStatus['meal:2026-11-10:lunch'].status, 'done');
  assert.ok(report.mackerel.keptHistory.some((x) => x.startsWith('10.11 обед')));
  assert.ok(report.mackerel.removedPast.length >= 2);
  assert.ok(report.mackerel.future > 0);
  // прошлая закупка: купленная скумбрия — история, не купленная — убрана
  const shop = after.shoppingEvents['old-shop'];
  assert.deepEqual(shop.lines!.map((l) => l.productId), ['mackerel_fillet', 'potato', 'tomato'], 'прочие строки не трогаются');
  assert.equal(after.shoppingEvents['old-shop-2'], undefined, 'неотмеченная закупка только со скумбрией удалена');
  // нигде в активном меню, рецептах и каталоге
  assert.ok(!SEED_RECIPES.some((r) => /скумбри/i.test(r.title + r.ingredients_text)));
  assert.ok(!TEMPLATE.products.some((p) => !p.archived && /скумбри/i.test(p.name)));
  for (const x of Object.values(after.planDays)) if (x.date >= '2026-11-14') assert.ok(!/скумбри|mackerel/i.test(JSON.stringify(x)), x.date);
  for (const e of [...Object.values(after.cookingEvents), ...Object.values(after.shoppingEvents)]) if (e.date >= '2026-11-14') assert.ok(!/скумбри|mackerel/i.test(JSON.stringify(e)), e.id);
  // откат из копии возвращает прежнее меню без скумбрии; записи пользователя не трогаются; само не применяется снова
  const back = applyOps(after, rollbackMenuOps(after, after.settings.menuReportUnseen!, '2026-11-14'));
  assert.equal(back.settings.plan!.startDate, '2026-11-02');
  assert.equal(menuUpdatePending(back), true);
  assert.equal(back.weights.w1.kg, 106.1);
  assert.ok(back.planDays['2026-11-09']);
  for (const x of Object.values(back.planDays)) if (x.date >= '2026-11-14') assert.ok(!/скумбри|mackerel/i.test(JSON.stringify(x.mealCards ?? x.meals)), x.date);
  assert.equal(dataMigrationOps(back, '2026-11-14', NOW).length, 0);
});

test('проверка av.ru: недоступный товар блокируется; замена пересчитывает граммовки, упаковки, цены и калорийность', () => {
  let d = freshData('2026-11-14', '2026-11-16', true);
  const ids = orderProductIds(Object.values(d.shoppingEvents).find((e) => e.kind === 'main')!);
  assert.equal(basketState(d, ids).verified, false, 'без проверки корзина не проверена');
  const kcal0 = dishNutrition('L01', 1).kcal;
  d = applyOps(d, productCheckOps(d, 'chicken', { status: 'unavailable' }, '2026-11-14', NOW));
  assert.equal(isBlocked(d, 'chicken'), true);
  assert.deepEqual(basketState(d, ids).unavailable, ['chicken']);
  // замена из каталога меню — только товары той же категории с карточками av.ru
  assert.deepEqual(alternativesFor(d, 'chicken').map((p) => p.id), ['turkey', 'turkey_mince', 'beef_mince']);
  const { sub } = makeSub('chicken', { catalogId: 'turkey', name: '', url: '', packSize: 0, packPrice: 0 }, NOW);
  d = applyOps(d, productCheckOps(d, 'chicken', { sub }, '2026-11-14', NOW));
  applyProductSubs(d.avProducts);
  try {
    assert.equal(isBlocked(d, 'chicken'), false);
    assert.equal(PRODUCTS.chicken.url, 'https://av.ru/i/461436');
    assert.equal(sub!.qtyFactor, 1.05, 'граммовка сохраняет белок');
    assert.equal(ingredientLines('L01', 1).find((l) => l.productId === 'chicken')!.amount, '189 г');
    assert.ok(Math.abs(dishNutrition('L01', 1).kcal - kcal0) > 1, 'калорийность пересчитана');
    const line = Object.values(d.shoppingEvents).find((e) => e.kind === 'main')!.lines!.find((l) => l.productId === 'chicken')!;
    assert.deepEqual([line.need, line.packs, line.cost], [378, 1, 681], 'закупка — по упаковке замены');
    const inst = buildInstance(d.settings.plan!, { trips: Object.values(d.trips), relaxOverrides: d.settings.relaxOverrides, today: '2026-11-14' });
    okAll(checkInstance(inst));
    // «корзина проверена» — только после адреса и всех товаров
    for (const id of ids) if (id !== 'chicken') d = applyOps(d, productCheckOps(d, id, { status: 'available' }, '2026-11-14', NOW));
    assert.equal(basketState(d, ids).verified, false, 'адрес ещё не выбран');
    d = applyOps(d, [{ store: 'settings', put: { ...d.settings, avAddressConfirmedAt: NOW } }]);
    assert.equal(basketState(d, ids).verified, true);
    // своя замена — только индивидуальная карточка av.ru
    assert.ok(makeSub('curd', { name: 'Творог', url: 'https://av.ru/catalog/moloko', packSize: 200, packPrice: 120 }, NOW).errors.length);
    assert.ok(makeSub('curd', { name: 'Творог 5%', url: 'https://av.ru/i/123456', packSize: 180, packPrice: 120 }, NOW).sub);
  } finally {
    applyProductSubs({});
  }
});

test('ноябрь 2026 после применения меню: командировки, тренировки, релакс, порции, закупки, продолжение программы', () => {
  const before = v4State();
  const mid = applyOps(before, dataMigrationOps(before, '2026-11-14', NOW));
  const d = applyOps(mid, menuUpdateOps(mid, '2026-11-16', '2026-11-14', NOW).ops);
  const day = (x: string) => d.planDays[x];
  const tasks = (x: string) => tasksForDate(d, x);
  assert.equal(day('2026-11-16').dayNumber, 1);
  assert.equal(day('2026-12-15').dayNumber, 30);
  const trip = (x: string) => (day(x)?.tripId ? d.trips[day(x)!.tripId!].city : null);
  assert.deepEqual(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].map(trip), [null, 'Екатеринбург', 'Екатеринбург', 'Екатеринбург', null]);
  assert.deepEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].map(trip), [null, 'Санкт-Петербург', 'Санкт-Петербург', null]);
  assert.equal(day('2026-11-19').meals!.breakfast, 'Завтрак в гостинице');
  for (const x of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25']) {
    const t = tasks(x).find((k) => k.kind === 'training')!;
    assert.ok(t.optional && t.tripId, `${x}: плановый отдых`);
    assert.equal(day(x).mealCards, null);
  }
  const plan: Record<string, string> = {
    '2026-11-16': 'Силовая А', '2026-11-17': 'Степпер', '2026-11-21': 'Восстановление после командировки', '2026-11-22': 'Отдых',
    '2026-11-23': 'Силовая Б', '2026-11-26': 'Восстановление после командировки', '2026-11-27': 'Силовая А по самочувствию',
    '2026-11-28': 'Степпер 15–20 минут или прогулка', '2026-11-29': 'Релакс-день, отдых', '2026-11-30': 'Силовая Б',
  };
  for (const [x, label] of Object.entries(plan)) assert.equal(scheduledTraining(d, x)!.label, label, x);
  for (const e of Object.values(d.cookingEvents)) {
    if (e.instanceId !== d.settings.plan!.instanceId) continue;
    assert.ok(!['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25', '2026-11-29'].includes(e.date), `готовка ${e.date}`);
    for (const it of e.items ?? []) for (const u of it.uses) assert.ok(!day(u.date)?.tripId, `${it.dishId}: порция на ${u.date}`);
  }
  // смена даты старта не сдвигает командировки и релакс
  const moved = applyOps(d, replanOps(d, cfg('2026-11-18'), '2026-11-14').ops);
  assert.equal(moved.planDays['2026-11-29'].relax, true);
  assert.notEqual(moved.planDays['2026-12-13']?.relax, true);
  for (const x of ['2026-11-18', '2026-11-24']) assert.ok(moved.planDays[x].tripId);
  // программа продолжается
  assert.ok(scheduledTraining(d, '2027-03-01'), 'тренировки на год вперёд');
  const next = buildInstance(cfg('2026-12-16'), { trips: Object.values(d.trips), relaxOverrides: d.settings.relaxOverrides, today: null });
  okAll(checkInstance(next), 'следующий цикл: ');
  // даты — календарные строки без часовых поясов
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2027-03-27', 2), '2027-03-29');
  assert.equal(diffDays('2026-12-15', '2026-11-16'), 29);
});

test('новая командировка: предпросмотр показывает изменения, конфликт с релакс-днём не удаляет задачи', () => {
  const d = freshData('2026-11-14', '2026-11-16', true);
  const trip = { id: 'trip-x', city: 'Казань', from: '2026-12-26', to: '2026-12-28', hotelBreakfast: false, fridge: true, canTrain: true, comment: null, createdAt: NOW, updatedAt: NOW };
  const diff = previewChange(d, tripOps(trip, null), '2026-11-14', ['2026-12-26', '2026-12-27', '2026-12-28']);
  assert.deepEqual(diff.conflicts.relax, ['2026-12-27'], 'релакс-день декабря попадает на поездку');
  assert.ok(diff.trainings.length > 0, 'видно, какие тренировки станут отдыхом');
  assert.equal(Object.keys(d.trips).length, 2, 'до подтверждения ничего не меняется');
  const after = applyOps(d, diff.ops);
  assert.equal(after.trips['trip-x'].city, 'Казань');
  const inst = buildInstance(after.settings.plan!, { trips: Object.values(after.trips), relaxOverrides: after.settings.relaxOverrides, today: '2026-11-14' });
  okAll(checkInstance(inst));
  assert.equal(after.planDays['2026-12-26'].tripId, 'trip-x', 'командировка вне цикла тоже с командировочным меню');
});

test('свежая установка в ноябре 2026 (второе устройство): командировки, старт 16.11, релакс 29.11, новое меню', () => {
  const d = freshData('2026-11-14', '2026-11-16', true);
  assert.deepEqual(Object.values(d.trips).map((t) => `${t.city} ${t.from}–${t.to}`).sort(), ['Екатеринбург 2026-11-18–2026-11-20', 'Санкт-Петербург 2026-11-24–2026-11-25']);
  assert.equal(d.settings.training.startDate, '2026-11-16');
  assert.equal(d.planDays['2026-11-19'].tripId, 'trip-2026-11-18-ekb');
  assert.equal(d.planDays['2026-11-29'].relax, true);
  assert.equal(d.planDays['2026-11-16'].mealCards!.breakfast.parts[0].dishId, 'B01');
  assert.equal(menuUpdatePending(d), false);
  const later = freshData('2026-12-20', '2026-12-21', true);
  assert.equal(Object.keys(later.trips).length, 0);
});
