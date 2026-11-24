// Версия 2.0: планировщик недели (без ИИ) — подбор из проверенных рецептов библиотеки.
//  • КБЖУ каждого дня: завтраки и перекусы подбираются под обеды и ужины дня, недостающее — простые «добавки»
//    (творог, йогурт, орехи, хлеб, фрукты), цель — ккал 2300–2600 и белок от 150 г.
//  • Основные блюда: 2–3 блюда на 4–6 порций (партия может быть на порцию больше или меньше стандартной),
//    без повторов за 4 недели, разные виды белка, рыба, чередование по дням; порции, которые не доживут
//    в холодильнике, — в морозилку.
//  • Остатки и упаковки: прогноз запасов по неделям (что останется от упаковок прошлых недель и что дома),
//    сначала используется скоропортящееся; стоимость считается упаковками.
//  • Бюджет: доля месячного бюджета на дни недели; если меню не укладывается в цели — неделя не готова к
//    утверждению «как полное»: проблемы и варианты показываются пользователю.
//  • Командировки: при изменении дат черновики пересобираются, в утверждённые недели добавляются освободившиеся
//    дни (порции готовки, если она ещё не сделана), уже купленное учитывается через запасы.
import type { Op } from '../state/idb';
import type { AppData, MealSlot } from '../state/types';
import { MEAL_SLOTS } from '../state/types';
import { addDays, daysInMonth, diffDays, fmtShort, isWeekend, range, type ISODate } from '../lib/dates';
import { ADDON, ADDONS, AV_SUBS, LIB_RECIPES, PRODUCTS, TEMPLATE, avSub, buyInfo, dishNutrition, libEff, type Product } from './catalog';
import type { LibRecipe } from './recipeCheck';
import { libNutrition } from './recipeLib';
import { BUDGET_RUB, KCAL_TARGET, setWeeklyHook, type ReplanResult } from './plan';
import { tripList } from './trips';
import { stockLots } from './stock';
import {
  LIB, cookDone, dayKind, effectiveWeek, libVerified, planCycles, prefsOf, recalcPurchase, recentMains, recipeAvail, shopBought,
  weekFrom, weekList, weekNeeds, weekTo, weeklyOf, weeklyReplanOps,
  type Cycle, type WeekCookItem, type WeekEstimate, type WeekMeal, type WeekPlan, type WeeklySettings,
} from './weekly';

// ------------------------------------------------------------------ цели дня

export const DAY_KCAL = KCAL_TARGET;
export const DAY_KCAL_MIN = KCAL_TARGET - 150;
export const DAY_KCAL_MAX = KCAL_TARGET + 150;
export const DAY_PROTEIN_TARGET = Number((TEMPLATE.source as { protein_target?: number }).protein_target ?? 165);
export const DAY_PROTEIN_MIN = DAY_PROTEIN_TARGET - 15;
/** Жиры — не больше 40% калорийности дня. */
export const DAY_FAT_MAX_SHARE = 0.4;
/** Обед или ужин, который ещё не составлен (соседняя неделя): средние значения основного блюда. */
const MAIN_UNKNOWN: N = { kcal: 650, p: 50, f: 22, c: 60 };
const SNACK_AVG: N = { kcal: 300, p: 22, f: 10, c: 30 };

export interface N { kcal: number; p: number; f: number; c: number }
const Z = (): N => ({ kcal: 0, p: 0, f: 0, c: 0 });
const plus = (a: N, b: N, k = 1): N => ({ kcal: a.kcal + b.kcal * k, p: a.p + b.p * k, f: a.f + b.f * k, c: a.c + b.c * k });
const round = (a: N): N => ({ kcal: Math.round(a.kcal), p: Math.round(a.p), f: Math.round(a.f), c: Math.round(a.c) });

export function recipeN(id: string): N { const r = LIB[id]; return r ? libNutrition(r) : Z(); }
const ADDON_N = new Map<string, N>();
export function addonN(id: string): N {
  let n = ADDON_N.get(id);
  if (!n) { const d = dishNutrition(id, 1); n = { kcal: d.kcal, p: d.p, f: d.f, c: d.c }; ADDON_N.set(id, n); }
  return n;
}
export function mealN(m: WeekMeal | undefined | null): N {
  if (!m) return Z();
  let n = m.r ? recipeN(m.r) : Z();
  for (const a of m.add ?? []) n = plus(n, addonN(a));
  return n;
}

/** Какая неделя отвечает за приём (последняя по дате готовки) — по календарю с учётом поездок. */
function weekMealAt(weeks: WeekPlan[], date: ISODate, slot: MealSlot): WeekMeal | null {
  for (let i = weeks.length - 1; i >= 0; i--) { const m = weeks[i].meals[date]?.[slot]; if (m) return m; }
  return null;
}

export interface DayNutrition extends N {
  /** Все четыре приёма известны (включая соседние недели) и посчитаны. */
  complete: boolean;
  /** Приёмы «из того, что есть» без рецепта — не посчитаны. */
  unknown: MealSlot[];
  ok: boolean;
}
/** КБЖУ дня по всем неделям (день готовки складывается из двух недель). */
export function dayNutrition(data: AppData, date: ISODate, weeks?: WeekPlan[]): DayNutrition {
  const trips = tripList(data);
  const list = weeks ?? weekList(weeklyOf(data)).map((w) => effectiveWeek(data, w, trips));
  let n = Z();
  const unknown: MealSlot[] = [];
  for (const s of MEAL_SLOTS) {
    const m = weekMealAt(list, date, s);
    if (!m || (!m.r && !(m.add ?? []).length)) { unknown.push(s); continue; }
    if (!m.r) unknown.push(s);
    n = plus(n, mealN(m));
  }
  const r = round(n);
  const complete = unknown.length === 0;
  const fatOk = r.kcal <= 0 || (r.f * 9) / r.kcal <= DAY_FAT_MAX_SHARE;
  return { ...r, complete, unknown, ok: !complete || (r.kcal >= DAY_KCAL_MIN && r.kcal <= DAY_KCAL_MAX && r.p >= DAY_PROTEIN_MIN && fatOk) };
}

// ------------------------------------------------------------------ цены и прогноз запасов

/** ₽ за единицу покупки (г, мл, шт.) по карточке av.ru. */
export function unitPrice(pid: string): number {
  const bi = buyInfo(pid);
  if (bi.status === 'listed' && bi.packPrice && bi.packSize) return bi.packPrice / bi.packSize;
  const p = PRODUCTS[pid];
  return p ? (p.unit === 'pcs' ? p.price : p.price / 1000) : 0;
}
const gross = (p: Product, net: number) => (p.unit === 'pcs' || p.edible_ratio >= 1 ? net : net / p.edible_ratio);
/** Скоропортящееся: в холодильнике, не замораживается, хранится до 10 дней — остаток пропадает. */
export function perishable(pid: string): boolean {
  const p = PRODUCTS[pid];
  return !!p && p.storage === 'fridge' && !p.freezable && p.shelf_days <= 10;
}
const FAR = '2099-12-31';
function lotUntil(p: Product, buyDate: ISODate): ISODate {
  if (p.storage === 'freezer') return FAR;
  if (p.storage === 'pantry') return addDays(buyDate, Math.max(30, p.shelf_days));
  // мясо, рыба, хлеб: остаток упаковки замораживается в день покупки
  return p.freezable ? addDays(buyDate, 60) : addDays(buyDate, p.shelf_days);
}

