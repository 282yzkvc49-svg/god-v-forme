import type { ISODate } from '../lib/dates';

export type MealSlot = 'breakfast' | 'lunch' | 'snack' | 'dinner';
export const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'snack', 'dinner'];
export const MEAL_LABELS: Record<MealSlot, string> = { breakfast: 'Завтрак', lunch: 'Обед', snack: 'Перекус', dinner: 'Ужин' };

export type TemplateId = 'strength_a' | 'strength_b' | 'stepper' | 'recovery';
export const TEMPLATE_IDS: TemplateId[] = ['strength_a', 'strength_b', 'stepper', 'recovery'];
export type TrainingKind = TemplateId | 'rest';

// ---------------------------------------------------------------- план (меняется только seed и импортом)

export interface PlanTraining {
  templateId: TrainingKind;
  label: string;
  time?: string | null;
}

export interface PlanDay {
  date: ISODate;
  source: 'seed' | 'import';
  patchId?: string | null;
  dayNumber?: number | null;
  relax: boolean;
  meals: Record<MealSlot, string> | null;
  relaxMealsText?: Record<MealSlot, string> | null;
  training: PlanTraining | null;
  drinks?: string | null;
  note?: string | null;
  kcalNote?: string | null;
}

export interface TemplateItem {
  exerciseId: string;
  sets: number;
  reps?: number | null;
  seconds?: number | null;
  minutes?: number | [number, number] | null;
  perSide?: string | null;
  weightKg?: [number, number] | null;
  weightNote?: string | null;
  note?: string | null;
}

export interface WorkoutTemplate {
  id: TemplateId;
  name: string;
  type: 'strength' | 'cardio' | 'recovery';
  durationMin: [number, number] | null;
  restSec: [number, number] | null;
  description: string;
  items: TemplateItem[];
}

export interface TemplateVersion {
  id: string;
  templateId: TemplateId;
  effectiveFrom: ISODate;
  template: WorkoutTemplate;
  source: 'seed' | 'import';
  patchId?: string | null;
  reason?: string | null;
  createdAt: string;
}

export interface ShoppingItem {
  itemId: string;
  category: string;
  name: string;
  unit: string;
  qty: number;
  pricePerUnit: number | null;
  priceEstimate: number | null;
  note: string | null;
}

export interface ShoppingEvent {
  id: string;
  date: ISODate;
  title: string;
  forDatesText?: string | null;
  items: ShoppingItem[];
  source: 'seed' | 'import';
  patchId?: string | null;
}

export interface CookingDish {
  text: string;
  recipeIds: string[];
  comment?: string | null;
}

export interface CookingEvent {
  id: string;
  date: ISODate;
  eventType: 'meal_prep' | 'relax_day';
  title: string;
  sourceText: string;
  forDaysText: string;
  forDates: ISODate[];
  storage: string;
  dishes: CookingDish[];
  source: 'seed' | 'import';
  patchId?: string | null;
}

// ---------------------------------------------------------------- справочники (из сборки)

export interface Exercise {
  id: string;
  name: string;
  equipment: string[];
  kind: 'reps' | 'time' | 'cardio';
  per_side?: string;
  figure: string;
  muscles: string;
  frames: string[];
  steps: string[];
  mistakes: string[];
  easier: string;
  warnings: string[];
}

export interface Ingredient {
  source_text: string;
  qty: number | null;
  qty_max: number | null;
  unit: string | null;
  name: string;
}

export interface RecipeStep {
  text: string;
  temperature_c: string | null;
  minutes: string | null;
}

export type RecipeType = 'main' | 'side' | 'breakfast' | 'snack' | 'other';

export interface Recipe {
  id: string;
  title: string;
  type: RecipeType;
  type_label: string;
  yield_text: string;
  servings: number | null;
  scalable: boolean;
  ingredients_text: string;
  ingredients: Ingredient[];
  method_text: string;
  steps: RecipeStep[];
  storage_ids: string[];
  source: string;
  user?: boolean;
  createdAt?: string;
}

export type MatchKind = 'exact' | 'alias' | 'similar' | 'simple' | 'unknown';

export interface MealMapEntry {
  id?: string;
  match: string;
  scope: 'component' | 'whole';
  kind: MatchKind;
  recipe_id: string | null;
  comment: string | null;
  user?: boolean;
}

