// Версия 2.0: недельный цикл питания. Одна закупка и одна основная готовка в неделю (по умолчанию — воскресенье),
// меню недели собирается из библиотеки рецептов, закупка считается только после подтверждения фактических запасов.
// Неделя хранится в настройках (settings.weekly.weeks) и разворачивается в обычные записи приложения: дни плана
// с карточками приёмов пищи, готовку с распределением порций (холодильник / морозилка) и закупку. Прошедшие дни,
// отметки, тренировки, вес и фото не меняются: пересчитываются только даты с сегодняшнего дня и только то,
// что не отмечено.
import type { Op } from '../state/idb';
import type {
  AppData, CookItem, CookUse, CookingEvent, MealCard, MealCardPart, MealSlot, PlanDay, ShopLine, ShoppingEvent, StockRec, Trip,
} from '../state/types';
import { MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, fmtShort, isoWeekday, isWeekend, range, type ISODate } from '../lib/dates';
import { ADDON, AV_SUBS, DISHES, LIB_RECIPES, PRODUCTS, avSub, buyInfo, libDishId, libEff, type LibSub, type Product } from './catalog';
import type { LibRecipe } from './recipeCheck';
import { DRINKS_TEXT, TRIP_DRINKS_TEXT, hasDayMarks, mealTitle, setWeeklyHook, type ReplanResult } from './plan';
import { isRelaxDate, tripList, tripMeal, tripOn } from './trips';
import { emptyStock, stockLots, stockRemaining } from './stock';
import { recipeHash } from './recipeCheck';
import report from '../data/library/check_report.json';

export const WEEKLY_INSTANCE = 'weekly';
export const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const SLOT_ORDER: Record<MealSlot, number> = { breakfast: 1, lunch: 2, snack: 3, dinner: 4 };

// ------------------------------------------------------------------ типы

export interface WeekMeal {
  /** id рецепта библиотеки; пусто — приём без рецепта (например, «из остатков»), тогда title. */
  r: string;
  title?: string | null;
  /** cook — порция из готовки недели; fresh — готовится к приёму; stock — из того, что уже есть дома. */
  src: 'cook' | 'fresh' | 'stock';
  note?: string | null;
  /** Добавки к приёму (id из ADDONS): доводят ккал и белок дня до цели. */
  add?: string[];
}
export interface WeekCookUse { date: ISODate; slot: MealSlot; storage: 'fridge' | 'freeze'; thawOn?: ISODate | null }
export interface WeekCookItem { r: string; servings: number; uses: WeekCookUse[] }
export interface WeekPlan {
  id: string;
  title: string;
  cookDate: ISODate | null;
  cookTime: string | null;
  shopDate: ISODate | null;
  status: 'draft' | 'approved';
  approvedAt: string | null;
  /** planner — планировщик приложения; chat — составлено в чате с Claude; ai — генерация через API (на будущее). */
  source: 'planner' | 'chat' | 'ai';
  meals: Record<ISODate, Partial<Record<MealSlot, WeekMeal>>>;
  cook: WeekCookItem[];
  /** Когда пользователь подтвердил фактические запасы к закупке; до этого закупка не считается. */
  stockConfirmedAt: string | null;
  /** Список закупки на момент подтверждения запасов (не меняется от отметок «куплено»). */
  purchase?: WeekPurchase | null;
  /** Замены на эту неделю, выбранные пользователем (товара нет в магазине): продукт → замена. */
  subs?: Record<string, string>;
  notes: string[];
  /** Что мешает утвердить меню как полное (не хватает порций, день вне цели по ккал/белку, бюджет): нужен выбор. */
  problems?: string[];
  /** Пользователь утвердил неделю, зная о проблемах (явное подтверждение). */
  acceptedProblems?: string[] | null;
  /** Оценка недели при составлении: стоимость, бюджет, остатки. */
  estimate?: WeekEstimate | null;
  /** Доставка в день закупки: время (ЧЧ:ММ) или null — не подтверждено; готовка начинается после доставки. */
  delivery?: { time: string | null; note?: string | null } | null;
  /** Номер варианта планировщика (для «Другой вариант»). */
  seed?: number;
  createdAt: string;
}
export interface WeekEstimate {
  /** Ориентировочная стоимость закупки недели (упаковками, с учётом прогноза запасов). */
  cost: number;
  /** Доля месячного бюджета на дни этой недели. */
  allowance: number;
  /** Что, по прогнозу, пропадёт (скоропортящиеся остатки упаковок). */
  waste: string[];
  wasteRub: number;
  /** Остатки упаковок, которые использованы в этой неделе (из прогноза запасов). */
  usedLeftovers: string[];
  at: string;
}
export interface WeeklySettings {
  since: ISODate;
  /** День закупки и основной готовки: 1 = пн … 7 = вс. */
  shopDay: number;
  cookTime: string;
  /** Свободное место в морозилке: сколько плоских пакетов на 1 л помещается; null — не указано. */
  freezer: { capacity: number | null };
  weeks: Record<string, WeekPlan>;
  /** Источник новых меню: local — планировщик приложения по библиотеке; ai — генерация через API (не подключена). */
  planner: 'local';
  ai: { mode: 'off' };
  /** id резервной копии перед переходом на версию 2.0. */
  backupId?: string | null;
  reportUnseen?: boolean;
}
export interface RecipePref { fav?: boolean; rating?: number | null; hidden?: boolean; at: string }

export function weeklyOf(data: AppData): WeeklySettings | null {
  return (data.settings as { weekly?: WeeklySettings | null }).weekly ?? null;
}
export function prefsOf(data: AppData): Record<string, RecipePref> {
  return (data.settings as { recipePrefs?: Record<string, RecipePref> | null }).recipePrefs ?? {};
}
export const LIB: Record<string, LibRecipe> = Object.fromEntries(LIB_RECIPES.map((r) => [r.id, r]));
const REPORT = new Map(((report as { recipes?: { id: string; hash: string; ok: boolean }[] }).recipes ?? []).map((e) => [e.id, e]));
/** Рецепт прошёл автоматическую проверку в текущей редакции. */
export function libVerified(r: LibRecipe): boolean {
  const e = REPORT.get(r.id);
  return !!e && e.ok && e.hash === recipeHash(r);
}

export function weekList(ws: WeeklySettings | null): WeekPlan[] {
  return Object.values(ws?.weeks ?? {}).sort((a, b) => (a.cookDate ?? weekFrom(a)).localeCompare(b.cookDate ?? weekFrom(b)));
}
export function weekDates(w: WeekPlan): ISODate[] { return Object.keys(w.meals).sort(); }
export function weekFrom(w: WeekPlan): ISODate { return weekDates(w)[0] ?? w.cookDate ?? '9999-12-31'; }
export function weekTo(w: WeekPlan): ISODate { const d = weekDates(w); return d[d.length - 1] ?? w.cookDate ?? '0000-01-01'; }
export function cookEventId(w: WeekPlan) { return `cook-weekly-${w.id}`; }
export function shopEventId(w: WeekPlan) { return `shop-weekly-${w.id}`; }
export function weekOfEvent(data: AppData, eventId: string): WeekPlan | null {
  const ws = weeklyOf(data);
  return weekList(ws).find((w) => cookEventId(w) === eventId || shopEventId(w) === eventId) ?? null;
}

