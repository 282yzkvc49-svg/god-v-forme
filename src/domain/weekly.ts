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
import { DISHES, LIB_RECIPES, PRODUCTS, libDishId, type Product } from './catalog';
import type { LibRecipe } from './recipeCheck';
import { DRINKS_TEXT, TRIP_DRINKS_TEXT, hasDayMarks, mealTitle, setWeeklyHook, type ReplanResult } from './plan';
import { isRelaxDate, tripList, tripMeal, tripOn } from './trips';
import { emptyStock, stockRemaining } from './stock';
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
  notes: string[];
  createdAt: string;
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

export interface WeeklyRecords { planDays: PlanDay[]; cookingEvents: CookingEvent[]; shoppingEvents: ShoppingEvent[]; issues: string[] }

/** Все записи недельного цикла с даты from (дни, готовки, закупки). */
export function buildWeeklyRecords(data: AppData, from: ISODate, to: ISODate): WeeklyRecords {
  const ws = weeklyOf(data)!;
  const weeks = weekList(ws);
  const trips = tripList(data);
  const issues: string[] = [];
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
        cards[slot] = { title: hit.m.title || 'Из того, что есть дома', parts: [], note: hit.m.note ?? null };
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
      cards[slot] = { title: mealTitle([part]), parts: [part], note: notes.length ? notes.join(' ') : null };
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
        for (const i of r.ingredients) {
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
        source: 'seed', patchId: null, instanceId: WEEKLY_INSTANCE, blockId: w.id, kind: 'main', time: w.cookTime ?? ws.cookTime,
        timeNote: 'Один сеанс: аэрогриль, плита и электрогриль работают параллельно — порядок шагов в разделе «Неделя».',
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

export interface WeekNeed { productId: string; qty: number; uses: string[]; stockOnly: number; firstUse: ISODate }

/** Что нужно на неделю (масса покупки с учётом очистки): готовка целиком + свежие блюда с дня закупки.
 * Уже отмеченное (съеденный приём, приготовленная готовка) не считается: эти продукты уже списаны. */
export function weekNeeds(w: WeekPlan, data?: AppData): Map<string, WeekNeed> {
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
      if (!m.r || m.src === 'cook' || marked(`meal:${date}:${slot}`)) continue;
      // приёмы до доставки (утро дня закупки и раньше) — из того, что уже есть
      const beforeShop = date < startShop || (date === startShop && SLOT_ORDER[slot] < SLOT_ORDER.dinner);
      const r = LIB[m.r];
      if (!r) continue;
      for (const i of r.ingredients) add(i.p, i.q / r.servings, `${fmtShort(date)}: ${r.title}`, date, m.src === 'stock' || beforeShop);
    }
  }
  for (const n of out.values()) { n.qty = Math.round(n.qty * 10) / 10; n.stockOnly = Math.round(n.stockOnly * 10) / 10; }
  return out;
}

