import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED, SEED_RECIPES, AVAILABLE_KETTLEBELLS, seedTemplateVersions } from '../src/lib/seed';
import { DISHES, PRODUCTS, TEMPLATE, dishNutrition } from '../src/domain/catalog';
import { freshData } from './helpers';
import { MEAL_SLOTS } from '../src/state/types';

test('шаблон меню «Азбука вкуса»: 24 дня меню по 4 рецепта, 61 рецепт, 8 партий, старт 16.11', () => {
  assert.equal(TEMPLATE.id, 'azbuka-2026-11-16-30days-v1');
  assert.equal(TEMPLATE.base_start, '2026-11-16');
  assert.equal(TEMPLATE.length, 30);
  assert.equal(TEMPLATE.budget_rub, 50000);
  assert.equal(TEMPLATE.days.length, 24);
  for (const d of TEMPLATE.days) for (const s of MEAL_SLOTS) assert.equal(d.meals![s].parts.length, 1, `день ${d.day} ${s}`);
  assert.equal(new Set(TEMPLATE.days.map((d) => d.meals!.breakfast.parts[0].dish)).size, 24, '24 разных завтрака');
  assert.equal(TEMPLATE.dishes.filter((d) => !d.archived).length, 61);
  assert.equal(TEMPLATE.blocks.length, 8);
  const portions = TEMPLATE.blocks.reduce((n, b) => n + b.items.reduce((m, i) => m + i.uses.length, 0), 0);
  assert.equal(portions, 48, '48 обедов и ужинов из партий');
  const src = TEMPLATE.source!;
  assert.equal(src.calendar.length, 30);
  assert.equal(src.orders.reduce((x, o) => x + o.subtotal, 0).toFixed(2), '38653.20');
});