// ------------------------------------------------------------------ календарь: домашние дни, командировки, релакс

export type DayKind = 'home' | 'trip' | 'relax';
export function dayKind(data: AppData, date: ISODate, trips: Trip[] = tripList(data)): DayKind {
  if (tripOn(trips, date)) return 'trip';
  if (isRelaxDate(data.settings, date)) return 'relax';
  return 'home';
}

const marked = (data: AppData, key: string) => { const st = data.taskStatus[key]?.status; return !!st && st !== 'planned'; };
export function cookDone(data: AppData, w: WeekPlan): boolean { return marked(data, `cook:${cookEventId(w)}`); }
export function shopBought(data: AppData, w: WeekPlan): boolean {
  const id = shopEventId(w);
  return marked(data, `shop:${id}`) || Object.values(data.shoppingChecks).some((c) => c.eventId === id && c.bought);
}

/**
 * Неделя по текущему календарю. Приёмы на днях командировки и релакса не действуют (и возвращаются, если
 * поездку отменят), порции готовки на эти дни не готовятся — пока готовка не отмечена; после готовки они
 * остаются запасом в морозилке. Если день готовки попал на командировку — готовка в первый домашний день недели.
 */
export function effectiveWeek(data: AppData, w: WeekPlan, trips: Trip[] = tripList(data)): WeekPlan {
  const home = (d: ISODate) => dayKind(data, d, trips) === 'home';
  const dates = Object.keys(w.meals);
  const cookTrip = !!w.cookDate && !!tripOn(trips, w.cookDate);
  if (dates.every(home) && !cookTrip) return w;
  const cooked = cookDone(data, w);
  const meals: WeekPlan['meals'] = {};
  for (const d of dates) if (home(d)) meals[d] = w.meals[d];
  const cook = w.cook
    .map((c) => {
      const uses = c.uses.filter((u) => home(u.date));
      const removed = c.uses.length - uses.length;
      return { ...c, uses, servings: cooked ? c.servings : Math.max(uses.length, c.servings - removed) };
    })
    .filter((c) => cooked || c.uses.length > 0);
  let cookDate = w.cookDate;
  let shopDate = w.shopDate;
  if (cookTrip && !cooked) {
    cookDate = Object.keys(meals).sort().find((d) => d > w.cookDate!) ?? null;
    if (shopDate && tripOn(trips, shopDate) && !shopBought(data, w)) shopDate = cookDate;
  }
  return { ...w, meals, cook: cookDate || cooked ? cook : [], cookDate: cooked ? w.cookDate : cookDate, shopDate };
}

