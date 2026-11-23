import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOps, dataMigrationOps, emptyData } from '../src/state/model';
import { replanOps } from '../src/domain/plan';
import { scheduledTraining, thawList } from '../src/domain/tasks';
import { SEED_RECIPES } from '../src/lib/seed';
import { CORR_ID, CORR_REV, buildCorrection, correctionApplied, correctionPending, emptyInput, firstRevisionApplied, menuMissing, revisionBlocked } from '../src/domain/correction';
import { cookStockOps, mealStockOps, readyFood, readyFoodOps, stockLots, stockRemaining, stockSummary } from '../src/domain/stock';
import type { AppData } from '../src/state/types';

const TODAY = '2026-11-22';
const AT = '2026-11-22T17:45:00.000Z';
const J = (x: unknown) => JSON.stringify(x);
const C22 = 'cook-p20261116-x2211b';
const C23 = 'cook-p20261116-x2311';
const R1 = 'cook-p20261116-x2211';

function load(file: string): AppData {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
  return { ...emptyData(), ...raw, ready: true } as AppData;
}
/**
 * Устройство на 22.11 (версия 1.6.0): меню v2 со старта 16.11, Санкт-Петербург перенесена на 25–26.11,
 * первая закупка отмечена, завтрак 22.11 отмечен съеденным. Как получен файл — tests/fixtures/README.md.
 */
const device = () => load('state_1.6.0_2211.json');
/** То же устройство после первой редакции корректировки (версия 1.7.0): индейка с булгуром на 3 порции. */
const deviceR1 = () => load('state_1.7.0_r1_2211.json');

const applied = (d = device(), today = TODAY, at = AT) => {
  const c = buildCorrection(d, today, at, emptyInput(), '1.8.0');
  return { before: d, c, after: applyOps(d, c.ops) };
};
const card = (d: AppData, date: string, s: string) => (d.planDays[date].mealCards as any)[s];
const mark = (taskId: string, date: string, status: string) => ({ store: 'taskStatus', put: { taskId, date, kind: taskId.split(':')[0] === 'cook' ? 'cooking' : 'meal', status, updatedAt: AT } }) as any;

test('предпросмотр ничего не меняет; сначала резервная копия', () => {
  const d = device();
  assert.equal(correctionPending(d, TODAY), true);
  assert.equal(d.settings.inventory, undefined);
  const snap = J(d);
  const c = buildCorrection(d, TODAY, AT, emptyInput());
  assert.equal(J(d), snap, 'данные не изменены');
  assert.equal(c.ops[0].store, 'backups', 'сначала резервная копия');
  assert.equal(J((c.ops[0] as any).put.stores.planDays), J(Object.values(d.planDays)), 'в копии — прежний план');
});