interface Lot { qty: number; until: ISODate; src: 'home' | 'buy' }
export type Pool = Map<string, Lot[]>;
const clonePool = (pool: Pool): Pool => new Map([...pool].map(([k, v]) => [k, v.map((l) => ({ ...l }))]));
function avail(pool: Pool, pid: string, date: ISODate): number {
  return (pool.get(pid) ?? []).filter((l) => l.until >= date).reduce((s, l) => s + l.qty, 0);
}
function take(pool: Pool, pid: string, qty: number, date: ISODate): number {
  let q = qty;
  const lots = (pool.get(pid) ?? []).filter((l) => l.until >= date && l.qty > 0.01).sort((a, b) => a.until.localeCompare(b.until));
  for (const l of lots) { if (q <= 0.01) break; const t = Math.min(l.qty, q); l.qty -= t; q -= t; }
  return qty - q;
}
function addLot(pool: Pool, pid: string, qty: number, until: ISODate) {
  if (qty <= 0.01) return;
  const lots = pool.get(pid) ?? [];
  lots.push({ qty, until, src: 'buy' });
  pool.set(pid, lots);
}

/** Запасы дома сейчас (только в сроке). */
export function homePool(data: AppData, today: ISODate): Pool {
  const pool: Pool = new Map();
  for (const rec of Object.values(data.stock ?? {})) {
    const lots = stockLots(rec).filter((l) => l.frozen || l.until >= today).map((l) => ({ qty: l.qty, until: l.frozen ? FAR : l.until, src: 'home' as const }));
    if (lots.length) pool.set(rec.productId, lots);
  }
  return pool;
}

/** Нужное на неделю после замен (товара нет на av.ru): сначала то, что есть, остальное — заменой. */
function needsWithSubs(data: AppData, w: WeekPlan, pool: Pool) {
  const needs = new Map([...weekNeeds(w, data)].map(([k, v]) => [k, { ...v }]));
  for (const n of [...needs.values()]) {
    const chosen = w.subs?.[n.productId];
    const sub = chosen ? { to: chosen, ratio: AV_SUBS[n.productId]?.to === chosen ? AV_SUBS[n.productId].ratio ?? 1 : 1 } : avSub(n.productId);
    if (!sub || sub.to === n.productId) continue;
    const have = avail(pool, n.productId, n.firstUse);
    const covered = Math.min(n.qty, Math.max(have, n.stockOnly));
    const rest = n.qty - covered;
    if (rest <= 0.01) continue;
    n.qty = covered;
    if (n.qty <= 0.01) needs.delete(n.productId);
    const t = needs.get(sub.to) ?? { productId: sub.to, qty: 0, uses: [], stockOnly: 0, firstUse: n.firstUse };
    t.qty += rest * (sub.ratio ?? 1);
    if (n.firstUse < t.firstUse) t.firstUse = n.firstUse;
    needs.set(sub.to, t);
  }
  return needs;
}

export interface WeekStep { cost: number; waste: string[]; wasteRub: number; usedLeftovers: string[]; buys: Map<string, number> }
const shortName = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[«,]/)[0].trim();
const qtyText = (pid: string, q: number) => {
  const p = PRODUCTS[pid];
  if (!p) return String(Math.round(q));
  if (p.unit === 'pcs') return `${Math.round(q)} шт.`;
  return p.unit === 'ml' ? `${Math.round(q)} мл` : q >= 1000 ? `${(Math.round(q / 100) / 10).toString().replace('.', ',')} кг` : `${Math.round(q)} г`;
};

/**
 * Неделя в прогнозе запасов: докупить недостающее упаковками (если закупка ещё не сделана), списать нужное
 * (сначала то, что раньше испортится), а скоропортящиеся остатки, которые не доживут до следующей закупки, —
 * в «пропадёт».
 */
export function stepWeek(data: AppData, w: WeekPlan, pool: Pool, nextShop: ISODate | null): WeekStep {
  const bought = shopBought(data, w);
  const shop = w.shopDate ?? weekFrom(w);
  const needs = needsWithSubs(data, w, pool);
  let cost = 0;
  const used: string[] = [];
  const buys = new Map<string, number>();
  for (const n of needs.values()) {
    const p = PRODUCTS[n.productId];
    if (!p) continue;
    const a = avail(pool, n.productId, n.firstUse);
    const fromLeft = (pool.get(n.productId) ?? []).filter((l) => l.src === 'buy' && l.until >= n.firstUse).reduce((s, l) => s + l.qty, 0);
    if (fromLeft > 0.5 && p.category !== 'Специи') used.push(`${shortName(n.productId)} ${qtyText(n.productId, Math.min(fromLeft, n.qty))}`);
    if (!bought) {
      const buyNeed = Math.max(0, n.qty - n.stockOnly - Math.max(0, a - n.stockOnly));
      if (buyNeed > 0.01) {
        const bi = buyInfo(n.productId);
        const size = bi.packSize || p.pack?.size || 0;
        const packs = size > 0 ? Math.ceil(buyNeed / size - 1e-9) : 0;
        const q = size > 0 ? packs * size : buyNeed;
        cost += size > 0 && bi.packPrice != null ? packs * bi.packPrice : buyNeed * unitPrice(n.productId);
        addLot(pool, n.productId, q, lotUntil(p, shop));
        buys.set(n.productId, q);
      }
    }
    take(pool, n.productId, n.qty, n.firstUse);
  }
  // что пропадёт до следующей закупки
  const waste: string[] = [];
  let wasteRub = 0;
  const horizon = nextShop ?? addDays(weekTo(w), 1);
  for (const [pid, lots] of pool) {
    if (!perishable(pid)) continue;
    const lost = lots.filter((l) => l.until < horizon && l.qty > 0.5 && l.src === 'buy' && l.until >= shop);
    const q = lost.reduce((s, l) => s + l.qty, 0);
    if (q <= 0.5) continue;
    const rub = q * unitPrice(pid);
    if (rub >= 20) { waste.push(`${shortName(pid)} ${qtyText(pid, q)} (≈${Math.round(rub)} ₽)`); wasteRub += rub; }
    for (const l of lost) l.qty = 0;
  }
  return { cost: Math.round(cost), waste, wasteRub: Math.round(wasteRub), usedLeftovers: used, buys };
}

/** Прогноз запасов к началу недели с датой готовки beforeCook: всё, что дома, плюс остатки закупок недель до неё. */
export function projectPool(data: AppData, today: ISODate, beforeCook: ISODate, skipId?: string): Pool {
  const pool = homePool(data, today);
  const trips = tripList(data);
  const weeks = weekList(weeklyOf(data)).filter((w) => w.id !== skipId && w.cookDate && w.cookDate < beforeCook && weekTo(w) >= today);
  for (let i = 0; i < weeks.length; i++) {
    const w = effectiveWeek(data, weeks[i], trips);
    stepWeek(data, w, pool, weeks[i + 1]?.shopDate ?? beforeCook);
  }
  return pool;
}

// ------------------------------------------------------------------ бюджет

export function homeDaysInMonth(data: AppData, ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  const n = daysInMonth(y, m);
  const trips = tripList(data);
  let home = 0;
  for (let d = 1; d <= n; d++) if (dayKind(data, `${ym}-${String(d).padStart(2, '0')}`, trips) !== 'trip') home++;
  return Math.max(1, home);
}
/** Доля месячного бюджета на приёмы (каждый приём — четверть дня; приёмы «из того, что есть» не считаются). */
export function slotsAllowance(data: AppData, slots: { date: ISODate }[]): number {
  const cache = new Map<string, number>();
  let sum = 0;
  for (const s of slots) {
    const ym = s.date.slice(0, 7);
    if (!cache.has(ym)) cache.set(ym, BUDGET_RUB / homeDaysInMonth(data, ym));
    sum += cache.get(ym)! / 4;
  }
  return Math.round(sum);
}
export function weekAllowance(data: AppData, w: Pick<WeekPlan, 'meals'>): number {
  const slots: { date: ISODate }[] = [];
  for (const [d, sl] of Object.entries(w.meals)) for (const m of Object.values(sl)) if (m && (m.r || m.src !== 'stock')) slots.push({ date: d });
  return slotsAllowance(data, slots);
}