/** Порции и приёмы недели, которые сейчас не действуют из-за командировки или релакс-дня. */
export function suspendedMeals(data: AppData, w: WeekPlan): { date: ISODate; slot: MealSlot; r: string; src: WeekMeal['src'] }[] {
  const trips = tripList(data);
  const out: { date: ISODate; slot: MealSlot; r: string; src: WeekMeal['src'] }[] = [];
  for (const [d, slots] of Object.entries(w.meals)) {
    if (dayKind(data, d, trips) === 'home') continue;
    for (const s of MEAL_SLOTS) { const m = slots[s]; if (m) out.push({ date: d, slot: s, r: m.r, src: m.src }); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
}

/** Горизонт календаря: не меньше 6 недель вперёд и до конца последней составленной недели. */
export function horizon(data: AppData, today: ISODate): ISODate {
  const ws = weeklyOf(data);
  let end = addDays(today, 42);
  for (const w of weekList(ws)) if (weekTo(w) > end) end = weekTo(w);
  for (const t of tripList(data)) if (t.to > end && t.from <= addDays(today, 120)) end = t.to;
  return end;
}

// ------------------------------------------------------------------ записи приложения из недель

function tripDay(t: Trip, date: ISODate, relax: boolean): PlanDay {
  const meals = Object.fromEntries(MEAL_SLOTS.map((s) => [s, tripMeal(t, s).title])) as Record<MealSlot, string>;
  return {
    date, source: 'seed', patchId: null, dayNumber: null, relax, meals, relaxMealsText: null, training: null, drinks: TRIP_DRINKS_TEXT,
    note: `Командировка: ${t.city}, день ${diffDays(date, t.from) + 1} из ${diffDays(t.to, t.from) + 1}. Домашней готовки и закупки скоропортящегося нет, расходы — вне домашнего бюджета.`,
    kcalNote: null, instanceId: WEEKLY_INSTANCE, templateDay: null, mealCards: null, tripId: t.id,
  };
}
function relaxDay(date: ISODate): PlanDay {
  return {
    date, source: 'seed', patchId: null, dayNumber: null, relax: true, meals: null,
    relaxMealsText: { breakfast: 'Свободный выбор', lunch: 'Свободный выбор', snack: 'По желанию', dinner: 'Свободный выбор' },
    training: null, drinks: 'Свободное меню, но без алкоголя. Вода, чаи и морсы без сахара.',
    note: 'Релакс-день: любимая еда без обязательного меню и подсчёта калорий; алкоголь исключён. Это часть плана, а не нарушение.',
    kcalNote: null, instanceId: WEEKLY_INSTANCE, templateDay: null, mealCards: null,
  };
}
function emptyHomeDay(date: ISODate, shopDay: number): PlanDay {
  return {
    date, source: 'seed', patchId: null, dayNumber: null, relax: false, meals: null, relaxMealsText: null, training: null, drinks: DRINKS_TEXT,
    note: `Меню на эти дни ещё не составлено: его готовит планировщик перед закупкой (${WEEKDAY_NAMES[shopDay - 1]}) — раздел «Неделя».`,
    kcalNote: null, instanceId: WEEKLY_INSTANCE, templateDay: null, mealCards: null,
  };
}

/** Какая неделя отвечает за приём пищи (последняя по дате готовки, если две недели сходятся в один день). */
function mealOf(weeks: WeekPlan[], date: ISODate, slot: MealSlot): { w: WeekPlan; m: WeekMeal } | null {
  for (let i = weeks.length - 1; i >= 0; i--) { const m = weeks[i].meals[date]?.[slot]; if (m) return { w: weeks[i], m }; }
  return null;
}

function addonParts(m: WeekMeal, stockOnly: boolean): MealCardPart[] {
  return (m.add ?? []).filter((id) => DISHES[id]).map((id) => ({ dishId: id, qty: 1, fresh: true, cookEventId: null, storage: null, thawOn: null, ...(stockOnly ? { stockOnly: true } : {}) }));
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
/** Начало готовки: не раньше заданного времени и через 20 минут после доставки, если её время известно. */
export function cookStart(w: WeekPlan, ws: WeeklySettings | null): string {
  const base = w.cookTime ?? ws?.cookTime ?? '17:00';
  const dt = w.delivery?.time;
  if (w.delivery && dt && w.shopDate === w.cookDate && toMin(dt) + 20 > toMin(base)) return fromMin(toMin(dt) + 20);
  return base;
}
export function cookTimeNote(w: WeekPlan): string {
  const base = 'Один сеанс: аэрогриль, плита и электрогриль работают параллельно — порядок шагов в разделе «Неделя».';
  if (!w.delivery || w.shopDate !== w.cookDate) return base;
  const ready = dinnerReadyIn(w);
  const when = ready != null ? ` Ужин этого дня — первое готовое блюдо, примерно через ${ready} мин после начала.` : '';
  return w.delivery.time ? `После доставки (${w.delivery.time}).${when} ${base}` : `Начать сразу после доставки — время доставки ещё не подтверждено.${when} ${base}`;
}
/** Через сколько минут после начала готовки готов ужин дня готовки (по расписанию). */
export function dinnerReadyIn(w: WeekPlan): number | null {
  if (!w.cookDate) return null;
  const m = w.meals[w.cookDate]?.dinner;
  if (!m || m.src !== 'cook' || !LIB[m.r]) return null;
  const title = LIB[m.r].title;
  const steps = cookSchedule(w).steps.filter((s) => s.recipe === title);
  return steps.length ? Math.max(...steps.map((s) => s.end)) + 5 : null;
}

export interface WeeklyRecords { planDays: PlanDay[]; cookingEvents: CookingEvent[]; shoppingEvents: ShoppingEvent[]; issues: string[] }

/** Все записи недельного цикла с даты from (дни, готовки, закупки). */
export function buildWeeklyRecords(data: AppData, from: ISODate, to: ISODate): WeeklyRecords {
  const ws = weeklyOf(data)!;
  const trips = tripList(data);
  const all = weekList(ws);
  const weeks = all.map((w) => effectiveWeek(data, w, trips));
  const issues: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i], b = weeks[i];
    if (a === b || weekTo(a) < from) continue;
    const off = a.cook.reduce((s, c) => s + c.uses.length, 0) - b.cook.reduce((s, c) => s + c.uses.length, 0);
    if (off > 0) issues.push(`${a.title}: ${off} порц. приходятся на командировку или релакс-день — ${cookDone(data, a) ? 'остаются запасом в морозилке' : 'не готовятся, закупка меньше'}; если поездку отменят, вернутся в меню`);
    if (a.cookDate !== b.cookDate && b.cookDate) issues.push(`${a.title}: готовка переносится с ${fmtShort(a.cookDate!)} на ${fmtShort(b.cookDate)} — ${fmtShort(a.cookDate!)} командировка`);
  }
  const planDays: PlanDay[] = [];
  const cookingEvents: CookingEvent[] = [];
  const shoppingEvents: ShoppingEvent[] = [];
  const cookUses = new Map<string, Map<string, WeekCookUse>>(); // cookId → `${r}|date|slot` → use
  for (const w of weeks) {
    const m = new Map<string, WeekCookUse>();
    for (const it of w.cook) for (const u of it.uses) m.set(`${it.r}|${u.date}|${u.slot}`, u);
    cookUses.set(cookEventId(w), m);
  }
  for (const date of range(from, to)) {
    const kind = dayKind(data, date, trips);
    if (kind === 'trip') { planDays.push(tripDay(tripOn(trips, date)!, date, isRelaxDate(data.settings, date))); continue; }
    if (kind === 'relax') { planDays.push(relaxDay(date)); continue; }
    const old = data.planDays[date];
    const cards = {} as Record<MealSlot, MealCard>;
    let any = false, draft = false, hits = 0;
    for (const slot of MEAL_SLOTS) {
      const hit = mealOf(weeks, date, slot);
      if (!hit) {
        // приём, которого нет в неделе (например, завтрак и обед в день перехода на версию 2.0), остаётся прежним
        const prev = old?.mealCards?.[slot];
        if (prev && date <= ws.since) { cards[slot] = prev; any = true; }
        continue;
      }
      if (!hit.m.r) {
        const parts = addonParts(hit.m, true);
        cards[slot] = { title: [hit.m.title || 'Из того, что есть дома', ...parts.map((x) => DISHES[x.dishId]?.short.toLowerCase())].join(' + '), parts, note: hit.m.note ?? null };
        hits++; any = true;
        continue;
      }
      const r = LIB[hit.m.r];
      if (!r) { issues.push(`${fmtShort(date)}: рецепт ${hit.m.r} не найден в библиотеке`); continue; }
      const cookId = cookEventId(hit.w);
      const use = hit.m.src === 'cook' ? cookUses.get(cookId)?.get(`${r.id}|${date}|${slot}`) ?? null : null;
      const part: MealCardPart = {
        dishId: libDishId(r.id), qty: 1, fresh: hit.m.src !== 'cook', cookEventId: hit.m.src === 'cook' ? cookId : null,
        storage: use ? use.storage : null, thawOn: use?.thawOn ?? null, ...(hit.m.src === 'stock' ? { stockOnly: true } : {}),
      };
      const notes = [hit.m.note, hit.w.status === 'draft' ? 'Черновик меню: утвердите неделю перед закупкой.' : null].filter(Boolean) as string[];
      const parts = [part, ...addonParts(hit.m, hit.m.src === 'stock')];
      cards[slot] = { title: mealTitle(parts), parts, note: notes.length ? notes.join(' ') : null };
      any = true; hits++;
      if (hit.w.status === 'draft') draft = true;
    }
    // день перехода без блюд недели — прежняя запись без изменений
    if (!hits && old && date <= ws.since) { planDays.push(old); continue; }
    if (!any) { planDays.push(emptyHomeDay(date, ws.shopDay)); continue; }
    for (const slot of MEAL_SLOTS) if (!cards[slot]) cards[slot] = { title: 'Не запланировано', parts: [], cancelled: true, note: 'Приём пищи не входит в меню недели.' };
    planDays.push({
      date, source: 'seed', patchId: null, dayNumber: null, relax: false,
      meals: Object.fromEntries(MEAL_SLOTS.map((s) => [s, cards[s].title])) as Record<MealSlot, string>,
      relaxMealsText: null, training: null, drinks: DRINKS_TEXT, note: draft ? 'Меню недели — черновик.' : null, kcalNote: null,
      instanceId: WEEKLY_INSTANCE, templateDay: null, mealCards: cards,
    });
  }
  const homeSet = new Set(planDays.filter((d) => d.mealCards).map((d) => d.date));
  for (const w of weeks) {
    if (w.cookDate && w.cook.length && w.cookDate >= addDays(from, -7)) {
      const id = cookEventId(w);
      const items: CookItem[] = [];
      const dates = new Set<ISODate>();
      let frozen = 0;
      const thaw = new Map<string, number>();
      for (const it of w.cook) {
        const r = LIB[it.r];
        if (!r) continue;
        const uses: CookUse[] = it.uses
          .filter((u) => u.date < from || homeSet.has(u.date) || u.date === w.cookDate)
          .map((u) => ({ date: u.date, slot: u.slot, qty: 1, via: null, storage: u.storage, thawOn: u.thawOn ?? null }));
        const dropped = it.uses.length - uses.length;
        if (dropped > 0) issues.push(`${r.title}: ${dropped} порц. попадают на командировку или релакс-день — их стоит заморозить или пересобрать неделю`);
        for (const u of uses) { dates.add(u.date); if (u.storage === 'freeze') frozen++; }
        items.push({ dishId: libDishId(r.id), qty: it.servings, uses });
        // сырые замороженные рыба и мясо — накануне готовки переложить в холодильник
        for (const i of libEff(r).r.ingredients) {
          const p = PRODUCTS[i.p];
          if (p && p.storage === 'freezer' && (p.category === 'Рыба и морепродукты' || p.category === 'Мясо и птица')) thaw.set(i.p, (thaw.get(i.p) ?? 0) + i.q * (it.servings / r.servings));
        }
      }
      const forDates = [...dates].sort();
      cookingEvents.push({
        id, date: w.cookDate, eventType: 'meal_prep', title: `Основная готовка недели${w.status === 'draft' ? ' (черновик)' : ''}`,
        sourceText: items.map((i) => DISHES[i.dishId]?.title ?? i.dishId).join('; '),
        forDaysText: forDates.length ? `на ${fmtShort(forDates[0])}–${fmtShort(forDates[forDates.length - 1])}` : '',
        forDates,
        storage: frozen ? `Порции на ближайшие дни — в холодильник, ${frozen} порц. — сразу в морозилку плоскими пакетами.` : 'Остудить не дольше 30 минут и убрать в холодильник.',
        dishes: items.map((i) => ({ text: DISHES[i.dishId]?.title ?? i.dishId, recipeIds: [i.dishId], comment: null })),
        source: 'seed', patchId: null, instanceId: WEEKLY_INSTANCE, blockId: w.id, kind: 'main', time: cookStart(w, ws),
        timeNote: cookTimeNote(w),
        items, thawProducts: [...thaw].map(([productId, qty]) => ({ productId, qty: Math.round(qty) })),
      });
    }
    if (w.shopDate && w.shopDate >= addDays(from, -7)) {
      const pur = weekPurchase(data, w);
      shoppingEvents.push({
        id: shopEventId(w), date: w.shopDate,
        title: pur.ready ? 'Закупка недели' : w.status === 'draft' ? 'Закупка недели — меню ещё черновик' : 'Закупка недели — сначала подтвердите запасы',
        forDatesText: `${fmtShort(weekFrom(w))}–${fmtShort(weekTo(w))}`, items: [], source: 'seed', patchId: null, instanceId: WEEKLY_INSTANCE,
        kind: 'main', tripId: null, time: '10:00', lines: pur.ready ? pur.lines : [], covers: { from: weekFrom(w), to: weekTo(w) },
      });
    }
  }
  return { planDays, cookingEvents, shoppingEvents, issues };
}

/**
 * Пересчёт записей недельного цикла с сегодняшнего дня (вызывается вместо пересчёта по шаблону: командировки,
 * релакс-дни, замены, изменение недели). Прошедшее и отмеченное не меняется — попадает в conflicts.
 */
export function weeklyReplanOps(data: AppData, today: ISODate, opts: { overwriteMarked?: boolean; from?: ISODate } = {}): ReplanResult {
  const ws = weeklyOf(data)!;
  const from = [today, ws.since, opts.from && opts.from > ws.since ? opts.from : ws.since].sort().reverse()[0];
  const to = horizon(data, today);
  const rec = buildWeeklyRecords(data, from, to);
  const ops: Op[] = [];
  const conflicts: string[] = [];
  const changed = { days: [] as ISODate[], cooks: [] as string[], shops: [] as string[] };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const marked = (key: string) => { const st = data.taskStatus[key]?.status; return !!st && st !== 'planned'; };
  const shopChecked = (id: string) => Object.values(data.shoppingChecks).some((c) => c.eventId === id && (c.bought || c.atHome || c.actualPrice != null));
  const newDays = new Set(rec.planDays.map((d) => d.date));
  for (const d of rec.planDays) {
    const old = data.planDays[d.date];
    if (old && old.source === 'import') continue;
    if (old && same(old, d)) continue;
    if (old && d.date > today && hasDayMarks(data, d.date) && !opts.overwriteMarked) { conflicts.push(`${fmtShort(d.date)}: есть отметки приёмов пищи`); continue; }
    if (old && d.date === today && hasDayMarks(data, d.date)) {
      // сегодня: отмеченные приёмы остаются как были, остальные — по неделе
      const cards = { ...(d.mealCards ?? {}) } as Record<MealSlot, MealCard>;
      for (const slot of MEAL_SLOTS) {
        const st = data.taskStatus[`meal:${d.date}:${slot}`]?.status;
        if (st && st !== 'planned' && old.mealCards?.[slot]) cards[slot] = old.mealCards[slot];
      }
      const merged: PlanDay = { ...d, mealCards: d.mealCards ? cards : old.mealCards ?? null, meals: d.mealCards ? Object.fromEntries(MEAL_SLOTS.map((s) => [s, cards[s].title])) as Record<MealSlot, string> : d.meals };
      if (same(old, merged)) continue;
      ops.push({ store: 'planDays', put: merged });
      changed.days.push(d.date);
      continue;
    }
    ops.push({ store: 'planDays', put: d });
    changed.days.push(d.date);
  }
  // прежние дни шаблона за горизонтом пересчёта (будущее без отметок) — убрать, чтобы не путали
  for (const old of Object.values(data.planDays)) {
    if (old.source !== 'seed' || old.date < from || newDays.has(old.date)) continue;
    if (hasDayMarks(data, old.date)) { conflicts.push(`${fmtShort(old.date)}: есть отметки — день оставлен`); continue; }
    ops.push({ store: 'planDays', del: old.date });
    changed.days.push(old.date);
  }
  const newIds = new Set([...rec.cookingEvents.map((e) => e.id), ...rec.shoppingEvents.map((e) => e.id)]);
  for (const [store, prefix, list] of [['cookingEvents', 'cook', rec.cookingEvents], ['shoppingEvents', 'shop', rec.shoppingEvents]] as const) {
    const key = store === 'cookingEvents' ? 'cooks' : 'shops';
    for (const e of list as (CookingEvent | ShoppingEvent)[]) {
      const old = (data[store] as Record<string, CookingEvent | ShoppingEvent>)[e.id];
      if (old && same(old, e)) continue;
      const touched = old && (marked(`${prefix}:${old.id}`) || (prefix === 'shop' && shopChecked(old.id)));
      if (touched && !opts.overwriteMarked) {
        // отмеченную закупку можно обновлять только в части строк, если запасы подтверждены заново; готовку — нет
        if (prefix === 'shop' && !marked(`${prefix}:${old.id}`)) { ops.push({ store, put: e }); changed[key].push(e.id); continue; }
        conflicts.push(`${prefix === 'cook' ? 'Готовка' : 'Закупка'} ${fmtShort(old.date)}: есть отметки — не меняется`);
        continue;
      }
      if (e.date < today && !old) continue;
      ops.push({ store, put: e });
      changed[key].push(e.id);
    }
    for (const old of Object.values(data[store]) as (CookingEvent | ShoppingEvent)[]) {
      if (old.source !== 'seed' || newIds.has(old.id) || old.date < today) continue;
      if (marked(`${prefix}:${old.id}`) || (prefix === 'shop' && shopChecked(old.id))) { conflicts.push(`${prefix === 'cook' ? 'Готовка' : 'Закупка'} ${fmtShort(old.date)} прежнего меню отмечена — оставлена`); continue; }
      ops.push({ store, del: old.id });
      changed[key].push(old.id);
    }
  }
  const instance = {
    cfg: data.settings.plan, ctx: null, layout: null, planDays: rec.planDays, cookingEvents: rec.cookingEvents, shoppingEvents: rec.shoppingEvents,
    issues: rec.issues.map((text) => ({ level: 'warn', text })), totalCost: rec.shoppingEvents.reduce((s, e) => s + (e.lines ?? []).reduce((a, l) => a + l.cost, 0), 0),
    tripCost: 0, deficits: [],
  } as unknown as ReplanResult['instance'];
  return { ops, instance, mealMarks: 0, eventMarks: conflicts, importedKept: 0, changed, conflicts };
}

setWeeklyHook((data, today, opts) => (weeklyOf(data) ? weeklyReplanOps(data, today, opts) : null));

// ------------------------------------------------------------------ потребности, запасы и закупка недели

function gross(p: Product, net: number): number {
  return p.unit === 'pcs' || p.edible_ratio >= 1 ? net : net / p.edible_ratio;
}

/** Можно ли сейчас поставить блюдо в меню: каждый продукт (после замен) есть на av.ru по последней проверке или лежит дома. */
export function recipeAvail(r: LibRecipe, data?: AppData): { ok: boolean; missing: string[]; subs: LibSub[] } {
  const { r: e, subs } = libEff(r);
  const home = (pid: string) => !!data && stockRemaining(data, pid) > 0;
  const missing = [...new Set(e.ingredients.map((i) => i.p))].filter((pid) => {
    if (buyInfo(pid).status === 'listed' || home(pid)) return false;
    return true;
  });
  // замена не нужна, если исходный продукт есть дома
  return { ok: missing.length === 0, missing, subs: subs.filter((x) => !home(x.from)) };
}

export interface WeekNeed { productId: string; qty: number; uses: string[]; stockOnly: number; firstUse: ISODate }

/** Что нужно на неделю (масса покупки с учётом очистки): готовка целиком + свежие блюда с дня закупки.
 * Уже отмеченное (съеденный приём, приготовленная готовка) не считается: эти продукты уже списаны. */
export function weekNeeds(w0: WeekPlan, data?: AppData): Map<string, WeekNeed> {
  const w = data ? effectiveWeek(data, w0) : w0;
  const marked = (key: string) => { const st = data?.taskStatus[key]?.status; return !!st && st !== 'planned'; };
  const out = new Map<string, WeekNeed>();
  const add = (pid: string, q: number, label: string, date: ISODate, stockOnly: boolean) => {
    const p = PRODUCTS[pid];
    if (!p || !(q > 0)) return;
    const g = gross(p, q);
    const n = out.get(pid) ?? { productId: pid, qty: 0, uses: [], stockOnly: 0, firstUse: date };
    n.qty += g;
    if (stockOnly) n.stockOnly += g;
    if (!n.uses.includes(label)) n.uses.push(label);
    if (date < n.firstUse) n.firstUse = date;
    out.set(pid, n);
  };
  for (const it of marked(`cook:${cookEventId(w)}`) ? [] : w.cook) {
    const r = LIB[it.r];
    if (!r) continue;
    for (const i of r.ingredients) add(i.p, i.q * (it.servings / r.servings), `готовка: ${r.title}`, w.cookDate ?? weekFrom(w), false);
  }
  const startShop = w.shopDate ?? weekFrom(w);
  for (const [date, slots] of Object.entries(w.meals)) {
    for (const [slot, m] of Object.entries(slots) as [MealSlot, WeekMeal][]) {
      if (marked(`meal:${date}:${slot}`)) continue;
      // приёмы до доставки (утро дня закупки и раньше) — из того, что уже есть
      const beforeShop = date < startShop || (date === startShop && SLOT_ORDER[slot] < SLOT_ORDER.dinner);
      for (const id of m.add ?? []) { const a = ADDON[id]; if (a) add(a.p, a.q, `${fmtShort(date)}: ${a.title.toLowerCase()}`, date, m.src === 'stock' || beforeShop); }
      if (!m.r || m.src === 'cook') continue;
      const r = LIB[m.r];
      if (!r) continue;
      for (const i of r.ingredients) add(i.p, i.q / r.servings, `${fmtShort(date)}: ${r.title}`, date, m.src === 'stock' || beforeShop);
    }
  }
  for (const n of out.values()) { n.qty = Math.round(n.qty * 10) / 10; n.stockOnly = Math.round(n.stockOnly * 10) / 10; }
  return out;
}

export interface StockCheckRow {
  productId: string; name: string; unit: Product['unit']; need: number;
  /** По учёту всего и сколько из этого ещё в сроке (просроченное по учёту — не предлагается). */
  have: number; usable: number;
  confirmed: boolean; checkedAt: string | null; place: string;
}
/** Что проверить дома перед закупкой: всё, что нужно на неделю, с остатком по учёту. */
export function weekStockRows(data: AppData, w: WeekPlan, today: ISODate): StockCheckRow[] {
  const rows: StockCheckRow[] = [];
  for (const n of weekNeeds(w, data).values()) {
    const p = PRODUCTS[n.productId];
    const rec = data.stock[n.productId];
    const usable = rec ? stockLots(rec).filter((l) => l.until >= today).reduce((a, l) => a + l.qty, 0) : 0;
    rows.push({
      productId: n.productId, name: p.name, unit: p.unit, need: n.qty, have: Math.max(0, Math.round(stockRemaining(data, n.productId) * 10) / 10),
      usable: Math.max(0, Math.round(Math.min(usable, stockRemaining(data, n.productId)) * 10) / 10),
      confirmed: !!rec?.confirmedAt && !!w.stockConfirmedAt && rec.confirmedAt >= w.stockConfirmedAt.slice(0, 10), checkedAt: rec?.confirmedAt ?? null,
      place: rec?.location ?? p.storage,
    });
  }
  return rows.sort((a, b) => (PRODUCTS[a.productId].category + a.name).localeCompare(PRODUCTS[b.productId].category + b.name));
}

export interface WeekPurchase {
  ready: boolean;
  lines: ShopLine[];
  total: number;
  /** Товары без подтверждённой карточки и цены av.ru. */
  unverified: string[];
  /** Чего не хватает к блюдам «из того, что есть дома» (не докупается). */
  deficits: string[];
  leftovers: string[];
  /** Продукты, остаток которых не подтверждён после изменения меню: в закупку попадут после подтверждения. */
  pending?: string[];
}

const NOT_READY: WeekPurchase = { ready: false, lines: [], total: 0, unverified: [], deficits: [], leftovers: [] };

/** Закупка недели: снимок на момент подтверждения запасов; до подтверждения — нет. */
export function weekPurchase(_data: AppData, w: WeekPlan): WeekPurchase {
  if (!w.stockConfirmedAt || w.status !== 'approved' || !w.purchase) return NOT_READY;
  return w.purchase;
}

/** Посчитать закупку по текущим запасам: упаковки целиком, остатки и их использование. */
export function computePurchase(data: AppData, w: WeekPlan): WeekPurchase {
  if (w.status !== 'approved') return NOT_READY;
  const lines: ShopLine[] = [];
  const unverified: string[] = [];
  const deficits: string[] = [];
  const leftovers: string[] = [];
  const pending: string[] = [];
  const since = w.stockConfirmedAt ? w.stockConfirmedAt.slice(0, 10) : null;
  const subTargets = new Set<string>();
  let total = 0;
  // товара нет на av.ru: сначала то, что есть дома, недостающее — покупаем замену (граммовка × ratio)
  const needs = new Map([...weekNeeds(w, data)].map(([k, v]) => [k, { ...v, uses: [...v.uses] }]));
  for (const n of [...needs.values()]) {
    const chosen = w.subs?.[n.productId];
    const sub = chosen ? { to: chosen, ratio: AV_SUBS[n.productId]?.to === chosen ? AV_SUBS[n.productId].ratio ?? 1 : 1, note: 'замена выбрана: товара нет в магазине' } : avSub(n.productId);
    if (!sub || sub.to === n.productId) continue;
    const have = Math.max(0, stockRemaining(data, n.productId));
    const covered = Math.min(n.qty, Math.max(have, n.stockOnly));
    const rest = Math.max(0, n.qty - covered);
    if (rest <= 0.01) continue;
    n.qty = Math.round(covered * 10) / 10;
    if (n.qty <= 0.01) needs.delete(n.productId);
    const t = needs.get(sub.to) ?? { productId: sub.to, qty: 0, uses: [], stockOnly: 0, firstUse: n.firstUse };
    t.qty = Math.round((t.qty + rest * sub.ratio) * 10) / 10;
    t.uses.push(`вместо: ${shortName(n.productId)} — ${sub.note}`);
    subTargets.add(sub.to);
    if (n.firstUse < t.firstUse) t.firstUse = n.firstUse;
    needs.set(sub.to, t);
  }
  for (const n of needs.values()) {
    const p = PRODUCTS[n.productId];
    const have = Math.max(0, stockRemaining(data, n.productId));
    // новые продукты после изменения меню: остаток ещё не подтверждён — закупка по ним после подтверждения
    const rec = data.stock[n.productId];
    if (since && !subTargets.has(n.productId) && !(rec?.confirmedAt && rec.confirmedAt >= since)) { pending.push(n.productId); continue; }
    const buyNeed = Math.max(0, n.qty - n.stockOnly - Math.max(0, have - n.stockOnly));
    if (n.stockOnly > have + 0.01 && p.category !== 'Специи' && !['salt', 'oliveoil'].includes(n.productId)) deficits.push(`${shortName(n.productId)}: к блюдам из запасов нужно ${fmtQty(p, n.stockOnly)}, дома ${fmtQty(p, have)}`);
    if (buyNeed <= 0.01) continue;
    const bi = buyInfo(n.productId);
    const size = bi.packSize || p.pack?.size || 0;
    const packs = size > 0 ? Math.ceil(buyNeed / size - 1e-9) : null;
    const buy = packs != null ? packs * size : buyNeed;
    const price = bi.status === 'listed' ? bi.packPrice : null;
    const cost = packs != null && typeof price === 'number' ? Math.round(packs * price) : 0;
    if (bi.status !== 'listed' || typeof price !== 'number') unverified.push(shortName(n.productId));
    const leftover = Math.round((buy - buyNeed) * 10) / 10;
    const notes: string[] = n.uses.filter((u) => u.startsWith('вместо: '));
    if (leftover > 0.5) {
      const perishable = p.storage !== 'pantry' && p.shelf_days <= 10;
      const share = size ? leftover / size : 0;
      const where = perishable ? (p.freezable ? 'заморозить в день покупки или поставить в меню следующей недели' : `использовать до ${fmtShort(addDays(n.firstUse, Math.max(1, p.shelf_days - 1)))}`) : 'остаётся в запасах';
      notes.push(`останется ${fmtQty(p, leftover)} — ${where}`);
      if (perishable && share >= 0.5 && buyNeed <= 100 && p.unit !== 'pcs') notes.push('нужно мало, упаковка большая: проверьте упаковку поменьше');
      leftovers.push(`${shortName(n.productId)}: ${fmtQty(p, leftover)} — ${where}`);
    }
    if (n.firstUse > addDays(w.shopDate ?? weekFrom(w), p.shelf_days) && p.storage === 'fridge') notes.push(p.freezable ? 'нужно позже срока хранения — заморозить в день покупки' : 'нужно позже срока хранения — купить ближе к дате');
    total += cost;
    lines.push({
      productId: n.productId, need: Math.round(n.qty * 10) / 10, fromStock: Math.round(Math.min(have, n.qty) * 10) / 10, buy: Math.round(buy * 10) / 10,
      packs, cost, leftover, freezeNow: 0, notes, needs: n.uses.map((u) => ({ date: w.shopDate ?? weekFrom(w), label: u, qty: 0 })),
    });
  }
  lines.sort((a, b) => (PRODUCTS[a.productId].category + PRODUCTS[a.productId].name).localeCompare(PRODUCTS[b.productId].category + PRODUCTS[b.productId].name));
  return { ready: true, lines, total, unverified, deficits, leftovers, ...(pending.length ? { pending } : {}) };
}

/**
 * Закупка после изменения меню (замена блюда, поездка, замена товара): по подтверждённым запасам. Уже купленные
 * строки не меняются (они в запасах), недостающее — новыми строками; по новым продуктам — после подтверждения остатка.
 */
export function recalcPurchase(data: AppData, w: WeekPlan): WeekPurchase | null {
  if (!w.stockConfirmedAt || w.status !== 'approved') return null;
  const fresh = computePurchase(data, w);
  const old = w.purchase;
  const ev = shopEventId(w);
  const bought = new Set((old?.lines ?? []).filter((l) => data.shoppingChecks[`${ev}:${l.productId}`]?.bought).map((l) => l.productId));
  if (!old || !bought.size) return fresh;
  const lines: ShopLine[] = old.lines.filter((l) => bought.has(l.productId)).map((l) => ({ ...l, notes: l.notes.filter((n) => !n.startsWith('после изменения меню')) }));
  for (const l of fresh.lines) {
    if (!bought.has(l.productId)) { lines.push(l); continue; }
    const b = lines.find((x) => x.productId === l.productId)!;
    b.notes = [...b.notes, `после изменения меню нужно ещё ${fmtQty(PRODUCTS[l.productId], l.buy)} — докупить`];
  }
  lines.sort((a, b) => (PRODUCTS[a.productId].category + PRODUCTS[a.productId].name).localeCompare(PRODUCTS[b.productId].category + PRODUCTS[b.productId].name));
  return { ...fresh, lines, total: lines.reduce((s2, l) => s2 + l.cost, 0) + fresh.lines.filter((l) => bought.has(l.productId)).reduce((s2, l) => s2 + l.cost, 0) };
}

const shortName = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[«,]/)[0].trim();

