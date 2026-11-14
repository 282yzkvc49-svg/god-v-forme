import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshData, NOW } from './helpers';
import { applyOps, dataMigrationOps, emptyData, removedDates } from '../src/state/model';
import { menuUpdatePending } from '../src/domain/plan';
import { checkActiveData } from '../src/domain/planCheck';
import { buildReport } from '../src/domain/report';
import { buildShoppingExport } from '../src/domain/shopExport';
import { makeSub, productCheckOps } from '../src/domain/avCheck';
import { TEMPLATE, applyProductSubs } from '../src/domain/catalog';
import type { AppData } from '../src/state/types';

const TODAY = '2026-11-14';

/**
 * База устройства, где после версии 1.2.0 новое меню не применили: план со стартом 16.11, собранный версией 1.2.0
 * (коммит fde8436), плюс дни первого плана с 02.11 и две отметки пользователя. Как получена — tests/fixtures/README.md.
 */
function state120(): AppData {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/state_1.2.0.json', import.meta.url), 'utf8'));
  return { ...emptyData(), ...raw, ready: true } as AppData;
}

const reportJson = (d: AppData) => JSON.stringify(buildReport(d, {
  from: '2026-11-16', to: '2026-12-15', today: TODAY, appVersion: 't', generatedAt: NOW,
  include: { weights: true, workouts: true, nutrition: true, notes: true }, notes: '', photos: [],
} as any).json);

test('источник скумбрии: план версии 1.2.0 в локальной базе — те же даты, что в экспорте отчёта', () => {
  const d = state120();
  assert.equal(d.settings.plan!.startDate, '2026-11-16');
  assert.equal(d.settings.plan!.menuId, undefined, 'план собран до меню «Азбука вкуса»');
  assert.equal(menuUpdatePending(d), true);
  assert.deepEqual(removedDates(d, TODAY), {
    days: ['2026-11-28', '2026-11-30', '2026-12-07', '2026-12-08', '2026-12-09'],
    cooks: ['2026-11-28', '2026-12-07'],
    shops: ['2026-11-15', '2026-12-01'],
  });
  assert.ok(/Скумбрия/.test(reportJson(d)), 'в отчёте за 16.11–15.12 — скумбрия из сохранённого плана');
  // в данных, которые приходят с приложением, активной скумбрии нет: только архивное блюдо для истории
  assert.ok(TEMPLATE.dishes.filter((x) => /скумбри/i.test(x.title)).every((x) => x.archived));
  assert.ok(TEMPLATE.products.filter((p) => /скумбри/i.test(p.name)).every((p) => p.archived));
});

test('запуск новой версии на базе 1.2.0: копия, меню v2, без скумбрии в меню, готовках, закупках и отчёте; история цела', () => {
  const before = state120();
  const after = applyOps(before, dataMigrationOps(before, TODAY, NOW, '1.5.0'));
  assert.equal(menuUpdatePending(after), false);
  assert.equal(after.settings.plan!.startDate, '2026-11-16');
  assert.equal(after.settings.plan!.menuId, TEMPLATE.id);
  // копия всего прежнего плана и отчёт
  const bk = after.backups[after.settings.menuReportUnseen!];
  assert.equal(bk.stores.planDays.length, Object.keys(before.planDays).length);
  assert.equal(bk.stores.cookingEvents.length, Object.keys(before.cookingEvents).length);
  assert.equal(bk.report!.auto, true);
  assert.deepEqual(bk.report!.mackerelDates!.days, ['2026-11-28', '2026-11-30', '2026-12-07', '2026-12-08', '2026-12-09']);
  assert.deepEqual(bk.report!.mackerelDates!.cooks, ['2026-11-28', '2026-12-07']);
  // активные данные и отчёт
  const check = checkActiveData(after, TODAY);
  assert.ok(check.ok, check.details.join('; '));
  assert.deepEqual(removedDates(after, TODAY), { days: [], cooks: [], shops: [] });
  assert.ok(!/скумбри/i.test(reportJson(after)), 'в отчёте за 16.11–15.12 скумбрии нет');
  // новый план: 8 готовок, 48 порций обедов и ужинов, 2 основные закупки
  const cooks = Object.values(after.cookingEvents).filter((e) => e.date >= TODAY && e.eventType === 'meal_prep');
  assert.equal(cooks.length, 8);
  assert.equal(cooks.reduce((s, e) => s + (e.items ?? []).reduce((x, i) => x + i.qty, 0), 0), 48);
  assert.deepEqual(Object.values(after.shoppingEvents).filter((e) => e.date >= TODAY && e.kind === 'main').map((e) => e.date).sort(), ['2026-11-15', '2026-11-29']);
  // история: отмеченный обед 10.11 со скумбрией остался; прошедший день 09.11 не удалён
  assert.equal(after.taskStatus['meal:2026-11-10:lunch'].status, 'done');
  assert.match(after.planDays['2026-11-10'].meals!.lunch, /Скумбрия/);
  assert.ok(bk.report!.mackerel.keptHistory.some((x) => x.startsWith('10.11 обед')));
  assert.ok(after.planDays['2026-11-09']);
  assert.equal(after.planDays['2026-11-09'].meals!.dinner, 'Блюдо прежнего меню удалено');
  assert.equal(after.planDays['2026-11-09'].meals!.breakfast, before.planDays['2026-11-09'].meals!.breakfast);
  assert.equal(after.taskStatus['meal:2026-11-03:breakfast'].status, 'done');
  assert.equal(Object.keys(after.planDays).filter((x) => x < TODAY).length, Object.keys(before.planDays).filter((x) => x < TODAY).length, 'прошедшие дни не удалены');
  // повторный запуск ничего не меняет
  assert.equal(dataMigrationOps(after, TODAY, NOW).length, 0);
  // экспорт товаров: ни одной строки со скумбрией
  assert.ok(!/скумбри|mackerel/i.test(JSON.stringify(buildShoppingExport(after, TODAY, 't', NOW))));
});

