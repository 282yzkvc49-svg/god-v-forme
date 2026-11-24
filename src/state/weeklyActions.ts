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
  computePurchase, draftWeek, planCycles, prefsOf, replaceInWeek, setRemainingOps, shopEventId, weekPurchase, weeklyOf, weeklyReplanOps,
  type RecipePref, type WeekPlan, type WeeklySettings,
} from '../domain/weekly';

function commitWeekly(build: (data: AppData) => Op[]): Promise<string[]> {
  const data = getData();
  const ops = build(data);
  if (!ops.length) return Promise.resolve([]);
  const mid = applyToData(data, ops);
  const rp = weeklyReplanOps(mid, todayFn());
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

export function approveWeek(id: string) {
  return updateWeek(id, (w) => ({ ...w, status: 'approved', approvedAt: nowStamp() }));
}

export function replaceDish(id: string, oldId: string, newId: string, at?: { date: ISODate; slot: MealSlot }) {
  return updateWeek(id, (w) => replaceInWeek(w, oldId, newId, at));
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
    const drafted = draftWeek({ ...data, settings: { ...data.settings, weekly: { ...ws, weeks: Object.fromEntries(Object.entries(ws.weeks).filter(([k]) => k !== id)) } } }, cyc, { now: nowStamp() });
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
    if (w.stockConfirmedAt && w.purchase) next.purchase = computePurchase(data, next);
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
        const w = draftWeek(d, c, { now: nowStamp() });
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
      const w = draftWeek(d, c, { now: nowStamp() });
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