export function fmtQty(p: Product, q: number): string {
  if (p.unit === 'pcs') return `${Math.round(q * 10) / 10} шт.`;
  const v = Math.round(q);
  return p.unit === 'ml' ? `${v} мл` : v >= 1000 ? `${(Math.round(v / 100) / 10).toString().replace('.', ',')} кг` : `${v} г`;
}

/** Установить фактический остаток продукта (подтверждение запасов перед закупкой). */
export function setRemainingOps(data: AppData, productId: string, qty: number, now: string, today: ISODate, note: string | null): Op[] {
  const p = PRODUCTS[productId];
  if (!p) return [];
  const rec: StockRec = data.stock[productId] ?? emptyStock(productId, now);
  const cur = stockRemaining(data, productId);
  const delta = Math.round((qty - cur) * 10) / 10;
  const moves = Math.abs(delta) > 0.05
    ? [...rec.moves, { id: `adj-${productId}-${now}`, date: today, kind: 'adjust' as const, qty: delta, source: 'проверка запасов к закупке', note, confirmed: true, at: now }]
    : rec.moves;
  return [{ store: 'stock', put: { ...rec, moves, confirmedAt: now, note: note ?? rec.note, updatedAt: now } }];
}

// ------------------------------------------------------------------ цикл недель и планировщик (без ИИ)

