import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOW } from './helpers';
import { applyOps, dataMigrationOps, emptyData } from '../src/state/model';
import { replanOps } from '../src/domain/plan';
import { scheduledTraining } from '../src/domain/tasks';
import { buildCorrection, correctionPending, emptyInput, CORR_ID } from '../src/domain/correction';
import { cookStockOps, mealStockOps, readyFood, readyFoodOps, stockLots, stockRemaining, stockSummary } from '../src/domain/stock';
import type { AppData } from '../src/state/types';

const TODAY = '2026-11-22';
const AT = '2026-11-22T16:45:00.000Z';
const J = (x: unknown) => JSON.stringify(x);
const X01 = 'cook-p20261116-x2211';
const X02 = 'cook-p20261116-x2311';

/**
 * Устройство на 22.11 (версия 1.6.0): меню v2 со старта 16.11, Санкт-Петербург перенесена на 25–26.11,
 * первая закупка отмечена, завтрак 22.11 отмечен съеденным. Как получен файл — tests/fixtures/README.md.
 */
function device(): AppData {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/state_1.6.0_2211.json', import.meta.url), 'utf8'));
  return { ...emptyData(), ...raw, ready: true } as AppData;
}

const applied = () => {
  const d = device();
  const c = buildCorrection(d, TODAY, AT, emptyInput(), '1.7.0');
  return { before: d, c, after: applyOps(d, c.ops) };
};

test('корректировка ждёт проверки и подтверждения; предпросмотр ничего не меняет', () => {
  const d = device();
  assert.equal(correctionPending(d, TODAY), true);
  assert.equal(d.settings.inventory, undefined);
  const snap = J(d);
  const c = buildCorrection(d, TODAY, AT, emptyInput());
  assert.equal(J(d), snap, 'данные не изменены');
  assert.equal(c.ops[0].store, 'backups', 'сначала резервная копия');
});

