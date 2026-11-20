// Чистые функции модели данных: пустое состояние, применение операций, загрузка seed.
// Без IndexedDB — поэтому легко тестируются в Node.
import type { Op } from './idb';
import {
  RECORD_STORES, STORE_KEYS, type AppData, type Meta, type RecordStore, type Settings,
} from './types';
import { SEED_ID, defaultSettings, seedTemplateVersions } from '../lib/seed';
import type { ISODate } from '../lib/dates';
import { BASE_START, PLAN_LENGTH, buildInstance, makePlanSettings, menuUpdatePending, replanOps } from '../domain/plan';
import { addDays, fmtShort } from '../lib/dates';
import { planV8Ops } from '../domain/tripMove';
import type { BackupRec, CookingEvent, MealCard, MealSlot, MigrationReport, PlanDay, ShoppingEvent, Trip } from './types';
import { MEAL_LABELS, MEAL_SLOTS } from './types';
import { DISHES, PRODUCTS, TEMPLATE } from '../domain/catalog';

export const DATA_VERSION = 8;

export function emptyData(): AppData {
  const d: any = { ready: false, settings: defaultSettings(), meta: null };
  for (const s of RECORD_STORES) d[s] = {};
  return d as AppData;
}

/** Применяет операции к состоянию в памяти (неизменяемо — новые объекты для изменённых коллекций). */
export function applyOps(data: AppData, ops: Op[]): AppData {
  const next: any = { ...data };
  const touched = new Set<string>();
  for (const op of ops) {
    const store = op.store;
    if (store === 'photoBlobs') continue;
    if (store === 'settings') {
      if ('put' in op) next.settings = op.put as Settings;
      continue;
    }
    if (store === 'meta') {
      if ('put' in op) next.meta = op.put as Meta;
      else next.meta = null;
      continue;
    }
    if (!(RECORD_STORES as readonly string[]).includes(store)) continue;
    if (!touched.has(store)) {
      next[store] = { ...next[store] };
      touched.add(store);
    }
    const key = STORE_KEYS[store as RecordStore];
    if ('put' in op) next[store][op.put[key]] = op.put;
    else if ('del' in op) delete next[store][op.del as string];
    else next[store] = {};
  }
  return next as AppData;
}

/**
 * Операции первого запуска: шаблоны тренировок, настройки, метаданные.
 * План питания появляется, когда пользователь выберет дату старта (экран первой настройки).
 */
export function seedOps(now: string, today: ISODate): Op[] {
  const ops: Op[] = [];
  for (const t of seedTemplateVersions(now)) ops.push({ store: 'templateVersions', put: t });
  const settings = defaultSettings();
  // ноябрь 2026: известные командировки и релакс-день попадают и в свежую установку (например, на втором устройстве)
  if (today <= NOV_2026_TRIPS[NOV_2026_TRIPS.length - 1].to) {
    for (const t of NOV_2026_TRIPS) ops.push({ store: 'trips', put: { ...t, createdAt: now, updatedAt: now } });
    settings.relaxOverrides = { ...settings.relaxOverrides, '2026-11': '2026-11-29' };
  }
  if (today <= NOV_2026_START) settings.training = { ...settings.training, startDate: NOV_2026_START };
  ops.push({ store: 'settings', put: settings });
  const meta: Meta = {
    key: 'main', seedId: SEED_ID, seedIds: [SEED_ID], seedAppliedAt: now, createdAt: now, installDate: today, dataVersion: DATA_VERSION,
  };
  ops.push({ store: 'meta', put: meta });
  return ops;
}

/**
 * Если в новой версии приложения появится другой seed — добавляем только то, чего ещё нет.
 * Существующие дни, события и любые пользовательские записи не трогаем и не дублируем.
 */
export function seedUpgradeOps(data: AppData, now: string): Op[] {
  if (!data.meta || data.meta.seedIds?.includes(SEED_ID)) return [];
  const ops: Op[] = [];
  // стартовые шаблоны тренировок обновляются на месте: история хранит копию шаблона в каждой тренировке
  for (const t of seedTemplateVersions(now)) {
    const old = data.templateVersions[t.id];
    ops.push({ store: 'templateVersions', put: old ? { ...t, createdAt: old.createdAt } : t });
  }
  ops.push({ store: 'meta', put: { ...data.meta, seedIds: [...(data.meta.seedIds || [data.meta.seedId]), SEED_ID] } });
  return ops;
}