export interface Cycle {
  cookDate: ISODate; slots: { date: ISODate; slot: MealSlot }[]; fresh: { date: ISODate; slot: MealSlot }[]; beforeTrip: boolean;
  /** Приёмы дня готовки до закупки, которые не закрывает прошлая неделя (после командировки): из того, что есть. */
  gap: { date: ISODate; slot: MealSlot }[];
}

/**
 * Дни готовки: каждый день закупки (по умолчанию воскресенье) и день возвращения из командировки, если до
 * следующего дня закупки больше суток. Порции готовки закрывают обеды и ужины от ужина дня готовки до обеда
 * следующего дня готовки; завтраки и перекусы — со следующего утра до следующего дня готовки включительно.
 */
export function planCycles(data: AppData, from: ISODate, to: ISODate, shopDay: number): Cycle[] {
  const trips = tripList(data);
  const kind = (d: ISODate) => dayKind(data, d, trips);
  const cookDays: ISODate[] = [];
  for (const d of range(from, to)) {
    if (kind(d) === 'trip') continue;
    const prevTrip = kind(addDays(d, -1)) === 'trip';
    const isShop = isoWeekday(d) === shopDay;
    let nextShop = d;
    while (isoWeekday(nextShop) !== shopDay) nextShop = addDays(nextShop, 1);
    if (isShop || (prevTrip && diffDays(nextShop, d) > 1) || d === from) cookDays.push(d);
  }
  const cycles: Cycle[] = [];
  for (let i = 0; i < cookDays.length; i++) {
    const c = cookDays[i];
    const next = cookDays[i + 1] ?? addDays(to, 1);
    const slots: Cycle['slots'] = [];
    const fresh: Cycle['fresh'] = [];
    const gap: Cycle['gap'] = [];
    let beforeTrip = false;
    if ((c === from || kind(addDays(c, -1)) === 'trip') && kind(c) === 'home') gap.push({ date: c, slot: 'breakfast' }, { date: c, slot: 'lunch' }, { date: c, slot: 'snack' });
    for (const d of range(c, addDays(next, -1 + 1))) {
      if (d > to) break;
      const k = kind(d);
      if (k === 'trip') { beforeTrip = true; break; }
      if (k === 'relax') continue;
      const lastDay = d === next;
      if (d === c) { slots.push({ date: d, slot: 'dinner' }); continue; }
      if (lastDay) { slots.push({ date: d, slot: 'lunch' }); fresh.push({ date: d, slot: 'breakfast' }, { date: d, slot: 'snack' }); continue; }
      slots.push({ date: d, slot: 'lunch' }, { date: d, slot: 'dinner' });
      fresh.push({ date: d, slot: 'breakfast' }, { date: d, slot: 'snack' });
    }
    if (slots.length) cycles.push({ cookDate: c, slots, fresh, beforeTrip, gap });
  }
  return cycles;
}