export interface MonthBudget {
  month: string; budget: number;
  /** Куплено (по отметкам «Куплено», фактическая цена — если указана). */
  spent: number;
  /** Подтверждённые закупки, ещё не купленные. */
  confirmed: number;
  /** Оценка по неделям без подтверждённой закупки (прогноз запасов, упаковками). */
  forecast: number;
  left: number;
  weeks: { id: string; title: string; shopDate: ISODate; amount: number; kind: 'spent' | 'confirmed' | 'forecast' }[];
}
/** Бюджет месяца на домашнюю еду: куплено + подтверждённые закупки + прогноз по остальным неделям. */
export function monthBudget(data: AppData, month: string, today: ISODate): MonthBudget {
  const out: MonthBudget = { month, budget: BUDGET_RUB, spent: 0, confirmed: 0, forecast: 0, left: 0, weeks: [] };
  // закупки прежнего меню (до версии 2.0) в этом месяце
  for (const e of Object.values(data.shoppingEvents)) {
    if (!e.date.startsWith(month) || e.instanceId === 'weekly' || e.kind === 'trip') continue;
    for (const l of e.lines ?? []) {
      const c = data.shoppingChecks[`${e.id}:${l.productId}`];
      if (c?.bought) out.spent += c.actualPrice ?? l.cost;
    }
  }
  const trips = tripList(data);
  const weeks = weekList(weeklyOf(data));
  const pool = homePool(data, today);
  for (let i = 0; i < weeks.length; i++) {
    const w0 = weeks[i];
    const w = effectiveWeek(data, w0, trips);
    const inMonth = !!w.shopDate && w.shopDate.startsWith(month);
    const ev = `shop-weekly-${w.id}`;
    const pur = w.status === 'approved' && w.stockConfirmedAt ? w.purchase : null;
    if (weekTo(w) < today && !inMonth) continue;
    if (pur) {
      let bought = 0, open = 0;
      for (const l of pur.lines) {
        const c = data.shoppingChecks[`${ev}:${l.productId}`];
        if (c?.bought) bought += c.actualPrice ?? l.cost; else if (!c?.absent) open += l.cost;
      }
      // запасы для прогноза следующих недель: подтверждённая закупка
      if (weekTo(w) >= today) stepWeek(data, w, pool, weeks[i + 1]?.shopDate ?? null);
      if (!inMonth) continue;
      out.spent += bought; out.confirmed += open;
      out.weeks.push({ id: w.id, title: w.title, shopDate: w.shopDate!, amount: Math.round(bought + open), kind: open ? 'confirmed' : 'spent' });
      continue;
    }
    if (weekTo(w) < today) continue;
    const st = stepWeek(data, w, pool, weeks[i + 1]?.shopDate ?? null);
    if (!inMonth) continue;
    out.forecast += st.cost;
    out.weeks.push({ id: w.id, title: w.title, shopDate: w.shopDate!, amount: st.cost, kind: 'forecast' });
  }
  out.spent = Math.round(out.spent); out.confirmed = Math.round(out.confirmed); out.forecast = Math.round(out.forecast);
  out.left = out.budget - out.spent - out.confirmed - out.forecast;
  return out;
}

// ------------------------------------------------------------------ подбор: вспомогательное