/** Миграции формата записей внутри хранилищ (не схемы IndexedDB). */
export function dataMigrationOps(data0: AppData, today: ISODate = BASE_START, now = new Date().toISOString(), appVersion = 'migration'): Op[] {
  const ops: Op[] = [];
  if (!data0.meta) return ops;
  const v = data0.meta.dataVersion || 1;
  let data = data0;
  const step = (more: Op[]) => { ops.push(...more); data = applyOps(data, more); };
  if (v < 4) step(planV4Ops(data, today, now));
  if (v < 5) step(planV5Ops(data, today, now));
  if (v < 6) step(planV6Ops(data, today, now));
  if (v < 7) step(planV7Ops(data, today, now, appVersion));
  if (v < 8) step(planV8Ops(data, today, now, appVersion));
  if (v < 2) {
    // v2: у позиции «Апельсины» из стартовых закупок убрано примечание (по решению пользователя)
    for (const e of Object.values(data.shoppingEvents)) {
      if (e.source !== 'seed' || !e.items.some((it) => it.itemId === 'p46' && it.note)) continue;
      ops.push({ store: 'shoppingEvents', put: { ...e, items: e.items.map((it) => (it.itemId === 'p46' ? { ...it, note: null } : it)) } });
    }
  }
  const { medicalAck: _old, ...rest } = data.settings as any;
  // v3: фото прогресса раз в неделю вместо раза в месяц
  if (rest.photo && typeof rest.photo.weekday !== 'number') rest.photo = { enabled: rest.photo.enabled !== false, weekday: defaultSettings().photo.weekday };
  const settings = { ...defaultSettings(), ...rest };
  // v4: план питания из шаблона с выбором даты старта; тренировки — своё расписание
  if (v < 4 && !settings.plan) settings.plan = makePlanSettings(V1_START, now, false);
  if (JSON.stringify(settings) !== JSON.stringify(data.settings)) ops.push({ store: 'settings', put: settings });
  if (v !== DATA_VERSION) ops.push({ store: 'meta', put: { ...data.meta, dataVersion: DATA_VERSION } });
  return ops;
}

// Позиции закупок первой версии плана → продукты нового каталога (чтобы сохранить галочки «куплено»).
const V1_ITEMS: Record<string, string[]> = {
  p01: ['chicken_breast'], p02: ['turkey_mince', 'turkey_breast'], p03: ['chicken_thigh_fillet'], p04: ['beef_lean'],
  p05: ['trout_fillet'], p06: ['salmon_fillet'], p07: ['mackerel_fillet'], p08: ['hake_fillet'], p09: ['shrimp_raw'],
  p10: ['tuna_canned'], p11: ['egg'], p12: ['cottage_5'], p13: ['greek_yogurt'], p14: ['kefir_1', 'ryazhenka'],
  p15: ['cheese_17'], p16: ['milk_15'], p17: ['kidney_beans'], p18: ['rice'], p19: ['buckwheat'], p20: ['bulgur'],
  p21: ['pearl_barley'], p22: ['couscous'], p23: ['quinoa'], p25: ['oats'], p27: ['bread_whole'], p28: ['lavash'],
  p29: ['potato'], p30: ['broccoli_frozen'], p31: ['green_beans_frozen'], p32: ['bell_pepper'], p33: ['tomato'],
  p34: ['cucumber'], p35: ['cabbage'], p36: ['carrot'], p37: ['spinach_frozen'], p38: ['onion'], p39: ['mushrooms_frozen'],
  p40: ['zucchini'], p41: ['chinese_cabbage'], p42: ['apple'], p43: ['banana'], p44: ['pear'], p45: ['kiwi'], p46: ['orange'],
  p47: ['blueberry_frozen', 'cherry_frozen', 'strawberry_frozen'], p48: ['walnuts', 'almonds'], p49: ['pumpkin_seeds', 'chia', 'flax'],
  p50: ['olive_oil'], p51: ['canned_tomatoes'], p52: ['soy_sauce'], p53: ['paprika', 'cumin', 'lemon', 'garlic'],
};