export interface StockCheckRow {
  productId: string; name: string; unit: Product['unit']; need: number; have: number; confirmed: boolean; checkedAt: string | null; place: string;
}
/** Что проверить дома перед закупкой: всё, что нужно на неделю, с остатком по учёту. */
export function weekStockRows(data: AppData, w: WeekPlan): StockCheckRow[] {
  const rows: StockCheckRow[] = [];
  for (const n of weekNeeds(w, data).values()) {
    const p = PRODUCTS[n.productId];
    const rec = data.stock[n.productId];
    rows.push({
      productId: n.productId, name: p.name, unit: p.unit, need: n.qty, have: Math.max(0, Math.round(stockRemaining(data, n.productId) * 10) / 10),
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
}

/** Закупка недели: считается только после подтверждения запасов; упаковки целиком, остатки и их использование. */
export function weekPurchase(data: AppData, w: WeekPlan): WeekPurchase {
  if (!w.stockConfirmedAt || w.status !== 'approved') return { ready: false, lines: [], total: 0, unverified: [], deficits: [], leftovers: [] };
  const lines: ShopLine[] = [];
  const unverified: string[] = [];
  const deficits: string[] = [];
  const leftovers: string[] = [];
  let total = 0;
  for (const n of weekNeeds(w, data).values()) {
    const p = PRODUCTS[n.productId];
    const have = Math.max(0, stockRemaining(data, n.productId));
    const buyNeed = Math.max(0, n.qty - n.stockOnly - Math.max(0, have - n.stockOnly));
    if (n.stockOnly > have + 0.01) deficits.push(`${p.name}: к блюдам из запасов нужно ${fmtQty(p, n.stockOnly)}, дома ${fmtQty(p, have)}`);
    if (buyNeed <= 0.01) continue;
    const size = p.pack?.size || 0;
    const packs = size > 0 ? Math.ceil(buyNeed / size - 1e-9) : null;
    const buy = packs != null ? packs * size : buyNeed;
    const price = (p as Product & { pack_price?: number }).pack_price;
    const cost = packs != null && typeof price === 'number' && !p.av ? Math.round(packs * price) : 0;
    if (p.av === 'unverified' || typeof price !== 'number') unverified.push(p.name);
    const leftover = Math.round((buy - buyNeed) * 10) / 10;
    const notes: string[] = [];
    if (leftover > 0.5) {
      const perishable = p.storage !== 'pantry' && p.shelf_days <= 10;
      const share = size ? leftover / size : 0;
      const where = perishable ? (p.freezable ? 'заморозить в день покупки или поставить в меню следующей недели' : `использовать до ${fmtShort(addDays(n.firstUse, Math.max(1, p.shelf_days - 1)))}`) : 'остаётся в запасах';
      notes.push(`останется ${fmtQty(p, leftover)} — ${where}`);
      if (perishable && share >= 0.5 && buyNeed <= 100 && p.unit !== 'pcs') notes.push('нужно мало, упаковка большая: проверьте упаковку поменьше');
      leftovers.push(`${p.name}: ${fmtQty(p, leftover)} — ${where}`);
    }
    if (n.firstUse > addDays(w.shopDate ?? weekFrom(w), p.shelf_days) && p.storage === 'fridge') notes.push(p.freezable ? 'нужно позже срока хранения — заморозить в день покупки' : 'нужно позже срока хранения — купить ближе к дате');
    total += cost;
    lines.push({
      productId: n.productId, need: Math.round(n.qty * 10) / 10, fromStock: Math.round(Math.min(have, n.qty) * 10) / 10, buy: Math.round(buy * 10) / 10,
      packs, cost, leftover, freezeNow: 0, notes, needs: n.uses.map((u) => ({ date: w.shopDate ?? weekFrom(w), label: u, qty: 0 })),
    });
  }
  lines.sort((a, b) => (PRODUCTS[a.productId].category + PRODUCTS[a.productId].name).localeCompare(PRODUCTS[b.productId].category + PRODUCTS[b.productId].name));
  return { ready: true, lines, total, unverified, deficits, leftovers };
}

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

export interface DraftOptions { now: string; exclude?: Set<string>; seed?: number }

/**
 * Черновик недели по библиотеке (без ИИ): 2–3 основных блюда на все обеды и ужины цикла, без повторов
 * за последние 4 недели, с разными видами белка и морской рыбой, если она есть в библиотеке; что не доживёт
 * в холодильнике — в морозилку; завтраки и перекусы — без повторов в соседние дни. Это подбор из проверенных
 * рецептов, а не генерация новых.
 */
export function draftWeek(data: AppData, cycle: Cycle, opts: DraftOptions): WeekPlan {
  const ws = weeklyOf(data);
  const prefs = prefsOf(data);
  const recent = recentMains(data, cycle.cookDate, 28);
  const notes: string[] = [];
  const ok = (r: LibRecipe) => libVerified(r) && !prefs[r.id]?.hidden && !opts.exclude?.has(r.id);
  const score = (r: LibRecipe) => (prefs[r.id]?.fav ? 2 : 0) + ((prefs[r.id]?.rating ?? 3) - 3) * 0.5 + (r.tags.includes('заморозка') ? 0.3 : 0);
  const N = cycle.slots.length;
  let pool = LIB_RECIPES.filter((r) => r.kind === 'main' && r.servings >= 2 && ok(r) && !recent.has(r.id));
  if (pool.length < 2) {
    const older = LIB_RECIPES.filter((r) => r.kind === 'main' && r.servings >= 2 && ok(r) && !pool.includes(r))
      .sort((a, b) => (recent.get(a.id) ?? '').localeCompare(recent.get(b.id) ?? ''));
    pool = [...pool, ...older.slice(0, 4 - pool.length)];
    notes.push('В библиотеке пока мало основных блюд: часть повторяется раньше, чем через 4 недели.');
  }
  // подобрать 1–3 блюда, сумма порций — ровно на все приёмы или на одну больше
  const cand = pool.sort((a, b) => score(b) - score(a)).slice(0, 12);
  type Pick = { r: LibRecipe; k: number };
  const best2: { v: Pick[] | null; s: number } = { v: null, s: -Infinity };
  const consider = (set: Pick[]) => {
    const sum = set.reduce((s, x) => s + x.r.servings * x.k, 0);
    if (sum < N || sum > N + (cycle.beforeTrip ? 0 : 1)) return;
    const proteins = new Set(set.map((x) => x.r.protein));
    const fish = set.some((x) => ['белая рыба', 'жирная рыба', 'морепродукты', 'рыба'].includes(x.r.protein));
    const devices = new Set(set.flatMap((x) => x.r.equipment));
    // двойная партия — только у небольших блюд, которые морозятся; одного блюда — не больше 6 порций в неделю
    if (set.some((x) => x.k > 1 && (!x.r.storage.freeze || x.r.servings > 3))) return;
    if (set.some((x) => x.r.servings * x.k > 6)) return;
    const sc = set.reduce((s, x) => s + score(x.r) - (x.k > 1 ? 1 : 0), 0) + proteins.size * 1.5 + (fish ? 2 : 0) + devices.size * 0.5 - (sum - N) - (set.length === 1 ? 1 : 0);
    if (sc > best2.s) { best2.s = sc; best2.v = set; }
  };
  const K = [1, 2];
  for (let i = 0; i < cand.length; i++) for (const a of K) {
    consider([{ r: cand[i], k: a }]);
    for (let j = i + 1; j < cand.length; j++) for (const b of K) {
      consider([{ r: cand[i], k: a }, { r: cand[j], k: b }]);
      for (let k = j + 1; k < cand.length; k++) for (const c of K) consider([{ r: cand[i], k: a }, { r: cand[j], k: b }, { r: cand[k], k: c }]);
    }
  }
  const chosen: Pick[] = best2.v ? [...best2.v] : [];
  if (!chosen.length) {
    // ровно не сходится — берём больше и лишние порции замораживаем
    let sum = 0;
    for (const r of cand) { if (sum >= N) break; chosen.push({ r, k: 1 }); sum += r.servings; }
    if (chosen.length > 3) notes.push(`${chosen.length} блюда вместо 2–3: в библиотеке пока мало основных блюд на 5–6 порций; после пополнения библиотеки неделя соберётся из трёх.`);
    if (sum > N) notes.push(`${sum - N} порц. сверх меню — в морозилку как запас.`);
    if (sum < N) notes.push(`Не хватает ${N - sum} порц.: в библиотеке недостаточно подходящих блюд — замените блюдо или добавьте рецепт.`);
  }
  // раздача порций: сначала рыба (хранится меньше), блюда чередуются
  const queue: { r: LibRecipe; left: number }[] = chosen
    .map((x) => ({ r: x.r, left: x.r.servings * x.k }))
    .sort((a, b) => a.r.storage.fridge_days - b.r.storage.fridge_days);
  const meals: WeekPlan['meals'] = {};
  const cook: WeekCookItem[] = chosen.map((x) => ({ r: x.r.id, servings: x.r.servings * x.k, uses: [] }));
  for (const x of chosen) if (x.k > 1) notes.push(`${x.r.title}: двойная партия (${x.r.servings * x.k} порций).`);
  const extra = chosen.reduce((s2, x) => s2 + x.r.servings * x.k, 0) - N;
  if (best2.v && extra > 0) notes.push(`${extra} порц. сверх меню — в морозилку про запас.`);
  let prev: string | null = null;
  for (const s of cycle.slots) {
    const days = diffDays(s.date, cycle.cookDate);
    const fits = (q: { r: LibRecipe; left: number }) => q.left > 0 && (days <= q.r.storage.fridge_days || q.r.storage.freeze);
    const pick = queue.find((q) => fits(q) && q.r.id !== prev && days <= q.r.storage.fridge_days)
      ?? queue.find((q) => fits(q) && q.r.id !== prev) ?? queue.find(fits) ?? null;
    if (!pick) continue;
    pick.left--;
    prev = pick.r.id;
    const storage: 'fridge' | 'freeze' = days <= Math.min(3, pick.r.storage.fridge_days) ? 'fridge' : 'freeze';
    (meals[s.date] ??= {})[s.slot] = { r: pick.r.id, src: 'cook' };
    cook.find((c) => c.r === pick.r.id)!.uses.push({ date: s.date, slot: s.slot, storage, thawOn: storage === 'freeze' ? addDays(s.date, -1) : null });
  }
  for (const q of queue) if (q.left > 0) {
    const c = cook.find((x) => x.r === q.r.id)!;
    c.servings = c.uses.length + q.left;
  }
  // завтраки и перекусы
  const pickFresh = (kind: 'breakfast' | 'snack', date: ISODate, used: Map<string, ISODate>) => {
    const list = LIB_RECIPES.filter((r) => r.kind === kind && ok(r));
    const weekend = isWeekend(date);
    const scored = list.map((r) => {
      const last = used.get(r.id);
      const gap = last ? diffDays(date, last) : 99;
      const place = r.tags.includes('дома') ? (weekend ? 1 : -5) : r.tags.includes('на работу') ? (weekend ? 0 : 1) : 0;
      return { r, s: score(r) + place + Math.min(gap, 7) - (gap < 3 ? 20 : 0) };
    }).sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id));
    const r = scored[0]?.r;
    if (r) used.set(r.id, date);
    return r;
  };
  const usedB = new Map<string, ISODate>(), usedS = new Map<string, ISODate>();
  // завтраки и перекусы последних дней прошлой недели — чтобы не повторить их сразу
  for (const pw of weekList(ws)) for (const [d, sl] of Object.entries(pw.meals)) {
    if (d > cycle.cookDate || d < addDays(cycle.cookDate, -4)) continue;
    if (sl.breakfast?.r && (!usedB.has(sl.breakfast.r) || usedB.get(sl.breakfast.r)! < d)) usedB.set(sl.breakfast.r, d);
    if (sl.snack?.r && (!usedS.has(sl.snack.r) || usedS.get(sl.snack.r)! < d)) usedS.set(sl.snack.r, d);
  }
  const freshSet = new Set(cycle.fresh.map((f) => `${f.date}|${f.slot}`));
  for (const f of cycle.fresh) {
    if (meals[f.date]?.[f.slot]) continue;
    const r = pickFresh(f.slot === 'breakfast' ? 'breakfast' : 'snack', f.date, f.slot === 'breakfast' ? usedB : usedS);
    if (!r) continue;
    const next = addDays(f.date, 1);
    if (r.servings >= 2 && freshSet.has(`${next}|${f.slot}`) && !meals[next]?.[f.slot]) {
      (meals[f.date] ??= {})[f.slot] = { r: r.id, src: 'fresh', note: `Готовится ${r.servings} порции — вторая на завтра.` };
      (meals[next] ??= {})[f.slot] = { r: r.id, src: 'fresh', note: 'Вторая порция, приготовленная накануне.' };
      (f.slot === 'breakfast' ? usedB : usedS).set(r.id, next);
    } else if (r.servings >= 2) {
      // второй порции некуда встать — берём другой рецепт на одну порцию
      const alt = LIB_RECIPES.find((x) => x.kind === r.kind && x.servings === 1 && ok(x) && x.id !== r.id && !(f.slot === 'breakfast' ? usedB : usedS).has(x.id));
      if (alt) { (meals[f.date] ??= {})[f.slot] = { r: alt.id, src: 'fresh' }; (f.slot === 'breakfast' ? usedB : usedS).set(alt.id, f.date); }
    } else (meals[f.date] ??= {})[f.slot] = { r: r.id, src: 'fresh' };
  }
  for (const g of cycle.gap) {
    if (meals[g.date]?.[g.slot]) continue;
    (meals[g.date] ??= {})[g.slot] = { r: '', src: 'stock', title: g.slot === 'lunch' ? 'Обед на работе или из того, что есть' : 'Из того, что есть дома', note: 'День закупки после командировки: продукты привезут к вечеру.' };
  }
  // морозилка
  const frozen = cook.reduce((s, c) => s + c.uses.filter((u) => u.storage === 'freeze').length, 0) + cook.reduce((s, c) => s + Math.max(0, c.servings - c.uses.length), 0);
  const cap = ws?.freezer.capacity ?? null;
  if (frozen && cap == null) notes.push(`В морозилку пойдёт ${frozen} порц. (плоские пакеты на 1 л). Укажите свободное место в настройках — планировщик будет его учитывать.`);
  if (cap != null && frozen > cap) notes.push(`В морозилку нужно ${frozen} пакетов, а свободно ${cap}: нужна короткая вторая готовка в середине недели — замените одно блюдо на свежее.`);
  const id = `w${cycle.cookDate.replace(/-/g, '')}`;
  return {
    id, title: `Неделя с ${fmtShort(cycle.cookDate)}`, cookDate: cycle.cookDate, cookTime: ws?.cookTime ?? '17:00', shopDate: cycle.cookDate,
    status: 'draft', approvedAt: null, source: 'planner', meals, cook, stockConfirmedAt: null, notes, createdAt: opts.now,
  };
}

/** Заменить блюдо в неделе: основное блюдо — во всех его порциях готовки; завтрак и перекус — в одном приёме. */
export function replaceInWeek(w: WeekPlan, oldId: string, newId: string, at?: { date: ISODate; slot: MealSlot }): WeekPlan {
  const r = LIB[newId];
  if (!r) return w;
  const meals: WeekPlan['meals'] = JSON.parse(JSON.stringify(w.meals));
  if (at && LIB[oldId]?.kind !== 'main') {
    const m = meals[at.date]?.[at.slot];
    if (m) meals[at.date]![at.slot] = { ...m, r: newId };
    return { ...w, meals, stockConfirmedAt: null };
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
    return { r: newId, servings: Math.max(uses.length, r.servings), uses };
  });
  return { ...w, meals, cook, stockConfirmedAt: null };
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
    .filter((r) => r.kind === cur.kind && r.id !== cur.id && !inWeek.has(r.id) && !prefs[r.id]?.hidden && libVerified(r))
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
    if (!m?.r) continue;
    const d = DISHES[libDishId(m.r)];
    if (!d) continue;
    for (const i of d.ingredients) {
      const p = PRODUCTS[i.product];
      if (!p) continue;
      const g = p.unit === 'pcs' ? i.qty * (p.piece_g ?? 0) : i.qty;
      s.kcal += (g * p.nutr.kcal) / 100; s.p += (g * p.nutr.p) / 100; s.f += (g * p.nutr.f) / 100; s.c += (g * p.nutr.c) / 100;
    }
  }
  return { kcal: Math.round(s.kcal), p: Math.round(s.p), f: Math.round(s.f), c: Math.round(s.c) };
}

