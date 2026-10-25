import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED } from '../src/lib/seed';
import { freshData } from './helpers';
import { resolveMeal } from '../src/domain/meals';
import { MEAL_SLOTS } from '../src/state/types';

test('seed: 30 дней 02.11–01.12, 28 рецептов без дублей', () => {
  assert.equal(SEED.calendar.length, 30);
  assert.equal(SEED.calendar[0].date, '2026-11-02');
  assert.equal(SEED.calendar[29].date, '2026-12-01');
  assert.equal(new Set(SEED.calendar.map((d: any) => d.date)).size, 30);
  assert.equal(SEED.recipes.length, 28);
  assert.equal(new Set(SEED.recipes.map((r: any) => r.id)).size, 28);
  assert.equal(new Set(SEED.recipes.map((r: any) => r.title)).size, 28);
});

test('seed: закупки 01.11 и 16.11, модельный бюджет 29 668 ₽', () => {
  const ev = SEED.shopping.shopping_events;
  assert.deepEqual(ev.map((e: any) => e.date), ['2026-11-01', '2026-11-16']);
  const total = ev.flatMap((e: any) => e.items).reduce((s: number, i: any) => s + i.price_estimate_rub, 0);
  assert.equal(Math.round(total), 29668);
});

test('seed: готовка только meal_prep, 28.11 — сдвинутая, 29.11 — не готовка', () => {
  const prep = SEED.cooking_events.filter((e: any) => e.event_type === 'meal_prep').map((e: any) => e.date);
  assert.ok(prep.includes('2026-11-28'));
  assert.ok(!prep.includes('2026-11-29'));
  assert.equal(SEED.cooking_events.find((e: any) => e.date === '2026-11-29').event_type, 'relax_day');
});

test('seed: в упражнениях нет гантелей, штанг, скамей', () => {
  for (const e of SEED.exercise_library) for (const eq of e.equipment) assert.ok(!/гантел|штанг|скам|тренаж/i.test(eq), eq);
});

test('seed: исходные блюда сохранены дословно (без подмены)', () => {
  const d = freshData();
  assert.equal(d.planDays['2026-11-02'].meals!.breakfast, 'Овсянка на ночь: йогурт, банан, лён, грецкий орех');
  assert.equal(d.planDays['2026-11-29'].relax, true);
  assert.equal(d.planDays['2026-11-29'].meals, null);
});

test('сопоставление блюд: каждое блюдо разобрано, без придуманных рецептов', () => {
  const d = freshData();
  let unknown = 0, recipe = 0;
  for (const day of Object.values(d.planDays)) {
    if (!day.meals) continue;
    for (const s of MEAL_SLOTS) {
      const parts = resolveMeal(d, s, day.meals[s]);
      assert.ok(parts.length >= 1);
      for (const p of parts) {
        if (p.status === 'recipe') { recipe++; assert.ok(p.recipe); }
        if (p.status === 'unknown') { unknown++; assert.equal(p.recipe, null); }
      }
    }
  }
  assert.ok(recipe > 50);
  assert.ok(unknown > 0, 'есть блюда «Нужно уточнить рецепт»');
});

test('миграции данных: примечание у «Апельсинов», старое поле настроек, фото раз в неделю', async () => {
  const { dataMigrationOps, applyOps } = await import('../src/state/model');
  let d = freshData();
  const ev = d.shoppingEvents['shop-2026-11-01'];
  d = applyOps(d, [
    { store: 'shoppingEvents', put: { ...ev, items: ev.items.map((it) => (it.itemId === 'p46' ? { ...it, note: 'старое примечание' } : it)) } },
    { store: 'settings', put: { ...d.settings, medicalAck: true, photo: { enabled: true, dayOfMonth: 2 } } as any },
    { store: 'meta', put: { ...d.meta!, dataVersion: 1 } },
  ]);
  const d2 = applyOps(d, dataMigrationOps(d));
  assert.deepEqual(d2.settings.photo, { enabled: true, weekday: 1 }, 'v3: фото раз в неделю');
  assert.equal(d2.shoppingEvents['shop-2026-11-01'].items.find((it) => it.itemId === 'p46')!.note, null);
  assert.equal('medicalAck' in d2.settings, false);
  assert.equal(d2.meta!.dataVersion, 3);
  assert.equal(dataMigrationOps(d2).length, 0, 'повторная миграция ничего не меняет');
});
