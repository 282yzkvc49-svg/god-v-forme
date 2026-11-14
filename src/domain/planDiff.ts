// Предпросмотр изменений плана перед подтверждением: командировка, релакс-день, дата старта.
import type { Op } from '../state/idb';
import type { AppData, MealSlot, Trip } from '../state/types';
import { MEAL_SLOTS } from '../state/types';
import { applyOps } from '../state/model';
import { addDays, fmtShort, type ISODate } from '../lib/dates';
import { DISHES } from './catalog';
import { hasDayMarks, replanOps, type PlanInstance } from './plan';
import { scheduledTraining } from './tasks';
import { monthKey, relaxDateOfMonth, tripDates, tripList, tripOn } from './trips';

export interface CookChange { title: string; text: string }
export interface TrainingChange { date: ISODate; before: string; after: string }

export interface PlanDiff {
  ops: Op[];
  after: AppData;
  instance: PlanInstance | null;
  homeMealsBefore: number;
  homeMealsAfter: number;
  replacedMeals: Record<MealSlot, number>;
  cookChanges: CookChange[];
  frozenBefore: number;
  frozenAfter: number;
  costBefore: number;
  costAfter: number;
  tripCostAfter: number;
  trainings: TrainingChange[];
  conflicts: {
    relax: ISODate[];
    markedDays: ISODate[];
    trainingLogs: ISODate[];
    doneEvents: string[];
  };
}

function homeMeals(data: AppData): number {
  let n = 0;
  for (const d of Object.values(data.planDays)) if (d.mealCards && !d.tripId) n += 4;
  return n;
}

function frozen(data: AppData): number {
  let n = 0;
  for (const e of Object.values(data.cookingEvents)) for (const it of e.items ?? []) n += it.uses.filter((u) => u.storage === 'freeze').length;
  return n;
}

function homeCost(data: AppData): { home: number; trip: number } {
  let home = 0, trip = 0;
  for (const e of Object.values(data.shoppingEvents)) {
    if (data.settings.plan && e.instanceId !== data.settings.plan.instanceId) continue;
    const c = (e.lines ?? []).reduce((s, l) => s + l.cost, 0);
    if (e.kind === 'trip') trip += c; else home += c;
  }
  return { home, trip };
}

function portions(e: AppData['cookingEvents'][string]): string {
  return (e.items ?? []).filter((i) => DISHES[i.dishId]?.unit === 'portion').map((i) => `${DISHES[i.dishId].short} ×${i.qty}`).join(', ');
}

function trainingLabel(data: AppData, date: ISODate): string {
  const t = scheduledTraining(data, date);
  return t ? t.label : '—';
}

/**
 * Что изменится, если применить ops (командировка, релакс-день) и пересобрать план.
 * focus — даты, где искать конфликты (дни поездки).
 */
export function previewChange(data: AppData, changeOps: Op[], today: ISODate, focus: ISODate[]): PlanDiff {
  const mid = applyOps(data, changeOps);
  const cfg = mid.settings.plan;
  const rp = cfg ? replanOps(mid, cfg, today) : null;
  const ops = [...changeOps, ...(rp?.ops ?? [])];
  const after = applyOps(data, ops);
  const replaced = { breakfast: 0, lunch: 0, snack: 0, dinner: 0 } as Record<MealSlot, number>;
  for (const date of focus) {
    const b = data.planDays[date];
    const a = after.planDays[date];
    if (b?.mealCards && a?.tripId) for (const s of MEAL_SLOTS) replaced[s]++;
  }
  const cookChanges: CookChange[] = [];
  const ids = new Set([...Object.keys(data.cookingEvents), ...Object.keys(after.cookingEvents)]);
  for (const id of ids) {
    const b = data.cookingEvents[id];
    const a = after.cookingEvents[id];
    if (b && b.date < today) continue;
    if (!a && b && b.source === 'seed') { cookChanges.push({ title: `${b.title} ${fmtShort(b.date)}`, text: `не нужна (${portions(b) || 'гарниры'})` }); continue; }
    if (a && !b) { cookChanges.push({ title: `${a.title} ${fmtShort(a.date)}, ${a.time}`, text: `новая: ${portions(a) || 'гарниры'}` }); continue; }
    if (!a || !b) continue;
    const parts: string[] = [];
    if (a.date !== b.date || a.time !== b.time) parts.push(`переносится с ${fmtShort(b.date)} ${b.time ?? ''} на ${fmtShort(a.date)} ${a.time ?? ''}`.replace(/ +/g, ' '));
    const pb = portions(b), pa = portions(a);
    if (pb !== pa) parts.push(`порции: ${pb || '—'} → ${pa || '—'}`);
    const fb = (b.items ?? []).reduce((n, i) => n + i.uses.filter((u) => u.storage === 'freeze').length, 0);
    const fa = (a.items ?? []).reduce((n, i) => n + i.uses.filter((u) => u.storage === 'freeze').length, 0);
    if (fa !== fb) parts.push(`в морозилку: ${fb} → ${fa}`);
    if (parts.length) cookChanges.push({ title: `${a.title} ${fmtShort(a.date)}`, text: parts.join('; ') });
  }
  const trainings: TrainingChange[] = [];
  if (focus.length) {
    const from = focus[0];
    const to = addDays(focus[focus.length - 1], 7);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const before = trainingLabel(data, d);
      const aft = trainingLabel(after, d);
      if (before !== aft) trainings.push({ date: d, before, after: aft });
    }
  }
  const relax: ISODate[] = [];
  const months = Array.from(new Set(focus.map(monthKey)));
  for (const ym of months) {
    const r = relaxDateOfMonth(after.settings, ym);
    if (focus.includes(r) && tripOn(tripList(after), r)) relax.push(r);
  }
  const markedDays = focus.filter((d) => hasDayMarks(data, d));
  const trainingLogs = focus.filter((d) => data.trainingLogs[`train:${d}`]);
  const doneEvents: string[] = [];
  for (const e of Object.values(data.cookingEvents)) if (focus.includes(e.date) && data.taskStatus[`cook:${e.id}`]?.status === 'done') doneEvents.push(`Готовка ${fmtShort(e.date)} (выполнена)`);
  for (const e of Object.values(data.shoppingEvents)) if (focus.includes(e.date) && data.taskStatus[`shop:${e.id}`]?.status === 'done') doneEvents.push(`Закупка ${fmtShort(e.date)} (выполнена)`);
  const cb = homeCost(data), ca = homeCost(after);
  return {
    ops, after, instance: rp?.instance ?? null,
    homeMealsBefore: homeMeals(data), homeMealsAfter: homeMeals(after), replacedMeals: replaced, cookChanges,
    frozenBefore: frozen(data), frozenAfter: frozen(after),
    costBefore: cb.home, costAfter: ca.home, tripCostAfter: ca.trip, trainings,
    conflicts: { relax, markedDays, trainingLogs, doneEvents },
  };
}

export function tripOps(trip: Trip | null, removeId: string | null): Op[] {
  const ops: Op[] = [];
  if (removeId && (!trip || trip.id !== removeId)) ops.push({ store: 'trips', del: removeId });
  if (trip) ops.push({ store: 'trips', put: trip });
  return ops;
}

export { tripDates };
