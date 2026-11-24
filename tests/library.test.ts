import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS } from '../src/domain/catalog';
import { checkLibrary, checkRecipe, recipeHash, type LibRecipe } from '../src/domain/recipeCheck';
import { LIBRARY, verifyState } from '../src/domain/recipeLib';

const base = (): LibRecipe => JSON.parse(JSON.stringify(LIBRARY.find((r) => r.id === 'm001')));

test('библиотека: все рецепты проверены в текущей редакции (отчёт не устарел)', () => {
  for (const r of LIBRARY) assert.equal(verifyState(r), 'verified', `${r.id} ${r.title}`);
});

test('библиотека: повторная проверка совпадает с отчётом', () => {
  const res = checkLibrary(LIBRARY, PRODUCTS);
  for (const c of res.checks) assert.deepEqual(c.errors, [], `${c.id}: ${c.errors.join('; ')}`);
  assert.equal(res.duplicates.length, 0);
});

test('проверка ловит технику, которой нет', () => {
  for (const word of ['духовке', 'блендером', 'мультиварке', 'пароварке', 'миксером', 'чайнике', 'микроволновке']) {
    const r = base();
    r.steps[0].t = `Подготовить всё в ${word} заранее.`;
    assert.ok(checkRecipe(r, PRODUCTS).errors.some((e) => e.includes('техника')), word);
  }
  const r = base();
  r.equipment.push('мультиварка' as never);
  assert.ok(checkRecipe(r, PRODUCTS).errors.some((e) => e.includes('не подтверждено')));
});

test('проверка ловит исключённые продукты, но не «медальоны» и «без сахара»', () => {
  const r = base();
  r.steps[0].t = 'Курицу смазать мёдом и обжарить.';
  assert.ok(checkRecipe(r, PRODUCTS).errors.some((e) => e.includes('исключённый')));
  const s = base();
  s.steps[0].t = 'Нарезать медальонами; соус без сахара.';
  assert.deepEqual(checkRecipe(s, PRODUCTS).errors, []);
  const m = base();
  m.ingredients[0] = { p: 'mackerel_fillet', q: 600 };
  assert.ok(checkRecipe(m, PRODUCTS).errors.some((e) => e.includes('исключённый') || e.includes('убран')));
});

test('проверка: ккал и белок по нормам, данные ингредиентов, температура и время', () => {
  const r = base();
  r.ingredients = r.ingredients.filter((i) => i.p !== 'chicken');
  assert.ok(checkRecipe(r, PRODUCTS).errors.some((e) => e.includes('белок')));
  const u = base();
  u.ingredients.push({ p: 'unknown_product', q: 10 });
  const cu = checkRecipe(u, PRODUCTS);
  assert.ok(cu.errors.some((e) => e.includes('отсутствует')) && cu.errors.some((e) => e.includes('требует уточнения')));
  const t = base();
  delete t.steps[2].temp;
  assert.ok(checkRecipe(t, PRODUCTS).errors.some((e) => e.includes('температура')));
});

test('проверка: хранение рыбы, повтор состава и названия', () => {
  const fish = JSON.parse(JSON.stringify(LIBRARY.find((r) => r.id === 'm004'))) as LibRecipe;
  fish.storage.fridge_days = 3;
  assert.ok(checkRecipe(fish, PRODUCTS).errors.some((e) => e.includes('2 суток')));
  const copy = base();
  copy.id = 'm999';
  copy.title = 'Курица по-индийски с рисом';
  const res = checkLibrary([base(), copy], PRODUCTS);
  assert.ok(res.checks[1].errors.some((e) => e.includes('почти тот же состав')));
  const same = base(); same.id = 'm998';
  same.ingredients = same.ingredients.map((i) => (i.p === 'chicken' ? { p: 'turkey', q: 700 } : i));
  const res2 = checkLibrary([base(), same], PRODUCTS);
  assert.ok(res2.checks[1].errors.some((e) => e.includes('то же название')));
});

test('отметка «проверено» снимается при любой правке рецепта', () => {
  const r = base();
  assert.equal(verifyState(r), 'verified');
  r.ingredients[0].q = 800;
  assert.notEqual(recipeHash(r), recipeHash(base()));
  assert.equal(verifyState(r), 'unchecked');
});