test('22–24.11: новые блюда и порции из купленного, 21.11 — по факту, 27.11 — готовка после командировки', () => {
  const { before, c, after } = applied();
  const r = c.report;
  // отметки по факту; уже отмеченное (завтрак 22.11) не тронуто
  const st = (id: string) => after.taskStatus[id]?.status;
  assert.equal(st('meal:2026-11-21:breakfast'), 'done');
  for (const s of ['lunch', 'snack', 'dinner']) assert.equal(st(`meal:2026-11-21:${s}`), 'skipped', s);
  assert.equal(st('cook:cook-p20261116-cook-01'), 'done');
  assert.equal(st('cook:cook-p20261116-cook-02'), 'skipped', 'готовка 21.11 отменена');
  assert.equal(st('shop:shop-p20261116-t1'), 'skipped', 'докупки 21.11 не было');
  assert.equal(st('meal:2026-11-22:lunch'), 'skipped');
  assert.equal(J(after.taskStatus['meal:2026-11-22:breakfast']), J(before.taskStatus['meal:2026-11-22:breakfast']));
  for (const x of ['meal:2026-11-23:breakfast', 'meal:2026-11-24:lunch', 'cook:' + X01]) assert.equal(st(x), undefined, `${x}: будущее не отмечается`);
  // блюда
  const card = (date: string, s: string) => (after.planDays[date].mealCards as any)[s];
  assert.equal(card('2026-11-22', 'lunch').cancelled, true);
  assert.equal(card('2026-11-22', 'breakfast').title, before.planDays['2026-11-22'].mealCards!.breakfast.title, 'завтрак 22.11 — из меню');
  assert.equal(card('2026-11-22', 'snack').title, before.planDays['2026-11-22'].mealCards!.snack.title, 'перекус 22.11 — из меню');
  for (const [date, slot, cook, dish] of [['2026-11-22', 'dinner', X01, 'X01'], ['2026-11-23', 'lunch', X01, 'X01'], ['2026-11-24', 'lunch', X01, 'X01'], ['2026-11-23', 'dinner', X02, 'X02'], ['2026-11-24', 'dinner', X02, 'X02']]) {
    assert.deepEqual([card(date, slot).parts[0].dishId, card(date, slot).parts[0].cookEventId, card(date, slot).parts[0].storage], [dish, cook, 'fridge'], `${date} ${slot}`);
  }
  const t = after.cookingEvents[X01], k = after.cookingEvents[X02];
  assert.deepEqual([t.date, t.items![0].qty, k.date, k.items![0].qty], ['2026-11-22', 3, '2026-11-23', 2]);
  // завтраки и перекусы 23–24.11 — разные и собираются из запасов
  assert.equal(c.picks.length, 4);
  assert.ok(c.picks.every((p) => p.feasible));
  assert.equal(new Set(c.picks.map((p) => p.dishId)).size, 4);
  // командировка, релакс, тренировки
  for (const x of ['2026-11-25', '2026-11-26']) assert.ok(after.planDays[x].tripId && !after.planDays[x].mealCards);
  assert.ok(!Object.values(after.cookingEvents).some((e) => e.date === '2026-11-25' || e.date === '2026-11-26'));
  assert.equal(after.planDays['2026-11-29'].relax, true);
  assert.equal(scheduledTraining(after, '2026-11-24')!.label, 'Степпер');
  assert.equal(scheduledTraining(after, '2026-11-27')!.label, 'Силовая А по самочувствию');
  // 27–28.11 — меню остаётся, готовка после возвращения; к ней — небольшая закупка до поездки
  const c03 = after.cookingEvents['cook-p20261116-cook-03'];
  assert.deepEqual([c03.date, c03.time], ['2026-11-27', '07:00']);
  assert.ok(c03.items!.every((i) => i.uses.every((u) => u.date >= '2026-11-27')));
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].date, '2026-11-24');
  for (const n of ['Минтай', 'Филе грудки цыплёнка-бройлера охлаждённое']) assert.ok(r.extra[0].lines.some((l) => l.name === n), n);
  assert.ok(!Object.values(after.shoppingEvents).some((e) => e.kind === 'topup' && (e.date === '2026-11-22' || e.date === '2026-11-23')), 'сегодня и завтра — без закупок');
  // вторая основная закупка — с вычетом остатков
  assert.ok(r.main);
  assert.ok(r.main!.lines.some((l) => l.name === 'Филе грудки индейки' && l.fromStock !== '—'), 'индейка — с учётом остатка');
  assert.ok(r.main!.covered.some((x) => /Гречка/.test(x)), 'гречки хватает — не покупать');
  for (const n of ['Фарш из мякоти говядины', 'Фарш из филе грудки индейки', 'Стейк форели охлаждённый']) assert.ok(r.main!.lines.some((l) => l.name === n), `${n} — в будущей закупке`);
  assert.ok(r.deficits.some((x) => /Перец/.test(x)), 'нехватка показана, а не докуплена');
  assert.ok(r.budget.left === r.budget.total - r.budget.spent - r.budget.planned);
  // прошедшее и пользовательские записи
  for (const id of Object.keys(before.shoppingEvents)) if (before.shoppingEvents[id].date < TODAY) assert.equal(J(after.shoppingEvents[id]), J(before.shoppingEvents[id]), id);
  for (const x of Object.keys(before.planDays)) if (x < '2026-11-22') assert.equal(J(after.planDays[x]), J(before.planDays[x]), x);
  for (const s of ['weights', 'photos', 'trainingLogs', 'trips', 'templateVersions'] as const) assert.equal(J(after[s]), J(before[s]), s);
  assert.equal(correctionPending(after, TODAY), false);
  assert.ok(after.settings.corrections?.[CORR_ID]);
  assert.equal(after.backups[after.settings.correctionReportUnseen!].correctionReport!.id, CORR_ID);
  assert.equal(dataMigrationOps(after, TODAY, AT).length, 0);
  assert.equal(replanOps(after, after.settings.plan!, TODAY, { keepPast: true }).ops.length, 0, 'пересчёт без изменений ничего не меняет');
});

test('запасы: по чекам минус приготовленное и съеденное; без минусов; требуют подтверждения', () => {
  const { after } = applied();
  const s = (pid: string) => stockSummary(after.stock[pid], TODAY);
  assert.equal(after.settings.inventory!.since, '2026-11-22');
  assert.deepEqual([s('chicken').bought, s('chicken').used, s('chicken').remaining, after.stock.chicken.location], [878, 360, 518, 'freezer']);
  assert.deepEqual([s('turkey').bought, s('turkey').remaining, after.stock.turkey.location], [894, 714, 'freezer']);
  assert.equal(s('yogurt').bought, 1750);
  assert.equal(s('curd').bought, 1180);
  assert.ok(s('chicken').needsConfirm, 'расчётный остаток требует подтверждения');
  for (const pid of ['pollock', 'egg', 'potato', 'oliveoil', 'beef_mince', 'turkey_mince', 'trout']) assert.equal(stockRemaining(after, pid), 0, `${pid}: не считается имеющимся`);
  for (const rec of Object.values(after.stock)) assert.ok(stockLots(rec).every((l) => l.qty >= 0), rec.productId);
  // завтрак 22.11 отмечен «съедено» — творог и йогурт списаны по факту
  assert.ok(after.stock.curd.moves.some((m) => m.source === 'meal:2026-11-22:breakfast'));
});