/** Последовательность общей готовки: что на плите, что в аэрогриле и на электрогриле, по порядку. */
export function cookSequence(w: WeekPlan): { eq: string; text: string; recipe: string; min: string | null }[] {
  const out: { eq: string; text: string; recipe: string; min: string | null }[] = [];
  const recipes = w.cook.map((c) => LIB[c.r]).filter(Boolean);
  // сначала подготовка всех блюд, затем шаги с нагревом: длинные на плите — раньше, аэрогриль и электрогриль — параллельно
  for (const r of recipes) for (const s of r.steps) if (!s.eq) out.push({ eq: 'подготовка', text: s.t, recipe: r.title, min: s.min && s.min !== '—' ? s.min : null });
  const heat = recipes.flatMap((r) => r.steps.filter((s) => s.eq).map((s) => ({ eq: s.eq as string, text: s.t + (s.temp ? ` (${s.temp})` : ''), recipe: r.title, min: s.min ?? null, load: r.load?.[s.eq!] ?? 0 })));
  heat.sort((a, b) => (a.eq === 'плита' ? 0 : 1) - (b.eq === 'плита' ? 0 : 1) || b.load - a.load);
  for (const h of heat) out.push({ eq: h.eq, text: h.text, recipe: h.recipe, min: h.min });
  return out;
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
  // плита — две конфорки параллельно; общее время — самый загруженный прибор плюс подготовка
  const stove = Math.ceil((byDevice['плита'] ?? 0) / 2);
  const total = Math.max(stove, byDevice['аэрогриль'] ?? 0, byDevice['электрогриль'] ?? 0) + Math.round(active / 2) + 15;
  return { active, total, byDevice };
}