/**
 * v4: стартовый план 02.11–01.12 заменяется тем же планом с граммовками (даты и приёмы пищи те же,
 * поэтому отметки «съедено» остаются на своих местах). Отметки готовок и закупок, галочки «куплено»
 * и переносы переходят на новые события. Ничего пользовательского не удаляется.
 */
/** Дата старта плана первой версии приложения (данные до v4). */
const V1_START = '2026-11-02';

export function planV4Ops(data: AppData, today: ISODate, now: string): Op[] {
  const cfg = data.settings.plan ?? makePlanSettings(V1_START, now, false);
  const hasSeedPlan = Object.values(data.planDays).some((d) => d.source === 'seed');
  if (!hasSeedPlan && !data.settings.onboarded) return [];
  const res = replanOps(data, cfg, today, { force: true, now });
  const ops = res.ops.filter((o) => o.store !== 'settings');
  const inst = res.instance;
  const idMap = new Map<string, string>();
  for (const old of Object.values(data.cookingEvents)) {
    if (old.source !== 'seed' || old.instanceId) continue;
    const same = inst.cookingEvents.filter((e) => e.date === old.date);
    const hit = same.find((e) => e.kind === 'main') ?? same[0];
    if (hit) idMap.set(`cook:${old.id}`, `cook:${hit.id}`);
  }
  const oldShops = Object.values(data.shoppingEvents).filter((e) => e.source === 'seed' && !e.instanceId).sort((a, b) => a.date.localeCompare(b.date));
  const newMains = inst.shoppingEvents.filter((e) => e.kind === 'main');
  oldShops.forEach((old, i) => { if (newMains[i]) idMap.set(`shop:${old.id}`, `shop:${newMains[i].id}`); });
  const dateOf = (taskId: string) => {
    const id = taskId.slice(5);
    return inst.cookingEvents.find((e) => e.id === id)?.date ?? inst.shoppingEvents.find((e) => e.id === id)?.date ?? null;
  };
  for (const [oldId, newId] of idMap) {
    const st = data.taskStatus[oldId];
    if (st && !data.taskStatus[newId]) ops.push({ store: 'taskStatus', put: { ...st, taskId: newId, date: dateOf(newId) ?? st.date } });
    const mv = data.taskMoves[oldId];
    if (mv && !data.taskMoves[newId]) ops.push({ store: 'taskMoves', put: { ...mv, taskId: newId, fromDate: dateOf(newId) ?? mv.fromDate } });
  }
  for (const c of Object.values(data.shoppingChecks)) {
    const newEv = idMap.get(`shop:${c.eventId}`)?.slice(5);
    if (!newEv) continue;
    const lines = inst.shoppingEvents.find((e) => e.id === newEv)?.lines ?? [];
    for (const pid of V1_ITEMS[c.itemId] ?? []) {
      if (!lines.some((l) => l.productId === pid)) continue;
      const id = `${newEv}:${pid}`;
      if (data.shoppingChecks[id]) continue;
      ops.push({ store: 'shoppingChecks', put: { ...c, id, eventId: newEv, itemId: pid, actualPrice: null } });
    }
  }
  return ops;
}

/** План для свежей установки (тесты и режим без IndexedDB): старт с базовой даты. */
export function freshPlanOps(data: AppData, startDate: ISODate, today: ISODate, now: string): Op[] {
  return replanOps(data, makePlanSettings(startDate, now), today).ops;
}

// ------------------------------------------------------------------ v5: старт 16.11 и командировки

export const NOV_2026_START = '2026-11-16';
export const NOV_2026_TRIPS: Omit<Trip, 'createdAt' | 'updatedAt'>[] = [
  { id: 'trip-2026-11-18-ekb', city: 'Екатеринбург', from: '2026-11-18', to: '2026-11-20', hotelBreakfast: true, fridge: false, canTrain: false, comment: 'Гостиница, завтрак включён' },
  // даты перенесены 20.11.2026 (было 24–25.11); на следующий день после возвращения — силовая по самочувствию
  { id: 'trip-2026-11-24-spb', city: 'Санкт-Петербург', from: '2026-11-25', to: '2026-11-26', hotelBreakfast: true, fridge: false, canTrain: false, trainNextDay: true, comment: 'Гостиница, завтрак включён' },
];

