// Командировки и релакс-дни: календарные события, от которых зависят меню, готовка, закупки и тренировки.
import type { AppData, MealSlot, Settings, Trip } from '../state/types';
import { addDays, diffDays, isoWeekday, type ISODate } from '../lib/dates';

// ------------------------------------------------------------------ релакс-дни: один в календарный месяц

export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Последнее воскресенье месяца — релакс-день по умолчанию. */
export function lastSunday(ym: string): ISODate {
  let d = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  while (isoWeekday(d) !== 7) d = addDays(d, -1);
  return d;
}

export function relaxDateOfMonth(s: Pick<Settings, 'relaxOverrides'>, ym: string): ISODate {
  const o = s.relaxOverrides?.[ym];
  return o && monthKey(o) === ym ? o : lastSunday(ym);
}

export function isRelaxDate(s: Pick<Settings, 'relaxOverrides'>, date: ISODate): boolean {
  return relaxDateOfMonth(s, monthKey(date)) === date;
}

/** Релакс-дни в интервале дат (включительно). */
export function relaxDatesBetween(s: Pick<Settings, 'relaxOverrides'>, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let ym = monthKey(from);
  for (let i = 0; i < 24 && ym <= monthKey(to); i++) {
    const d = relaxDateOfMonth(s, ym);
    if (d >= from && d <= to) out.push(d);
    const [y, m] = ym.split('-').map(Number);
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}

// ------------------------------------------------------------------ командировки

export function tripList(src: AppData | Record<string, Trip> | Trip[]): Trip[] {
  const arr = Array.isArray(src) ? src : 'trips' in src && (src as AppData).settings ? Object.values((src as AppData).trips ?? {}) : Object.values(src as Record<string, Trip>);
  return arr.slice().sort((a, b) => a.from.localeCompare(b.from));
}

export function tripOn(trips: Trip[], date: ISODate): Trip | null {
  return trips.find((t) => t.from <= date && date <= t.to) ?? null;
}

export function tripDates(t: Trip): ISODate[] {
  const out: ISODate[] = [];
  for (let d = t.from; d <= t.to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

export function tripLength(t: Trip): number {
  return diffDays(t.to, t.from) + 1;
}

/** Есть ли день командировки строго между датами. */
export function tripBetween(trips: Trip[], a: ISODate, b: ISODate): boolean {
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) if (tripOn(trips, d)) return true;
  return false;
}

/** Сколько дней прошло после последнего дня командировки (1 — первый день дома), или null. */
export function daysAfterTrip(trips: Trip[], date: ISODate, within = 7): number | null {
  for (let i = 1; i <= within; i++) {
    const d = addDays(date, -i);
    if (tripOn(trips, d)) return i;
  }
  return null;
}

export function validateTrip(t: Pick<Trip, 'city' | 'from' | 'to'> & { id?: string }, others: Trip[]): string[] {
  const errs: string[] = [];
  if (!t.city.trim()) errs.push('Укажите город.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.from) || !/^\d{4}-\d{2}-\d{2}$/.test(t.to)) errs.push('Укажите даты начала и окончания.');
  else if (t.to < t.from) errs.push('Дата окончания раньше даты начала.');
  else if (diffDays(t.to, t.from) > 60) errs.push('Командировка длиннее 60 дней — разбейте на части.');
  for (const o of others) {
    if (o.id === t.id) continue;
    if (t.from <= o.to && o.from <= t.to) errs.push(`Даты пересекаются с командировкой «${o.city}».`);
  }
  return errs;
}

// ------------------------------------------------------------------ питание в командировке

export interface TripItem { name: string; amount: string; productId?: string; qty?: number }
export interface TripVariant { id: string; title: string; items: TripItem[]; kcal: string }
export interface TripMeal { slot: MealSlot; title: string; place: string; variants: TripVariant[]; alternatives: string | null }

const HOTEL_BREAKFAST: TripMeal = {
  slot: 'breakfast', title: 'Завтрак в гостинице', place: 'шведский стол',
  variants: [
    { id: 'b1', title: 'Яйца и овощи', kcal: '≈550', items: [
      { name: 'Омлет или яйца', amount: '3 шт.' }, { name: 'Хлеб цельнозерновой', amount: '≈70 г' },
      { name: 'Огурцы и помидоры', amount: '≈150 г' }, { name: 'Яблоко', amount: '≈150 г' }] },
    { id: 'b2', title: 'Овсяная каша и йогурт', kcal: '≈650', items: [
      { name: 'Овсяная каша', amount: 'порция из ≈70 г хлопьев' }, { name: 'Йогурт натуральный без сахара', amount: '≈200 г' },
      { name: 'Банан', amount: '≈120 г' }, { name: 'Орехи', amount: '≈20 г' }] },
    { id: 'b3', title: 'Творог и фрукты', kcal: '≈620', items: [
      { name: 'Творог', amount: '≈200 г' }, { name: 'Фрукты', amount: '≈150 г' },
      { name: 'Хлеб цельнозерновой', amount: '≈70 г' }, { name: 'Орехи', amount: '≈20 г' }] },
  ],
  alternatives: 'Подойдёт любой завтрак с белком (яйца, творог, йогурт, сыр) и крупой или цельнозерновым хлебом; выпечку и сладкое — по чуть-чуть.',
};

const SHOP_BREAKFAST: TripMeal = {
  slot: 'breakfast', title: 'Завтрак из супермаркета или кафе', place: 'без завтрака в гостинице',
  variants: [
    { id: 'sb1', title: 'Творог, банан и хлебцы', kcal: '≈480', items: [
      { name: 'Творог 5%', amount: '200 г', productId: 'curd', qty: 200 }, { name: 'Банан', amount: '≈120 г', productId: 'banana', qty: 120 },
      { name: 'Хлебцы цельнозерновые', amount: '≈30 г', productId: 'crispbread', qty: 30 }] },
    { id: 'sb2', title: 'Йогурт, яблоко и орехи', kcal: '≈480', items: [
      { name: 'Йогурт греческий без сахара', amount: '250 г', productId: 'yogurt', qty: 250 }, { name: 'Яблоко', amount: '≈150 г', productId: 'apple', qty: 150 },
      { name: 'Грецкие орехи', amount: '≈20 г', productId: 'walnuts', qty: 20 }] },
    { id: 'sb3', title: 'Омлет или каша в кафе', kcal: '≈550', items: [
      { name: 'Омлет из 3 яиц или овсяная каша', amount: '1 порция' }, { name: 'Хлеб цельнозерновой', amount: '≈60 г' }] },
  ],
  alternatives: null,
};

const LUNCH: TripMeal = {
  slot: 'lunch', title: 'Обед', place: 'ресторан, кафе или доставка',
  variants: [
    { id: 'l1', title: 'Курица гриль, рис, овощи', kcal: '≈700', items: [
      { name: 'Куриное филе на гриле', amount: '≈200 г' }, { name: 'Рис готовый', amount: '≈200 г' }, { name: 'Овощи', amount: '≈200 г' }] },
    { id: 'l2', title: 'Индейка, гречка, салат', kcal: '≈700', items: [
      { name: 'Индейка', amount: '≈200 г' }, { name: 'Гречка готовая', amount: '≈200 г' }, { name: 'Овощной салат', amount: '≈200 г' }] },
    { id: 'l3', title: 'Рыба, картофель, овощи', kcal: '≈650', items: [
      { name: 'Рыба', amount: '≈200 г' }, { name: 'Картофель', amount: '≈250 г' }, { name: 'Овощи', amount: '≈200 г' }] },
  ],
  alternatives: 'Тоже подходит: суп с мясом, поке, домашние котлеты с гарниром, паста с курицей или другое сбалансированное блюдо — белок, гарнир и овощи.',
};

const SNACK: TripMeal = {
  slot: 'snack', title: 'Перекус', place: 'из супермаркета, без готовки',
  variants: [
    { id: 's1', title: 'Творог и банан', kcal: '≈330', items: [
      { name: 'Творог 5% (подойдёт 2–5%)', amount: '200 г', productId: 'curd', qty: 200 }, { name: 'Банан', amount: '≈120 г', productId: 'banana', qty: 120 }] },
    { id: 's2', title: 'Греческий йогурт, ягоды, орехи', kcal: '≈360', items: [
      { name: 'Йогурт греческий без сахара', amount: '250 г', productId: 'yogurt', qty: 250 }, { name: 'Ягоды свежие', amount: '≈100 г', productId: 'berries_fresh', qty: 100 },
      { name: 'Грецкие орехи', amount: '≈20 г', productId: 'walnuts', qty: 20 }] },
    { id: 's3', title: 'Яйца, яблоко и хлебцы', kcal: '≈310', items: [
      { name: 'Яйца варёные', amount: '2 шт.', productId: 'egg_boiled', qty: 2 }, { name: 'Яблоко', amount: '≈150 г', productId: 'apple', qty: 150 },
      { name: 'Хлебцы цельнозерновые', amount: '≈30 г', productId: 'crispbread', qty: 30 }] },
  ],
  alternatives: null,
};

const DINNER: TripMeal = {
  slot: 'dinner', title: 'Ужин', place: 'ресторан, кафе, гостиница или доставка',
  variants: [
    { id: 'd1', title: 'Рыба, картофель, салат', kcal: '≈650', items: [
      { name: 'Рыба', amount: '≈200 г' }, { name: 'Картофель', amount: '≈250 г' }, { name: 'Овощной салат', amount: '≈200 г' }] },
    { id: 'd2', title: 'Курица или индейка, гарнир, овощи', kcal: '≈650', items: [
      { name: 'Курица или индейка', amount: '≈200 г' }, { name: 'Готовый гарнир', amount: '≈200 г' }, { name: 'Овощи', amount: '≈200 г' }] },
    { id: 'd3', title: 'Салат с курицей и белок', kcal: '≈650', items: [
      { name: 'Готовый салат с курицей', amount: '1 порция' }, { name: 'Дополнительный нежирный белок (яйца, творог, курица)', amount: '1 порция' },
      { name: 'Хлеб цельнозерновой', amount: '≈50 г' }] },
  ],
  alternatives: 'Разумные альтернативы в ресторане: стейк с овощами, паста, суши и роллы, суп и второе, блюда с рыбой. Отличие от вариантов — не срыв.',
};

export function tripMeal(trip: Trip, slot: MealSlot): TripMeal {
  if (slot === 'breakfast') return trip.hotelBreakfast ? HOTEL_BREAKFAST : SHOP_BREAKFAST;
  return slot === 'lunch' ? LUNCH : slot === 'snack' ? SNACK : DINNER;
}

export function tripVariant(trip: Trip, slot: MealSlot, id: string | null | undefined): TripVariant | null {
  return tripMeal(trip, slot).variants.find((v) => v.id === id) ?? null;
}

export const TRIP_PRINCIPLES = [
  'Цель — умеренное питание без систематического переедания; взвешивать еду и считать калории не нужно, граммы — ориентир на глаз.',
  'В каждом приёме — белок (мясо, рыба, яйца, творог, йогурт): вместе около 165 г в день; плюс овощи и гарнир из круп или картофеля.',
  'Напитки: вода, столовая минеральная вода, травяные чаи без сахара. Без алкоголя, кофе, энергетиков и сладких лимонадов; без мёда, дорады и сардин.',
  'Выбрали другое подходящее блюдо — это нормально, не срыв. Отметьте «другое», комментарий — по желанию.',
];

/** Вариант перекуса (и завтрака без гостиницы) по дням поездки — для небольшого списка покупок. */
export function tripShoppingPlan(trip: Trip): { date: ISODate; slot: MealSlot; variant: TripVariant }[] {
  const out: { date: ISODate; slot: MealSlot; variant: TripVariant }[] = [];
  tripDates(trip).forEach((date, i) => {
    out.push({ date, slot: 'snack', variant: SNACK.variants[i % SNACK.variants.length] });
    if (!trip.hotelBreakfast) {
      const v = SHOP_BREAKFAST.variants[i % 2];
      out.push({ date, slot: 'breakfast', variant: v });
    }
  });
  return out;
}

export function tripTrainingNote(trip: Trip): string {
  return trip.canTrain
    ? 'Плановый отдых. По желанию: прогулка 20–40 минут или комплекс с собственным весом (отжимания, выпады назад, ягодичный мостик, планка — 2 круга).'
    : 'Плановый отдых. По желанию: прогулка 20–40 минут, если хватает времени и сил.';
}