/** Детерминированный «случайный» сдвиг: разные недели и варианты — разные блюда при равной оценке. */
function jitter(id: string, salt: string): number {
  let h = 2166136261;
  for (const ch of `${id}|${salt}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

/** Основные блюда в соседних неделях (±27 дней от дат цикла) и в прошедших днях: нельзя повторять. */
function nearbyMains(data: AppData, from: ISODate, to: ISODate, skipId?: string): Map<string, ISODate> {
  const out = recentMains(data, from, 28);
  for (const w of weekList(weeklyOf(data))) {
    if (w.id === skipId) continue;
    for (const [d, slots] of Object.entries(w.meals)) {
      if (d < addDays(from, -27) || d > addDays(to, 27)) continue;
      for (const s of ['lunch', 'dinner'] as MealSlot[]) { const m = slots[s]; if (m?.r && LIB[m.r]?.kind === 'main') out.set(m.r, d); }
    }
  }
  return out;
}
/** Когда блюдо было в меню последний раз (вся история и все недели): для чередования библиотеки. */
function lastUses(data: AppData): Map<string, ISODate> {
  const out = new Map<string, ISODate>();
  const note = (r: string, d: ISODate) => { if (!out.has(r) || out.get(r)! < d) out.set(r, d); };
  for (const day of Object.values(data.planDays)) for (const slot of MEAL_SLOTS) {
    for (const p of day.mealCards?.[slot]?.parts ?? []) if (p.dishId.startsWith('lib-')) note(p.dishId.slice(4), day.date);
  }
  for (const w of weekList(weeklyOf(data))) for (const [d, slots] of Object.entries(w.meals)) for (const m of Object.values(slots)) if (m?.r) note(m.r, d);
  return out;
}

/** Стоимость добавить рецепт (mult партий) к прогнозу запасов: новые упаковки по цене, остатки — дешевле. */
function marginalCost(pool: Pool, r: LibRecipe, mult: number, date: ISODate, commit = false): number {
  let cost = 0;
  for (const i of r.ingredients) {
    const pid = i.p;
    const p = PRODUCTS[pid];
    if (!p) continue;
    const q = gross(p, i.q * mult);
    const a = avail(pool, pid, date);
    const fromStock = Math.min(q, a);
    const buy = q - fromStock;
    // остаток скоропортящегося, который иначе пропадёт, — почти бесплатно; прочие запасы — по цене (их всё равно съедят позже)
    cost += fromStock * unitPrice(pid) * (perishable(pid) ? 0.1 : 0.7);
    if (buy > 0.01) {
      const bi = buyInfo(pid);
      const size = bi.packSize || p.pack?.size || 0;
      const packs = size > 0 ? Math.ceil(buy / size - 1e-9) : 0;
      cost += size > 0 && bi.packPrice != null ? packs * bi.packPrice : buy * unitPrice(pid);
      if (commit && size > 0) addLot(pool, pid, packs * size, lotUntil(p, date));
    }
    if (commit) take(pool, pid, q, date);
  }
  return cost;
}
/** Сколько ценного из запасов (скоропортящееся) рецепт использует — бонус в подборе. */
function perishableUse(pool: Pool, r: LibRecipe, mult: number, date: ISODate): number {
  let v = 0;
  for (const i of r.ingredients) {
    if (!perishable(i.p)) continue;
    const p = PRODUCTS[i.p];
    v += Math.min(gross(p, i.q * mult), avail(pool, i.p, date)) * unitPrice(i.p);
  }
  return v;
}

const FISH = ['белая рыба', 'жирная рыба', 'морепродукты', 'рыба'];
const MEAT_FISH = ['Мясо и птица', 'Рыба и морепродукты'];
/** Рецепт с заменой товара (нет на av.ru): лучше исходный; замена основного белка (кальмар → хек) — заметно хуже. */
function subPenalty(r: LibRecipe): number {
  const subs = libEff(r).subs;
  if (!subs.length) return 0;
  return subs.reduce((s, x) => s + (MEAT_FISH.includes(PRODUCTS[x.from]?.category ?? '') ? 2.5 : 0.6), 0);
}

// ------------------------------------------------------------------ раздача порций основных блюд

interface MainPick { r: LibRecipe; n: number }
interface Assigned { meals: Map<string, string>; ok: boolean; missing: number }
/**
 * Порции по обедам и ужинам: не одно блюдо в обед и ужин одного дня, не одно и то же в тот же приём подряд,
 * короткий срок хранения (рыба) — в первые дни, незамораживаемое — только пока хранится в холодильнике.
 */
function distribute(cycle: Cycle, picks: MainPick[]): Assigned {
  const left = new Map(picks.map((p) => [p.r.id, p.n]));
  const byId = new Map(picks.map((p) => [p.r.id, p.r]));
  const meals = new Map<string, string>();
  const slots = cycle.slots;
  let missing = 0;
  const days = (d: ISODate) => diffDays(d, cycle.cookDate);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const dd = days(s.date);
    const other = meals.get(`${s.date}|${s.slot === 'lunch' ? 'dinner' : 'lunch'}`);
    const prevSame = meals.get(`${addDays(s.date, -1)}|${s.slot}`);
    const prevSlot = i > 0 ? meals.get(`${slots[i - 1].date}|${slots[i - 1].slot}`) : undefined;
    let best: string | null = null, bestS = -Infinity;
    for (const [id, n] of left) {
      if (n <= 0) continue;
      const r = byId.get(id)!;
      const fridge = dd <= Math.min(3, r.storage.fridge_days);
      if (!fridge && !r.storage.freeze) continue;
      // сколько слотов ещё доступно этому блюду (незамораживаемому — только в сроке)
      const window = slots.slice(i).filter((x) => r.storage.freeze || days(x.date) <= Math.min(3, r.storage.fridge_days)).length;
      const urgency = window > 0 ? n / window : 99;
      let sc = urgency * 4;
      if (urgency >= 1) sc += 50;
      if (other === id) sc -= 12;
      if (prevSame === id) sc -= 5;
      if (prevSlot === id) sc -= 3;
      if (fridge) sc += (3 - Math.min(3, r.storage.fridge_days)) * 0.8;
      if (sc > bestS) { bestS = sc; best = id; }
    }
    if (!best) { missing++; continue; }
    left.set(best, left.get(best)! - 1);
    meals.set(`${s.date}|${s.slot}`, best);
  }
  return { meals, ok: missing === 0, missing };
}

// ------------------------------------------------------------------ черновик недели

export interface DraftOptions { now: string; today?: ISODate; exclude?: Set<string>; seed?: number; skipId?: string }

/**
 * Черновик недели по библиотеке (без ИИ): основные блюда, завтраки, перекусы и добавки под цели дня, бюджет и
 * остатки. Неделя всегда черновик; если что-то не сходится — список проблем (утвердить «как есть» можно только явно).
 */
export function draftWeek(data: AppData, cycle: Cycle, opts: DraftOptions): WeekPlan {
  const ws = weeklyOf(data);
  const prefs = prefsOf(data);
  const today = opts.today ?? opts.now.slice(0, 10);
  const seed = opts.seed ?? 0;
  const salt = `${cycle.cookDate}#${seed}`;
  const notes: string[] = [];
  const problems: string[] = [];
  const id = `w${cycle.cookDate.replace(/-/g, '')}`;
  const skipId = opts.skipId ?? id;
  const lastDate = [...cycle.slots, ...cycle.fresh].map((s) => s.date).sort().slice(-1)[0] ?? cycle.cookDate;
  const near = nearbyMains(data, cycle.cookDate, lastDate, skipId);
  const last = lastUses(data);
  const pool = projectPool(data, today, cycle.cookDate, skipId);
  const trips = tripList(data);
  const others = weekList(ws).filter((w) => w.id !== skipId).map((w) => effectiveWeek(data, w, trips));
  const ok = (r: LibRecipe) => libVerified(r) && !prefs[r.id]?.hidden && (prefs[r.id]?.rating ?? 3) > 2 && !opts.exclude?.has(r.id) && recipeAvail(r, data).ok;
  const pref = (r: LibRecipe) => (prefs[r.id]?.fav ? 2 : 0) + ((prefs[r.id]?.rating ?? 3) - 3) * 0.5;
  const novelty = (r: LibRecipe) => { const d = last.get(r.id); return d ? Math.min(3, Math.max(0, diffDays(cycle.cookDate, d)) / 28) * 0.5 : 1.5; };
  const N0 = cycle.slots.length;
  const allowance = slotsAllowance(data, [...cycle.slots, ...cycle.fresh]);

  // --- основные блюда
  let mains = LIB_RECIPES.filter((r) => r.kind === 'main' && r.servings >= 2 && ok(r) && !near.has(r.id));
  if (mains.length < 3) {
    const older = LIB_RECIPES.filter((r) => r.kind === 'main' && r.servings >= 2 && ok(r) && !mains.includes(r))
      .sort((a, b) => (near.get(a.id) ?? '').localeCompare(near.get(b.id) ?? ''));
    mains = [...mains, ...older.slice(0, 4 - mains.length)];
    problems.push('Подходящих основных блюд мало: часть повторяется раньше, чем через 4 недели. Замените блюдо или разрешите повтор.');
  }
  const base = new Map<string, number>();
  for (const r of mains) {
    const n = recipeN(r.id);
    const perServingCost = marginalCost(pool, r, 1, cycle.cookDate) / r.servings;
    const sc = pref(r) + novelty(r) + jitter(r.id, salt) * 1.2
      - Math.abs(n.kcal - 690) / 140 + (n.p >= 45 ? 0.5 : 0)
      - Math.max(0, (n.f * 9) / Math.max(1, n.kcal) - 0.35) * 12
      - Math.max(0, perServingCost - 230) / 90
      + perishableUse(pool, r, 1, cycle.cookDate) / 150
      + (r.servings >= 4 && r.servings <= 6 ? 0.5 : -0.5)
      + (r.tags.includes('заморозка') ? 0.3 : 0)
      - subPenalty(r);
    base.set(r.id, sc);
  }
  const cand = [...mains].sort((a, b) => base.get(b.id)! - base.get(a.id)!).slice(0, 18);
  type Opt = { r: LibRecipe; n: number; pen: number };
  const sizes = (r: LibRecipe): Opt[] => {
    const out: Opt[] = [{ r, n: r.servings, pen: 0 }];
    if (r.servings + 1 <= 6) out.push({ r, n: r.servings + 1, pen: 0.4 });
    if (r.servings - 1 >= 3) out.push({ r, n: r.servings - 1, pen: 0.4 });
    // короткий цикл (3–4 приёма): половина партии, чтобы в обед и ужин были разные блюда
    if (N0 <= 4 && r.servings >= 3) out.push({ r, n: 2, pen: 0.3 });
    if (r.storage.freeze && r.servings <= 3 && r.servings * 2 <= 6) out.push({ r, n: r.servings * 2, pen: 0.8 });
    return out;
  };
  const maxExtra = 1;
  const optCost = new Map<string, number>();
  const costOf = (o: Opt) => {
    const k = `${o.r.id}|${o.n}`;
    let c = optCost.get(k);
    if (c == null) { c = marginalCost(pool, o.r, o.n / o.r.servings, cycle.cookDate); optCost.set(k, c); }
    return c;
  };
  const kcalOf = new Map(cand.map((r) => [r.id, recipeN(r.id).kcal]));
  const ranked: { set: Opt[]; s: number }[] = [];
  const consider = (set: Opt[]) => {
    const sum = set.reduce((s, x) => s + x.n, 0);
    if (sum < N0 || sum > N0 + maxExtra) return;
    // перед командировкой лишняя порция — только если её можно заморозить
    if (cycle.beforeTrip && sum > N0 && !set.some((x) => x.r.storage.freeze)) return;
    const proteins = new Set(set.map((x) => x.r.protein));
    const fish = set.some((x) => FISH.includes(x.r.protein));
    const devices = new Set(set.flatMap((x) => x.r.equipment));
    const cuisines = new Set(set.map((x) => x.r.cuisine));
    const active = set.reduce((s, x) => s + x.r.time.active, 0);
    const kcal = set.reduce((s, x) => s + kcalOf.get(x.r.id)! * x.n, 0) / sum;
    const cost = set.reduce((s, x) => s + costOf(x), 0);
    let sc = set.reduce((s, x) => s + base.get(x.r.id)! - x.pen, 0)
      + proteins.size * 1.5 + (fish && N0 >= 6 ? 2 : 0) + devices.size * 0.5 + cuisines.size * 0.3
      - (sum - N0) * 0.7 - Math.max(0, active - 110) / 20 - Math.abs(kcal - 690) / 120
      - Math.max(0, cost - allowance * 0.65) / 400;
    if (set.length === 1 && N0 > 4) sc -= 3;
    if (set.length === 1 && N0 >= 3) sc -= 2;
    if (set.length === 3 && N0 <= 6) sc -= 1.5;
    ranked.push({ set, s: sc });
  };
  for (let i = 0; i < cand.length; i++) for (const a of sizes(cand[i])) {
    consider([a]);
    for (let j = i + 1; j < cand.length; j++) for (const b of sizes(cand[j])) {
      consider([a, b]);
      if (N0 >= 7) for (let k = j + 1; k < cand.length; k++) for (const c of sizes(cand[k])) consider([a, b, c]);
    }
  }
  ranked.sort((a, b) => b.s - a.s);
  let chosen: Opt[] = [];
  let assigned: Assigned | null = null;
  let bestQ = -Infinity;
  for (const x of ranked.slice(0, 60)) {
    const as = distribute(cycle, x.set.map((o) => ({ r: o.r, n: o.n })));
    if (!as.ok) continue;
    // качество раздачи: одно блюдо в обед и ужин одного дня, тот же приём подряд
    let dup = 0, rep = 0;
    for (const s of cycle.slots) {
      const id = as.meals.get(`${s.date}|${s.slot}`);
      if (s.slot === 'dinner' && as.meals.get(`${s.date}|lunch`) === id) dup++;
      if (as.meals.get(`${addDays(s.date, -1)}|${s.slot}`) === id) rep++;
    }
    const q = x.s - dup * 2 - rep * 0.6;
    if (q > bestQ) { bestQ = q; chosen = x.set; assigned = as; }
    if (q >= ranked[0].s - 0.01) break;
  }
  if (!assigned) {
    // ровно не сходится — всё, что есть, по порядку; недостающее — проблема с вариантами
    let sum = 0;
    for (const r of cand) { if (sum >= N0 || chosen.length >= 4) break; const n = Math.min(6, r.servings + 1); chosen.push({ r, n, pen: 0 }); sum += n; }
    assigned = distribute(cycle, chosen.map((o) => ({ r: o.r, n: o.n })));
    if (assigned.missing) problems.push(`Не хватает ${assigned.missing} порц. обедов и ужинов: в библиотеке нет подходящих блюд с нужным сроком хранения — замените блюдо или увеличьте партию.`);
  }
  const meals: WeekPlan['meals'] = {};
  const cook: WeekCookItem[] = chosen.map((x) => ({ r: x.r.id, servings: x.n, uses: [] }));
  for (const s of cycle.slots) {
    const rid = assigned.meals.get(`${s.date}|${s.slot}`);
    if (!rid) { (meals[s.date] ??= {})[s.slot] = { r: '', src: 'stock', title: 'Нужно выбрать блюдо', note: 'Порции не хватило — выберите вариант в разделе «Неделя».' }; continue; }
    const r = LIB[rid];
    const dd = diffDays(s.date, cycle.cookDate);
    const storage: 'fridge' | 'freeze' = dd <= Math.min(3, r.storage.fridge_days) ? 'fridge' : 'freeze';
    (meals[s.date] ??= {})[s.slot] = { r: rid, src: 'cook' };
    cook.find((c) => c.r === rid)!.uses.push({ date: s.date, slot: s.slot, storage, thawOn: storage === 'freeze' ? addDays(s.date, -1) : null });
  }
  for (const x of chosen) if (x.n !== x.r.servings) notes.push(`${x.r.title}: партия на ${x.n} порц. (в рецепте ${x.r.servings}) — граммовка пересчитана.`);
  const extra = cook.reduce((s, c) => s + c.servings - c.uses.length, 0);
  if (extra > 0) notes.push(`${extra} порц. сверх меню — в морозилку про запас.`);
  for (const x of chosen) marginalCost(pool, x.r, x.n / x.r.servings, cycle.cookDate, true);

  // --- завтраки, перекусы и добавки под КБЖУ дня
  const mainsOf = (date: ISODate): N => {
    let n = Z();
    for (const s of ['lunch', 'dinner'] as MealSlot[]) {
      const m = meals[date]?.[s] ?? weekMealAt(others, date, s);
      if (m?.r) n = plus(n, recipeN(m.r));
      else if (!m && dayKind(data, date, trips) === 'home') n = plus(n, MAIN_UNKNOWN);
    }
    return n;
  };
  const otherOf = (date: ISODate, slot: MealSlot): N | null => {
    const m = meals[date]?.[slot] ?? weekMealAt(others, date, slot);
    return m ? mealN(m) : null;
  };
  const usedB = new Map<string, ISODate>(), usedS = new Map<string, ISODate>();
  for (const w of others) for (const [d, sl] of Object.entries(w.meals)) {
    if (d > lastDate || d < addDays(cycle.cookDate, -10)) continue;
    if (sl.breakfast?.r && (!usedB.has(sl.breakfast.r) || usedB.get(sl.breakfast.r)! < d)) usedB.set(sl.breakfast.r, d);
    if (sl.snack?.r && (!usedS.has(sl.snack.r) || usedS.get(sl.snack.r)! < d)) usedS.set(sl.snack.r, d);
  }
  const freshSet = new Set(cycle.fresh.map((f) => `${f.date}|${f.slot}`));
  const dayFit = (n: N, roomForAddon: boolean): number => {
    let pen = 0;
    if (n.kcal > DAY_KCAL_MAX) pen += (n.kcal - DAY_KCAL_MAX) / 40;
    const low = roomForAddon ? DAY_KCAL - 420 : DAY_KCAL_MIN;
    if (n.kcal < low) pen += (low - n.kcal) / 60;
    pen += Math.abs(DAY_KCAL - (roomForAddon ? 120 : 0) - n.kcal) / 300;
    const pLow = roomForAddon ? DAY_PROTEIN_MIN - 20 : DAY_PROTEIN_MIN;
    if (n.p < pLow) pen += (pLow - n.p) / 5;
    if (n.kcal > 0 && (n.f * 9) / n.kcal > 0.36) pen += ((n.f * 9) / n.kcal - 0.36) * 30;
    return pen;
  };
  for (const f of [...cycle.fresh].sort((a, b) => a.date.localeCompare(b.date) || (a.slot === 'breakfast' ? -1 : 1))) {
    if (meals[f.date]?.[f.slot]) continue;
    const kind = f.slot === 'breakfast' ? 'breakfast' : 'snack';
    const used = kind === 'breakfast' ? usedB : usedS;
    const next = addDays(f.date, 1);
    const pairFree = freshSet.has(`${next}|${f.slot}`) && !meals[next]?.[f.slot];
    const weekend = isWeekend(f.date);
    let best: { r: LibRecipe; s: number; two: boolean } | null = null;
    for (const r of LIB_RECIPES) {
      if (r.kind !== kind || !ok(r)) continue;
      const two = r.servings >= 2 && pairFree;
      if (r.servings >= 2 && !two) continue; // вторую порцию некуда поставить
      const lastD = used.get(r.id);
      const gap = lastD ? diffDays(f.date, lastD) : 99;
      let s = pref(r) + jitter(r.id, `${salt}|${f.date}|${f.slot}`) * 1.5 - subPenalty(r);
      if (kind === 'breakfast') s += gap < 7 ? -15 : gap < 14 ? -3 : Math.min(gap, 30) / 30;
      else s += gap < 3 ? -15 : gap < 7 ? -2 : Math.min(gap, 14) / 14;
      s += r.tags.includes('дома') ? (weekend ? 1 : -5) : r.tags.includes('на работу') ? (weekend ? 0 : 1) : 0;
      // КБЖУ дня: обеды и ужины + этот приём + другой (уже выбранный или средний перекус)
      const own = recipeN(r.id);
      const dayN = (d: ISODate) => {
        let n = plus(mainsOf(d), own);
        const o = otherOf(d, kind === 'breakfast' ? 'snack' : 'breakfast');
        n = plus(n, o ?? (kind === 'breakfast' ? SNACK_AVG : { kcal: 560, p: 38, f: 18, c: 60 }));
        return n;
      };
      s -= dayFit(dayN(f.date), true) * 1.6;
      if (two) s -= dayFit(dayN(next), true) * 1.6;
      // цена: новые упаковки дороже, остатки — почти бесплатно
      s -= marginalCost(pool, r, two ? 1 : 1 / r.servings, f.date) / 90;
      s += perishableUse(pool, r, two ? 1 : 1 / r.servings, f.date) / 120;
      if (!best || s > best.s) best = { r, s, two };
    }
    if (!best) continue;
    const r = best.r;
    if (best.two) {
      (meals[f.date] ??= {})[f.slot] = { r: r.id, src: 'fresh', note: `Готовится ${r.servings} порции — вторая на завтра.` };
      (meals[next] ??= {})[f.slot] = { r: r.id, src: 'fresh', note: 'Вторая порция, приготовленная накануне.' };
      used.set(r.id, next);
    } else {
      (meals[f.date] ??= {})[f.slot] = { r: r.id, src: 'fresh' };
      used.set(r.id, f.date);
    }
    marginalCost(pool, r, best.two ? 1 : 1 / r.servings, f.date, true);
  }
  for (const g of cycle.gap) {
    if (meals[g.date]?.[g.slot]) continue;
    const afterTrip = dayKind(data, addDays(g.date, -1), trips) === 'trip';
    (meals[g.date] ??= {})[g.slot] = { r: '', src: 'stock', title: g.slot === 'lunch' ? 'Обед на работе или из того, что есть' : 'Из того, что есть дома', note: afterTrip ? 'День закупки после командировки: продукты привезут к вечеру.' : 'День закупки: продукты привезут к вечеру — до этого из того, что есть.' };
  }
  // добавки: дни, где завтрак и перекус — этой недели
  const freshDays = [...new Set(cycle.fresh.map((f) => f.date))].sort();
  let prevAdd: string[] = [];
  const addCount = new Map<string, number>();
  for (const d of freshDays) {
    let n = Z();
    for (const s of MEAL_SLOTS) {
      const m = meals[d]?.[s] ?? weekMealAt(others, d, s);
      if (m) n = plus(n, mealN(m));
      else if ((s === 'lunch' || s === 'dinner') && dayKind(data, d, trips) === 'home') n = plus(n, MAIN_UNKNOWN);
    }
    const add = pickAddons(n, pool, d, prevAdd, (slot) => !!meals[d]?.[slot], addCount);
    for (const a of add) addCount.set(a, (addCount.get(a) ?? 0) + 1);
    for (const a of add) {
      const slot = meals[d]?.[ADDON[a].slot] ? ADDON[a].slot : 'snack';
      const m = meals[d]?.[slot];
      if (!m) continue;
      m.add = [...(m.add ?? []), a];
      const p = PRODUCTS[ADDON[a].p];
      const q = gross(p, ADDON[a].q);
      if (avail(pool, ADDON[a].p, d) < q) {
        const bi = buyInfo(ADDON[a].p);
        const size = bi.packSize || p.pack.size;
        if (size) addLot(pool, ADDON[a].p, Math.ceil((q - avail(pool, ADDON[a].p, d)) / size - 1e-9) * size, lotUntil(p, d));
      }
      take(pool, ADDON[a].p, q, d);
    }
    prevAdd = add;
  }

  // --- проверка недели: КБЖУ дней, бюджет, морозилка
  const w: WeekPlan = {
    id, title: `Неделя с ${fmtShort(cycle.cookDate)}`, cookDate: cycle.cookDate, cookTime: ws?.cookTime ?? '17:00', shopDate: cycle.cookDate,
    status: 'draft', approvedAt: null, source: 'planner', meals, cook, stockConfirmedAt: null, notes, problems, createdAt: opts.now, seed,
  };
  const all = [...others, w].sort((a, b) => (a.cookDate ?? '').localeCompare(b.cookDate ?? ''));
  const badDays: string[] = [];
  for (const d of freshDays) {
    const dn = dayNutrition(data, d, all);
    if (!dn.complete) continue;
    if (!dn.ok) badDays.push(`${fmtShort(d)}: ${dn.kcal} ккал, Б ${dn.p} / Ж ${dn.f} г`);
  }
  if (badDays.length) problems.push(`Дни вне цели (${DAY_KCAL_MIN}–${DAY_KCAL_MAX} ккал, белок от ${DAY_PROTEIN_MIN} г, жиры до 40%): ${badDays.join('; ')}. Замените завтрак, перекус или блюдо.`);
  w.estimate = estimateWeek(data, w, today, opts.now);
  if (w.estimate.cost > w.estimate.allowance * 1.1) problems.push(`Закупка ≈${w.estimate.cost.toLocaleString('ru-RU')} ₽ — больше доли месячного бюджета на эти дни (≈${w.estimate.allowance.toLocaleString('ru-RU')} ₽). Варианты дешевле — в разделе «Меню».`);
  const frozen = cook.reduce((s, c) => s + c.uses.filter((u) => u.storage === 'freeze').length + Math.max(0, c.servings - c.uses.length), 0);
  const cap = ws?.freezer.capacity ?? null;
  if (frozen && cap == null) notes.push(`В морозилку пойдёт ${frozen} порц. (плоские пакеты на 1 л). Укажите свободное место в настройках — планировщик будет его учитывать.`);
  if (cap != null && frozen > cap) problems.push(`В морозилку нужно ${frozen} пакетов, а свободно ${cap}: замените одно блюдо на то, что хранится в холодильнике, или добавьте короткую готовку в середине недели.`);
  return w;
}

/** Добавки к дню: до двух простых продуктов, чтобы дотянуть ккал и белок; остатки упаковок — в первую очередь. */
function pickAddons(day: N, pool: Pool, date: ISODate, prev: string[], hasSlot: (s: MealSlot) => boolean, count: Map<string, number> = new Map()): string[] {
  const fit = (n: N) => {
    let pen = Math.abs(DAY_KCAL - n.kcal) / 80;
    if (n.kcal > 0 && (n.f * 9) / n.kcal > 0.36) pen += ((n.f * 9) / n.kcal - 0.36) * 25;
    if (n.kcal > DAY_KCAL_MAX) pen += (n.kcal - DAY_KCAL_MAX) / 25;
    if (n.kcal < DAY_KCAL_MIN) pen += (DAY_KCAL_MIN - n.kcal) / 40;
    pen += Math.max(0, DAY_PROTEIN_TARGET - n.p) / 6;
    if (n.p < DAY_PROTEIN_MIN) pen += (DAY_PROTEIN_MIN - n.p) / 3;
    return pen;
  };
  const f0 = fit(day);
  if (day.kcal >= DAY_KCAL_MIN && day.p >= DAY_PROTEIN_MIN) return [];
  const list = ADDONS.filter((a) => (buyInfo(a.p).status === 'listed' || avail(pool, a.p, date) > 0) && (hasSlot(a.slot) || hasSlot('snack')));
  const cost = (a: typeof ADDONS[number]) => {
    const p = PRODUCTS[a.p];
    const q = gross(p, a.q);
    const have = avail(pool, a.p, date);
    if (have >= q) return q * unitPrice(a.p) * (perishable(a.p) ? 0.1 : 0.7);
    const bi = buyInfo(a.p);
    // новая упаковка: её остаток доедается добавками следующих дней — считаем половину
    return (bi.packPrice ?? q * unitPrice(a.p)) * 0.5;
  };
  let best: string[] = [], bestF = f0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const often = (id: string) => (count.get(id) ?? 0) * 0.35;
    const fa = fit(plus(day, addonN(a.id))) + cost(a) / 120 + (prev.includes(a.id) ? 0.3 : 0) + often(a.id);
    if (fa < bestF) { bestF = fa; best = [a.id]; }
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (a.p === b.p || a.group === b.group) continue;
      const fb = fit(plus(plus(day, addonN(a.id)), addonN(b.id))) + (cost(a) + cost(b)) / 120 + (prev.includes(a.id) ? 0.3 : 0) + (prev.includes(b.id) ? 0.3 : 0) + 0.8 + often(a.id) + often(b.id);
      if (fb < bestF) { bestF = fb; best = [a.id, b.id]; }
    }
  }
  return best;
}

