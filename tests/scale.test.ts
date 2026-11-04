import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_RECIPES } from '../src/lib/seed';
import { parseIngredientLine, scaleRecipe, stepChips } from '../src/domain/scale';
import { ingredientLines } from '../src/domain/catalog';
import type { Recipe } from '../src/state/types';

// Пересчёт текстовых рецептов (свои рецепты пользователя и импорт) — на примерах первой версии плана.
const ing = (t: string) => parseIngredientLine(t);
const mk = (id: string, servings: number | null, lines: string[], yieldText = `${servings} порции`): Recipe => ({
  id, title: id, type: 'main', type_label: 'Основное', yield_text: yieldText, servings, scalable: servings != null,
  ingredients_text: lines.join('; '), ingredients: lines.map(ing), method_text: '', steps: [], storage_ids: [], source: 'тест',
});
const OLD: Record<string, Recipe> = {
  chicken_lemon_paprika: mk('chicken_lemon_paprika', 3, ['600 г грудки', 'сок 1/2 лимона', 'паприка 0,75 ч.л.']),
  turkey_chili: mk('turkey_chili', 4, ['700 г фарша индейки', '2 банки фасоли']),
  trout: mk('trout', 1, ['180–200 г форели']),
  omelet_lavash: mk('omelet_lavash', 1, ['2 яйца']),
  grains: mk('grains', null, ['210–240 г сухой крупы'], '3–4 порции'),
};
OLD.chicken_lemon_paprika.ingredients[1] = { source_text: 'сок 1/2 лимона', qty: null, qty_max: null, unit: null, name: 'сок 1/2 лимона' };
OLD.chicken_lemon_paprika.ingredients[2] = { source_text: 'паприка 0,75 ч.л.', qty: 0.75, qty_max: null, unit: 'ч.л.', name: 'паприка' };
OLD.turkey_chili.ingredients[1] = { source_text: '2 банки фасоли', qty: 2, qty_max: null, unit: 'банка', name: 'фасоли' };
OLD.omelet_lavash.ingredients[0] = { source_text: '2 яйца', qty: 2, qty_max: null, unit: 'шт.', name: 'яйца' };
const r = (id: string) => OLD[id];

test('блюда меню: граммовки на порцию и на партию, яйца в штуках', () => {
  assert.ok(SEED_RECIPES.find((x) => x.id === 'turkey_meatballs'));
  const one = ingredientLines('turkey_meatballs', 1);
  assert.equal(one.find((l) => l.productId === 'turkey_mince')!.amount, '200 г');
  assert.equal(one.find((l) => l.productId === 'egg')!.amount, '⅓ шт.');
  const batch = ingredientLines('turkey_meatballs', 3, true);
  assert.equal(batch.find((l) => l.productId === 'turkey_mince')!.amount, '600 г');
  assert.equal(batch.find((l) => l.productId === 'egg')!.amount, '1 шт.');
  const rice = ingredientLines('grain_rice', 90);
  assert.equal(rice[0].amount, '90 г');
});

test('пересчёт структурированных количеств на порции', () => {
  const s = scaleRecipe(r('chicken_lemon_paprika'), 1); // 3 → 1
  assert.ok(s.canScale);
  assert.equal(s.items[0].text, '200 г грудки');
  assert.equal(s.items[1].text, 'сок 1/2 лимона', 'текст без количества не пересчитывается');
  assert.ok(s.items[1].textOnly);
  assert.equal(s.items[2].text, 'паприка 0,25 ч.л.');
  const chili = scaleRecipe(r('turkey_chili'), 2); // 4 → 2
  assert.equal(chili.items[0].text, '350 г фарша индейки');
  assert.equal(chili.items[1].text, '1 банка фасоли');
  const fish = scaleRecipe(r('trout'), 2);
  assert.equal(fish.items[0].text, '360–400 г форели');
  const eggs = scaleRecipe(r('omelet_lavash'), 3);
  assert.equal(eggs.items[0].text, '6 яиц');
});

test('рецепт с выходом «3–4 порции» не пересчитывается — показывается исходный текст', () => {
  const s = scaleRecipe(r('grains'), 2);
  assert.equal(s.canScale, false);
  assert.equal(s.items[0].text, '210–240 г сухой крупы');
  assert.ok(s.reason);
});

test('температура и время из текста шага', () => {
  assert.deepEqual(stepChips('Гриль 5–7 мин с каждой стороны или аэрогриль 190°C 10–14 мин до готовности.'), { temps: ['190°C'], times: ['5–7 мин', '10–14 мин'] });
});

test('разбор строки ингредиента пользователя', () => {
  assert.deepEqual(parseIngredientLine('200 г творога'), { source_text: '200 г творога', qty: 200, qty_max: null, unit: 'г', name: 'творога' });
  assert.equal(parseIngredientLine('корица по вкусу').qty, null);
  assert.equal(parseIngredientLine('паприка 1 ч.л.').unit, 'ч.л.');
});
