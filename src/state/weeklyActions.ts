// Версия 2.0: действия недельного цикла и библиотеки рецептов. Каждое изменение недели пересчитывает
// записи с сегодняшнего дня (прошедшее и отмеченное не меняется).
import { commit, getData } from './store';
import type { Op } from './idb';
import type { AppData, MealSlot, ShoppingCheck, StockRec } from './types';
import { applyOps as applyToData } from './model';
import { today as todayFn } from '../lib/clock';
import { nowStamp } from '../lib/util';
import type { ISODate } from '../lib/dates';
import { emptyStock } from '../domain/stock';
import {
  computePurchase, planCycles, prefsOf, recalcPurchase, replaceInWeek, setRemainingOps, shopEventId, weekPurchase, weeklyOf,
  type RecipePref, type WeekPlan, type WeeklySettings,
} from '../domain/weekly';
import { draftWeek, weekIssues, weeklyReplanAll } from '../domain/weekPlanner';

function commitWeekly(build: (data: AppData) => Op[]): Promise<string[]> {
  const data = getData();
  const ops = build(data);
  if (!ops.length) return Promise.resolve([]);
  const mid = applyToData(data, ops);
  const rp = weeklyReplanAll(mid, todayFn(), { now: nowStamp() });
  return commit([...ops, ...rp.ops]).then(() => rp.conflicts ?? []);
}

function putWeekly(data: AppData, ws: WeeklySettings): Op {
  return { store: 'settings', put: { ...data.settings, weekly: ws } };
}

export function updateWeek(id: string, fn: (w: WeekPlan) => WeekPlan) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    const w = ws?.weeks[id];
    if (!ws || !w) return [];
    return [putWeekly(data, { ...ws, weeks: { ...ws.weeks, [id]: fn(w) } })];
  });
}

/** Утвердить меню. Если есть нерешённые проблемы (порции, КБЖУ дней, бюджет) — только с явным подтверждением accept. */
export function approveWeek(id: string, accept = false): Promise<string[]> {
  const data = getData();
  const w = weeklyOf(data)?.weeks[id];
  if (!w) return Promise.resolve([]);
  const issues = [...weekIssues(data, w, todayFn()), ...(w.problems ?? []).filter((p) => /бюджет|морозилк|повторяется/.test(p))];
  if (issues.length && !accept) return Promise.resolve(issues);
  return updateWeek(id, (x) => ({ ...x, status: 'approved', approvedAt: nowStamp(), acceptedProblems: issues.length ? issues : null })).then(() => []);
}

/** Заменить блюдо: меню, порции, хранение и разморозка, КБЖУ дней пересчитываются; закупка — по подтверждённым запасам. */
export function replaceDish(id: string, oldId: string, newId: string, at?: { date: ISODate; slot: MealSlot }) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    const w = ws?.weeks[id];
    if (!ws || !w) return [];
    const next = replaceInWeek(w, oldId, newId, at);
    const mid = applyToData(data, [putWeekly(data, { ...ws, weeks: { ...ws.weeks, [id]: next } })]);
    const purchase = recalcPurchase(mid, next);
    const fixed: WeekPlan = { ...next, ...(purchase ? { purchase } : {}), problems: w.status === 'draft' ? weekIssues(mid, next, todayFn()) : next.problems };
    return [putWeekly(data, { ...ws, weeks: { ...ws.weeks, [id]: fixed } })];
  });
}

/** Время доставки в день закупки (ЧЧ:ММ) или null — не подтверждено. */
export function setDelivery(id: string, time: string | null) {
  return updateWeek(id, (w) => ({ ...w, delivery: { time, note: w.delivery?.note ?? null } }));
}

/** Доставка поздно: ужин дня готовки — из того, что есть; его порция остаётся запасом в морозилке. */
export function lateDinner(id: string) {
  return updateWeek(id, (w) => {
    if (!w.cookDate) return w;
    const m = w.meals[w.cookDate]?.dinner;
    if (!m || m.src !== 'cook') return w;
    const meals = { ...w.meals, [w.cookDate]: { ...w.meals[w.cookDate], dinner: { r: '', src: 'stock' as const, title: 'Из того, что есть дома', note: 'Доставка поздно — ужин из того, что есть; порция готовки — в морозилку про запас.' } } };
    const cook = w.cook.map((c) => (c.r === m.r ? { ...c, uses: c.uses.filter((u) => !(u.date === w.cookDate && u.slot === 'dinner')) } : c));
    return { ...w, meals, cook };
  });
}