// ---------------------------------------------------------------- пользовательские данные

export type TaskStatus = 'planned' | 'done' | 'skipped';

export type TaskKind =
  | 'meal' | 'training' | 'cooking' | 'shopping' | 'containers' | 'weigh' | 'photo' | 'custom';

export interface TaskStatusRec {
  taskId: string;
  date: ISODate; // исходная плановая дата задачи
  kind: TaskKind;
  status: TaskStatus;
  updatedAt: string;
}

export interface TaskMove {
  taskId: string;
  kind: TaskKind;
  fromDate: ISODate;
  toDate: ISODate;
  movedAt: string;
}

export interface CustomTask {
  id: string;
  date: ISODate;
  title: string;
  kind: 'custom' | 'training';
  templateId?: TemplateId | null;
  time?: string | null;
  note?: string | null;
  createdAt: string;
}

export type Difficulty = 'easy' | 'ok' | 'hard';
export type Feeling = 'great' | 'ok' | 'hard';
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'легко', ok: 'нормально', hard: 'тяжело' };
export const FEELING_LABELS: Record<Feeling, string> = { great: 'отлично', ok: 'нормально', hard: 'тяжело' };

export interface ExerciseLog {
  index: number;
  exerciseId: string;
  sets: boolean[];
  weightKg?: number | null;
  difficulty?: Difficulty | null;
  minutes?: number | null;
}

export interface TrainingLog {
  id: string; // = id задачи тренировки
  plannedDate: ISODate;
  date: ISODate; // фактическая дата выполнения
  templateId: TemplateId;
  templateVersionId: string;
  /** Копия шаблона на момент начала — история не зависит от последующих обновлений и откатов. */
  templateSnapshot?: WorkoutTemplate | null;
  status: 'in_progress' | 'done' | 'skipped';
  startedAt?: string | null;
  finishedAt?: string | null;
  feeling?: Feeling | null;
  note?: string | null;
  stepperMinutes?: number | null;
  exercises: ExerciseLog[];
  quick?: boolean; // отмечено галочкой без подробностей
  updatedAt: string;
}

export interface WeightEntry { id: string; date: ISODate; kg: number; note?: string | null; createdAt: string }
export interface Measurement { id: string; date: ISODate; waistCm: number; createdAt: string }

export type PhotoPose = 'front' | 'side' | 'back';
export const POSE_LABELS: Record<PhotoPose, string> = { front: 'спереди', side: 'сбоку', back: 'сзади' };
export interface PhotoMeta {
  id: string;
  date: ISODate;
  pose: PhotoPose | null;
  width: number;
  height: number;
  bytes: number;
  type: string;
  createdAt: string;
}
export interface PhotoBlobRec { id: string; full: Blob; thumb: Blob }

export interface ShoppingCheck {
  id: string; // eventId:itemId
  eventId: string;
  itemId: string;
  bought: boolean;
  actualPrice?: number | null;
  updatedAt: string;
}

/** Галочки подпунктов: этапы готовки, контейнеры, шаги рецепта. */
export interface CheckRec {
  id: string;
  done: boolean;
  updatedAt: string;
}

export interface DayNote { date: ISODate; text: string; updatedAt: string }

export interface ExportRecord {
  id: string;
  createdAt: string;
  kind: 'monthly_report' | 'backup';
  fileName: string;
  period?: { from: ISODate; to: ISODate } | null;
  includedPhotos?: number;
  counts?: Record<string, number>;
  encrypted?: boolean;
  bytes?: number;
}

export interface Goals {
  startWeightKg: number;
  targetWeightKg: number;
  kcalReference: number;
}

export interface PlanSnapshot {
  planDays: PlanDay[];
  templateVersions: TemplateVersion[];
  shoppingEvents: ShoppingEvent[];
  cookingEvents: CookingEvent[];
  goals: Goals;
}

export interface ChangeLine {
  label: string;
  before: string;
  after: string;
  danger?: boolean;
}

export interface ChangeSummary {
  id: string;
  type: string;
  title: string;
  effectiveFrom?: string | null;
  reason?: string | null;
  lines: ChangeLine[];
}

