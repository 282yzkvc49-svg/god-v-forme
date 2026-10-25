// Сопоставление «блюдо дня → рецепт» по проверяемой таблице соответствий (initial_seed.json.meal_recipe_map)
// плюс связи, добавленные пользователем. Отсутствующий рецепт никогда не подставляется молча.
import type { AppData, MealMapEntry, MealSlot, Recipe } from '../state/types';
import { SEED_MEAL_MAP, SEED_RECIPES } from '../lib/seed';
import { normText } from '../lib/util';

export type PartStatus = 'recipe' | 'similar' | 'simple' | 'unknown';

export interface MealPart {
  text: string;
  status: PartStatus;
  recipe: Recipe | null;
  comment: string | null;
  key: string; // ключ для добавления своей связи: scope|match
}

const seedIndex = new Map<string, MealMapEntry>(SEED_MEAL_MAP.map((e) => [`${e.scope}|${e.match}`, e]));
const SEED_RECIPE_INDEX = new Map(SEED_RECIPES.map((r) => [r.id, r]));

export function allRecipes(data: AppData): Recipe[] {
  return [...SEED_RECIPES, ...Object.values(data.userRecipes)];
}

export function recipeById(data: AppData, id: string | null | undefined): Recipe | null {
  if (!id) return null;
  return SEED_RECIPE_INDEX.get(id) ?? data.userRecipes[id] ?? null;
}

function lookup(data: AppData, scope: 'component' | 'whole', text: string): MealMapEntry | null {
  const key = `${scope}|${normText(text)}`;
  return data.mealLinks[key] ?? seedIndex.get(key) ?? null;
}

function toPart(data: AppData, text: string, entry: MealMapEntry | null, key: string): MealPart {
  if (!entry) return { text, status: 'unknown', recipe: null, comment: null, key };
  const recipe = recipeById(data, entry.recipe_id);
  const status: PartStatus =
    entry.kind === 'exact' || entry.kind === 'alias' ? (recipe ? 'recipe' : 'unknown')
      : entry.kind === 'similar' ? 'similar'
        : entry.kind === 'simple' ? 'simple' : 'unknown';
  return { text, status, recipe, comment: entry.comment, key };
}

/** Разбор блюда: целиком (завтраки и перекусы) или по составляющим «A + B + C» (обеды и ужины). */
export function resolveMeal(data: AppData, _slot: MealSlot, text: string): MealPart[] {
  const cleaned = text.replace(/\s*\(дома\)\s*$/i, '').trim();
  const whole = lookup(data, 'whole', cleaned);
  if (whole) return [toPart(data, cleaned, whole, `whole|${normText(cleaned)}`)];
  const comps = cleaned.split(' + ').map((s) => s.trim()).filter(Boolean);
  if (comps.length <= 1) {
    const comp = lookup(data, 'component', cleaned);
    return [toPart(data, cleaned, comp, `${comp ? 'component' : 'whole'}|${normText(cleaned)}`)];
  }
  return comps.map((c) => toPart(data, c, lookup(data, 'component', c), `component|${normText(c)}`));
}

/** Рецепты, связанные с блюдом (для кнопки «Рецепт»). */
export function mealRecipes(parts: MealPart[]): Recipe[] {
  const out: Recipe[] = [];
  for (const p of parts) if (p.recipe && (p.status === 'recipe') && !out.includes(p.recipe)) out.push(p.recipe);
  return out;
}

export function needsRecipe(parts: MealPart[]): MealPart[] {
  return parts.filter((p) => p.status === 'unknown' || p.status === 'similar');
}

export const RECIPE_TYPE_LABELS: Record<string, string> = {
  main: 'Основные блюда',
  side: 'Гарниры',
  breakfast: 'Завтраки',
  snack: 'Перекусы',
  other: 'Мои рецепты',
};