/** Старые события командировки на 26.11 из первого плана (до версии 1.2.0). */
function staleTripTask(title: string): boolean {
  return /командир|петербург|спб|поездк/i.test(title);
}

/**
 * v5: программа питания и тренировок стартует 16.11.2026; командировки 18–20.11 (Екатеринбург) и 24–25.11
 * (Санкт-Петербург); релакс-день ноября — 29.11. План пересобирается, прошедшее остаётся историей,
 * отметки, тренировки, вес и фото не трогаются.
 */
export function planV5Ops(data: AppData, today: ISODate, now: string): Op[] {
  const ops: Op[] = [];
  for (const t of NOV_2026_TRIPS) {
    const same = Object.values(data.trips ?? {}).some((x) => x.from === t.from && x.to === t.to);
    if (!same) ops.push({ store: 'trips', put: { ...t, createdAt: now, updatedAt: now } });
  }
  for (const c of Object.values(data.customTasks)) {
    if (c.date === '2026-11-26' && c.date >= today && staleTripTask(`${c.title} ${c.note ?? ''}`)) ops.push({ store: 'customTasks', del: c.id });
  }
  const imp = data.planDays['2026-11-26'];
  if (imp && imp.source === 'import' && staleTripTask(`${imp.note ?? ''} ${Object.values(imp.meals ?? {}).join(' ')}`)) ops.push({ store: 'planDays', del: '2026-11-26' });
  // меню и дата старта питания меняются только после предпросмотра нового меню (menuUpdateOps)
  const settings = {
    ...data.settings,
    relaxOverrides: { ...(data.settings.relaxOverrides ?? {}), '2026-11': '2026-11-29' },
    training: { ...data.settings.training, startDate: NOV_2026_START },
  };
  ops.push({ store: 'settings', put: settings });
  return ops;
}

/**
 * v6: скумбрия заменена горбушей (обед и ужины с рыбой, рецепт «Горбуша гриль с картофелем и овощным салатом»).
 * План пересобирается по новому шаблону с той же датой старта: меню, готовки и закупки с сегодняшнего дня —
 * по новым граммовкам; прошедшие дни остаются историей, отметки и все записи пользователя не трогаются.
 */
export function planV6Ops(_data: AppData, _today: ISODate, _now: string): Op[] {
  // замена скумбрии горбушей вошла в меню «Азбука вкуса»; новое меню применяется после предпросмотра
  return [];
}

/**
 * v7: прежнее меню больше не остаётся активным до нажатия кнопки. В 1.3.0–1.4.0 новое меню применялось только
 * по кнопке на экране обновления, и на устройствах, где её не нажали, в базе оставался план версии 1.2.0
 * (старт 16.11) со скумбрией 28.11, 30.11, 07.12, 08.12, 09.12, готовками 28.11 и 07.12 и строками закупок.
 * Теперь обновление на комплект v2 применяется при запуске: сначала внутренняя резервная копия, затем новое меню,
 * затем удаление скумбрии из оставшихся данных; отмеченное пользователем остаётся историей, отчёт показывается
 * один раз. Если меню уже новое — только проверка, что в данных нет удалённых блюд и товаров.
 */
export function planV7Ops(data: AppData, today: ISODate, now: string, appVersion = 'migration'): Op[] {
  if (!data.settings.onboarded || !data.settings.plan) return [];
  if (!menuUpdatePending(data)) return purgeRemovedOps(data, today).ops;
  const base = TEMPLATE.base_start;
  const start = today <= addDays(base, PLAN_LENGTH - 1) ? base : today;
  const res = menuUpdateOps(data, start, today, now, appVersion, true);
  const after = applyOps(data, res.ops);
  return [...res.ops, { store: 'settings', put: { ...after.settings, menuReportUnseen: res.backupId } }];
}