test('товары av.ru: ссылка, статус ссылки, фасовка и цена упаковки; наличие не проверено', () => {
  const av = TEMPLATE.products.filter((p) => !p.archived);
  assert.equal(av.length, 49);
  for (const p of av) {
    assert.match(p.url!, /^https:\/\/av\.ru\//, p.id);
    assert.ok(['individual_product_page', 'category_listing'].includes(p.listing_status!), p.id);
    assert.equal(p.availability, 'not_verified');
    assert.ok(p.pack.size > 0 && p.pack_price! > 0, p.id);
  }
  assert.equal(av.filter((p) => p.listing_status === 'category_listing').length, 2);
  for (const d of TEMPLATE.dishes.filter((x) => !x.archived)) for (const i of d.ingredients) assert.ok(PRODUCTS[i.product]?.url, `${d.id}: ${i.product}`);
});

test('блюда: у каждого ингредиенты с количеством, известные продукты и шаги рецепта', () => {
  for (const d of TEMPLATE.dishes) {
    assert.ok(d.steps.length > 0, d.id);
    assert.ok(d.ingredients.length > 0, d.id);
    for (const i of d.ingredients) {
      assert.ok(i.qty > 0, `${d.id}: ${i.product}`);
      assert.ok(PRODUCTS[i.product] || DISHES[i.product], `${d.id}: ${i.product}`);
    }
  }
  assert.equal(new Set(TEMPLATE.dishes.map((d) => d.id)).size, TEMPLATE.dishes.length);
  assert.equal(SEED_RECIPES.length, TEMPLATE.dishes.filter((d) => !d.archived).length, 'каждое блюдо меню — карточка рецепта');
  assert.ok(!SEED_RECIPES.some((r) => DISHES[r.id]?.archived), 'архивных блюд нет в списке рецептов');
});

test('меню: нет общих слов «гарнир», «салат», «фрукты» без состава', () => {
  for (const d of TEMPLATE.dishes) assert.ok(!/^(гарнир|салат|фрукты|овощи)$/i.test(d.title.trim()), d.title);
  for (const p of TEMPLATE.products) assert.ok(!/^(овощи|фрукты|ягоды|орехи|рыба|мясо|сыр|творог)$/i.test(p.name), p.name);
});

test('исключённые продукты отсутствуют', () => {
  const names = TEMPLATE.products.map((p) => p.name.toLowerCase()).join('|') + TEMPLATE.dishes.map((d) => d.title.toLowerCase()).join('|');
  for (const bad of ['мёд', 'мед ', 'дорад', 'сардин', 'алкогол', 'вино', 'пиво', 'кофе', 'энергетик', 'лимонад']) assert.ok(!names.includes(bad), bad);
});

test('калорийность: расчёт по продуктам совпадает с оценками комплекта (≈2389 ккал в среднем, 2139–2559)', () => {
  const ks: number[] = [];
  for (const d of TEMPLATE.days) {
    let k = 0;
    for (const s of MEAL_SLOTS) for (const p of d.meals![s].parts) k += dishNutrition(p.dish, p.qty).kcal;
    ks.push(k);
  }
  const avg = ks.reduce((a, b) => a + b, 0) / ks.length;
  assert.ok(Math.abs(avg - 2389.2) < 1, `${avg}`);
  assert.equal(Math.round(Math.min(...ks)), 2139);
  assert.equal(Math.round(Math.max(...ks)), 2559);
  for (const d of TEMPLATE.dishes.filter((x) => !x.archived)) assert.ok(Math.abs(dishNutrition(d.id, 1).kcal - d.nutrition_estimate!.kcal) < 1.5, d.id);
});

test('тренировки: только гири 12 и 16 кг, без весов 6, 8, 10, 14 кг', () => {
  assert.deepEqual(AVAILABLE_KETTLEBELLS, [12, 16]);
  const json = JSON.stringify(SEED.workout_templates);
  assert.ok(!/"weight_kg"/.test(json), 'старые диапазоны весов убраны');
  for (const v of seedTemplateVersions('x')) for (const it of v.template.items) {
    if (it.kettlebellKg != null) assert.ok([12, 16].includes(it.kettlebellKg));
    if (it.fallbackKg != null) assert.ok([12, 16].includes(it.fallbackKg));
  }
  const b = seedTemplateVersions('x').find((v) => v.templateId === 'strength_b')!.template;
  assert.equal(b.items.find((i) => i.exerciseId === 'kb_rdl')!.kettlebellKg, 16);
  assert.equal(b.items.find((i) => i.exerciseId === 'kb_rdl')!.fallbackKg, 12);
  assert.equal(b.items.find((i) => i.exerciseId === 'kb_floor_press')!.alternative!.exerciseId, 'incline_push_up');
  for (const e of SEED.exercise_library) for (const eq of e.equipment) assert.ok(!/гантел|штанг|скам|тренаж|разборн/i.test(eq), eq);
});

test('план со стартом 02.11 без поездок: дни, релакс 29.11, карточки с граммовками, меню идёт по кругу', () => {
  const d = freshData();
  assert.equal(d.planDays['2026-11-02'].dayNumber, 1);
  assert.equal(d.planDays['2026-11-29'].relax, true);
  assert.equal(d.planDays['2026-11-29'].meals, null);
  const card = d.planDays['2026-11-02'].mealCards!.lunch;
  assert.equal(card.parts[0].dishId, 'L01');
  assert.ok(card.parts[0].cookEventId, 'порция из готовки');
  // 29 домашних дней при 24 днях меню: с 26.11 меню начинается сначала, партии — целиком
  assert.equal(d.planDays['2026-11-25'].mealCards!.breakfast.parts[0].dishId, 'B24');
  assert.equal(d.planDays['2026-11-26'].mealCards!.breakfast.parts[0].dishId, 'B01');
  assert.equal(d.planDays['2026-12-01'].mealCards!.lunch.parts[0].dishId, 'L02');
  const second = Object.values(d.cookingEvents).filter((e) => e.blockId === 'cook-01');
  assert.equal(second.length, 2, 'первая партия меню готовится и во втором круге');
  assert.equal(d.planDays['2026-12-02'], undefined);
});
