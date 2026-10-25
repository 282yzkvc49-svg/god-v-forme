// Пересчёт ингредиентов на 1–4 порции. Пересчитываются только структурированные количества;
// всё, что записано в источнике текстом («лук», «сок 1/2 лимона»), показывается как есть.
import type { Ingredient, Recipe } from '../state/types';
import { fmtNum } from '../lib/util';
import { plural as _p } from '../lib/dates';

export interface ScaledIngredient {
  text: string;
  original: string;
  scaled: boolean; // число пересчитано
  textOnly: boolean; // в источнике нет структурированного количества
}

export interface ScaledRecipe {
  canScale: boolean;
  factor: number;
  items: ScaledIngredient[];
  reason?: string;
}

const FORMS: [RegExp, [string, string, string]][] = [
  [/^(яйцо|яйца|яиц)(?=[\s,.;)]|$)/, ['яйцо', 'яйца', 'яиц']],
  [/^(зубчик|зубчика|зубчиков)(?=[\s,.;)]|$)/, ['зубчик', 'зубчика', 'зубчиков']],
  [/^(банка|банки|банок)(?=[\s,.;)]|$)/, ['банка', 'банки', 'банок']],
  [/^(луковица|луковицы|луковиц)(?=[\s,.;)]|$)/, ['луковица', 'луковицы', 'луковиц']],
];

function stepFor(unit: string | null, v: number): number {
  switch (unit) {
    case 'г':
    case 'мл':
      return v < 20 ? 1 : 5;
    case 'кг':
    case 'л':
      return 0.05;
    case 'ч.л.':
    case 'ст.л.':
      return 0.25;
    default:
      return 0.5; // шт., зубч., банки
  }
}

function roundQty(v: number, unit: string | null): number {
  const step = stepFor(unit, v);
  const r = Math.round(v / step) * step;
  return Math.max(step, +r.toFixed(2));
}

const NUM_RE = /(\d+(?:[.,]\d+)?)(\s*[–-]\s*(\d+(?:[.,]\d+)?))?/;

export function scaleIngredient(ing: Ingredient, factor: number): ScaledIngredient {
  const original = ing.source_text;
  if (ing.qty == null) return { text: original, original, scaled: false, textOnly: true };
  if (Math.abs(factor - 1) < 1e-9) return { text: original, original, scaled: false, textOnly: false };
  const a = roundQty(ing.qty * factor, ing.unit);
  const b = ing.qty_max != null ? roundQty(ing.qty_max * factor, ing.unit) : null;
  const m = NUM_RE.exec(original);
  if (!m) return { text: original, original, scaled: false, textOnly: true };
  const numText = b != null && b !== a ? `${fmtNum(a, 2)}–${fmtNum(b, 2)}` : fmtNum(a, 2);
  const before = original.slice(0, m.index);
  let after = original.slice(m.index + m[0].length);
  // согласование счётных слов: «2 яйца», «5 яиц», «1,5 яйца»
  const trimmed = after.replace(/^\s+/, '');
  const lead = after.length - trimmed.length;
  for (const [re, forms] of FORMS) {
    const fm = re.exec(trimmed);
    if (fm) {
      const n = b ?? a;
      const form = Number.isInteger(n) ? _p(n, forms[0], forms[1], forms[2]) : forms[1];
      after = after.slice(0, lead) + form + trimmed.slice(fm[0].length);
      break;
    }
  }
  return { text: `${before}${numText}${after}`, original, scaled: true, textOnly: false };
}

export function scaleRecipe(r: Recipe, servings: number): ScaledRecipe {
  if (!r.scalable || !r.servings) {
    return {
      canScale: false, factor: 1,
      items: r.ingredients.map((i) => ({ text: i.source_text, original: i.source_text, scaled: false, textOnly: i.qty == null })),
      reason: r.servings ? undefined : `Выход в источнике указан как «${r.yield_text}», поэтому автоматический пересчёт не делаем.`,
    };
  }
  const factor = servings / r.servings;
  return { canScale: true, factor, items: r.ingredients.map((i) => scaleIngredient(i, factor)) };
}

/** Температуры и время из текста шага: «190°C», «12–15 мин». */
export function stepChips(text: string): { temps: string[]; times: string[] } {
  const temps = Array.from(text.matchAll(/(\d{2,3}(?:[–-]\d{2,3})?)\s*°C/g), (m) => `${m[1].replace('-', '–')}°C`);
  const times = Array.from(text.matchAll(/(\d{1,3}(?:[–-]\d{1,3})?)\s*мин/g), (m) => `${m[1].replace('-', '–')} мин`);
  return { temps, times };
}

const UNITS = '(г|кг|мл|л|ч\\.л\\.?|ст\\.л\\.?|шт\\.?)';
const NUM = '(\\d+(?:[.,]\\d+)?)';
const RANGE = `${NUM}(?:\\s*[–-]\\s*${NUM})?`;
const toNum = (x?: string) => (x == null ? null : Number(x.replace(',', '.')));

/** Разбор строки ингредиента, введённой пользователем: «600 г курицы», «паприка 1 ч.л.». Остальное — просто текст. */
export function parseIngredientLine(line: string): Ingredient {
  const p = line.trim().replace(/[.;]$/, '');
  let m = new RegExp(`^${RANGE}\\s*${UNITS}\\s+(.+)$`, 'i').exec(p);
  if (m) return { source_text: p, qty: toNum(m[1]), qty_max: toNum(m[2]), unit: normUnit(m[3]), name: m[4] };
  m = new RegExp(`^(.+?)\\s+${RANGE}\\s*${UNITS}$`, 'i').exec(p);
  if (m) return { source_text: p, qty: toNum(m[2]), qty_max: toNum(m[3]), unit: normUnit(m[4]), name: m[1] };
  m = /^(\d+)\s+(.+)$/.exec(p);
  if (m) return { source_text: p, qty: Number(m[1]), qty_max: null, unit: 'шт.', name: m[2] };
  return { source_text: p, qty: null, qty_max: null, unit: null, name: p };
}

function normUnit(u: string): string {
  const x = u.toLowerCase();
  if (x.startsWith('ч.л')) return 'ч.л.';
  if (x.startsWith('ст.л')) return 'ст.л.';
  if (x.startsWith('шт')) return 'шт.';
  return x;
}
