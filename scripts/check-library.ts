// Автоматическая проверка библиотеки рецептов. Запуск: npm run check:library
// Пишет src/data/library/check_report.json (отпечатки проверенных редакций) и печатает итог.
// Код возврата 1 — если есть рецепты с ошибками (они не считаются проверенными).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS, buyInfo, libEff } from '../src/domain/catalog';
import { checkLibrary, checkRecipe, type LibRecipe } from '../src/domain/recipeCheck';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/data/library');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as LibRecipe[];
const recipes = [...load('breakfasts.json'), ...load('snacks.json'), ...load('mains.json')];
const res = checkLibrary(recipes, PRODUCTS);
// рецепт «как готовить сейчас»: товары, которых нет на av.ru, заменены — нормы КБЖУ должны выполняться и с заменой
const short = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[«,(]/)[0].trim().toLowerCase();
let withSubs = 0;
const blocked: Record<string, string[]> = {};
for (const c of res.checks) {
  const r = recipes.find((x) => x.id === c.id)!;
  const { r: e, subs } = libEff(r);
  if (subs.length) {
    withSubs++;
    c.warnings.push(`на av.ru нет: ${subs.map((x) => `${short(x.from)} → ${short(x.to)}${x.toQ !== x.q ? ` (${x.toQ} г вместо ${x.q})` : ''}`).join(', ')}`);
    const ce = checkRecipe(e, PRODUCTS);
    for (const err of ce.errors.filter((x) => /ккал|белок|жиры/.test(x))) { c.errors.push(`с заменой: ${err}`); c.ok = false; }
  }
  const miss = [...new Set(e.ingredients.map((i) => i.p))].filter((pid) => buyInfo(pid).status !== 'listed');
  if (miss.length) { c.warnings.push(`пока не в меню — нет на av.ru и без замены: ${miss.map(short).join(', ')}`); blocked[c.id] = miss; }
}
for (const k of Object.keys(res.counts) as (keyof typeof res.counts)[]) res.counts[k].ok = res.checks.filter((c, i) => c.ok && recipes[i].kind === k).length;
const now = process.env.CHECK_DATE ?? new Date().toISOString();
const out = {
  checkedAt: now,
  counts: res.counts,
  recipes: res.checks.map((c) => ({ id: c.id, hash: c.hash, ok: c.ok, errors: c.errors, warnings: c.warnings, kcal: c.nutr.kcal, p: c.nutr.p, f: c.nutr.f, c: c.nutr.c })),
};
if (!process.argv.includes('--dry')) fs.writeFileSync(path.join(dir, 'check_report.json'), JSON.stringify(out, null, 1) + '\n');
for (const c of res.checks) {
  const r = recipes.find((x) => x.id === c.id)!;
  console.log(`${c.ok ? '✓' : '✗'} ${c.id} ${r.title} — ${c.nutr.kcal} ккал, Б ${c.nutr.p} / Ж ${c.nutr.f} / У ${c.nutr.c}`);
  for (const e of c.errors) console.log(`    ошибка: ${e}`);
  for (const w of c.warnings) console.log(`    замечание: ${w}`);
}
const tot = Object.values(res.counts).reduce((a, x) => ({ total: a.total + x.total, ok: a.ok + x.ok }), { total: 0, ok: 0 });
console.log(`\nВсего ${tot.total}, прошли проверку ${tot.ok}: завтраки ${res.counts.breakfast.ok}/${res.counts.breakfast.total}, перекусы ${res.counts.snack.ok}/${res.counts.snack.total}, основные ${res.counts.main.ok}/${res.counts.main.total}`);
console.log(`С заменами товаров, которых нет на av.ru: ${withSubs}. Пока не могут попасть в меню (товар не найден и замены нет): ${Object.keys(blocked).length}${Object.keys(blocked).length ? ` — ${Object.keys(blocked).join(', ')}` : ''}`);
process.exit(tot.ok === tot.total ? 0 : 1);