/** Даты прежнего меню со скумбрией начиная с сегодняшнего дня (для отчёта). */
export function removedDates(data: AppData, today: ISODate): { days: ISODate[]; cooks: ISODate[]; shops: ISODate[] } {
  const sorted = (xs: ISODate[]) => Array.from(new Set(xs)).sort();
  return {
    days: sorted(Object.values(data.planDays).filter((d) => d.date >= today && dayHasRemoved(d)).map((d) => d.date)),
    cooks: sorted(Object.values(data.cookingEvents).filter((e) => e.date >= today && cookHasRemoved(e)).map((e) => e.date)),
    shops: sorted(Object.values(data.shoppingEvents).filter((e) => e.date >= today && shopHasRemoved(e)).map((e) => e.date)),
  };
}

/**
 * Переход на новое меню (шаблон с другим id): план пересобирается с выбранной датой старта.
 * Прошедшие дни — история; тренировки, вес, фото, отметки, командировки и релакс-дни не меняются.
 */
export function menuUpdateOps(data: AppData, startDate: ISODate, today: ISODate, now: string, appVersion = 'test', auto = false) {
  const res = replanOps(data, makePlanSettings(startDate, now, true), today, { now });
  const after = applyOps(data, res.ops);
  const purge = purgeRemovedOps(after, today, res.instance);
  const newDays = new Set(res.instance.planDays.map((d) => d.date));
  const replacedDays = res.instance.planDays.filter((d) => d.date >= today && JSON.stringify(data.planDays[d.date]?.meals ?? null) !== JSON.stringify(d.meals)).length;
  // будущие готовки и закупки прежнего плана заменяются все (удаляются или перезаписываются новыми с тем же id)
  const gone = (store: 'cookingEvents' | 'shoppingEvents') => Object.values(data[store]).filter((e) => e.source === 'seed' && e.date >= today).length;
  const futureMackerel = Object.values(data.planDays).filter((d) => d.date >= today && dayHasRemoved(d)).length
    + Object.values(data.cookingEvents).filter((e) => e.date >= today && cookHasRemoved(e)).length
    + Object.values(data.shoppingEvents).filter((e) => e.date >= today && shopHasRemoved(e)).length;
  const keptMarks: string[] = [];
  for (const s of Object.values(data.taskStatus)) {
    if (s.status === 'planned' || !s.taskId.startsWith('meal:')) continue;
    const [, date, slot] = s.taskId.split(':');
    if (date >= today && newDays.has(date) && data.planDays[date]?.meals?.[slot as MealSlot] !== res.instance.planDays.find((d) => d.date === date)?.meals?.[slot as MealSlot]) {
      keptMarks.push(`${date} ${slot}: отметка «${s.status}» сохранена, блюдо меняется`);
    }
  }
  const report: MigrationReport = {
    appliedAt: now, startDate, replacedDays, removedFutureCooks: gone('cookingEvents'), removedFutureShops: gone('shoppingEvents'),
    mackerel: { removedPast: purge.removed, keptHistory: purge.kept, future: futureMackerel }, unknownRefsFixed: purge.unknown, keptMarks,
    auto, mackerelDates: removedDates(data, today),
  };
  // резервная копия всех данных (кроме самих фото) — до изменения базы, в той же транзакции
  const backup: BackupRec = {
    id: `menu-${now.replace(/[^0-9]/g, '').slice(0, 14)}`, createdAt: now,
    reason: `${auto ? 'Автоматически при запуске версии ' + appVersion + ', перед' : 'Перед'} обновлением меню на «${TEMPLATE.id}»`, appVersion,
    fromMenu: data.settings.plan?.menuId ?? null, toMenu: TEMPLATE.id, stores: dataToStores(data), report,
  };
  const old = Object.values(data.backups ?? {}).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(1);
  const ops: Op[] = [{ store: 'backups', put: backup }, ...old.map((b) => ({ store: 'backups', del: b.id }) as Op), ...res.ops, ...purge.ops];
  return { ...res, ops, report, backupId: backup.id };
}

// ------------------------------------------------------------------ удалённые продукты (скумбрия) в старых данных

/** Блюда и продукты, убранные из меню навсегда: в активных данных их быть не должно. */
export const REMOVED_DISHES = ['mackerel'];
export const REMOVED_PRODUCTS = ['mackerel_fillet'];
export const REMOVED_TEXT = /скумбри/i;