/** Основные блюда, которые были в меню за последние days дней (по записям и неделям): рецепт → последняя дата. */
export function recentMains(data: AppData, before: ISODate, days = 28): Map<string, ISODate> {
  const out = new Map<string, ISODate>();
  const since = addDays(before, -days);
  const note = (r: string, d: ISODate) => { if (d >= since && d < before && (!out.has(r) || out.get(r)! < d)) out.set(r, d); };
  for (const day of Object.values(data.planDays)) for (const slot of ['lunch', 'dinner'] as MealSlot[]) {
    for (const p of day.mealCards?.[slot]?.parts ?? []) if (p.dishId.startsWith('lib-')) note(p.dishId.slice(4), day.date);
  }
  for (const w of weekList(weeklyOf(data))) for (const [d, slots] of Object.entries(w.meals)) {
    for (const s of ['lunch', 'dinner'] as MealSlot[]) { const m = slots[s]; if (m?.r) note(m.r, d); }
  }
  return out;
}

/** Заменить блюдо в неделе: основное блюдо — во всех его порциях готовки; завтрак и перекус — в одном приёме. */
export function replaceInWeek(w: WeekPlan, oldId: string, newId: string, at?: { date: ISODate; slot: MealSlot }): WeekPlan {
  const r = LIB[newId];
  if (!r) return w;
  const meals: WeekPlan['meals'] = JSON.parse(JSON.stringify(w.meals));
  if (at && LIB[oldId]?.kind !== 'main') {
    const m = meals[at.date]?.[at.slot];
    if (m) {
      meals[at.date]![at.slot] = { ...m, r: newId, note: m.note && /вторая порция|готовится \d/i.test(m.note) ? null : m.note ?? null };
      // пара «две порции на два дня» распадается: у соседнего дня убрать пояснение про вторую порцию
      for (const d of [addDays(at.date, 1), addDays(at.date, -1)]) {
        const o = meals[d]?.[at.slot];
        if (o && o.r === oldId && o.note && /вторая порция|готовится \d/i.test(o.note)) meals[d]![at.slot] = { ...o, note: null };
      }
    }
    return { ...w, meals };
  }
  for (const slots of Object.values(meals)) for (const s of MEAL_SLOTS) if (slots[s]?.r === oldId) slots[s] = { ...slots[s]!, r: newId };
  const cook = w.cook.map((c) => {
    if (c.r !== oldId) return c;
    // порции, которые не доживут в холодильнике у нового блюда, — в морозилку
    const uses = c.uses.map((u) => {
      const days = w.cookDate ? diffDays(u.date, w.cookDate) : 0;
      const storage: 'fridge' | 'freeze' = days <= Math.min(3, r.storage.fridge_days) ? 'fridge' : 'freeze';
      return { ...u, storage, thawOn: storage === 'freeze' ? addDays(u.date, -1) : null };
    });
    // партия — по числу порций в меню (плюс запас, если он был), а не по стандартному выходу рецепта
    const spare = Math.max(0, c.servings - c.uses.length);
    return { r: newId, servings: uses.length + spare, uses };
  });
  return { ...w, meals, cook };
}

