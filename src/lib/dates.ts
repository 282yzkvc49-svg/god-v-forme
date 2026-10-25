// Календарные даты в формате 'YYYY-MM-DD' без привязки к часовому поясу.
// Никогда не используем Date.toISOString() для локальной даты: в поездках день «переезжает».
// Вся арифметика — в UTC-полдень, где нет переходов на летнее время.

export type ISODate = string;

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(s: ISODate): { y: number; m: number; d: number } {
  const m = RE.exec(s);
  if (!m) throw new Error(`Некорректная дата: ${s}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function fromParts(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Локальная дата устройства (не UTC). */
export function localDate(date: Date = new Date()): ISODate {
  return fromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function toUTCNoon(s: ISODate): number {
  const { y, m, d } = parts(s);
  return Date.UTC(y, m - 1, d, 12);
}

function fromUTC(ms: number): ISODate {
  const dt = new Date(ms);
  return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(s: ISODate, n: number): ISODate {
  return fromUTC(toUTCNoon(s) + n * 86400000);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTCNoon(a) - toUTCNoon(b)) / 86400000);
}

/** День недели ISO: 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(s: ISODate): number {
  const wd = new Date(toUTCNoon(s)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function isWeekend(s: ISODate): boolean {
  return isoWeekday(s) >= 6;
}

export function startOfWeek(s: ISODate): ISODate {
  return addDays(s, 1 - isoWeekday(s));
}

export function startOfMonth(s: ISODate): ISODate {
  const { y, m } = parts(s);
  return fromParts(y, m, 1);
}

export function endOfMonth(s: ISODate): ISODate {
  const { y, m } = parts(s);
  return fromParts(y, m, daysInMonth(y, m));
}

export function addMonths(s: ISODate, n: number): ISODate {
  const { y, m, d } = parts(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fromParts(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function range(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const n = diffDays(to, from);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

export function inRange(s: ISODate, from: ISODate, to: ISODate): boolean {
  return s >= from && s <= to;
}

/** Сетка месяца: недели с понедельника, 6 строк × 7 дней. */
export function monthGrid(anyDay: ISODate): ISODate[][] {
  const first = startOfMonth(anyDay);
  let cur = startOfWeek(first);
  const weeks: ISODate[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: ISODate[] = [];
    for (let i = 0; i < 7; i++) {
      row.push(cur);
      cur = addDays(cur, 1);
    }
    weeks.push(row);
  }
  // последняя неделя целиком из следующего месяца — убрать
  const { m } = parts(anyDay);
  while (weeks.length > 4 && weeks[weeks.length - 1].every((d) => parts(d).m !== m)) weeks.pop();
  return weeks;
}

/**
 * Период «план-месяца» с заданного числа: при monthStartDay = 2 — со 2-го по 1-е.
 * Возвращает период, в который попадает дата.
 */
export function planMonthOf(s: ISODate, monthStartDay: number): { from: ISODate; to: ISODate } {
  const { y, m, d } = parts(s);
  const startDay = Math.max(1, Math.min(28, monthStartDay));
  let from = d >= startDay ? fromParts(y, m, startDay) : addMonths(fromParts(y, m, startDay), -1);
  const to = addDays(addMonths(from, 1), -1);
  return { from, to };
}

export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAYS_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** «2 ноября» */
export function fmtDayMonth(s: ISODate): string {
  const { m, d } = parts(s);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

/** «Понедельник, 2 ноября» */
export function fmtLong(s: ISODate): string {
  const wd = WEEKDAYS_FULL[isoWeekday(s) - 1];
  return `${wd[0].toUpperCase()}${wd.slice(1)}, ${fmtDayMonth(s)}`;
}

/** «02.11» */
export function fmtShort(s: ISODate): string {
  const { m, d } = parts(s);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

/** «02.11.2026» */
export function fmtFull(s: ISODate): string {
  const { y } = parts(s);
  return `${fmtShort(s)}.${y}`;
}

/** «Ноябрь 2026» */
export function fmtMonthYear(s: ISODate): string {
  const { y, m } = parts(s);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

export function weekdayShort(s: ISODate): string {
  return WEEKDAYS_SHORT[isoWeekday(s) - 1];
}

/** Минуты от начала суток для «08:30» / «20:00–21:30» (берётся начало). */
export function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

export function isTime(s: unknown): s is string {
  return typeof s === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);
}

export function nowMinutes(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Метка времени для имён файлов: 2026-11-02_1430 */
export function stampForFile(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDate(date)}_${p(date.getHours())}${p(date.getMinutes())}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