function partRemoved(dishId: string): boolean {
  if (REMOVED_DISHES.includes(dishId)) return true;
  const d = DISHES[dishId];
  if (!d) return true; // ссылка на блюдо, которого нет в справочнике
  return d.ingredients.some((i) => REMOVED_PRODUCTS.includes(i.product));
}

function slotRemoved(day: PlanDay, slot: MealSlot): boolean {
  const card = day.mealCards?.[slot];
  if (card && (card.parts.some((p) => partRemoved(p.dishId)) || REMOVED_TEXT.test(card.title))) return true;
  return REMOVED_TEXT.test(day.meals?.[slot] ?? '');
}

export function dayHasRemoved(day: PlanDay): boolean {
  return MEAL_SLOTS.some((s) => slotRemoved(day, s));
}

export function cookHasRemoved(e: CookingEvent): boolean {
  return (e.items ?? []).some((i) => partRemoved(i.dishId)) || REMOVED_TEXT.test(`${e.sourceText ?? ''} ${(e.dishes ?? []).map((x) => x.text).join(' ')}`);
}

function lineRemoved(productId: string, name?: string): boolean {
  return REMOVED_PRODUCTS.includes(productId) || !PRODUCTS[productId] || REMOVED_TEXT.test(name ?? '');
}

export function shopHasRemoved(e: ShoppingEvent): boolean {
  return (e.lines ?? []).some((l) => lineRemoved(l.productId)) || (e.items ?? []).some((i) => REMOVED_TEXT.test(i.name));
}

const REMOVED_CARD: MealCard = { title: 'Блюдо прежнего меню удалено', parts: [] };

/**
 * Убирает скумбрию (и ссылки на удалённые товары) из сохранённых данных прежних меню.
 * Отмеченное пользователем (съедено, приготовлено, куплено) остаётся историей. Дни целиком не удаляются:
 * неотмеченный приём со скумбрией с сегодняшнего дня получает блюдо нового плана на эту дату (inst),
 * в прошедших днях — пометку «Блюдо прежнего меню удалено»; остальные приёмы дня не меняются.
 */