test('меню 22–24.11: нут с булгуром, индейка с гречкой, курица с рисом; завтраки и перекусы — из меню', () => {
  const { before, c, after } = applied();
  const r = c.report;
  const st = (id: string) => after.taskStatus[id]?.status;
  // 21.11 — по факту: только завтрак; готовки не было
  assert.equal(st('meal:2026-11-21:breakfast'), 'done');
  for (const s of ['lunch', 'snack', 'dinner']) assert.equal(st(`meal:2026-11-21:${s}`), 'skipped', s);
  assert.equal(st('cook:cook-p20261116-cook-02'), 'skipped', 'готовка 21.11 не выполнялась');
  // 22.11: обед пропущен; завтрак, перекус и ужин автоматически не отмечаются, отметка завтрака — пользователя
  assert.equal(st('meal:2026-11-22:lunch'), 'skipped');
  assert.equal(J(after.taskStatus['meal:2026-11-22:breakfast']), J(before.taskStatus['meal:2026-11-22:breakfast']));
  for (const x of ['meal:2026-11-22:snack', 'meal:2026-11-22:dinner', 'meal:2026-11-23:lunch', 'cook:' + C22, 'cook:' + C23]) assert.equal(st(x), undefined, `${x}: не отмечается`);
  assert.equal(card(after, '2026-11-22', 'lunch').cancelled, true);
  assert.equal(card(after, '2026-11-22', 'lunch').title, 'Пропущен');
  for (const s of ['breakfast', 'snack']) assert.equal(card(after, '2026-11-22', s).title, card(before, '2026-11-22', s).title, `22.11 ${s} — из текущего меню`);
  // новые блюда и их готовки
  for (const [date, slot, cook, dish] of [['2026-11-22', 'dinner', C22, 'X03'], ['2026-11-23', 'lunch', C22, 'X04'], ['2026-11-24', 'lunch', C22, 'X04'], ['2026-11-23', 'dinner', C23, 'X02'], ['2026-11-24', 'dinner', C23, 'X02']]) {
    const p = card(after, date, slot).parts;
    assert.deepEqual([p.length, p[0].dishId, p[0].cookEventId, p[0].storage], [1, dish, cook, 'fridge'], `${date} ${slot}`);
  }
  assert.equal(card(after, '2026-11-22', 'dinner').title, 'Нут с булгуром и овощами');
  assert.equal(card(after, '2026-11-23', 'lunch').title, 'Индейка с гречкой и морковью');
  assert.equal(card(after, '2026-11-24', 'dinner').title, 'Курица с рисом и брокколи');
  const c22 = after.cookingEvents[C22], c23 = after.cookingEvents[C23];
  assert.deepEqual([c22.date, c22.time, c22.items!.map((i) => `${i.dishId}×${i.qty}`)], ['2026-11-22', '19:30', ['X03×1', 'X04×2']]);
  assert.deepEqual([c23.date, c23.time, c23.items!.map((i) => `${i.dishId}×${i.qty}`)], ['2026-11-23', '19:00', ['X02×2']]);
  assert.ok(!Object.values(after.cookingEvents).some((e) => e.date === '2026-11-24'), '24.11 — без новой готовки');
  assert.equal(Object.values(after.cookingEvents).filter((e) => e.date >= '2026-11-22' && e.date <= '2026-11-24').reduce((s, e) => s + e.items!.reduce((x, i) => x + i.qty, 0), 0), 5, 'ровно 5 порций — без лишних');
  // в карточках готовки — граммовки и распределение
  for (const t of ['нут 1 банка 400 г (≈240 г без жидкости)', 'булгур 70 г', 'филе индейки 360 г', 'гречка 150 г', 'морковь 200 г', 'лук 60 г', 'обед 23.11 в 12:00', 'обед 24.11 в 12:00', 'ещё 80 г моркови', 'куриное филе (360 г) из морозилки в холодильник']) assert.ok(c22.timeNote!.includes(t), t);
  for (const t of ['куриное филе 360 г', 'рис басмати 140 г', 'брокколи замороженная 320 г', 'ужин 23.11, ужин 24.11', '180 °C', '74 °C', 'контейнер с индейкой на обед 24.11']) assert.ok(c23.timeNote!.includes(t), t);
  assert.deepEqual(c23.thawProducts, [{ productId: 'chicken', qty: 360 }]);
  assert.ok(thawList(after, '2026-11-22').some((x) => /цыплёнка/.test(x) && /360 г/.test(x)), 'вечером 22.11 — переложить курицу');
  // завтраки и перекусы 23–24.11: блюдо меню, если продукты есть; иначе — замена из запасов и чего нет
  const pk = (date: string, slot: string) => c.picks.find((p) => p.date === date && p.slot === slot)!;
  assert.deepEqual([pk('2026-11-23', 'breakfast').dishId, pk('2026-11-23', 'breakfast').missing], ['B05', []]);
  assert.equal(card(after, '2026-11-23', 'breakfast').title, card(before, '2026-11-23', 'breakfast').title);
  assert.deepEqual(pk('2026-11-24', 'breakfast').missing, ['bread', 'avocado', 'egg', 'tomato']);
  assert.ok(c.picks.every((p) => p.feasible));
  for (const p of c.picks.filter((x) => x.dishId !== x.original)) assert.match(card(after, p.date, p.slot).note, /по учёту нет/);
  // предпросмотр меню и проверка остатков
  assert.equal(r.menu!.length, 12);
  assert.deepEqual(r.menu!.filter((m) => m.source === 'new').map((m) => `${m.date.slice(8)} ${m.slot}`), ['22 dinner', '23 lunch', '23 dinner', '24 lunch', '24 dinner']);
  assert.deepEqual(r.menu!.find((m) => m.date === TODAY && m.slot === 'lunch')!.source, 'cancel');
  assert.deepEqual(r.menu!.find((m) => m.date === TODAY && m.slot === 'breakfast')!.source, 'marked');
  assert.deepEqual(r.checks!.map((x) => x.productId), ['turkey', 'chicken', 'bulgur', 'buckwheat', 'rice', 'broccoli', 'chickpeas', 'carrot', 'onion', 'pepper']);
  assert.deepEqual(r.checks!.map((x) => x.need.split(' (')[0]), ['360 г', '360 г', '70 г', '150 г', '140 г', '320 г', '1 банка 400 г', '300 г', '100 г', 'до 80 г']);
  assert.ok(r.checks!.every((x) => x.state !== 'short'));
  assert.equal(r.noPurchaseUntil, '2026-11-24', 'на 22–24.11 закупка не нужна');
  assert.ok(!Object.values(after.shoppingEvents).some((e) => e.kind !== 'trip' && e.date >= TODAY && e.date <= '2026-11-24' && (e.lines ?? []).some((l) => l.buy > 0 && l.needs.some((n) => (n.use ?? n.date) <= '2026-11-24'))), 'ничего не покупается для 22–24.11');
  // какие даты и блюда изменены
  const ch = (date: string, slot: string) => r.dishes.find((x) => x.date === date && x.slot === slot);
  assert.equal(ch('2026-11-22', 'dinner')!.after, 'Нут с булгуром и овощами');
  assert.equal(ch('2026-11-23', 'lunch')!.after, 'Индейка с гречкой и морковью');
  assert.equal(ch('2026-11-22', 'breakfast'), undefined);
  // 25–29.11 и дальше; тренировки не меняются
  for (const x of ['2026-11-25', '2026-11-26']) assert.ok(after.planDays[x].tripId && !after.planDays[x].mealCards);
  assert.ok(!Object.values(after.cookingEvents).some((e) => e.date === '2026-11-25' || e.date === '2026-11-26'));
  assert.equal(J(after.planDays['2026-11-29']), J(before.planDays['2026-11-29']), '29.11 — релакс без изменений');
  for (const x of ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-27', '2026-11-28', '2026-11-30']) assert.equal(J(scheduledTraining(after, x)), J(scheduledTraining(before, x)), `тренировка ${x}`);
  const c03 = after.cookingEvents['cook-p20261116-cook-03'];
  assert.deepEqual([c03.date, c03.time], ['2026-11-27', '07:00']);
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].date, '2026-11-24', 'докупка перед командировкой — к 27–28.11');
  const t2 = after.shoppingEvents[r.extra[0].id];
  assert.ok((t2.lines ?? []).filter((l) => l.buy > 0).every((l) => l.needs.every((n) => (n.use ?? n.date) > '2026-11-24' && /2[78]\.11/.test(n.label))), 'только для 27–28.11');
  assert.ok(r.main && r.main.date === '2026-11-29');
  assert.ok(r.main!.covered.some((x) => /Гречка/.test(x)), 'гречки хватает — не покупать');
  // прошедшее и пользовательские записи
  for (const id of Object.keys(before.shoppingEvents)) if (before.shoppingEvents[id].date < TODAY) assert.equal(J(after.shoppingEvents[id]), J(before.shoppingEvents[id]), id);
  for (const x of Object.keys(before.planDays)) if (x < TODAY) assert.equal(J(after.planDays[x]), J(before.planDays[x]), x);
  for (const s of ['weights', 'photos', 'trainingLogs', 'trips', 'templateVersions', 'measurements'] as const) assert.equal(J(after[s]), J(before[s]), s);
  assert.equal(correctionPending(after, TODAY), false);
  assert.ok(correctionApplied(after) && after.settings.corrections?.[CORR_ID]);
  assert.equal(after.backups[after.settings.correctionReportUnseen!].correctionReport!.id, CORR_REV);
  assert.equal(dataMigrationOps(after, TODAY, AT).length, 0);
  assert.equal(replanOps(after, after.settings.plan!, TODAY, { keepPast: true }).ops.length, 0, 'пересчёт без изменений ничего не меняет');
});