/** Пересобрать черновик недели планировщиком (утверждённую неделю — только после явного «Пересобрать»). */
export function redraftWeek(id: string) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    const w = ws?.weeks[id];
    if (!ws || !w || !w.cookDate) return [];
    const next = Object.values(ws.weeks).map((x) => x.cookDate).filter((d): d is string => !!d && d > w.cookDate!).sort()[0];
    const to = next ? next : Object.keys(w.meals).sort().slice(-1)[0];
    const cyc = planCycles(data, w.cookDate, to, ws.shopDay).find((c) => c.cookDate === w.cookDate);
    if (!cyc) return [];
    const drafted = draftWeek({ ...data, settings: { ...data.settings, weekly: { ...ws, weeks: Object.fromEntries(Object.entries(ws.weeks).filter(([k]) => k !== id)) } } }, cyc, { now: nowStamp(), today: todayFn(), seed: (w.seed ?? 0) + 1, skipId: id });
    return [putWeekly(data, { ...ws, weeks: { ...ws.weeks, [id]: { ...drafted, id, title: w.title } } })];
  });
}

/** Подтвердить фактические запасы к закупке недели: остатки записываются в учёт, закупка считается заново. */
export function confirmWeekStock(id: string, amounts: Record<string, number>, opened: Record<string, ISODate | null> = {}) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    const w = ws?.weeks[id];
    if (!ws || !w) return [];
    const now = nowStamp();
    const today = todayFn();
    const ops: Op[] = [];
    let cur = data;
    for (const [pid, qty] of Object.entries(amounts)) {
      const more = setRemainingOps(cur, pid, qty, now, today, 'Проверено перед закупкой недели');
      if (opened[pid] !== undefined && more[0] && 'put' in more[0]) (more[0].put as StockRec).openedOn = opened[pid];
      ops.push(...more);
      cur = applyToData(cur, more);
    }
    const ws2 = weeklyOf(cur)!;
    const confirmed = { ...w, stockConfirmedAt: now };
    ops.push(putWeekly(cur, { ...ws2, weeks: { ...ws2.weeks, [id]: { ...confirmed, purchase: computePurchase(cur, confirmed) } } }));
    return ops;
  });
}

/** Сбросить подтверждение запасов (например, если что-то съели или выбросили до закупки). */
export function resetWeekStock(id: string) {
  return updateWeek(id, (w) => ({ ...w, stockConfirmedAt: null, purchase: null }));
}

/** Строка закупки: куплено (поступает в запасы), нет в магазине, фактическая цена. */
export function setWeekLine(weekId: string, productId: string, patch: { bought?: boolean; absent?: boolean; actualPrice?: number | null }) {
  const data = getData();
  const w = weeklyOf(data)?.weeks[weekId];
  if (!w) return Promise.resolve();
  const eventId = shopEventId(w);
  const id = `${eventId}:${productId}`;
  const prev: ShoppingCheck | undefined = data.shoppingChecks[id];
  const now = nowStamp();
  const next: ShoppingCheck = {
    id, eventId, itemId: productId, bought: prev?.bought ?? false, atHome: false, absent: prev?.absent ?? false, actualPrice: prev?.actualPrice ?? null, updatedAt: now,
    ...patch,
  };
  if (patch.bought) next.absent = false;
  if (patch.absent) next.bought = false;
  const ops: Op[] = [{ store: 'shoppingChecks', put: next }];
  // купленное — в запасы (одним движением на строку); снятая галочка — убирает его
  const line = weekPurchase(data, w).lines.find((l) => l.productId === productId);
  const rec: StockRec = data.stock[productId] ?? emptyStock(productId, now);
  const moveId = `buy-${eventId}-${productId}`;
  const moves = rec.moves.filter((m) => m.id !== moveId);
  if (next.bought && line) moves.push({ id: moveId, date: todayFn(), kind: 'purchase', qty: line.buy, source: `shop:${eventId}`, note: 'Закупка недели', confirmed: true, at: now });
  if (next.bought !== (prev?.bought ?? false)) ops.push({ store: 'stock', put: { ...rec, moves, updatedAt: now } });
  return commit(ops);
}