export interface PatchRecord {
  id: string;
  importedAt: string;
  fileName: string;
  title: string;
  summary: string;
  schemaVersion: string;
  status: 'applied' | 'rolled_back';
  applied: ChangeSummary[];
  rejected: ChangeSummary[];
  snapshot: PlanSnapshot;
  rolledBackAt?: string | null;
}

export interface Settings {
  key: 'main';
  goals: Goals;
  mealTimes: Record<MealSlot, string>;
  trainingTimeWeekday: string;
  trainingTimeWeekend: string;
  weighIn: { enabled: boolean; weekday: number; time: string };
  photo: { enabled: boolean; weekday: number }; // фото прогресса раз в неделю, 1 = понедельник
  monthStartDay: number;
  containersEnabled: boolean;
  trainingStartDate: ISODate | null;
  postponeCardio: boolean;
  restDefaultSec: number;
  restAutoStart: boolean;
  restSound: boolean;
  photoMaxSide: number; // 0 — без уменьшения
  showWaist: boolean;
  theme: 'auto' | 'light' | 'dark';
  onboarded: boolean;
  installHintDismissed: boolean;
  lastBackupAt: string | null;
}

export interface Meta {
  key: 'main';
  seedId: string;
  seedIds: string[];
  seedAppliedAt: string;
  createdAt: string;
  installDate: ISODate;
  dataVersion: number;
}

export interface AppData {
  ready: boolean;
  settings: Settings;
  meta: Meta | null;
  planDays: Record<ISODate, PlanDay>;
  templateVersions: Record<string, TemplateVersion>;
  shoppingEvents: Record<string, ShoppingEvent>;
  cookingEvents: Record<string, CookingEvent>;
  taskStatus: Record<string, TaskStatusRec>;
  taskMoves: Record<string, TaskMove>;
  customTasks: Record<string, CustomTask>;
  trainingLogs: Record<string, TrainingLog>;
  weights: Record<string, WeightEntry>;
  measurements: Record<string, Measurement>;
  photos: Record<string, PhotoMeta>;
  shoppingChecks: Record<string, ShoppingCheck>;
  checks: Record<string, CheckRec>;
  dayNotes: Record<ISODate, DayNote>;
  userRecipes: Record<string, Recipe>;
  mealLinks: Record<string, MealMapEntry>;
  exportHistory: Record<string, ExportRecord>;
  patches: Record<string, PatchRecord>;
}

/** Хранилища-коллекции (в памяти — Record по ключу). */
export const RECORD_STORES = [
  'planDays', 'templateVersions', 'shoppingEvents', 'cookingEvents', 'taskStatus', 'taskMoves', 'customTasks',
  'trainingLogs', 'weights', 'measurements', 'photos', 'shoppingChecks', 'checks', 'dayNotes', 'userRecipes',
  'mealLinks', 'exportHistory', 'patches',
] as const;
export type RecordStore = (typeof RECORD_STORES)[number];

/** Ключ записи в каждом хранилище IndexedDB. */
export const STORE_KEYS: Record<RecordStore | 'settings' | 'meta' | 'photoBlobs', string> = {
  planDays: 'date',
  templateVersions: 'id',
  shoppingEvents: 'id',
  cookingEvents: 'id',
  taskStatus: 'taskId',
  taskMoves: 'taskId',
  customTasks: 'id',
  trainingLogs: 'id',
  weights: 'id',
  measurements: 'id',
  photos: 'id',
  shoppingChecks: 'id',
  checks: 'id',
  dayNotes: 'date',
  userRecipes: 'id',
  mealLinks: 'id',
  exportHistory: 'id',
  patches: 'id',
  settings: 'key',
  meta: 'key',
  photoBlobs: 'id',
};

/** Хранилища плана: их снимает «снимок» перед импортом и восстанавливает откат. */
export const PLAN_STORES = ['planDays', 'templateVersions', 'shoppingEvents', 'cookingEvents'] as const;
export type PlanStore = (typeof PLAN_STORES)[number];

/** Хранилища пользователя: импорт плана их никогда не трогает. */
export const USER_STORES = [
  'taskStatus', 'taskMoves', 'customTasks', 'trainingLogs', 'weights', 'measurements', 'photos',
  'shoppingChecks', 'checks', 'dayNotes', 'userRecipes', 'mealLinks', 'exportHistory', 'patches',
] as const;
