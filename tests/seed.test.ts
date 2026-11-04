import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED, SEED_RECIPES, AVAILABLE_KETTLEBELLS, seedTemplateVersions } from '../src/lib/seed';
import { DISHES, PRODUCTS, TEMPLATE, dishNutrition } from '../src/domain/catalog';
import { freshData } from './helpers';
import { MEAL_SLOTS } from '../src/state/types';

test('шаблон меню: 30 дней, релакс-день 28, 116 приёмов пищи с конкретными блюдами', () => {
  assert.equal(TEMPLATE.days.length, 30);
  assert.equal(TEMPLATE.base_start, '2026-11-02');
  assert.equal(TEMPLATE.relax_day, 28);
  const menuDays = TEMPLATE.days.filter((d) => !d.relax);
  assert.equal(menuDays.length, 29);
  let meals = 0;
  for (const d of menuDays) for (const s of MEAL_SLOTS) { assert.ok(d.meals![s].parts.length >= 1); meals++; }
  assert.equal(meals, 116);
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
  assert.equal(SEED_RECIPES.length, TEMPLATE.dishes.length, 'каждое блюдо — карточка рецепта');
});

test('меню: нет общих слов «гарнир», «салат», «фрукты» без состава', () => {
  for (const d of TEMPLATE.dishes) assert.ok(!/^(гарнир|салат|фрукты|овощи)$/i.test(d.title.trim()), d.title);
  for (const p of TEMPLATE.products) assert.ok(!/^(овощи|фрукты|ягоды|орехи|рыба|мясо|сыр|творог)$/i.test(p.name), p.name);
});

test('исключённые продукты отсутствуют', () => {
  const names = TEMPLATE.products.map((p) => p.name.toLowerCase()).join('|') + TEMPLATE.dishes.map((d) => d.title.toLowerCase()).join('|');
  for (const bad of ['мёд', 'мед ', 'дорад', 'сардин', 'алкогол', 'вино', 'пиво', 'кофе', 'энергетик', 'лимонад']) assert.ok(!names.includes(bad), bad);
});

test('калорийность дня ≈2450 ккал по справочным данным', () => {
  for (const d of TEMPLATE.days) {
    if (d.relax) continue;
    let k = 0;
    for (const s of MEAL_SLOTS) for (const p of d.meals![s].parts) k += dishNutrition(p.dish, p.qty).kcal;
    assert.ok(k > 2300 && k < 2600, `день ${d.day}: ${Math.round(k)}`);
  }
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

test('план со стартом 02.11: дни, релакс 29.11, карточки с граммовками', () => {
  const d = freshData();
  assert.equal(d.planDays['2026-11-02'].dayNumber, 1);
  assert.equal(d.planDays['2026-11-29'].relax, true);
  assert.equal(d.planDays['2026-11-29'].meals, null);
  const card = d.planDays['2026-11-02'].mealCards!.lunch;
  assert.equal(card.parts[0].dishId, 'chicken_lemon_paprika');
  assert.ok(card.parts[0].cookEventId, 'порция из готовки');
  assert.equal(d.planDays['2026-12-02'], undefined);
});