/** Замена товара на эту неделю (его нет в магазине): закупка и КБЖУ дней пересчитываются; null — отменить. */
export function setWeekSub(weekId: string, productId: string, to: string | null) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    const w = ws?.weeks[weekId];
    if (!ws || !w) return [];
    const subs = { ...(w.subs ?? {}) };
    if (to) subs[productId] = to; else delete subs[productId];
    const next: WeekPlan = { ...w, subs };
    if (w.stockConfirmedAt && w.purchase) next.purchase = recalcPurchase(data, next) ?? computePurchase(data, next);
    return [putWeekly(data, { ...ws, weeks: { ...ws.weeks, [weekId]: next } })];
  });
}

export function setWeeklySettings(patch: Partial<Pick<WeeklySettings, 'shopDay' | 'cookTime'>> & { freezerCapacity?: number | null }) {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    if (!ws) return [];
    const next: WeeklySettings = {
      ...ws, ...(patch.shopDay ? { shopDay: patch.shopDay } : {}), ...(patch.cookTime ? { cookTime: patch.cookTime } : {}),
      ...(patch.freezerCapacity !== undefined ? { freezer: { capacity: patch.freezerCapacity } } : {}),
    };
    // день закупки изменился — черновики будущих недель пересобираются, утверждённые недели не трогаются
    if (patch.shopDay && patch.shopDay !== ws.shopDay) {
      const today = todayFn();
      const keep = Object.fromEntries(Object.entries(ws.weeks).filter(([, w]) => w.status === 'approved' || (w.cookDate ?? '') < today));
      const lastKept = Object.values(keep).flatMap((w) => Object.keys(w.meals)).sort().slice(-1)[0] ?? today;
      let d: AppData = { ...data, settings: { ...data.settings, weekly: { ...next, weeks: keep } } };
      const start = lastKept >= today ? lastKept : today;
      for (const c of planCycles(d, start, addDaysLocal(start, 34), patch.shopDay)) {
        if (c.cookDate <= lastKept && Object.values(keep).some((w) => w.cookDate === c.cookDate)) continue;
        const w = draftWeek(d, c, { now: nowStamp(), today });
        d = { ...d, settings: { ...d.settings, weekly: { ...(weeklyOf(d) as WeeklySettings), weeks: { ...(weeklyOf(d) as WeeklySettings).weeks, [w.id]: w } } } };
      }
      return [putWeekly(data, weeklyOf(d) as WeeklySettings)];
    }
    return [putWeekly(data, next)];
  });
}
function addDaysLocal(d: ISODate, n: number): ISODate {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Составить черновики недель до горизонта (для дней без меню). */
export function draftMissingWeeks() {
  return commitWeekly((data) => {
    const ws = weeklyOf(data);
    if (!ws) return [];
    const today = todayFn();
    const covered = new Set(Object.values(ws.weeks).flatMap((w) => Object.keys(w.meals)));
    let d = data;
    const start = Object.values(ws.weeks).flatMap((w) => Object.keys(w.meals)).sort().slice(-1)[0] ?? today;
    const from = start > today ? start : today;
    for (const c of planCycles(d, from, addDaysLocal(from, 28), ws.shopDay)) {
      if (c.slots.every((x) => covered.has(x.date))) continue;
      const w = draftWeek(d, c, { now: nowStamp(), today });
      d = { ...d, settings: { ...d.settings, weekly: { ...(weeklyOf(d) as WeeklySettings), weeks: { ...(weeklyOf(d) as WeeklySettings).weeks, [w.id]: w } } } };
    }
    return [putWeekly(data, weeklyOf(d) as WeeklySettings)];
  });
}

export function markWeeklyReportSeen() {
  const data = getData();
  const ws = weeklyOf(data);
  if (!ws?.reportUnseen) return Promise.resolve();
  return commit([putWeekly(data, { ...ws, reportUnseen: false })]);
}

// ------------------------------------------------------------------ библиотека: избранное, оценки, «больше не предлагать»

export function setRecipePref(id: string, patch: Partial<Omit<RecipePref, 'at'>>) {
  const data = getData();
  const prefs = prefsOf(data);
  const next = { ...prefs, [id]: { ...prefs[id], ...patch, at: nowStamp() } };
  return commit([{ store: 'settings', put: { ...data.settings, recipePrefs: next } }]);
}
