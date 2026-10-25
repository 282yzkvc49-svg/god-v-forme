// Тонкая обёртка над IndexedDB с версионными миграциями схемы.
// Каждая новая версия схемы — новый шаг в MIGRATIONS; старые шаги не меняются,
// поэтому данные пользователя переживают обновления приложения.
import { STORE_KEYS } from './types';

export const DB_NAME = 'god-v-forme';
export const DB_VERSION = 1;

type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

const MIGRATIONS: Record<number, Migration> = {
  1: (db) => {
    for (const [name, keyPath] of Object.entries(STORE_KEYS)) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
    }
  },
  // 2: (db, tx) => { ... } — пример будущей миграции: добавить хранилище/индекс, преобразовать записи.
};

export type Op =
  | { store: string; put: any }
  | { store: string; del: IDBValidKey }
  | { store: string; clear: true };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDB(name = DB_NAME, version = DB_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB недоступна'));
      return;
    }
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const tx = r.transaction!;
      for (let v = (ev.oldVersion || 0) + 1; v <= version; v++) MIGRATIONS[v]?.(db, tx);
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('База данных занята другой вкладкой. Закройте другие окна приложения.'));
  });
}

export async function getAll<T = any>(db: IDBDatabase, store: string): Promise<T[]> {
  const tx = db.transaction(store, 'readonly');
  return req(tx.objectStore(store).getAll()) as Promise<T[]>;
}

export async function getOne<T = any>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly');
  return req(tx.objectStore(store).get(key)) as Promise<T | undefined>;
}

/** Все операции — в одной транзакции: либо всё записалось, либо ничего. */
export function write(db: IDBDatabase, ops: Op[]): Promise<void> {
  if (!ops.length) return Promise.resolve();
  const stores = Array.from(new Set(ops.map((o) => o.store)));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Транзакция прервана'));
    for (const op of ops) {
      const os = tx.objectStore(op.store);
      if ('put' in op) os.put(op.put);
      else if ('del' in op) os.delete(op.del);
      else os.clear();
    }
  });
}

export function deleteDB(name = DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}
