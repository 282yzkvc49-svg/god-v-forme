// Состояние приложения: всё (кроме самих фотографий) держим в памяти, каждое изменение
// сразу пишем в IndexedDB одной транзакцией. Фото (Blob) читаются из базы по запросу.
import { useSyncExternalStore } from 'react';
import { deleteDB, getAll, getOne, openDB, write, type Op } from './idb';
import { applyOps, dataMigrationOps, emptyData, seedOps, seedUpgradeOps } from './model';
import { RECORD_STORES, type AppData, type PhotoBlobRec } from './types';
import { localDate } from '../lib/dates';
import { nowStamp } from '../lib/util';

let db: IDBDatabase | null = null;
let data: AppData = emptyData();
const listeners = new Set<() => void>();

export type StorageMode = 'loading' | 'idb' | 'memory';
interface Status { mode: StorageMode; error: string | null; saveError: string | null; persisted: boolean | null }
let status: Status = { mode: 'loading', error: null, saveError: null, persisted: null };
const statusListeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function setStatus(s: Partial<Status>) {
  status = { ...status, ...s };
  for (const l of statusListeners) l();
}

export function getData(): AppData {
  return data;
}

export function useApp(): AppData {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => data, () => data);
}

export function useStorageStatus(): Status {
  return useSyncExternalStore((cb) => { statusListeners.add(cb); return () => statusListeners.delete(cb); }, () => status, () => status);
}

/** Записать изменения: сначала в память (интерфейс отвечает сразу), затем в базу. */
export async function commit(ops: Op[]): Promise<void> {
  if (!ops.length) return;
  data = applyOps(data, ops);
  emit();
  if (!db) return;
  try {
    await write(db, ops);
    if (status.saveError) setStatus({ saveError: null });
  } catch (e: any) {
    setStatus({ saveError: `Не удалось сохранить: ${e?.message || e}` });
    throw e;
  }
}

/** Заменить всё состояние (восстановление из копии). */
export async function replaceAll(ops: Op[]): Promise<void> {
  const clearOps: Op[] = [...RECORD_STORES, 'settings', 'meta', 'photoBlobs'].map((store) => ({ store, clear: true as const }));
  const all = [...clearOps, ...ops];
  data = applyOps(emptyData(), ops);
  data.ready = true;
  emit();
  if (db) await write(db, all);
}

export async function init(): Promise<void> {
  try {
    db = await openDB();
    const loaded: Record<string, any[]> = {};
    for (const s of [...RECORD_STORES, 'settings', 'meta']) loaded[s] = await getAll(db, s);
    let d = emptyData();
    const ops: Op[] = [];
    for (const [store, rows] of Object.entries(loaded)) for (const r of rows) ops.push({ store, put: r });
    d = applyOps(d, ops);
    const now = nowStamp();
    const extra: Op[] = [];
    if (!d.meta) extra.push(...seedOps(now, localDate()));
    else {
      extra.push(...seedUpgradeOps(d, now));
      extra.push(...dataMigrationOps(d));
    }
    if (extra.length) {
      await write(db, extra);
      d = applyOps(d, extra);
    }
    d.ready = true;
    data = d;
    setStatus({ mode: 'idb', error: null });
    emit();
    requestPersistence();
  } catch (e: any) {
    // Без IndexedDB (например, особый режим браузера) — работаем в памяти и честно предупреждаем.
    let d = applyOps(emptyData(), seedOps(nowStamp(), localDate()));
    d.ready = true;
    data = d;
    db = null;
    setStatus({ mode: 'memory', error: String(e?.message || e) });
    emit();
  }
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persisted) {
      let p = await navigator.storage.persisted();
      if (!p && navigator.storage.persist) p = await navigator.storage.persist();
      setStatus({ persisted: p });
    }
  } catch {
    /* не критично */
  }
}

// ------------------------------------------------------------------ фотографии

export async function getPhotoBlob(id: string): Promise<PhotoBlobRec | undefined> {
  if (!db) return memoryBlobs.get(id);
  return getOne<PhotoBlobRec>(db, 'photoBlobs', id);
}

const memoryBlobs = new Map<string, PhotoBlobRec>();
export async function putPhotoBlob(rec: PhotoBlobRec, extra: Op[] = []): Promise<void> {
  if (!db) memoryBlobs.set(rec.id, rec);
  await commit([{ store: 'photoBlobs', put: rec }, ...extra]);
}

export async function getAllPhotoBlobs(): Promise<PhotoBlobRec[]> {
  if (!db) return Array.from(memoryBlobs.values());
  return getAll<PhotoBlobRec>(db, 'photoBlobs');
}

// кэш object URL миниатюр, чтобы не создавать заново при каждом рендере
const urlCache = new Map<string, string>();
export async function photoURL(id: string, kind: 'thumb' | 'full'): Promise<string | null> {
  const key = `${id}:${kind}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const rec = await getPhotoBlob(id);
  if (!rec) return null;
  const url = URL.createObjectURL(kind === 'thumb' ? rec.thumb : rec.full);
  urlCache.set(key, url);
  return url;
}
export function forgetPhotoURL(id: string) {
  for (const kind of ['thumb', 'full']) {
    const key = `${id}:${kind}`;
    const u = urlCache.get(key);
    if (u) URL.revokeObjectURL(u);
    urlCache.delete(key);
  }
}

/** Полное удаление всех локальных данных (с последующей перезагрузкой страницы). */
export async function wipeEverything(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  await deleteDB();
}
