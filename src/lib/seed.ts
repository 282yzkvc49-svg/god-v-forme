// Стартовый план из src/data/initial_seed.json → записи хранилища.
import seedJson from '../data/initial_seed.json';
import type {
  CookingEvent, Exercise, MealMapEntry, PlanDay, Recipe, Settings, ShoppingEvent, TemplateId, TemplateVersion,
  TrainingKind, WorkoutTemplate,
} from '../state/types';

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
  kettlebell_max_kg: number;
  control: string;
}

export const PROFILE: SeedProfile = SEED.profile;
export const MEMO: { label: string; text: string }[] = SEED.memo;
export const STORAGE_GUIDE: { id: string; text: string; source: string }[] = SEED.storage_guide;
export const EXERCISES: Record<string, Exercise> = Object.fromEntries((SEED.exercise_library as Exercise[]).map((e) => [e.id, e]));
export const SEED_RECIPES: Recipe[] = SEED.recipes;
export const SEED_MEAL_MAP: MealMapEntry[] = SEED.meal_recipe_map;
export const SHOPPING_META: {
  budget_limit_rub: number;
  model_total_rub: number;
  price_warning: string;
  categories_order: string[];
} = SEED.shopping;

export const KETTLEBELL_MAX_KG: number = PROFILE.kettlebell_max_kg ?? 24;

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
      weightNote: it.weight_note ?? null,
      note: it.note ?? null,
    })),
  };
}

export function seedPlanDays(): PlanDay[] {
  return (SEED.calendar as any[]).map((d) => ({
    date: d.date,
    source: 'seed',
    patchId: null,
    dayNumber: d.day_number,
    relax: !!d.relax_day,
    meals: d.meals,
    relaxMealsText: d.relax_meals_text ?? null,
    training: d.training ? { templateId: d.training.template_id as TrainingKind, label: d.training.label, time: null } : null,
    drinks: d.drinks,
    note: d.note,
    kcalNote: d.kcal_note,
  }));
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

export function seedShoppingEvents(): ShoppingEvent[] {
  return (SEED.shopping.shopping_events as any[]).map((e) => ({
    id: e.id,
    date: e.date,
    title: e.title,
    forDatesText: e.for_dates_text,
    source: 'seed',
    patchId: null,
    items: e.items.map((it: any) => ({
      itemId: it.item_id,
      category: it.category,
      name: it.name,
      unit: it.unit,
      qty: it.qty,
      pricePerUnit: it.price_per_unit_rub,
      priceEstimate: it.price_estimate_rub,
      note: it.note,
    })),
  }));
}

export function seedCookingEvents(): CookingEvent[] {
  return (SEED.cooking_events as any[]).map((e) => ({
    id: e.id,
    date: e.date,
    eventType: e.event_type,
    title: e.title,
    sourceText: e.source_text,
    forDaysText: e.for_days_text,
    forDates: e.for_dates,
    storage: e.storage,
    dishes: e.dishes.map((d: any) => ({ text: d.text, recipeIds: d.recipe_ids, comment: d.comment })),
    source: 'seed',
    patchId: null,
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
    photo: { enabled: true, dayOfMonth: 2 },
    monthStartDay: 2,
    containersEnabled: true,
    trainingStartDate: null,
    postponeCardio: false,
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

export const PLAN_START: string = SEED.period.from;
export const PLAN_END: string = SEED.period.to;