/** Оценка недели: стоимость упаковками по прогнозу запасов, доля бюджета, что пропадёт. */
export function estimateWeek(data: AppData, w: WeekPlan, today: ISODate, now: string): WeekEstimate {
  const ws = weeklyOf(data);
  const pool = projectPool(data, today, w.cookDate ?? weekFrom(w), w.id);
  const next = weekList(ws).filter((x) => x.id !== w.id && (x.cookDate ?? '') > (w.cookDate ?? '')).map((x) => x.shopDate).filter(Boolean).sort()[0] ?? null;
  const st = stepWeek(data, effectiveWeek(data, w), pool, next);
  return { cost: st.cost, allowance: weekAllowance(data, effectiveWeek(data, w)), waste: st.waste, wasteRub: st.wasteRub, usedLeftovers: st.usedLeftovers, at: now };
}

/** Что мешает считать меню полным сейчас (для утверждённых и черновиков): дни вне цели, порции, бюджет. */
export function weekIssues(data: AppData, w0: WeekPlan, today: ISODate): string[] {
  const w = effectiveWeek(data, w0);
  const out: string[] = [];
  const all = weekList(weeklyOf(data)).map((x) => (x.id === w.id ? w : effectiveWeek(data, x)));
  const bad: string[] = [];
  for (const d of Object.keys(w.meals).sort()) {
    if (d < today) continue;
    const dn = dayNutrition(data, d, all);
    if (dn.complete && !dn.ok) bad.push(`${fmtShort(d)}: ${dn.kcal} ккал, Б ${dn.p} / Ж ${dn.f} г`);
  }
  if (bad.length) out.push(`Дни вне цели (${DAY_KCAL_MIN}–${DAY_KCAL_MAX} ккал, белок от ${DAY_PROTEIN_MIN} г, жиры до 40%): ${bad.join('; ')}.`);
  const empty = Object.entries(w.meals).flatMap(([d, s]) => (['lunch', 'dinner'] as MealSlot[]).filter((x) => s[x] && !s[x]!.r && s[x]!.title === 'Нужно выбрать блюдо').map((x) => `${fmtShort(d)} ${x === 'lunch' ? 'обед' : 'ужин'}`));
  if (empty.length) out.push(`Нет блюда: ${empty.join(', ')}.`);
  return out;
}

