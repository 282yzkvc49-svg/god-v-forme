// Перенос командировки как миграция данных: резервная копия, пересчёт с сегодняшнего дня только того,
// что затронуто (дни, готовки, закупки, тренировки), отчёт. Прошедшее и купленное не меняется;
// если перенос задевает уже отмеченное пользователем — только после подтверждения.
import type { Op } from '../state/idb';
import type { AppData, BackupRec, ShoppingEvent, Trip, TripMoveReport } from '../state/types';
import { applyOps, dataToStores } from '../state/model';
import { addDays, fmtShort, type ISODate } from '../lib/dates';
import { PRODUCTS } from './catalog';
import { buyText, replanOps } from './plan';
import { previewChange, tripOps } from './planDiff';
import { tripDates, tripList } from './trips';

/** 20.11.2026: командировка в Санкт-Петербург перенесена с 24–25.11 на 25–26.11 (включительно). */
export const SPB_MOVE = {
  city: 'Санкт-Петербург',
  before: { from: '2026-11-24', to: '2026-11-25' },
  after: { from: '2026-11-25', to: '2026-11-26' },
} as const;

/** Командировка в Санкт-Петербург с прежними датами (если пользователь её ещё не менял). */
export function spbTripToMove(data: AppData): Trip | null {
  return tripList(data).find((t) => /петербург/i.test(t.city) && t.from === SPB_MOVE.before.from && t.to === SPB_MOVE.before.to) ?? null;
}

export interface TripMove {
  trip: Trip;
  moved: Trip;
  ops: Op[];
  after: AppData;
  report: TripMoveReport;
  /** Что уже отмечено и изменится — нужно подтверждение. */
  conflicts: string[];
}

const short = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const rub = (x: number) => `≈${Math.round(x).toLocaleString('ru-RU')} ₽`;
const cost = (e: ShoppingEvent) => (e.lines ?? []).reduce((s, l) => s + l.cost, 0);

function dayText(d: AppData, date: ISODate): string {
  const p = d.planDays[date];
  if (!p) return '—';
  if (p.tripId) {
    const t = d.trips[p.tripId];
    return `командировка${t ? ` (${t.city})` : ''}: ${t?.hotelBreakfast ? 'завтрак в гостинице' : 'завтрак из супермаркета или кафе'}, обед и ужин — кафе или доставка, перекус из супермаркета`;
  }
  if (p.relax) return 'релакс-день';
  if (!p.mealCards) return Object.values(p.meals ?? {}).join('; ') || '—';
  const slot = (s: 'lunch' | 'dinner') => {
    const c = p.mealCards![s];
    const frozen = c.parts.some((x) => x.storage === 'freeze');
    return `${c.title}${frozen ? ' (из морозилки)' : ''}`;
  };
  return `дома: обед — ${slot('lunch')}; ужин — ${slot('dinner')}`;
}

function shopChanges(before: AppData, after: AppData, today: ISODate): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const ids = new Set([...Object.keys(before.shoppingEvents), ...Object.keys(after.shoppingEvents)]);
  const list = Array.from(ids).map((id) => ({ b: before.shoppingEvents[id], a: after.shoppingEvents[id] }))
    .filter(({ a, b }) => (a ?? b)!.date >= today || (b && b.date >= today))
    .filter(({ a, b }) => JSON.stringify(a) !== JSON.stringify(b))
    .sort((x, y) => (x.a ?? x.b)!.date.localeCompare((y.a ?? y.b)!.date));
  for (const { a, b } of list) {
    if (b && !a) { out.push({ title: `${fmtShort(b.date)} ${b.title}`, text: `не нужна: её продукты — в других закупках (${rub(cost(b))} убрано)` }); continue; }
    if (a && !b) { out.push({ title: `${fmtShort(a.date)} ${a.title}`, text: `новая: ${(a.lines ?? []).filter((l) => l.buy > 0).map((l) => `${short(l.productId)} — ${buyText(l)}`).join('; ')} (${rub(cost(a))})` }); continue; }
    const parts: string[] = [];
    if (a!.date !== b!.date) parts.push(`переносится с ${fmtShort(b!.date)} на ${fmtShort(a!.date)}`);
    const lb = new Map((b!.lines ?? []).map((l) => [l.productId, l]));
    const la = new Map((a!.lines ?? []).map((l) => [l.productId, l]));
    for (const [pid, l] of la) {
      const o = lb.get(pid);
      if (!o) { if (l.buy > 0) parts.push(`+ ${short(pid)} — ${buyText(l)}`); continue; }
      if (o.buy !== l.buy || o.packs !== l.packs) parts.push(`${short(pid)}: ${buyText(o)} → ${buyText(l)}`);
    }
    for (const [pid, o] of lb) if (!la.has(pid) && o.buy > 0) parts.push(`− ${short(pid)} (${buyText(o)})`);
    if (cost(a!) !== cost(b!)) parts.push(`${rub(cost(b!))} → ${rub(cost(a!))}`);
    if (!parts.length) parts.push('пересчитаны даты и назначения продуктов, покупать то же самое');
    out.push({ title: `${fmtShort(a!.date)} ${a!.title}`, text: parts.join('; ') });
  }
  return out;
}

