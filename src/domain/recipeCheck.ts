// Библиотека рецептов: типы и автоматическая проверка (структура, ингредиенты, граммовки, ккал/БЖУ, оборудование,
// хранение, дубликаты). Чистые функции — их вызывают и скрипт проверки (scripts/check-library.ts), и приложение:
// «проверено» показывается, только если отпечаток текущей редакции рецепта совпадает с отчётом проверки.
import type { Nutr, Product } from './catalog';

export type LibKind = 'breakfast' | 'snack' | 'main';
export type Equip = 'аэрогриль' | 'электрогриль' | 'плита' | 'без нагрева';

export interface LibIngr { p: string; q: number; note?: string }
export interface LibStep { t: string; eq?: Equip; temp?: string; min?: string }
export interface LibStorage {
  fridge_days: number;
  freeze: boolean;
  freeze_months?: number;
  thaw?: string;
  reheat?: string;
  note?: string;
}
export interface LibRecipe {
  id: string;
  kind: LibKind;
  title: string;
  cuisine: string;
  protein: string;
  base?: string;
  servings: number;
  equipment: Equip[];
  utensils?: string[];
  ingredients: LibIngr[];
  steps: LibStep[];
  time: { active: number; total: number };
  /** Сколько минут занят каждый прибор — для параллельной недельной готовки. */
  load?: Partial<Record<Equip, number>>;
  storage: LibStorage;
  tags: string[];
}

export const EQUIP: Equip[] = ['аэрогриль', 'электрогриль', 'плита', 'без нагрева'];
export const KIND_LABEL: Record<LibKind, string> = { breakfast: 'Завтрак', snack: 'Перекус', main: 'Основное блюдо' };
export const CUISINES = [
  'русская', 'европейская', 'средиземноморская', 'итальянская', 'греческая', 'испанская', 'французская', 'скандинавская',
  'ближневосточная', 'турецкая', 'кавказская', 'польская', 'грузинская', 'узбекская', 'индийская', 'тайская', 'вьетнамская', 'индонезийская',
  'китайская', 'японская', 'корейская', 'мексиканская', 'американская (креольская)', 'американская', 'латиноамериканская',
  'северноафриканская',
];
export const PROTEINS = [
  'курица', 'индейка', 'говядина', 'свинина', 'белая рыба', 'жирная рыба', 'рыба', 'морепродукты', 'яйца', 'творог',
  'молочное', 'бобовые', 'смешанное',
];

/** Нормы на одну порцию. */
export const TARGETS: Record<LibKind, { kcal: [number, number]; pMin: number; activeMax: number; servings: [number, number] }> = {
  breakfast: { kcal: [480, 760], pMin: 30, activeMax: 10, servings: [1, 3] },
  snack: { kcal: [220, 460], pMin: 15, activeMax: 5, servings: [1, 3] },
  main: { kcal: [520, 800], pMin: 40, activeMax: 45, servings: [1, 6] },
};

/** Исключённые продукты (по согласованию): мёд, дорада, сардины, скумбрия, алкоголь, кофе, энергетики, лимонады, сахар. */
export const EXCLUDED_RE = /(^|[^а-яё])(мёд[а-яё]*|мед(?:а|у|ом|е|ов[а-яё]*)?|дорад[а-яё]*|сардин[а-яё]*|скумбри[а-яё]*|алкогол[а-яё]*|вино|вина|пиво|коньяк|кофе|энергетик[а-яё]*|лимонад[а-яё]*|сахар[а-яё]*)(?![а-яё])/i;
/** «Без сахара» — не упоминание сахара. */
export const hasExcluded = (text: string) => EXCLUDED_RE.test(` ${text.replace(/без (добавленного )?сахара/gi, '')}`);
export const EXCLUDED_IDS = ['mackerel_fillet'];
/** Техника, которой нет: только аэрогриль, электрогриль и плита. */
export const FORBIDDEN_EQUIP_RE = /духовк|духовом|духовой|мультиварк|пароварк|блендер|миксер|комбайн|мясорубк|микроволнов|свч|чайник|тостер|вафельниц|су-?вид|фритюр|гриль-сковород|хлебопеч/i;

const SEAFOOD_CAT = 'Рыба и морепродукты';
const MEAT_CAT = 'Мясо и птица';
const SPICE_CATS = ['Специи'];

export interface RecipeNutr extends Nutr { complete: boolean; missing: string[] }

/** Масса ингредиента в граммах (штуки → граммы по массе штуки). */
export function ingrGrams(p: Product, q: number): number {
  return p.unit === 'pcs' ? q * (p.piece_g ?? 0) : q;
}