test('рецепты не дублируются: новые блюда — по одному разу, прежнее (индейка с булгуром) — только в истории', () => {
  const ids = SEED_RECIPES.map((r) => r.id);
  assert.equal(ids.length, new Set(ids).size);
  const titles = SEED_RECIPES.map((r) => r.title);
  assert.equal(titles.length, new Set(titles).size, 'нет двух рецептов с одним названием');
  for (const id of ['X02', 'X03', 'X04']) assert.equal(ids.filter((x) => x === id).length, 1, id);
  assert.ok(!ids.includes('X01'));
  assert.deepEqual(SEED_RECIPES.filter((r) => ['X02', 'X03', 'X04'].includes(r.id)).map((r) => r.title).sort(), ['Индейка с гречкой и морковью', 'Курица с рисом и брокколи', 'Нут с булгуром и овощами']);
});

test('запасы: планирование ничего не списывает; минусов нет', () => {
  const { after } = applied();
  const s = (pid: string) => stockSummary(after.stock[pid], TODAY);
  assert.deepEqual([s('chicken').bought, s('chicken').remaining, after.stock.chicken.location], [878, 518, 'freezer']);
  assert.deepEqual([s('turkey').bought, s('turkey').remaining], [894, 714]);
  assert.deepEqual([s('chickpeas').remaining, s('bulgur').remaining, s('buckwheat').remaining], [400, 500, 900]);
  for (const pid of ['pollock', 'egg', 'potato', 'oliveoil', 'beef_mince', 'turkey_mince', 'trout']) assert.equal(stockRemaining(after, pid), 0, `${pid}: не придумывается`);
  for (const rec of Object.values(after.stock)) assert.ok(stockLots(rec).every((l) => l.qty >= 0), rec.productId);
  assert.ok(!Object.values(after.stock).some((r) => r.moves.some((m) => (m.source ?? "").startsWith(`cook:${C22}`) || (m.source ?? "").startsWith(`cook:${C23}`))), 'готовки не отмечены — не списано');
});