// ------------------------------------------------------------------ варианты вместо «утвердить как есть»

export interface MainOption { r: LibRecipe; costDelta: number; kcal: number; p: number }
/** Замены основного блюда, отсортированные по экономии (для бюджета) — того же числа порций. */
export function cheaperMains(data: AppData, w: WeekPlan, recipeId: string, today: ISODate, limit = 4): MainOption[] {
  const cur = LIB[recipeId];
  const item = w.cook.find((c) => c.r === recipeId);
  if (!cur || !item) return [];
  const pool = projectPool(data, today, w.cookDate ?? weekFrom(w), w.id);
  const curCost = marginalCost(clonePool(pool), cur, item.servings / cur.servings, w.cookDate ?? weekFrom(w));
  const prefs = prefsOf(data);
  const near = nearbyMains(data, weekFrom(w), weekTo(w), w.id);
  const inWeek = new Set(w.cook.map((c) => c.r));
  const out: MainOption[] = [];
  for (const r of LIB_RECIPES) {
    if (r.kind !== 'main' || inWeek.has(r.id) || near.has(r.id) || prefs[r.id]?.hidden || (prefs[r.id]?.rating ?? 3) <= 2 || !libVerified(r) || !recipeAvail(r, data).ok) continue;
    // хранение: те же дни, что у текущего блюда
    const needFreeze = item.uses.some((u) => u.storage === 'freeze');
    if (needFreeze && !r.storage.freeze) continue;
    const c = marginalCost(clonePool(pool), r, item.servings / r.servings, w.cookDate ?? weekFrom(w));
    const n = recipeN(r.id);
    out.push({ r, costDelta: Math.round(c - curCost), kcal: Math.round(n.kcal), p: Math.round(n.p) });
  }
  return out.filter((x) => x.costDelta < -50).sort((a, b) => a.costDelta - b.costDelta).slice(0, limit);
}