/** Ккал и БЖУ на одну порцию — по данным ингредиентов каталога. */
export function recipeNutrition(r: LibRecipe, products: Record<string, Product>): RecipeNutr {
  const sum = { kcal: 0, p: 0, f: 0, c: 0 };
  const missing: string[] = [];
  for (const i of r.ingredients) {
    const p = products[i.p];
    const n = p?.nutr;
    if (!p || !n || ![n.kcal, n.p, n.f, n.c].every((x) => typeof x === 'number' && Number.isFinite(x))) { missing.push(i.p); continue; }
    const g = ingrGrams(p, i.q);
    if (p.unit === 'pcs' && !p.piece_g) { missing.push(i.p); continue; }
    sum.kcal += (g * n.kcal) / 100;
    sum.p += (g * n.p) / 100;
    sum.f += (g * n.f) / 100;
    sum.c += (g * n.c) / 100;
  }
  const k = Math.max(1, r.servings);
  return {
    kcal: Math.round(sum.kcal / k), p: Math.round((sum.p / k) * 10) / 10, f: Math.round((sum.f / k) * 10) / 10, c: Math.round((sum.c / k) * 10) / 10,
    complete: missing.length === 0, missing,
  };
}

/** Отпечаток редакции рецепта (FNV-1a по JSON с упорядоченными ключами) — меняется при любой правке. */
export function recipeHash(r: LibRecipe): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  const s = JSON.stringify(canon(r));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export interface RecipeCheck {
  id: string;
  hash: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  nutr: RecipeNutr;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();

/** Вектор «состава» на порцию (без специй, соли и масла) — для поиска повторов. */
function compVector(r: LibRecipe, products: Record<string, Product>): Map<string, number> {
  const v = new Map<string, number>();
  for (const i of r.ingredients) {
    const p = products[i.p];
    if (!p || SPICE_CATS.includes(p.category) || i.p === 'salt' || i.p === 'oliveoil') continue;
    v.set(i.p, (v.get(i.p) ?? 0) + ingrGrams(p, i.q) / Math.max(1, r.servings));
  }
  return v;
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; if (b.has(k)) dot += x * (b.get(k) as number); }
  for (const x of b.values()) nb += x * x;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Проверка одного рецепта (без сравнения с другими). */
export function checkRecipe(r: LibRecipe, products: Record<string, Product>): RecipeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);
  const t = TARGETS[r.kind];

  // структура
  const idRe = { breakfast: /^b\d{3}$/, snack: /^s\d{3}$/, main: /^m\d{3}$/ }[r.kind];
  if (!t || !idRe) err(`неизвестная категория «${r.kind}»`);
  else if (!idRe.test(r.id)) err(`номер ${r.id} не соответствует категории`);
  if (!r.title || r.title.length < 6 || r.title.length > 95) err('название пустое или слишком длинное');
  if (!CUISINES.includes(r.cuisine)) err(`кухня «${r.cuisine}» не из списка`);
  if (!PROTEINS.includes(r.protein)) err(`источник белка «${r.protein}» не из списка`);
  if (t && (!Number.isInteger(r.servings) || r.servings < t.servings[0] || r.servings > t.servings[1])) err(`порций ${r.servings}: допустимо ${t.servings[0]}–${t.servings[1]}`);
  if (!Array.isArray(r.ingredients) || r.ingredients.length < (r.kind === 'snack' ? 2 : 3)) err('мало ингредиентов');
  if (!Array.isArray(r.steps) || r.steps.length < (r.kind === 'main' ? 4 : 2)) err('мало шагов');
  if (!r.time || !(r.time.active > 0) || !(r.time.total >= r.time.active)) err('время указано неверно');
  if (t && r.time?.active > t.activeMax) err(`активное время ${r.time.active} мин — больше ${t.activeMax}`);
  if (r.kind === 'main' && r.time?.total > 120) err('общее время больше 2 часов');

  // оборудование
  const eq = new Set(r.equipment ?? []);
  if (!eq.size) err('не указано оборудование');
  for (const e of eq) if (!EQUIP.includes(e)) err(`оборудование «${e}» не подтверждено`);
  if (eq.has('без нагрева') && eq.size > 1) err('«без нагрева» вместе с нагревательной техникой');
  const used = new Set<Equip>();
  for (const [n, s] of (r.steps ?? []).entries()) {
    if (!s.t || s.t.length < 8) err(`шаг ${n + 1} пустой`);
    if (s.eq) {
      used.add(s.eq);
      if (!eq.has(s.eq)) err(`шаг ${n + 1}: «${s.eq}» не указан в оборудовании`);
      if (!s.min) err(`шаг ${n + 1}: не указано время`);
      if ((s.eq === 'аэрогриль' || s.eq === 'электрогриль') && !s.temp) err(`шаг ${n + 1}: не указана температура`);
      if (s.temp) {
        const deg = Number((s.temp.match(/\d+/) ?? ['0'])[0]);
        if (deg < 120 || deg > 240) err(`шаг ${n + 1}: температура ${s.temp} вне 120–240 °C`);
      }
    }
  }
  for (const e of eq) if (e !== 'без нагрева' && !used.has(e)) err(`«${e}» указан, но ни в одном шаге не используется`);
  const allText = [r.title, ...(r.steps ?? []).map((s) => s.t), ...(r.utensils ?? []), r.storage?.reheat ?? '', r.storage?.thaw ?? '', r.storage?.note ?? '', ...r.ingredients.map((i) => i.note ?? '')].join(' \n ');
  const fe = allText.match(FORBIDDEN_EQUIP_RE);
  if (fe) err(`упоминается техника, которой нет: «${fe[0]}»`);
  if (r.load) for (const [k, v] of Object.entries(r.load)) if (!eq.has(k as Equip) || !(Number(v) > 0)) err(`загрузка прибора «${k}» указана неверно`);

  // ингредиенты и граммовки
  const k = Math.max(1, r.servings || 1);
  let fish = false, meat = false;
  const seen = new Set<string>();
  for (const i of r.ingredients ?? []) {
    const p = products[i.p];
    if (!p) { err(`ингредиент «${i.p}» отсутствует в каталоге`); continue; }
    if (seen.has(i.p)) warn(`ингредиент «${p.name}» указан дважды`);
    seen.add(i.p);
    if (p.archived && !i.p.startsWith('l_')) err(`ингредиент «${p.name}» убран из каталога`);
    if (EXCLUDED_IDS.includes(i.p) || hasExcluded(p.name)) err(`исключённый продукт: «${p.name}»`);
    if (!(i.q > 0)) { err(`«${p.name}»: количество не задано`); continue; }
    const g = ingrGrams(p, i.q) / k;
    if (p.category === SEAFOOD_CAT) fish = true;
    if (p.category === MEAT_CAT) meat = true;
    const cap = i.p === 'oliveoil' ? 12 : i.p === 'salt' ? 3 : p.category === 'Специи' ? 4 : p.category === 'Орехи и семена' ? 35 : 600;
    if (g > cap) err(`«${p.name}»: ${Math.round(g)} г на порцию — больше разумного (${cap})`);
    if (r.kind === 'main' && (p.category === MEAT_CAT || p.category === SEAFOOD_CAT) && g > 280) err(`«${p.name}»: ${Math.round(g)} г сырого на порцию — слишком много`);
  }
  if (hasExcluded(`${r.title} ${(r.steps ?? []).map((s) => s.t).join(' ')}`)) err('в тексте упоминается исключённый продукт');

  // ккал и БЖУ
  const nutr = recipeNutrition(r, products);
  if (!nutr.complete) err(`калорийность требует уточнения: нет данных по ${nutr.missing.join(', ')}`);
  else if (t) {
    if (nutr.kcal < t.kcal[0] || nutr.kcal > t.kcal[1]) err(`${nutr.kcal} ккал на порцию: норма ${t.kcal[0]}–${t.kcal[1]}`);
    if (nutr.p < t.pMin) err(`белок ${nutr.p} г на порцию: нужно не меньше ${t.pMin}`);
    const fatShare = (nutr.f * 9) / Math.max(1, nutr.kcal);
    if (fatShare > 0.5) err(`жиры дают ${Math.round(fatShare * 100)}% калорийности`);
    else if (fatShare > 0.4) warn(`жиры дают ${Math.round(fatShare * 100)}% калорийности`);
  }

  // хранение и безопасность
  const st = r.storage;
  if (!st || !Number.isInteger(st.fridge_days) || st.fridge_days < 0 || st.fridge_days > 3) err('срок в холодильнике: 0–3 суток');
  else {
    if (fish && st.fridge_days > 2) err('рыба и морепродукты: не больше 2 суток в холодильнике');
    if (meat && st.fridge_days > 3) err('мясо и птица: не больше 3 суток в холодильнике');
    if (r.kind === 'main' && st.fridge_days < 1) err('основное блюдо для готовки партией должно храниться хотя бы сутки');
  }
  if (st?.freeze) {
    if (!(st.freeze_months && st.freeze_months >= 1 && st.freeze_months <= 3)) err('срок заморозки: 1–3 месяца');
    if (!st.reheat) err('для заморозки не указано, как разогревать');
    if (!st.thaw && r.kind === 'main') err('для заморозки не указано, как размораживать');
    if (r.ingredients.some((i) => ['cucumber', 'avocado'].includes(i.p))) warn('свежие огурцы или авокадо не замораживаются — хранить отдельно');
  }
  if (r.kind === 'main' && !st?.freeze) warn('основное блюдо не замораживается — только для первых дней после готовки');
  if (r.kind === 'main' && r.servings === 1) warn('одна порция — блюдо не для партии, а из запасов или на один раз');
  if ((fish || meat) && r.kind === 'main' && !/\d+ ?°C|непрозрачн|расслаива|розов|мягк/.test(r.steps.map((s) => s.t).join(' '))) warn('нет признака готовности мяса или рыбы');

  return { id: r.id, hash: recipeHash(r), ok: errors.length === 0, errors, warnings, nutr };
}

