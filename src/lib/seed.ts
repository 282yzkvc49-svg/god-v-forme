// Стартовый план из src/data/initial_seed.json → записи хранилища.
import seedJson from '../data/initial_seed.json';
import type { Exercise, MealMapEntry, Recipe, RecipeType, Settings, TemplateId, TemplateVersion, WorkoutTemplate } from '../state/types';
import { DISHES, PRODUCTS, TEMPLATE, fmtAmount, type Dish } from '../domain/catalog';

export const SEED: any = seedJson;
export const SEED_ID: string = SEED.seed_id;

export interface SeedProfile {
  start_weight_kg: number;
  target_weight_kg: number;
  horizon_text: string;
  kcal_reference: number;
  kcal_note: string;
  meal_times: Record<string, string>;
  weekend_note: string;
  cooking_days_text: string;
  shopping_text: string;
  budget_limit_rub: number;
  relax_days: string[];
  drinks: string;
  exclusions: string;
  kitchen: string;
  training_equipment: string[];
  kettlebells_kg: number[];
  control: string;
}

export const PROFILE: SeedProfile = SEED.profile;
export const MEMO: { label: string; text: string }[] = SEED.memo;
export const STORAGE_GUIDE: { id: string; text: string; source: string }[] = SEED.storage_guide;
export const EXERCISES: Record<string, Exercise> = Object.fromEntries((SEED.exercise_library as Exercise[]).map((e) => [e.id, e]));
/** Старые id рецептов (первая версия плана) → блюда нового меню: для своих связей и импорта. */
export const LEGACY_RECIPE_IDS: Record<string, string> = Object.fromEntries(
  [...TEMPLATE.dishes.filter((d) => d.legacy && !d.archived && (!DISHES[d.legacy] || DISHES[d.legacy].archived)).map((d) => [d.legacy as string, d.id]),
    ['grains', 'grain_rice']] as [string, string][],
);

const TYPE_OF: Record<Dish['category'], RecipeType> = { main: 'main', side: 'side', veg: 'side', protein: 'main', breakfast: 'breakfast', snack: 'snack', other: 'other' };
const TYPE_LABEL: Record<RecipeType, string> = { main: 'Основное', side: 'Гарнир', breakfast: 'Завтрак', snack: 'Перекус', other: 'Заготовка' };

/** Блюдо меню → карточка рецепта (на 1 порцию; крупы и заготовки — на 100 г). */
export function dishToRecipe(d: Dish): Recipe {
  const per = d.unit === 'g' ? 100 : 1;
  const ingredients = d.ingredients.map((i) => {
    const q = i.qty * per;
    const p = PRODUCTS[i.product];
    const sub = DISHES[i.product];
    const unit = p ? (p.unit === 'g' ? 'г' : p.unit === 'ml' ? 'мл' : 'шт.') : 'г';
    const name = p ? p.name : sub ? `${sub.title} (из готовки)` : i.product;
    const amount = p ? fmtAmount(q, p.unit) : `${Math.round(q)} г`;
    return { source_text: `${name} — ${amount}`, qty: Math.round(q * 100) / 100, qty_max: null, unit, name };
  });
  const spices = d.spices.map((t) => ({ source_text: t, qty: null, qty_max: null, unit: null, name: t }));
  const type = TYPE_OF[d.category];
  return {
    id: d.id, title: d.title, type, type_label: TYPE_LABEL[type],
    yield_text: d.unit === 'g' ? `на 100 ${d.unit_label ?? 'г'}` : `1 порция${d.serving_g ? ` (≈${d.serving_g} г)` : ''}`,
    servings: 1, scalable: true,
    ingredients_text: [...ingredients, ...spices].map((x) => x.source_text).join('; '),
    ingredients: [...ingredients, ...spices],
    method_text: d.steps.map((x) => x.text).join(' '),
    steps: d.steps,
    storage_ids: d.kind !== 'batch' ? ['work_fridge']
      : d.storage.freezable ? ['portion', 'cool_fast', 'freeze', 'veg_separate', 'reheat']
        : [...(d.ingredients.some((i) => PRODUCTS[i.product]?.storage === 'freezer') ? ['fish_thaw'] : []), 'veg_separate'],
    source: 'Меню на 30 дней',
  };
}