test('«Приготовлено» 22.11 списывает ровно по рецептам; повтор и отмена — без двойного списания', () => {
  const { after } = applied();
  const e = after.cookingEvents[C22];
  const r = cookStockOps(after, e, true, AT);
  assert.deepEqual(r.deficits, []);
  const cooked = applyOps(after, [...r.ops, mark(`cook:${C22}`, e.date, 'done')]);
  const used = (pid: string) => Math.round(stockRemaining(after, pid) - stockRemaining(cooked, pid));
  assert.deepEqual(['turkey', 'chickpeas', 'bulgur', 'buckwheat', 'carrot', 'onion', 'pepper'].map(used), [360, 400, 70, 150, 333, 114, 94]);
  assert.equal(Math.round(stockRemaining(cooked, 'turkey')), 354);
  assert.equal(used('chicken'), 0, 'курица — 23.11');
  const again = applyOps(cooked, cookStockOps(cooked, e, true, AT).ops);
  assert.equal(stockRemaining(again, 'turkey'), stockRemaining(cooked, 'turkey'));
  const undone = applyOps(cooked, cookStockOps(cooked, e, false, AT).ops);
  assert.equal(stockRemaining(undone, 'turkey'), stockRemaining(after, 'turkey'));
  // перец испортился — замена морковью при готовке
  const noPepper = cookStockOps(after, e, true, AT, { pepper: 'carrot' });
  const np = applyOps(after, noPepper.ops);
  assert.equal(stockRemaining(np, 'pepper'), stockRemaining(after, 'pepper'));
  // готовая еда: 3 порции; обед 23.11 пропущен — порция остаётся
  const ready = readyFood(cooked, TODAY);
  assert.deepEqual(ready.map((p) => `${p.dishId} ${p.date.slice(8)} ${p.slot}`), ['X03 22 dinner', 'X04 23 lunch', 'X04 24 lunch']);
  const left = applyOps(cooked, [mark('meal:2026-11-23:lunch', '2026-11-23', 'skipped')]);
  const p = readyFood(left, '2026-11-23').find((x) => x.date === '2026-11-23' && x.slot === 'lunch')!;
  assert.deepEqual([p.state, p.safeUntil], ['left', '2026-11-25']);
  assert.ok(!readyFood(applyOps(left, readyFoodOps(p, 'writeoff', AT)), '2026-11-23').some((x) => x.id === p.id));
  // «Съедено» у свежего блюда списывает, «Пропущено» — нет
  const y0 = stockRemaining(cooked, 'yogurt');
  assert.ok(stockRemaining(applyOps(cooked, mealStockOps(cooked, '2026-11-23', 'breakfast', 'done', AT)), 'yogurt') < y0);
  assert.equal(stockRemaining(applyOps(cooked, mealStockOps(cooked, '2026-11-23', 'breakfast', 'skipped', AT)), 'yogurt'), y0);
});