export function purgeRemovedOps(data: AppData, today: ISODate, inst?: { planDays: PlanDay[] } | null): { ops: Op[]; removed: string[]; kept: string[]; unknown: string[] } {
  const ops: Op[] = [];
  const removed: string[] = [], kept: string[] = [], unknown: string[] = [];
  const marked = (taskId: string) => { const st = data.taskStatus[taskId]?.status; return !!st && st !== 'planned'; };
  const instDays = new Map((inst?.planDays ?? []).map((d) => [d.date, d]));
  for (const day of Object.values(data.planDays)) {
    const slots = MEAL_SLOTS.filter((s) => slotRemoved(day, s));
    if (!slots.length) continue;
    const repl = day.date >= today ? instDays.get(day.date) : undefined;
    const cards = day.mealCards ? { ...day.mealCards } : null;
    const meals = day.meals ? { ...day.meals } : null;
    let changed = false;
    for (const s of slots) {
      const title = day.mealCards?.[s]?.title ?? day.meals?.[s] ?? '';
      const at = `${fmtShort(day.date)} ${MEAL_LABELS[s].toLowerCase()}`;
      if (marked(`meal:${day.date}:${s}`)) { kept.push(`${at}: «${title}» — отмечено, осталось в истории`); continue; }
      const card = repl?.mealCards?.[s] && !slotRemoved(repl, s) ? repl.mealCards[s] : REMOVED_CARD;
      if (cards) cards[s] = card;
      if (meals) meals[s] = card === REMOVED_CARD ? REMOVED_CARD.title : repl?.meals?.[s] ?? card.title;
      changed = true;
      removed.push(`${at}: «${title}» без отметки — ${card === REMOVED_CARD ? 'убрано' : `заменено на «${card.title}»`}`);
    }
    if (changed) ops.push({ store: 'planDays', put: { ...day, mealCards: cards, meals } });
  }
  for (const e of Object.values(data.cookingEvents)) {
    if (!cookHasRemoved(e)) continue;
    if (marked(`cook:${e.id}`)) { kept.push(`${fmtShort(e.date)} готовка «${e.title}» — отмечена, осталась в истории`); continue; }
    const items = (e.items ?? []).filter((i) => !partRemoved(i.dishId));
    const dishes = (e.dishes ?? []).filter((x) => !REMOVED_TEXT.test(x.text) && !x.recipeIds.some((r) => REMOVED_DISHES.includes(r)));
    if (!items.length && !dishes.length) ops.push({ store: 'cookingEvents', del: e.id });
    else ops.push({ store: 'cookingEvents', put: { ...e, items, dishes, sourceText: dishes.map((x) => x.text).join('; ') } });
    removed.push(`${fmtShort(e.date)} готовка: блюда со скумбрией убраны`);
  }
  for (const e of Object.values(data.shoppingEvents)) {
    if (!shopHasRemoved(e)) continue;
    const check = (id: string) => { const c = data.shoppingChecks[`${e.id}:${id}`]; return !!(c?.bought || c?.atHome); };
    const lines = (e.lines ?? []).filter((l) => !lineRemoved(l.productId) || check(l.productId));
    const items = (e.items ?? []).filter((i) => !(REMOVED_TEXT.test(i.name) || lineRemoved(i.itemId, i.name) && !!e.lines) || check(i.itemId));
    for (const l of e.lines ?? []) if (lineRemoved(l.productId)) {
      if (check(l.productId)) kept.push(`${fmtShort(e.date)} закупка: «${PRODUCTS[l.productId]?.name ?? l.productId}» — отмечено, осталось в истории`);
      else (PRODUCTS[l.productId] ? removed : unknown).push(`${fmtShort(e.date)} закупка: ${PRODUCTS[l.productId]?.name ?? l.productId} — строка убрана`);
    }
    if (!lines.length && !items.length && !marked(`shop:${e.id}`)) ops.push({ store: 'shoppingEvents', del: e.id });
    else ops.push({ store: 'shoppingEvents', put: { ...e, lines: e.lines ? lines : e.lines, items } });
  }
  for (const m of Object.values(data.mealLinks ?? {})) {
    if (m.recipe_id && REMOVED_DISHES.includes(m.recipe_id)) { ops.push({ store: 'mealLinks', del: (m as any).id }); removed.push(`связь «${m.match}» → рецепт со скумбрией убрана`); }
  }
  for (const c of Object.values(data.checks ?? {})) if (REMOVED_DISHES.some((d) => c.id.startsWith(`recipe:${d}:`))) ops.push({ store: 'checks', del: c.id });
  return { ops, removed, kept, unknown };
}

/**
 * Откат обновления меню: план (дни, готовки, закупки, дата старта) — как в копии; записи пользователя не трогаются.
 * Скумбрия и удалённые товары в активное меню не возвращаются.
 */
export function rollbackMenuOps(data: AppData, backupId: string, today: ISODate): Op[] {
  const b = data.backups?.[backupId];
  if (!b) return [];
  const ops: Op[] = [];
  for (const store of ['planDays', 'cookingEvents', 'shoppingEvents'] as const) {
    ops.push({ store, clear: true });
    for (const r of b.stores[store] ?? []) ops.push({ store, put: r });
  }
  const s = (b.stores.settings ?? [])[0];
  if (s) ops.push({ store: 'settings', put: { ...data.settings, plan: s.plan ?? null, menuReportUnseen: null } });
  return [...ops, ...purgeRemovedOps(applyOps(data, ops), today).ops];
}

export { buildInstance };

/** Состояние → массивы записей по хранилищам (для резервной копии). */
/** Все хранилища для копии; внутренние копии (backups) не вкладываются в новые. */
export function dataToStores(data: AppData, withBackups = false): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const s of RECORD_STORES) {
    if (s === 'backups' && !withBackups) continue;
    out[s] = Object.values((data[s] ?? {}) as Record<string, unknown>);
  }
  out.settings = [data.settings];
  out.meta = data.meta ? [data.meta] : [];
  return out;
}

/** Массивы записей → состояние. */
export function storesToData(stores: Record<string, any[]>): AppData {
  let d = emptyData();
  const ops: Op[] = [];
  for (const [store, rows] of Object.entries(stores)) for (const r of rows || []) ops.push({ store, put: r });
  d = applyOps(d, ops);
  d.settings = { ...defaultSettings(), ...d.settings };
  return d;
}