test('по факту: «Приготовлено» списывает, отмена и снятая отметка — возвращают; пропуск — порция в готовой еде', () => {
  const { after } = applied();
  const e = after.cookingEvents[X01];
  const turkey0 = stockRemaining(after, 'turkey');
  const r = cookStockOps(after, e, true, AT);
  const cooked = applyOps(after, [...r.ops, { store: 'taskStatus', put: { taskId: `cook:${X01}`, date: e.date, kind: 'cooking', status: 'done', updatedAt: AT } }]);
  assert.equal(Math.round(turkey0 - stockRemaining(cooked, 'turkey')), 540);
  assert.ok(r.deficits.some((x) => x.productId === 'pepper'), 'перца по учёту меньше — дефицит');
  assert.equal(stockRemaining(cooked, 'pepper'), 0, 'не минус');
  const again = applyOps(cooked, cookStockOps(cooked, e, true, AT).ops);
  assert.equal(stockRemaining(again, 'turkey'), stockRemaining(cooked, 'turkey'), 'повторная отметка не списывает дважды');
  const undone = applyOps(cooked, cookStockOps(cooked, e, false, AT).ops);
  assert.equal(stockRemaining(undone, 'turkey'), turkey0, 'снятая отметка возвращает продукты');
  // свежее блюдо: «Съедено» списывает, «Пропущено» — нет
  const y0 = stockRemaining(cooked, 'yogurt');
  const ate = applyOps(cooked, mealStockOps(cooked, '2026-11-23', 'breakfast', 'done', AT));
  assert.ok(stockRemaining(ate, 'yogurt') < y0);
  const skipped = applyOps(cooked, mealStockOps(cooked, '2026-11-23', 'breakfast', 'skipped', AT));
  assert.equal(stockRemaining(skipped, 'yogurt'), y0);
  // обед 23.11 пропущен — порция индейки осталась: съесть до 25.11, заморозить или списать
  const left = applyOps(cooked, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-23:lunch', date: '2026-11-23', kind: 'meal', status: 'skipped', updatedAt: AT } }]);
  const p = readyFood(left, '2026-11-23').find((x) => x.date === '2026-11-23' && x.slot === 'lunch')!;
  assert.deepEqual([p.state, p.safeUntil, p.storage], ['left', '2026-11-25', 'fridge']);
  const frozen = applyOps(left, readyFoodOps(p, 'frozen', AT));
  const pf = readyFood(frozen, '2026-11-23').find((x) => x.id === p.id)!;
  assert.deepEqual([pf.state, pf.storage], ['frozen', 'freeze']);
  const gone = applyOps(left, readyFoodOps(p, 'writeoff', AT));
  assert.ok(!readyFood(gone, '2026-11-23').some((x) => x.id === p.id));
});

test('проверка запасов меняет план: масло есть дома — не покупать; творог годен — в завтраках', () => {
  const d = device();
  const base = buildCorrection(d, TODAY, AT, emptyInput()).report;
  assert.ok(base.extra.flatMap((e) => e.lines).some((l) => /Масло оливковое/.test(l.name)));
  const withOil = buildCorrection(d, TODAY, AT, { ...emptyInput(), remaining: { oliveoil: 300 } }).report;
  assert.ok(!withOil.extra.flatMap((e) => e.lines).some((l) => /Масло оливковое/.test(l.name)), 'масло подтверждено — не в закупке');
  // по общему сроку творог от 15.11 уже не годен — в завтраки не идёт; срок с упаковки до 24.11 — идёт первым
  const CURD = ['B02', 'B07', 'B10', 'B12', 'B14', 'B21', 'B24', 'S01', 'S03', 'S05', 'S07', 'S10'];
  assert.ok(!buildCorrection(d, TODAY, AT, emptyInput()).picks.some((p) => CURD.includes(p.dishId) && p.dishId !== p.original));
  const curd = buildCorrection(d, TODAY, AT, { ...emptyInput(), expiry: { curd: '2026-11-24' } });
  assert.ok(curd.picks.some((p) => ['B07', 'B10', 'B21', 'B24', 'S01', 'S03', 'S10'].includes(p.dishId)), 'творог годен до 24.11 — используется в первую очередь');
  const spoiled = buildCorrection(d, TODAY, AT, { ...emptyInput(), spoiled: ['pepper'] });
  assert.equal(stockRemaining({ ...d, stock: spoiled.stock } as AppData, 'pepper'), 0);
  const spent = buildCorrection(d, TODAY, AT, { ...emptyInput(), spent: 9100 }).report;
  assert.deepEqual([spent.budget.spent, spent.budget.spentActual], [9100, true]);
});

test('если корректировку применяют на день позже, готовка 22.11 и её порции всё равно на месте', () => {
  const d = device();
  const c = buildCorrection(d, '2026-11-23', '2026-11-23T08:00:00.000Z', emptyInput());
  const after = applyOps(d, c.ops);
  assert.ok(after.cookingEvents[X01]);
  assert.equal(after.planDays['2026-11-22'].mealCards!.dinner.parts[0].cookEventId, X01);
  assert.equal(after.planDays['2026-11-23'].mealCards!.lunch.parts[0].cookEventId, X01);
  assert.equal(NOW.length > 0, true);
});