test('экспорт всех товаров в JSON: каждая строка каждой закупки, со ссылкой av.ru, упаковками, датой и стоимостью', () => {
  const d = freshData('2026-11-14', '2026-11-16', true);
  const x = buildShoppingExport(d, TODAY, '1.5.0', NOW);
  const events = Object.values(d.shoppingEvents);
  const lines = events.reduce((s, e) => s + (e.lines ?? e.items).length, 0);
  assert.equal(x.items.length, lines, 'ни одна позиция не объединена и не пропущена');
  assert.equal(x.purchases.length, events.length);
  assert.deepEqual(Array.from(new Set(x.purchases.map((p) => p.purchase_kind))).sort(), ['main', 'topup', 'trip']);
  for (const e of events) {
    const mine = x.items.filter((i) => i.purchase_id === e.id);
    assert.deepEqual(mine.map((i) => i.product_id), e.lines!.map((l) => l.productId), e.id);
    assert.ok(mine.every((i) => i.purchase_date === e.date && i.purchase_title === e.title));
  }
  for (const i of x.items) {
    assert.ok(i.name && i.product_id && i.unit && i.pack_label && i.pack_size, i.product_id);
    assert.match(i.av_url!, /^https:\/\/av\.ru\/i\/\d+\/?$/, i.product_id);
    assert.equal(i.av_card_number, /\/i\/(\d+)/.exec(i.av_url!)![1]);
    assert.equal(i.article, null, 'артикулов в комплекте нет — не придумываются');
    assert.equal(typeof i.planned_cost_rub, 'number');
    assert.ok(i.quantity_to_buy >= 0);
    assert.ok(i.packs == null || i.packs >= 0);
    assert.equal(i.archived_product, false);
  }
  const chicken = x.items.find((i) => i.product_id === 'chicken' && i.purchase_kind === 'main')!;
  assert.equal(chicken.av_url, 'https://av.ru/i/572843');
  assert.equal(chicken.pack_label, 'лоток 865 г');
  assert.equal(chicken.availability_check, 'unchecked');
  // суммы совпадают с разделом «Закупки»
  const home = events.filter((e) => e.kind !== 'trip').reduce((s, e) => s + e.lines!.reduce((t, l) => t + l.cost, 0), 0);
  assert.equal(x.totals.planned_cost_rub_home, Math.round(home));
  assert.ok(x.products.length >= 48 && new Set(x.products.map((p) => p.product_id)).size === x.products.length);
  // подтверждённая замена — видно и новый товар, и исходный
  const { sub } = makeSub('chicken', { catalogId: 'turkey', name: '', url: '', packSize: 0, packPrice: 0 }, NOW);
  const d2 = applyOps(d, productCheckOps(d, 'chicken', { status: 'unavailable', sub }, TODAY, NOW));
  applyProductSubs(d2.avProducts);
  try {
    const y = buildShoppingExport(d2, TODAY, '1.5.0', NOW);
    const c = y.items.find((i) => i.product_id === 'chicken' && i.purchase_kind === 'main')!;
    assert.equal(c.av_url, 'https://av.ru/i/461436');
    assert.equal(c.availability_check, 'replaced');
    assert.match(c.substitution!.original_name, /Петелинка/);
    assert.equal(c.substitution!.original_av_url, 'https://av.ru/i/572843');
  } finally {
    applyProductSubs(d.avProducts);
  }
});
