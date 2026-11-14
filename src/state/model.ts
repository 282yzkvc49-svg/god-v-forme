// Чистые функции модели данных: пустое состояние, применение операций, загрузка seed.
// Без IndexedDB — поэтому легко тестируются в Node.
import type { Op } from './idb';
import {
  RECORD_STORES, STORE_KEYS, type AppData, type Meta, type RecordStore, type Settings,
} from './types';
import { SEED_ID, defaultSettings, seedTemplateVersions } from '../lib/seed';
import type { ISODate } from '../lib/dates';
import { BASE_START, buildInstance, makePlanSettings, replanOps } from '../domain/plan';
import type { Trip } from './types';

export const DATA_VERSION = 5;

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
export function dataMigrationOps(data0: AppData, today: ISODate = BASE_START, now = new Date().toISOString()): Op[] {
  const ops: Op[] = [];
  if (!data0.meta) return ops;
  const v = data0.meta.dataVersion || 1;
  let data = data0;
  const step = (more: Op[]) => { ops.push(...more); data = applyOps(data, more); };
  if (v < 4) step(planV4Ops(data, today, now));
  if (v < 5) step(planV5Ops(data, today, now));
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
  if (v < 4 && !settings.plan) settings.plan = makePlanSettings(BASE_START, now, false);
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
export function planV4Ops(data: AppData, today: ISODate, now: string): Op[] {
  const cfg = data.settings.plan ?? makePlanSettings(BASE_START, now, false);
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
  { id: 'trip-2026-11-24-spb', city: 'Санкт-Петербург', from: '2026-11-24', to: '2026-11-25', hotelBreakfast: true, fridge: false, canTrain: false, comment: 'Гостиница, завтрак включён' },
];

/** Старые события командировки на 26.11 (даты поездки исправлены: 24–25.11). */
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
  const cfg = makePlanSettings(NOV_2026_START, now, false);
  const settings = {
    ...data.settings, plan: cfg,
    relaxOverrides: { ...(data.settings.relaxOverrides ?? {}), '2026-11': '2026-11-29' },
    training: { ...data.settings.training, startDate: NOV_2026_START },
  };
  ops.push({ store: 'settings', put: settings });
  const d2 = applyOps(data, ops);
  if (!data.settings.onboarded && !Object.values(data.planDays).length) return ops;
  return [...ops, ...replanOps(d2, cfg, today, { now }).ops];
}

export { buildInstance };

/** Состояние → массивы записей по хранилищам (для резервной копии). */
export function dataToStores(data: AppData): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const s of RECORD_STORES) out[s] = Object.values(data[s] as Record<string, unknown>);
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
