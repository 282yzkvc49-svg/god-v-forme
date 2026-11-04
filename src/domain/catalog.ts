// Справочник продуктов и блюд плана питания (src/data/plan_template.json, собирается tools/build_plan.py).
// Здесь — пищевая ценность, развёртка блюда в продукты и форматирование количеств.
import tpl from '../data/plan_template.json';
import type { MealSlot } from '../state/types';

export interface Nutr { kcal: number; p: number; f: number; c: number }

export interface Product {
  id: string;
  name: string;
  category: string;
  unit: 'g' | 'ml' | 'pcs';
  nutr: Nutr;
  nutr_src: 'ref' | 'label';
  price: number; // ₽ за кг, л или шт.
  pack: { size: number; label: string };
  shelf_days: number;
  storage: 'fridge' | 'freezer' | 'pantry';
  freezable: boolean;
  edible_ratio: number;
  piece_g: number | null;
  piece_label: string | null;
  note: string | null;
  pantry: boolean;
}

export interface DishIngr { product: string; qty: number; note: string | null }
export interface DishStep { text: string; temperature_c: string | null; minutes: string | null }

export interface Dish {
  id: string;
  title: string;
  short: string;
  category: 'main' | 'side' | 'veg' | 'protein' | 'breakfast' | 'snack' | 'other';
  kind: 'batch' | 'fresh';
  unit: 'portion' | 'g';
  unit_label: string | null;
  cooked_factor: number | null;
  serving_g: number | null;
  ingredients: DishIngr[];
  spices: string[];
  steps: DishStep[];
  method: string;
  storage: { place: 'fridge' | 'pantry'; days: number; freezable: boolean };
  note: string | null;
  legacy: string | null;
}

export interface TplPart { dish: string; qty: number; fresh: boolean }
export interface TplDay { day: number; relax: boolean; meals: Record<MealSlot, { parts: TplPart[] }> | null }
export interface TplUse { day: number; slot: MealSlot; qty: number; via: string | null; storage: string }
export interface TplBlock { id: string; day: number; when: 'morning' | 'evening'; kind: 'main' | 'quick'; items: { dish: string; uses: TplUse[] }[] }

export interface PlanTemplate {
  id: string;
  title: string;
  base_start: string;
  length: number;
  relax_day: number;
  kcal_target: number;
  budget_rub: number;
  nutrition_sources: string;
  price_note: string;
  categories: string[];
  products: Product[];
  dishes: Dish[];
  days: TplDay[];
  blocks: TplBlock[];
  topup_candidates: number[];
}

export const TEMPLATE: PlanTemplate = tpl as any;
export const PRODUCTS: Record<string, Product> = Object.fromEntries(TEMPLATE.products.map((p) => [p.id, p]));
export const DISHES: Record<string, Dish> = Object.fromEntries(TEMPLATE.dishes.map((d) => [d.id, d]));

export function isDish(id: string): boolean {
  return !!DISHES[id];
}

/** Масса в граммах для расчёта пищевой ценности (штуки → граммы). */
function grams(p: Product, qty: number): number {
  return p.unit === 'pcs' ? qty * (p.piece_g ?? 0) : qty;
}

export interface DishNutrition extends Nutr { labelProducts: string[] }

/** Пищевая ценность qty единиц блюда (вложенные блюда из партии — тоже). */
export function dishNutrition(dishId: string, qty: number): DishNutrition {
  const out: DishNutrition = { kcal: 0, p: 0, f: 0, c: 0, labelProducts: [] };
  const d = DISHES[dishId];
  if (!d) return out;
  for (const i of d.ingredients) {
    const q = i.qty * qty;
    if (DISHES[i.product]) {
      const n = dishNutrition(i.product, q);
      out.kcal += n.kcal; out.p += n.p; out.f += n.f; out.c += n.c;
      for (const l of n.labelProducts) if (!out.labelProducts.includes(l)) out.labelProducts.push(l);
      continue;
    }
    const p = PRODUCTS[i.product];
    if (!p) continue;
    const g = grams(p, q) / 100;
    out.kcal += p.nutr.kcal * g; out.p += p.nutr.p * g; out.f += p.nutr.f * g; out.c += p.nutr.c * g;
    if (p.nutr_src === 'label' && !out.labelProducts.includes(p.name)) out.labelProducts.push(p.name);
  }
  return out;
}

export function sumNutrition(list: DishNutrition[]): DishNutrition {
  const out: DishNutrition = { kcal: 0, p: 0, f: 0, c: 0, labelProducts: [] };
  for (const n of list) {
    out.kcal += n.kcal; out.p += n.p; out.f += n.f; out.c += n.c;
    for (const l of n.labelProducts) if (!out.labelProducts.includes(l)) out.labelProducts.push(l);
  }
  return out;
}

/** Текст калорийности: число — только если все продукты из справочника. */
export function kcalText(n: DishNutrition): { main: string; detail: string | null; verified: boolean } {
  const k = Math.round(n.kcal / 10) * 10;
  const bju = `Б ${Math.round(n.p)} · Ж ${Math.round(n.f)} · У ${Math.round(n.c)} г`;
  if (!n.labelProducts.length) return { main: `≈${k} ккал`, detail: `${bju} (справочные данные)`, verified: true };
  return {
    main: 'Калорийность требует уточнения',
    detail: `Без учёта марки ≈${k} ккал, ${bju}. Уточните по этикетке: ${n.labelProducts.join(', ')}.`,
    verified: false,
  };
}