/** Подходящие замены: того же вида (основное — с тем же числом порций ±1), не скрытые, без недавних повторов. */
export function alternatives(data: AppData, w: WeekPlan, recipeId: string, limit = 6): LibRecipe[] {
  const cur = LIB[recipeId];
  if (!cur) return [];
  const prefs = prefsOf(data);
  const inWeek = new Set([...w.cook.map((c) => c.r), ...Object.values(w.meals).flatMap((s) => Object.values(s).map((m) => m!.r)).filter(Boolean)]);
  const recent = recentMains(data, w.cookDate ?? weekFrom(w), 28);
  const need = w.cook.find((c) => c.r === recipeId)?.uses.length ?? 1;
  return LIB_RECIPES
    .filter((r) => r.kind === cur.kind && r.id !== cur.id && !inWeek.has(r.id) && !prefs[r.id]?.hidden && (prefs[r.id]?.rating ?? 3) > 2 && libVerified(r) && recipeAvail(r, data).ok)
    .filter((r) => cur.kind !== 'main' || (r.servings >= need && r.servings <= need + 2))
    .sort((a, b) => Number(recent.has(a.id)) - Number(recent.has(b.id)) || Number(!!prefs[b.id]?.fav) - Number(!!prefs[a.id]?.fav) || (prefs[b.id]?.rating ?? 3) - (prefs[a.id]?.rating ?? 3) || Number(a.protein === cur.protein) - Number(b.protein === cur.protein))
    .slice(0, limit);
}

