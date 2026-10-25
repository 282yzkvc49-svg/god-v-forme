import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_RECIPES } from '../src/lib/seed';
import { parseIngredientLine, scaleRecipe, stepChips } from '../src/domain/scale';

const r = (id: string) => SEED_RECIPES.find((x) => x.id === id)!;

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
