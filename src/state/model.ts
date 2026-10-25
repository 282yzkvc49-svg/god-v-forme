// Чистые функции модели данных: пустое состояние, применение операций, загрузка seed.
// Без IndexedDB — поэтому легко тестируются в Node.
import type { Op } from './idb';
import {
  RECORD_STORES, STORE_KEYS, type AppData, type Meta, type RecordStore, type Settings,
} from './types';
import {
  SEED_ID, defaultSettings, seedCookingEvents, seedPlanDays, seedShoppingEvents, seedTemplateVersions,
} from '../lib/seed';
import type { ISODate } from '../lib/dates';

export const DATA_VERSION = 2;

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

/** Операции первого запуска: стартовый план из initial_seed.json, настройки, метаданные. */
export function seedOps(now: string, today: ISODate): Op[] {
  const ops: Op[] = [];
  for (const d of seedPlanDays()) ops.push({ store: 'planDays', put: d });
  for (const t of seedTemplateVersions(now)) ops.push({ store: 'templateVersions', put: t });
  for (const e of seedShoppingEvents()) ops.push({ store: 'shoppingEvents', put: e });
  for (const e of seedCookingEvents()) ops.push({ store: 'cookingEvents', put: e });
  ops.push({ store: 'settings', put: defaultSettings() });
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
  for (const d of seedPlanDays()) if (!data.planDays[d.date]) ops.push({ store: 'planDays', put: d });
  for (const t of seedTemplateVersions(now)) if (!data.templateVersions[t.id]) ops.push({ store: 'templateVersions', put: t });
  for (const e of seedShoppingEvents()) if (!data.shoppingEvents[e.id]) ops.push({ store: 'shoppingEvents', put: e });
  for (const e of seedCookingEvents()) if (!data.cookingEvents[e.id]) ops.push({ store: 'cookingEvents', put: e });
  ops.push({ store: 'meta', put: { ...data.meta, seedIds: [...(data.meta.seedIds || [data.meta.seedId]), SEED_ID] } });
  return ops;
}

/** Миграции формата записей внутри хранилищ (не схемы IndexedDB). */
export function dataMigrationOps(data: AppData): Op[] {
  const ops: Op[] = [];
  if (!data.meta) return ops;
  const v = data.meta.dataVersion || 1;
  if (v < 2) {
    // v2: у позиции «Апельсины» из стартовых закупок убрано примечание (по решению пользователя)
    for (const e of Object.values(data.shoppingEvents)) {
      if (e.source !== 'seed' || !e.items.some((it) => it.itemId === 'p46' && it.note)) continue;
      ops.push({ store: 'shoppingEvents', put: { ...e, items: e.items.map((it) => (it.itemId === 'p46' ? { ...it, note: null } : it)) } });
    }
  }
  const { medicalAck: _old, ...rest } = data.settings as any;
  const settings = { ...defaultSettings(), ...rest };
  if (JSON.stringify(settings) !== JSON.stringify(data.settings)) ops.push({ store: 'settings', put: settings });
  if (v !== DATA_VERSION) ops.push({ store: 'meta', put: { ...data.meta, dataVersion: DATA_VERSION } });
  return ops;
}

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