/** Ккал и БЖУ дня недели (по рецептам библиотеки). */
export function weekDayNutrition(w: WeekPlan, date: ISODate): { kcal: number; p: number; f: number; c: number } | null {
  const slots = w.meals[date];
  if (!slots) return null;
  const s = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const m of Object.values(slots)) {
    if (!m) continue;
    for (const d of [m.r ? DISHES[libDishId(m.r)] : null, ...(m.add ?? []).map((id) => DISHES[id])]) {
    if (!d) continue;
    for (const i of d.ingredients) {
      // замена, выбранная на эту неделю, — КБЖУ по замене
      const to = w.subs?.[i.product];
      const p = PRODUCTS[to ?? i.product];
      if (!p) continue;
      const ratio = to && AV_SUBS[i.product]?.to === to ? AV_SUBS[i.product].ratio ?? 1 : 1;
      const g = (p.unit === 'pcs' ? i.qty * (p.piece_g ?? 0) : i.qty) * ratio;
      s.kcal += (g * p.nutr.kcal) / 100; s.p += (g * p.nutr.p) / 100; s.f += (g * p.nutr.f) / 100; s.c += (g * p.nutr.c) / 100;
    }
    }
  }
  return { kcal: Math.round(s.kcal), p: Math.round(s.p), f: Math.round(s.f), c: Math.round(s.c) };
}

export interface ScheduledStep { start: number; end: number; eq: string; text: string; recipe: string }

function stepMinutes(min: string | undefined, prep: boolean): number {
  if (!min || min === '—') return prep ? 5 : 0;
  const nums = (min.match(/\d+/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : prep ? 5 : 0;
}

/**
 * Расписание общей готовки: плита — две конфорки, аэрогриль и электрогриль — по одной закладке, руки — одна
 * подготовка за раз. Пока что-то варится или запекается, можно делать следующий шаг; шаг на том же приборе и
 * раскладка по порциям ждут окончания предыдущего. Разморозка — накануне, в расписание не входит.
 */
export function cookSchedule(w: WeekPlan): { before: string[]; steps: ScheduledStep[]; total: number } {
  const before: string[] = [];
  type S = { eq: string; dur: number; text: string };
  const chains: { title: string; steps: S[]; i: number; prevStart: number; prevEnd: number; ends: number[]; first: number }[] = [];
  // блюдо на ужин в день готовки — первым (особенно при вечерней доставке)
  const dinner = w.cookDate ? w.meals[w.cookDate]?.dinner : null;
  const firstId = dinner?.src === 'cook' ? dinner.r : null;
  for (const c of w.cook) {
    const r = LIB[c.r];
    if (!r) continue;
    const steps: S[] = [];
    for (const st of r.steps) {
      if (/разморозить/i.test(st.t) && !st.eq && (!st.min || st.min === '—')) { before.push(`${r.title}: ${st.t}`); continue; }
      steps.push({ eq: st.eq ?? 'подготовка', dur: stepMinutes(st.min, !st.eq), text: st.t + (st.temp && !st.t.includes(st.temp) ? ` (${st.temp})` : '') });
    }
    chains.push({ title: r.title, steps, i: 0, prevStart: 0, prevEnd: 0, ends: [], first: c.r === firstId ? 1 : 0 });
  }
  const cap: Record<string, number> = { 'плита': 2, 'аэрогриль': 1, 'электрогриль': 1, 'подготовка': 1, 'без нагрева': 1 };
  const busy: { eq: string; end: number }[] = [];
  const out: ScheduledStep[] = [];
  const remaining = (ch: (typeof chains)[number]) => ch.steps.slice(ch.i).reduce((a, x) => a + x.dur, 0);
  for (let t = 0; t < 600 && chains.some((ch) => ch.i < ch.steps.length); t++) {
    for (let k = busy.length - 1; k >= 0; k--) if (busy[k].end <= t) busy.splice(k, 1);
    const order = [...chains].sort((a, b) => b.first - a.first || remaining(b) - remaining(a));
    for (const ch of order) {
      if (ch.i >= ch.steps.length) continue;
      const st = ch.steps[ch.i];
      const prev = ch.i > 0 ? ch.steps[ch.i - 1] : null;
      const last = ch.i === ch.steps.length - 1 && ch.steps.length > 1;
      // ждать окончания: после подготовки, на том же приборе и для раскладки; иначе — можно начать, когда прошлый шаг пошёл
      const waitEnd = !prev || prev.eq === 'подготовка' || prev.eq === st.eq || last;
      const readyAt = !prev ? 0 : last ? Math.max(ch.prevEnd, ...ch.ends) : waitEnd ? ch.prevEnd : ch.prevStart + 1;
      if (t < readyAt) continue;
      const res = st.eq === 'без нагрева' ? 'подготовка' : st.eq;
      if (busy.filter((b) => b.eq === res).length >= (cap[res] ?? 1)) continue;
      const end = t + Math.max(1, st.dur);
      busy.push({ eq: res, end });
      out.push({ start: t, end, eq: st.eq, text: st.text, recipe: ch.title });
      ch.prevStart = t; ch.prevEnd = end; ch.ends.push(end); ch.i++;
      if (res === 'подготовка') break; // руки одни: за минуту начинаем не больше одной подготовки
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return { before, steps: out, total: out.reduce((m, x) => Math.max(m, x.end), 0) };
}

/** Сколько займёт готовка недели: активная работа и общее время с учётом параллельной работы техники. */
export function cookTiming(w: WeekPlan): { active: number; total: number; byDevice: Record<string, number> } {
  const byDevice: Record<string, number> = {};
  let active = 0;
  for (const c of w.cook) {
    const r = LIB[c.r];
    if (!r) continue;
    active += r.time.active;
    for (const [k, v] of Object.entries(r.load ?? {})) byDevice[k] = (byDevice[k] ?? 0) + (v ?? 0);
  }
  // общее время — по расписанию с параллельной техникой, плюс 15 минут на раскладку и остывание
  const total = cookSchedule(w).total + 15;
  return { active, total, byDevice };
}