// ------------------------------------------------------------------ командировки: подгонка недель

const covered = (weeks: WeekPlan[]) => {
  const set = new Set<string>();
  for (const w of weeks) for (const [d, sl] of Object.entries(w.meals)) for (const s of Object.keys(sl)) set.add(`${d}|${s}`);
  return set;
};

/**
 * Привести недели к календарю после изменения командировок или релакс-дней.
 * Черновики, которые задело изменение, пересобираются. В утверждённые недели добавляются освободившиеся дни:
 * порции той же готовки (если она ещё не сделана — партия больше), завтраки и перекусы. Приёмы на днях поездки
 * не удаляются — они не действуют, пока идёт поездка (см. effectiveWeek). Отмеченное и прошедшее не меняется.
 */
export function refitWeeks(data: AppData, today: ISODate, now: string): { ws: WeeklySettings; changed: string[]; notes: string[] } | null {
  const ws = weeklyOf(data);
  if (!ws) return null;
  const trips = tripList(data);
  const home = (d: ISODate) => dayKind(data, d, trips) === 'home';
  const list = weekList(ws);
  if (!list.length) return null;
  const lastEnd = list.reduce((m, w) => (weekTo(w) > m ? weekTo(w) : m), today);
  const start = today > ws.since ? today : addDays(ws.since, 1);
  const weeks: Record<string, WeekPlan> = { ...ws.weeks };
  const changed: string[] = [];
  const notes: string[] = [];
  const hasMarks = (w: WeekPlan) => cookDone(data, w) || shopBought(data, w) || Object.entries(w.meals).some(([d, sl]) => Object.keys(sl).some((s) => { const st = data.taskStatus[`meal:${d}:${s}`]?.status; return !!st && st !== 'planned'; }));
  // 1. черновики, задетые изменением, — убрать (пересоберутся)
  const nextCook = (w: WeekPlan) => list.filter((x) => (x.cookDate ?? '') > (w.cookDate ?? '')).map((x) => x.cookDate!).sort()[0] ?? null;
  const dropped: WeekPlan[] = [];
  for (const w of list) {
    if (w.status !== 'draft' || !w.cookDate || w.cookDate < start || hasMarks(w)) continue;
    const dates = Object.keys(w.meals);
    let hit = dates.some((d) => !home(d)) || !!trips.find((t) => t.from <= w.cookDate! && t.to >= w.cookDate!);
    // «после командировки», а командировки накануне больше нет
    if (!hit && dayKind(data, addDays(w.cookDate, -1), trips) !== 'trip') hit = Object.values(w.meals).some((sl) => Object.values(sl).some((m) => m && !m.r && /после командировки/.test(m.note ?? '')));
    if (!hit) {
      const end = nextCook(w) ?? addDays(weekTo(w), 1);
      const cov = covered(list.map((x) => effectiveWeek(data, x, trips)));
      for (const d of range(addDays(w.cookDate, 1), addDays(end, -1))) {
        if (home(d) && !['lunch', 'dinner'].every((s) => cov.has(`${d}|${s}`))) { hit = true; break; }
      }
    }
    if (hit) { dropped.push(w); delete weeks[w.id]; }
  }
  // 2. утверждённые недели: освободившиеся дни в их промежутке
  let cov = covered(Object.values(weeks).map((x) => effectiveWeek(data, x, trips)));
  for (const w0 of list) {
    if (w0.status !== 'approved' || !weeks[w0.id] || !w0.cookDate) continue;
    const ew = effectiveWeek(data, w0, trips);
    if (!ew.cookDate || weekTo(w0) < start) continue;
    // естественный промежуток недели по календарю: от готовки до следующего дня закупки или командировки
    const cyc = planCycles(data, ew.cookDate, lastEnd, ws.shopDay)[0];
    if (!cyc || cyc.cookDate !== ew.cookDate) continue;
    const free = [...cyc.slots, ...cyc.fresh].filter((x) => x.date >= start && !cov.has(`${x.date}|${x.slot}`))
      .sort((a, b) => a.date.localeCompare(b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot));
    if (!free.length) continue;
    const w = JSON.parse(JSON.stringify(w0)) as WeekPlan;
    const cooked = cookDone(data, w);
    const added: string[] = [];
    for (const f of free) {
      if (f.slot === 'lunch' || f.slot === 'dinner') {
        const dd = diffDays(f.date, w.cookDate!);
        const c = w.cook.filter((x) => LIB[x.r] && (dd <= Math.min(3, LIB[x.r].storage.fridge_days) || LIB[x.r].storage.freeze))
          .sort((a, b) => (b.servings - b.uses.length) - (a.servings - a.uses.length) || a.uses.length - b.uses.length)[0];
        const spare = c ? c.servings - c.uses.length : 0;
        if (c && (spare > 0 || (!cooked && c.servings < 7))) {
          if (spare <= 0) c.servings++;
          const storage: 'fridge' | 'freeze' = dd <= Math.min(3, LIB[c.r].storage.fridge_days) ? 'fridge' : 'freeze';
          c.uses.push({ date: f.date, slot: f.slot, storage, thawOn: storage === 'freeze' ? addDays(f.date, -1) : null });
          (w.meals[f.date] ??= {})[f.slot] = { r: c.r, src: 'cook', note: 'Добавлено после изменения поездки.' };
        } else {
          (w.meals[f.date] ??= {})[f.slot] = { r: '', src: 'stock', title: 'Нужно выбрать блюдо', note: 'День освободился после изменения поездки, а готовка уже сделана — выберите вариант.' };
        }
      } else {
        const r = simpleFresh(data, w, f.date, f.slot === 'breakfast' ? 'breakfast' : 'snack');
        (w.meals[f.date] ??= {})[f.slot] = r ? { r: r.id, src: 'fresh', note: 'Добавлено после изменения поездки.' } : { r: '', src: 'stock', title: 'Из того, что есть дома' };
      }
      added.push(f.date);
    }
    w.cook.sort((a, b) => a.r.localeCompare(b.r));
    for (const c of w.cook) c.uses.sort((a, b) => a.date.localeCompare(b.date) || (a.slot === 'lunch' ? -1 : 1));
    if (w.stockConfirmedAt) w.purchase = recalcPurchase(data, w) ?? w.purchase;
    weeks[w.id] = w;
    changed.push(w.id);
    const ds = [...new Set(added)].sort();
    notes.push(`${w.title}: добавлены освободившиеся дни ${fmtShort(ds[0])}–${fmtShort(ds[ds.length - 1])}${cooked ? '' : ' — партии готовки больше'}${w.stockConfirmedAt ? ', закупка пересчитана' : ''}.`);
    cov = covered(Object.values(weeks).map((x) => effectiveWeek(data, x, trips)));
  }
  // 3. непокрытые домашние дни до конца составленных недель — новыми черновиками
  const kept = Object.values(weeks);
  cov = covered(kept.map((x) => effectiveWeek(data, x, trips)));
  const gaps = range(start, lastEnd).filter((d) => home(d) && !['lunch', 'dinner'].every((s) => cov.has(`${d}|${s}`)));
  if (gaps.length || dropped.length) {
    let d: AppData = { ...data, settings: { ...data.settings, weekly: { ...ws, weeks } } };
    const from = gaps[0] ?? null;
    if (from) {
      for (const c of planCycles(d, from, lastEnd, ws.shopDay)) {
        const cv = covered(Object.values((weeklyOf(d) as WeeklySettings).weeks).map((x) => effectiveWeek(d, x, trips)));
        const cyc: Cycle = {
          ...c,
          slots: c.slots.filter((s) => !cv.has(`${s.date}|${s.slot}`)), fresh: c.fresh.filter((s) => !cv.has(`${s.date}|${s.slot}`)), gap: c.gap.filter((s) => !cv.has(`${s.date}|${s.slot}`)),
        };
        if (!cyc.slots.length) continue;
        const prev = dropped.find((x) => x.cookDate === c.cookDate);
        if (weeks[`w${c.cookDate.replace(/-/g, '')}`]) continue;
        const w = draftWeek(d, cyc, { now, today, seed: prev?.seed ?? 0 });
        weeks[w.id] = w;
        d = { ...d, settings: { ...d.settings, weekly: { ...ws, weeks } } };
        changed.push(w.id);
      }
    }
    if (dropped.length) notes.push(`Черновики пересобраны по новым датам: ${dropped.map((w) => w.title.replace('Неделя ', '')).join(', ')}.`);
  }
  if (!changed.length && !dropped.length) return null;
  return { ws: { ...ws, weeks }, changed, notes };
}