/**
 * Что будет, если перенести командировку на новые даты: изменения с сегодняшнего дня (дни, готовки, закупки,
 * тренировки) и что уже отмечено. На следующий день после возвращения — тренировка по самочувствию.
 */
export function planTripMove(data: AppData, trip: Trip, dates: { from: ISODate; to: ISODate }, today: ISODate, now: string): TripMove {
  const moved: Trip = { ...trip, from: dates.from, to: dates.to, trainNextDay: true, updatedAt: now };
  const changeOps = tripOps(moved, trip.id);
  const focus = Array.from(new Set([...tripDates(trip), ...tripDates(moved)])).sort();
  const diff = previewChange(data, changeOps, today, focus);
  const conflicts: string[] = [];
  const mid = applyOps(data, changeOps);
  if (mid.settings.plan) conflicts.push(...(replanOps(mid, mid.settings.plan, today, { keepPast: true }).conflicts ?? []));
  for (const t of diff.trainings) if (t.date >= today && data.trainingLogs[`train:${t.date}`]) conflicts.push(`${fmtShort(t.date)}: тренировка уже отмечена`);
  const after = diff.after;
  const days: TripMoveReport['days'] = [];
  const last = focus[focus.length - 1];
  for (const date of Object.keys({ ...data.planDays, ...after.planDays }).sort()) {
    if (date < today || date < focus[0] || date > addDays(last, 2)) continue;
    const b = dayText(data, date), a = dayText(after, date);
    if (a !== b) days.push({ date, before: b, after: a });
  }
  const report: TripMoveReport = {
    appliedAt: now, today, city: trip.city,
    before: { from: trip.from, to: trip.to }, after: { from: moved.from, to: moved.to },
    days, cooks: diff.cookChanges, shops: shopChanges(data, after, today), trainings: diff.trainings.filter((t) => t.date >= today),
    costBefore: diff.costBefore, costAfter: diff.costAfter, frozenBefore: diff.frozenBefore, frozenAfter: diff.frozenAfter, confirmed: [],
  };
  return { trip, moved, ops: diff.ops, after, report, conflicts: Array.from(new Set(conflicts)) };
}

/** Применить перенос: сначала внутренняя резервная копия, затем изменения; отчёт показывается один раз. */
export function applyTripMoveOps(data: AppData, mv: TripMove, now: string, appVersion: string, confirmed: string[] = []): { ops: Op[]; backupId: string } {
  const id = `trip-${now.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const backup: BackupRec = {
    id, createdAt: now, appVersion,
    reason: `Перед переносом командировки «${mv.trip.city}» с ${fmtShort(mv.trip.from)}–${fmtShort(mv.trip.to)} на ${fmtShort(mv.moved.from)}–${fmtShort(mv.moved.to)}`,
    fromMenu: data.settings.plan?.menuId ?? null, toMenu: data.settings.plan?.menuId ?? null,
    stores: dataToStores(data), report: null, tripReport: { ...mv.report, confirmed },
  };
  const ops: Op[] = [{ store: 'backups', put: backup }, ...mv.ops];
  const after = applyOps(data, ops);
  ops.push({ store: 'settings', put: { ...after.settings, tripReportUnseen: id, tripMovePending: null } });
  return { ops, backupId: id };
}

/**
 * v8: командировка в Санкт-Петербург перенесена с 24–25.11 на 25–26.11.2026. Если перенос не задевает уже
 * отмеченное — применяется при запуске (с резервной копией и отчётом); иначе ждёт подтверждения.
 * Если пользователь уже сам поменял даты или поездка прошла — ничего не делает.
 */
export function planV8Ops(data: AppData, today: ISODate, now: string, appVersion = 'migration'): Op[] {
  const t = spbTripToMove(data);
  if (!t || today > SPB_MOVE.after.to) return [];
  const mv = planTripMove(data, t, SPB_MOVE.after, today, now);
  if (mv.conflicts.length) return [{ store: 'settings', put: { ...data.settings, tripMovePending: { tripId: t.id, ...SPB_MOVE.after, createdAt: now } } }];
  return applyTripMoveOps(data, mv, now, appVersion).ops;
}