export interface LibraryCheck {
  checks: RecipeCheck[];
  duplicates: { a: string; b: string; sim: number }[];
  counts: Record<LibKind, { total: number; ok: number }>;
}

/** Проверка всей библиотеки: каждый рецепт + повторы названий и состава. */
export function checkLibrary(recipes: LibRecipe[], products: Record<string, Product>): LibraryCheck {
  const checks = recipes.map((r) => checkRecipe(r, products));
  const byId = new Map(checks.map((c) => [c.id, c]));
  const ids = new Map<string, number>();
  for (const r of recipes) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const r of recipes) if ((ids.get(r.id) ?? 0) > 1) byId.get(r.id)!.errors.push('номер рецепта повторяется');
  const titles = new Map<string, string>();
  for (const r of recipes) {
    const n = norm(r.title);
    if (titles.has(n)) byId.get(r.id)!.errors.push(`то же название, что у ${titles.get(n)}`);
    else titles.set(n, r.id);
  }
  const duplicates: LibraryCheck['duplicates'] = [];
  const vecs = recipes.map((r) => compVector(r, products));
  // второй взгляд: корень из граммов — чтобы мелкие ингредиенты (ягоды, соус, гарнир) весили больше,
  // а два блюда с одинаковым набором продуктов не прятались за разной долей мяса
  const sqrtVecs = vecs.map((v) => new Map([...v].map(([k, x]) => [k, Math.sqrt(x)])));
  for (let i = 0; i < recipes.length; i++) {
    for (let j = i + 1; j < recipes.length; j++) {
      if (recipes[i].kind !== recipes[j].kind) continue;
      const sim = Math.max(cosine(vecs[i], vecs[j]), cosine(sqrtVecs[i], sqrtVecs[j]));
      // тот же состав и та же техника — повтор (ошибка); другой способ приготовления — другое блюдо, но смотрю вручную
      const sameEq = [...recipes[i].equipment].sort().join() === [...recipes[j].equipment].sort().join();
      if (sim >= 0.92 && sameEq) {
        duplicates.push({ a: recipes[i].id, b: recipes[j].id, sim: Math.round(sim * 100) / 100 });
        byId.get(recipes[j].id)!.errors.push(`почти тот же состав, что у ${recipes[i].id} (${Math.round(sim * 100)}%)`);
      } else if (sim >= 0.92) byId.get(recipes[j].id)!.warnings.push(`состав близок к ${recipes[i].id} (${Math.round(sim * 100)}%), но другой способ приготовления`); else if (sim >= 0.8) byId.get(recipes[j].id)!.warnings.push(`похож по составу на ${recipes[i].id} (${Math.round(sim * 100)}%)`);
      else {
        // отличается одной заменой ингредиента (например, другой фрукт) — повод посмотреть вручную
        const a = new Set(vecs[i].keys()), b = new Set(vecs[j].keys());
        const diff = [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;
        if (a.size >= 3 && b.size >= 3 && diff <= 2) byId.get(recipes[j].id)!.warnings.push(`отличается от ${recipes[i].id} одним ингредиентом`);
      }
    }
  }
  for (const c of checks) c.ok = c.errors.length === 0;
  const counts = { breakfast: { total: 0, ok: 0 }, snack: { total: 0, ok: 0 }, main: { total: 0, ok: 0 } } as LibraryCheck['counts'];
  recipes.forEach((r, i) => { counts[r.kind].total++; if (checks[i].ok) counts[r.kind].ok++; });
  return { checks, duplicates, counts };
}