/** Завтрак или перекус для добавленного дня: без повторов за неделю, из проверенных и доступных. */
function simpleFresh(data: AppData, w: WeekPlan, date: ISODate, kind: 'breakfast' | 'snack'): LibRecipe | null {
  const prefs = prefsOf(data);
  const inWeek = new Set(Object.values(w.meals).flatMap((s) => Object.values(s).map((m) => m?.r)).filter(Boolean));
  const list = LIB_RECIPES.filter((r) => r.kind === kind && r.servings === 1 && !inWeek.has(r.id) && libVerified(r) && !prefs[r.id]?.hidden && (prefs[r.id]?.rating ?? 3) > 2 && recipeAvail(r, data).ok);
  return list.sort((a, b) => jitter(a.id, date) - jitter(b.id, date))[0] ?? null;
}

// ------------------------------------------------------------------ пересчёт записей (с подгонкой недель)

/** Пересчёт записей недельного цикла: сначала недели подгоняются к календарю, затем — дни, готовки, закупки. */
export function weeklyReplanAll(data: AppData, today: ISODate, opts: { overwriteMarked?: boolean; from?: ISODate; now?: string } = {}): ReplanResult {
  const fit = refitWeeks(data, today, opts.now ?? `${today}T12:00:00.000Z`);
  const settingsOps: Op[] = fit ? [{ store: 'settings', put: { ...data.settings, weekly: fit.ws } }] : [];
  const d2: AppData = fit ? { ...data, settings: { ...data.settings, weekly: fit.ws } } : data;
  // закупки подтверждённых недель — по новому меню (если что-то изменилось)
  const ws2 = weeklyOf(d2)!;
  let ws3 = ws2;
  for (const w of weekList(ws2)) {
    if (!w.stockConfirmedAt || !w.purchase || w.status !== 'approved' || weekTo(w) < today) continue;
    const p = recalcPurchase(d2, w);
    if (p && JSON.stringify(p) !== JSON.stringify(w.purchase)) ws3 = { ...ws3, weeks: { ...ws3.weeks, [w.id]: { ...w, purchase: p } } };
  }
  const ops2: Op[] = ws3 !== ws2 ? [{ store: 'settings', put: { ...d2.settings, weekly: ws3 } }] : settingsOps;
  const d3: AppData = ws3 !== ws2 ? { ...d2, settings: { ...d2.settings, weekly: ws3 } } : d2;
  const rp = weeklyReplanOps(d3, today, opts);
  if (fit) rp.instance.issues.push(...fit.notes.map((text) => ({ level: 'info', text })) as typeof rp.instance.issues);
  return { ...rp, ops: [...ops2, ...rp.ops] };
}
setWeeklyHook((data, today, opts) => (weeklyOf(data) ? weeklyReplanAll(data, today, opts) : null));

