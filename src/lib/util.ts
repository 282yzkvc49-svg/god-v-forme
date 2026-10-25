// Небольшие утилиты без зависимостей.

export function uid(prefix = ''): string {
  const rnd = (globalThis.crypto && 'getRandomValues' in globalThis.crypto)
    ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 18);
  return `${prefix}${Date.now().toString(36)}${rnd.slice(0, 10)}`;
}

/** Момент времени (не календарная дата) — ISO в UTC, удобно сортировать. */
export function nowStamp(): string {
  return new Date().toISOString();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Число по-русски: 106,4 · 1 512 */
export function fmtNum(n: number | null | undefined, maxFrac = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 });
}

export function fmtRub(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
}

export function fmtKg(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${fmtNum(n, 1)} кг`;
}

export function fmtSigned(n: number, maxFrac = 1): string {
  const s = fmtNum(Math.abs(n), maxFrac);
  if (Math.abs(n) < 1e-9) return '0';
  return n > 0 ? `+${s}` : `−${s}`;
}

/** «106,4» / «106.4» → 106.4; пусто или мусор → null */
export function parseNum(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = s.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function round(n: number, step: number): number {
  return Math.round(n / step) * step;
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function groupBy<T, K extends string>(xs: T[], key: (x: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const x of xs) (out[key(x)] ||= []).push(x);
  return out;
}

export function sortBy<T>(xs: T[], key: (x: T) => string | number): T[] {
  return [...xs].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${fmtNum(n / 1024, 0)} КБ`;
  return `${fmtNum(n / 1024 / 1024, 1)} МБ`;
}

/** Нормализация текста блюда для сопоставления с рецептом. */
export function normText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s*\(дома\)\s*$/, '')
    .replace(/\s+/g, ' ');
}