test('проверка запасов: чего нет — предупреждение и замена, без выдуманных остатков и без закупки на 22–24.11', () => {
  const d = device();
  // для завтраков 23–24.11 спрашиваем то, чего нет по учёту
  assert.deepEqual(menuMissing(d, AT, TODAY).map((m) => m.pid), ['curd', 'bread', 'avocado', 'egg', 'tomato', 'cherry', 'banana']);
  // хлеб есть, творог годен до 25.11 — перекус 23.11 остаётся по меню
  const kept = buildCorrection(d, TODAY, AT, { ...emptyInput(), remaining: { bread: 400 }, expiry: { curd: '2026-11-25' } });
  assert.equal(kept.picks.find((p) => p.date === '2026-11-23' && p.slot === 'snack')!.dishId, 'S05');
  // перец испортился: ужин 22.11 остаётся, перец — заменить морковью
  const pepper = buildCorrection(d, TODAY, AT, { ...emptyInput(), spoiled: ['pepper'] }).report;
  const pc = pepper.checks!.find((x) => x.productId === 'pepper')!;
  assert.equal(pc.state, 'short');
  assert.match(pc.text, /без перца: вместо него ещё 80 г моркови/);
  assert.equal(pepper.noPurchaseUntil, '2026-11-24', 'перец не обязателен — закупка не нужна');
  // индейки нет: предупреждение, замены нет, в закупку не добавлено
  const noTurkey = buildCorrection(d, TODAY, AT, { ...emptyInput(), spoiled: ['turkey'] });
  const tc = noTurkey.report.checks!.find((x) => x.productId === 'turkey')!;
  assert.deepEqual([tc.state, tc.haveText], ['short', 'нет']);
  assert.match(tc.text, /автоматически в закупку не добавлено/);
  assert.equal(noTurkey.report.noPurchaseUntil, null);
  assert.equal(stockRemaining({ ...d, stock: noTurkey.stock } as AppData, 'turkey'), 0);
  const after = applyOps(d, noTurkey.ops);
  assert.ok(!Object.values(after.shoppingEvents).some((e) => e.date <= '2026-11-24' && e.date >= TODAY && (e.lines ?? []).some((l) => l.productId === 'turkey' && l.buy > 0)));
  // риса меньше — замена гречкой (её хватает)
  const rice = buildCorrection(d, TODAY, AT, { ...emptyInput(), remaining: { rice: 100 } }).report.checks!.find((x) => x.productId === 'rice')!;
  assert.match(rice.text, /замена: гречка/);
  // масло есть дома — не покупать
  assert.ok(buildCorrection(d, TODAY, AT, emptyInput()).report.extra.flatMap((e) => e.lines).some((l) => /Масло оливковое/.test(l.name)));
  assert.ok(!buildCorrection(d, TODAY, AT, { ...emptyInput(), remaining: { oliveoil: 300 } }).report.extra.flatMap((e) => e.lines).some((l) => /Масло оливковое/.test(l.name)));
  const spent = buildCorrection(d, TODAY, AT, { ...emptyInput(), spent: 9100 }).report;
  assert.deepEqual([spent.budget.spent, spent.budget.spentActual], [9100, true]);
});