/** Продукты на qty единиц блюда. includeNested — разворачивать ли вложенные блюда из партии. */
export function dishProducts(dishId: string, qty: number, includeNested: boolean): Map<string, number> {
  const out = new Map<string, number>();
  const d = DISHES[dishId];
  if (!d) return out;
  for (const i of d.ingredients) {
    const q = i.qty * qty;
    if (DISHES[i.product]) {
      if (!includeNested) continue;
      for (const [k, v] of dishProducts(i.product, q, true)) out.set(k, (out.get(k) ?? 0) + v);
      continue;
    }
    out.set(i.product, (out.get(i.product) ?? 0) + q);
  }
  return out;
}

/** Штучные продукты в партии округляем до целых (1/3 яйца × 3 порции = 1 яйцо). */
export function roundBatch(p: Product, qty: number): number {
  if (p.unit === 'pcs') return Math.max(1, Math.ceil(qty - 0.05));
  return Math.round(qty);
}

const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function frac(x: number): string {
  const whole = Math.floor(x + 1e-6);
  const r = x - whole;
  const f = Math.abs(r - 1 / 3) < 0.02 ? '⅓' : Math.abs(r - 2 / 3) < 0.02 ? '⅔' : Math.abs(r - 0.5) < 0.02 ? '½'
    : Math.abs(r - 0.25) < 0.02 ? '¼' : Math.abs(r - 0.75) < 0.02 ? '¾' : r < 0.02 ? '' : null;
  if (f === null) return nf1.format(x);
  return whole ? `${whole}${f}` : f || '0';
}

/** «220 г», «1,2 кг», «300 мл», «2 шт.», «⅓ шт.» */
export function fmtAmount(qty: number, unit: 'g' | 'ml' | 'pcs'): string {
  if (unit === 'pcs') return `${frac(qty)} шт.`;
  const q = qty < 10 ? Math.round(qty * 2) / 2 : Math.round(qty);
  if (unit === 'g') return q >= 1000 ? `${nf2.format(q / 1000)} кг` : `${nf1.format(q)} г`;
  return q >= 1000 ? `${nf2.format(q / 1000)} л` : `${nf1.format(q)} мл`;
}

export function productAmount(productId: string, qty: number): string {
  const p = PRODUCTS[productId];
  return p ? fmtAmount(qty, p.unit) : `${qty}`;
}

/** Количество блюда: «1 порция», «2 порции», «90 г сухого риса». */
export function dishAmount(dishId: string, qty: number): string {
  const d = DISHES[dishId];
  if (!d) return String(qty);
  if (d.unit === 'g') return `${Math.round(qty)} ${d.unit_label ?? 'г'}`;
  const n = Math.round(qty * 100) / 100;
  const word = Math.abs(n % 10) === 1 && Math.abs(n % 100) !== 11 ? 'порция'
    : [2, 3, 4].includes(Math.abs(n % 10)) && ![12, 13, 14].includes(Math.abs(n % 100)) ? 'порции' : 'порций';
  return `${frac(n)} ${Number.isInteger(n) ? word : 'порции'}`;
}

/** Примерная масса готового: для крупы и картофеля — по выходу, для порций — вес порции. */
export function cookedWeight(dishId: string, qty: number): number | null {
  const d = DISHES[dishId];
  if (!d) return null;
  if (d.unit === 'g') return d.cooked_factor ? Math.round(qty * d.cooked_factor / 5) * 5 : null;
  return d.serving_g ? Math.round(qty * d.serving_g / 5) * 5 : null;
}

export interface IngrLine { productId: string | null; dishId: string | null; name: string; amount: string; note: string | null }

/** Ингредиенты блюда на qty единиц для показа (вложенное блюдо из партии — одной строкой). */
export function ingredientLines(dishId: string, qty: number, batchRound = false): IngrLine[] {
  const d = DISHES[dishId];
  if (!d) return [];
  const out: IngrLine[] = [];
  for (const i of d.ingredients) {
    const q = i.qty * qty;
    const sub = DISHES[i.product];
    if (sub) {
      out.push({ productId: null, dishId: sub.id, name: sub.title, amount: sub.unit === 'g' ? `${Math.round(q)} г` : dishAmount(sub.id, q), note: 'из готовки' });
      continue;
    }
    const p = PRODUCTS[i.product];
    if (!p) continue;
    const amount = fmtAmount(batchRound ? roundBatch(p, q) : q, p.unit);
    const piece = p.unit !== 'pcs' && p.piece_g && q >= p.piece_g * 0.4 ? ` (≈${frac(Math.round(q / p.piece_g * 2) / 2)} шт.)` : '';
    out.push({ productId: p.id, dishId: null, name: p.name, amount: amount + piece, note: i.note ?? p.note });
  }
  return out;
}

export const METHOD_LABEL: Record<string, string> = {
  'аэрогриль': 'Аэрогриль', 'электрогриль': 'Электрогриль', 'плита': 'Плита', 'без готовки': 'Без готовки',
};

export const DISH_CATEGORY_LABELS: Record<Dish['category'], string> = {
  main: 'Основные блюда', side: 'Гарниры', veg: 'Овощи и салаты', protein: 'Мясо для бутербродов',
  breakfast: 'Завтраки', snack: 'Перекусы', other: 'Заготовки',
};