export const SEED_RECIPES: Recipe[] = TEMPLATE.dishes.filter((d) => !d.archived).map(dishToRecipe);
/** Рецепты блюд, убранных из меню: только для ссылок из истории прошедших дней, в списке рецептов их нет. */
export const ARCHIVED_RECIPES: Recipe[] = TEMPLATE.dishes.filter((d) => d.archived).map(dishToRecipe);
export const SEED_MEAL_MAP: MealMapEntry[] = (SEED.meal_recipe_map ?? []).map((e: MealMapEntry) => ({
  ...e, recipe_id: e.recipe_id ? (LEGACY_RECIPE_IDS[e.recipe_id] ?? (DISHES[e.recipe_id] ? e.recipe_id : null)) : null,
  kind: e.recipe_id && !DISHES[LEGACY_RECIPE_IDS[e.recipe_id] ?? e.recipe_id] ? 'unknown' : e.kind,
}));
export const SHOPPING_META = {
  budget_limit_rub: TEMPLATE.budget_rub,
  price_warning: TEMPLATE.price_note,
  categories_order: TEMPLATE.categories,
};

/** Гири, которые есть у пользователя. Других весов в программе нет. */
export const AVAILABLE_KETTLEBELLS: number[] = PROFILE.kettlebells_kg ?? [12, 16];

export function seedTemplate(raw: any): WorkoutTemplate {
  return {
    id: raw.id as TemplateId,
    name: raw.name,
    type: raw.type,
    durationMin: raw.duration_min ?? null,
    restSec: raw.rest_sec ?? null,
    description: raw.description,
    items: raw.items.map((it: any) => ({
      exerciseId: it.exercise_id,
      sets: it.sets,
      reps: it.reps ?? null,
      seconds: it.seconds ?? null,
      minutes: it.minutes ?? null,
      perSide: it.per_side ?? null,
      weightKg: it.weight_kg ?? null,
      kettlebellKg: it.kettlebell_kg ?? null,
      fallbackKg: it.fallback_kg ?? null,
      alternative: it.alternative ? { exerciseId: it.alternative.exercise_id, reps: it.alternative.reps ?? null, note: it.alternative.note ?? null } : null,
      condition: it.condition ?? null,
      weightNote: it.weight_note ?? null,
      note: it.note ?? null,
    })),
  };
}

export const SEED_EFFECTIVE_FROM = '1970-01-01';

export function seedTemplateVersions(now: string): TemplateVersion[] {
  return (SEED.workout_templates as any[]).map((t) => ({
    id: `${t.id}@seed`,
    templateId: t.id,
    effectiveFrom: SEED_EFFECTIVE_FROM,
    template: seedTemplate(t),
    source: 'seed',
    patchId: null,
    createdAt: now,
  }));
}

export function defaultSettings(): Settings {
  return {
    key: 'main',
    goals: { startWeightKg: PROFILE.start_weight_kg, targetWeightKg: PROFILE.target_weight_kg, kcalReference: PROFILE.kcal_reference },
    mealTimes: { breakfast: '08:30', lunch: '12:00', snack: '16:30', dinner: '20:00–21:30' },
    trainingTimeWeekday: '19:00',
    trainingTimeWeekend: '11:00',
    weighIn: { enabled: true, weekday: 1, time: '07:30' },
    photo: { enabled: true, weekday: 1 },
    monthStartDay: 2,
    containersEnabled: true,
    trainingStartDate: null,
    postponeCardio: false,
    plan: null,
    relaxOverrides: {},
    training: { startDate: TEMPLATE.base_start, strengthDays: [1, 3, 5], cardioDays: [2, 6] },
    restDefaultSec: 75,
    restAutoStart: true,
    restSound: true,
    photoMaxSide: 1600,
    showWaist: false,
    theme: 'auto',
    onboarded: false,
    installHintDismissed: false,
    lastBackupAt: null,
  };
}

/** Базовая дата шаблона меню (день 1). Реальную дату старта выбирает пользователь. */
export const PLAN_START: string = TEMPLATE.base_start;