test('если применяют на день позже, готовка 22.11 и её порции на месте', () => {
  const { after } = applied(device(), '2026-11-23', '2026-11-23T08:00:00.000Z');
  assert.ok(after.cookingEvents[C22]);
  assert.equal(card(after, '2026-11-22', 'dinner').parts[0].cookEventId, C22);
  assert.equal(card(after, '2026-11-23', 'lunch').parts[0].cookEventId, C22);
  assert.equal(after.taskStatus['cook:' + C22], undefined, 'готовка 22.11 не отмечается сама');
  assert.match(after.cookingEvents[C23].timeNote!, /не переложили в холодильник с вечера 22\.11/);
});

test('устройство с первой редакцией: обновление меню без пересоздания запасов и отметок', () => {
  const d = deviceR1();
  assert.equal(firstRevisionApplied(d), true);
  assert.equal(correctionPending(d, TODAY), true, 'снова ждёт подтверждения');
  assert.equal(revisionBlocked(d), null);
  assert.equal(card(d, '2026-11-22', 'dinner').parts[0].dishId, 'X01');
  // пользователь съел перекус 22.11 после первой редакции — списано по факту
  const d2 = applyOps(d, [mark('meal:2026-11-22:snack', TODAY, 'done'), ...mealStockOps(d, TODAY, 'snack', 'done', AT)]);
  const { c, after } = applied(d2);
  assert.equal(c.report.revision, true);
  assert.deepEqual(c.report.marks, [], 'новых отметок нет');
  assert.equal(J(after.taskStatus), J(d2.taskStatus), 'отметки не тронуты');
  assert.equal(J(after.stock), J(d2.stock), 'запасы не пересоздаются');
  assert.ok(after.stock.yogurt.moves.some((m) => m.source === 'meal:2026-11-22:snack'));
  assert.equal(after.cookingEvents[R1], undefined, 'готовка первой редакции убрана');
  assert.deepEqual(after.cookingEvents[C22].items!.map((i) => `${i.dishId}×${i.qty}`), ['X03×1', 'X04×2']);
  assert.deepEqual(after.cookingEvents[C23].items!.map((i) => `${i.dishId}×${i.qty}`), ['X02×2']);
  assert.equal(after.settings.plan!.overrides!.sourceId, CORR_REV);
  assert.ok(!J(Object.values(after.planDays).filter((x) => x.date >= TODAY)).includes('"X01"'), 'индейки с булгуром в плане нет');
  assert.equal(card(after, '2026-11-22', 'snack').parts[0].dishId, card(d2, '2026-11-22', 'snack').parts[0].dishId, 'съеденный перекус не меняется');
  assert.ok(c.report.dishes.some((x) => x.date === TODAY && x.slot === 'dinner' && x.before === 'Индейка с булгуром и овощами' && x.after === 'Нут с булгуром и овощами'));
  assert.ok(c.report.portions.some((x) => /первой редакции убрана/.test(x)));
  assert.match((c.ops[0] as any).put.reason, /вторая редакция/);
  assert.equal(correctionPending(after, TODAY), false);
  assert.equal(replanOps(after, after.settings.plan!, TODAY, { keepPast: true }).ops.length, 0);
  assert.equal(dataMigrationOps(after, TODAY, AT).length, 0);
});

test('устройство с первой редакцией: индейка с булгуром уже приготовлена — меню не заменяется', () => {
  const d = applyOps(deviceR1(), [mark(`cook:${R1}`, TODAY, 'done')]);
  assert.match(revisionBlocked(d)!, /уже отмечена «Приготовлено»/);
  assert.equal(correctionPending(d, TODAY), false);
  const ate = applyOps(deviceR1(), [mark('meal:2026-11-22:dinner', TODAY, 'done')]);
  assert.match(revisionBlocked(ate)!, /уже отмечена «Съедено»/);
});
