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
  /** Экземпляр плана питания из шаблона (src/data/plan_template.json). */
  instanceId?: string | null;
  templateDay?: number | null;
  /** День командировки: вместо домашнего меню — варианты в гостинице, ресторане и из супермаркета. */
  tripId?: string | null;
  /** Подробные карточки приёмов пищи: блюда с количеством, из какой готовки взять порцию. */
  mealCards?: Record<MealSlot, MealCard> | null;
}

export interface MealCardPart {
  dishId: string;
  qty: number; // в единицах блюда: порции или граммы
  fresh: boolean; // готовится к этому приёму (не из партии)
  cookEventId?: string | null;
  storage?: 'fridge' | 'freeze' | 'pantry' | null;
  thawOn?: ISODate | null;
  /** Из того, что уже есть дома: чего не хватит — показать дефицит, а не докупать. */
  stockOnly?: boolean;
}

export interface MealCard {
  title: string;
  parts: MealCardPart[];
  /** Приём пищи отменён корректировкой (например, обед не дома). */
  cancelled?: boolean;
  /** Пояснение корректировки (почему блюдо заменено). */
  note?: string | null;
}

export interface TemplateItem {
  exerciseId: string;
  sets: number;
  reps?: number | null;
  seconds?: number | null;
  minutes?: number | [number, number] | null;
  perSide?: string | null;
  weightKg?: [number, number] | null;
  /** Явный вес гири: 12 или 16 кг; null — без гири. Автоматически не повышается. */
  kettlebellKg?: number | null;
  /** Более лёгкий вариант, если техника нарушается (например, 12 кг вместо 16). */
  fallbackKg?: number | null;
  /** Замена упражнения, если вес не удаётся безопасно контролировать. */
  alternative?: { exerciseId: string; reps?: number | null; note?: string | null } | null;
  /** Условие выполнения (показывается в карточке). */
  condition?: string | null;
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

/** date — купить не позже (закупка до этой даты), use — когда продукт идёт в дело (для срока хранения). */
export interface ShoppingNeed { date: ISODate; label: string; qty: number; use?: ISODate }

/** Строка закупки, посчитанная из меню и готовок: сколько нужно, сколько купить, сколько останется. */
export interface ShopLine {
  productId: string;
  need: number; // нужно к этой закупке (единицы продукта, масса покупки с учётом несъедобной части)
  fromStock: number; // покроет остаток прошлых закупок
  buy: number; // купить
  packs: number | null; // упаковок; null — по весу
  cost: number;
  leftover: number;
  freezeNow: number; // заморозить в день покупки (нужно позже срока хранения)
  notes: string[];
  needs: ShoppingNeed[];
}

export interface ShoppingEvent {
  id: string;
  date: ISODate;
  title: string;
  forDatesText?: string | null;
  items: ShoppingItem[];
  source: 'seed' | 'import';
  patchId?: string | null;
  instanceId?: string | null;
  kind?: 'main' | 'topup' | 'trip' | null;
  tripId?: string | null;
  time?: string | null;
  lines?: ShopLine[] | null;
  covers?: { from: ISODate; to: ISODate } | null;
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
  instanceId?: string | null;
  blockId?: string | null;
  kind?: 'main' | 'quick' | null;
  time?: string | null;
  timeNote?: string | null;
  items?: CookItem[] | null;
  /** Сырые продукты из морозилки: накануне переложить в холодильник. */
  thawProducts?: { productId: string; qty: number }[] | null;
  /** Своя готовка из того, что уже есть дома: чего не хватит — дефицит, а не докупка. */
  stockOnly?: boolean;
}

export interface CookUse {
  date: ISODate;
  slot: MealSlot;
  qty: number;
  via?: string | null; // блюдо, в которое входит (лаваш с индейкой и т. п.)
  storage: 'fridge' | 'freeze' | 'pantry';
  thawOn?: ISODate | null;
}

export interface CookItem {
  dishId: string;
  qty: number; // всего в единицах блюда
  uses: CookUse[];
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

export type RecipeType = 'main' | 'side' | 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';

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
  | 'meal' | 'training' | 'cooking' | 'shopping' | 'containers' | 'thaw' | 'weigh' | 'photo' | 'custom';

export interface TaskStatusRec {
  taskId: string;
  date: ISODate; // исходная плановая дата задачи
  kind: TaskKind;
  status: TaskStatus;
  updatedAt: string;
  /** Командировочный приём пищи: съел предложенный вариант или выбрал другое подходящее блюдо. */
  choice?: 'suggested' | 'other' | null;
  variantId?: string | null;
  comment?: string | null;
}

/** Командировка: в эти дни вместо домашнего меню и тренировок — командировочный режим. */
export interface Trip {
  id: string;
  city: string;
  from: ISODate;
  to: ISODate; // включительно
  hotelBreakfast: boolean;
  fridge: boolean;
  canTrain: boolean;
  /** На следующий день после возвращения — тренировка по схеме, по самочувствию (а не восстановление). */
  trainNextDay?: boolean;
  comment: string | null;
  /** Фактические расходы на еду в поездке — отдельно от домашнего бюджета (необязательно). */
  foodExpensesRub?: number | null;
  createdAt: string;
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
  /** Фактические повторы (или секунды) по подходам; null — не записано. */
  reps?: (number | null)[] | null;
  /** Выбранный вариант упражнения (например, отжимания от возвышения вместо жима). */
  variantId?: string | null;
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
  atHome?: boolean; // «есть дома» — не покупать
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
  /** Программа питания: дата старта (день 1). null — ещё не выбрано. */
  plan: PlanSettings | null;
  /** Релакс-день каждого календарного месяца ('YYYY-MM' → дата); по умолчанию — последнее воскресенье. */
  relaxOverrides: Record<string, ISODate>;
  /** Расписание тренировок — своё, не зависит от даты старта питания. */
  training: TrainingSchedule;
  restDefaultSec: number;
  restAutoStart: boolean;
  restSound: boolean;
  photoMaxSide: number; // 0 — без уменьшения
  showWaist: boolean;
  theme: 'auto' | 'light' | 'dark';
  onboarded: boolean;
  installHintDismissed: boolean;
  lastBackupAt: string | null;
  /** Пользователь выбрал свой адрес доставки на av.ru перед проверкой товаров. */
  avAddressConfirmedAt?: string | null;
  /** id резервной копии автоматического обновления меню, отчёт о котором ещё не показан. */
  menuReportUnseen?: string | null;
  /** id резервной копии переноса командировки, отчёт о котором ещё не показан. */
  tripReportUnseen?: string | null;
  /** Перенос командировки ждёт подтверждения: затрагивает уже отмеченное. */
  tripMovePending?: { tripId: string; from: ISODate; to: ISODate; createdAt: string } | null;
  /** Учёт запасов включён: отметки «приготовлено» и «съедено» с этой даты списывают продукты. */
  inventory?: { since: ISODate; createdAt: string } | null;
  /** Фактически потрачено на домашние закупки цикла (если указано). */
  budgetSpent?: { amount: number; note: string | null; at: string } | null;
  /** Применённые корректировки по факту: id → когда. */
  corrections?: Record<string, string> | null;
  /** id резервной копии корректировки, отчёт о которой ещё не показан. */
  correctionReportUnseen?: string | null;
}

export interface PlanSettings {
  startDate: ISODate;
  /** Устарело (v4): релакс-день теперь календарный — Settings.relaxOverrides. */
  relaxDay?: number;
  instanceId: string;
  confirmed: boolean; // пользователь подтвердил дату (после обновления — false, пока не подтвердит)
  /** Какое меню применено (id шаблона); другое значение — доступно обновление меню с предпросмотром. */
  menuId?: string;
  setAt: string;
  /** Ручные корректировки поверх шаблона: отдельные приёмы пищи и свои готовки. */
  overrides?: PlanOverrides | null;
}

/** Замена приёма пищи поверх шаблона. */
export type SlotOverride =
  | { kind: 'cancel'; label: string }
  | { kind: 'dish'; dishId: string; note?: string | null }
  | { kind: 'cook'; cookId: string; dishId: string; note?: string | null };

/** Своя готовка (не из партии шаблона): блюдо, порции и на какие приёмы. */
export interface CustomCook {
  id: string;
  date: ISODate;
  time: string;
  title: string;
  note?: string | null;
  items: { dishId: string; uses: { date: ISODate; slot: MealSlot }[] }[];
}

export interface PlanOverrides {
  /** Корректировка, которая их создала. */
  sourceId: string;
  days: Record<ISODate, Partial<Record<MealSlot, SlotOverride>>>;
  cooks: CustomCook[];
}

/** Учёт запасов: движения по продукту. Остаток = купленное + поступления − использованное − списанное ± исправления. */
export type StockKind = 'purchase' | 'use' | 'writeoff' | 'adjust';
export interface StockMove {
  id: string;
  date: ISODate;
  kind: StockKind;
  /** Количество в единицах товара (г, мл, шт.); у adjust — со знаком. */
  qty: number;
  /** Откуда: закупка, готовка (cook:<id>), приём пищи (meal:<дата>:<приём>), фото чеков, вручную. */
  source: string | null;
  note: string | null;
  /** false — расчёт/оценка, требует подтверждения. */
  confirmed: boolean;
  at: string;
}
export type StockPlace = 'fridge' | 'freezer' | 'pantry';
export interface StockRec {
  productId: string;
  location: StockPlace;
  moves: StockMove[];
  /** Когда пользователь проверил остаток; null — расчётный, «Требует подтверждения». */
  confirmedAt: string | null;
  /** Срок годности с упаковки, если указан. */
  expiresOn: ISODate | null;
  note: string | null;
  updatedAt: string;
}

/** Готовая еда: что стало с порцией, которую не съели по плану. */
export interface ReadyFoodRec {
  id: string; // `${cookId}|${dishId}|${date}|${slot}`
  cookId: string;
  dishId: string;
  date: ISODate;
  slot: MealSlot;
  status: 'frozen' | 'writeoff' | 'eaten';
  at: string;
}

export interface TrainingSchedule {
  startDate: ISODate; // первый день программы тренировок; силовые чередуются А/Б начиная с неё
  strengthDays: number[]; // 1 = пн … 7 = вс
  cardioDays: number[];
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

/** Замена товара, подтверждённая пользователем (товар есть в его корзине av.ru по его адресу). */
export interface ProductSub {
  /** Товар из каталога меню, который заменяет недоступный; null — свой товар av.ru. */
  catalogId: string | null;
  name: string;
  url: string; // только https://av.ru/i/<номер>
  packSize: number;
  packPrice: number;
  /** На 100 г (100 мл, для штучных — на 100 г при 1 шт. ≈ piece_g); null — как у исходного товара. */
  nutr: { kcal: number; p: number; f: number; c: number } | null;
  edibleRatio: number | null;
  /** Коэффициент граммовки в рецептах: сохраняет белок (мясо, рыба, молочное) или калорийность. */
  qtyFactor: number;
  confirmedAt: string;
}

/** Проверка товара в корзине av.ru по адресу пользователя. */
export interface AvProductRec {
  productId: string;
  status: 'available' | 'unavailable' | null;
  checkedAt: string | null;
  sub: ProductSub | null;
  updatedAt: string;
}

/** Внутренняя резервная копия перед изменением базы (обновление меню). */
export interface BackupRec {
  id: string;
  createdAt: string;
  reason: string;
  appVersion: string;
  fromMenu: string | null;
  toMenu: string | null;
  stores: Record<string, any[]>;
  /** Итог миграции для отчёта. */
  report?: MigrationReport | null;
  /** Итог переноса командировки для отчёта. */
  tripReport?: TripMoveReport | null;
  /** Итог корректировки по факту для отчёта. */
  correctionReport?: CorrectionReport | null;
}

/** Строка запасов в отчёте. */
export interface StockRow {
  productId: string;
  name: string;
  unit: 'g' | 'ml' | 'pcs';
  bought: number;
  used: number;
  writtenOff: number;
  adjusted: number;
  remaining: number;
  location: StockPlace;
  until: ISODate | null;
  expired: boolean;
  needsConfirm: boolean;
}

/** Корректировка по факту: что изменено в днях, готовках, запасах и закупках. */
export interface CorrectionReport {
  id: string;
  appliedAt: string;
  today: ISODate;
  marks: string[];
  dishes: { date: ISODate; slot: MealSlot; before: string; after: string }[];
  portions: string[];
  stock: StockRow[];
  needConfirm: string[];
  /** Небольшие закупки до второй основной (к 27–28.11). */
  extra: { id: string; date: ISODate; title: string; lines: { name: string; text: string; cost: number }[]; cost: number }[];
  main: { id: string; date: ISODate; lines: { name: string; need: string; fromStock: string; buy: string; cost: number }[]; cost: number; covered: string[] } | null;
  later: { date: ISODate; title: string; cost: number }[];
  budget: { total: number; spent: number; spentActual: boolean; planned: number; left: number };
  /** Чего по учёту не хватает к блюдам «из того, что есть дома» (не докупается). */
  deficits: string[];
  notes: string[];
  conflicts: string[];
}

/** Перенос командировки: что поменялось в днях, готовке, закупках и тренировках. */
export interface TripMoveReport {
  appliedAt: string;
  today: ISODate;
  city: string;
  before: { from: ISODate; to: ISODate };
  after: { from: ISODate; to: ISODate };
  days: { date: ISODate; before: string; after: string }[];
  cooks: { title: string; text: string }[];
  shops: { title: string; text: string }[];
  trainings: { date: ISODate; before: string; after: string }[];
  costBefore: number;
  costAfter: number;
  frozenBefore: number;
  frozenAfter: number;
  /** Отмеченное пользователем, что пришлось изменить после подтверждения. */
  confirmed: string[];
}

export interface MigrationReport {
  appliedAt: string;
  startDate: ISODate;
  replacedDays: number;
  removedFutureCooks: number;
  removedFutureShops: number;
  mackerel: { removedPast: string[]; keptHistory: string[]; future: number };
  unknownRefsFixed: string[];
  keptMarks: string[];
  /** Применено автоматически при запуске новой версии (а не кнопкой). */
  auto?: boolean;
  /** Даты прежнего меню со скумбрией (с сегодняшнего дня), которые заменены новым меню. */
  mackerelDates?: { days: ISODate[]; cooks: ISODate[]; shops: ISODate[] };
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
  trips: Record<string, Trip>;
  dayNotes: Record<ISODate, DayNote>;
  userRecipes: Record<string, Recipe>;
  mealLinks: Record<string, MealMapEntry>;
  exportHistory: Record<string, ExportRecord>;
  patches: Record<string, PatchRecord>;
  avProducts: Record<string, AvProductRec>;
  backups: Record<string, BackupRec>;
  stock: Record<string, StockRec>;
  readyFood: Record<string, ReadyFoodRec>;
}

/** Хранилища-коллекции (в памяти — Record по ключу). */
export const RECORD_STORES = [
  'planDays', 'templateVersions', 'shoppingEvents', 'cookingEvents', 'taskStatus', 'taskMoves', 'customTasks',
  'trainingLogs', 'weights', 'measurements', 'photos', 'shoppingChecks', 'checks', 'dayNotes', 'userRecipes',
  'mealLinks', 'exportHistory', 'patches', 'trips', 'avProducts', 'backups', 'stock', 'readyFood',
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
  trips: 'id',
  avProducts: 'productId',
  backups: 'id',
  stock: 'productId',
  readyFood: 'id',
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
  'shoppingChecks', 'checks', 'dayNotes', 'userRecipes', 'mealLinks', 'exportHistory', 'patches', 'trips', 'avProducts',
  'stock', 'readyFood',
] as const;
