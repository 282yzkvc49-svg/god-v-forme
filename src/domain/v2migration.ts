// Переход на версию 2.0 (данные v10): недельный цикл вместо шаблона на 30 дней.
// По решениям пользователя 24.11.2026: меню 24–30.11 (предварительно утверждено), командировки 1–2.12 и 15–22.12
// вместо 25–26.11, релакс-дни 29.11 и 27.12, закупка и основная готовка — по воскресеньям, место в морозилке не
// задано. Запасы: минтай ≈200 г и целая упаковка стручковой фасоли; открытые неделю назад фасоль и томаты не
// используются. Ничего из истории не удаляется: прошедшие дни, отметки, тренировки, вес и фото остаются как были;
// перед изменениями сохраняется резервная копия.
import type { Op } from '../state/idb';
import type { AppData, BackupRec, StockRec, Trip } from '../state/types';
import { addDays, type ISODate } from '../lib/dates';
import { PRODUCTS } from './catalog';
import { emptyStock, stockRemaining } from './stock';
import { tripList } from './trips';
import {
  draftWeek, planCycles, setRemainingOps, weeklyOf, weeklyReplanOps, type WeekPlan, type WeeklySettings,
} from './weekly';

export const V2_SINCE: ISODate = '2026-11-24';
export const V2_BACKUP_PREFIX = 'v2-';

/** Утверждённое (предварительно) меню 24–30.11: готовка 25.11, 9 порций; 24.11 — без изменений. */
export function approvedWeek1(now: string): WeekPlan {
  const fr = (r: string) => ({ r, src: 'fresh' as const });
  const ck = (r: string) => ({ r, src: 'cook' as const });
  return {
    id: 'w20261125', title: 'Неделя 25–30 ноября', cookDate: '2026-11-25', cookTime: '18:30', shopDate: '2026-11-25',
    status: 'approved', approvedAt: now, source: 'chat',
    meals: {
      '2026-11-25': {
        breakfast: { r: '', src: 'stock', title: 'Из остатков', note: 'Йогурт или творог, если ещё годны; вишня.' },
        lunch: { r: 'm011', src: 'stock', note: 'Готовится 24.11 вечером из остатков (≈25 минут): минтай ≈200 г, гречка, стручковая фасоль.' },
        snack: { r: '', src: 'stock', title: 'Из остатков', note: 'Что есть дома из молочного или фруктов.' },
        dinner: ck('m008'),
      },
      '2026-11-26': { breakfast: fr('b006'), lunch: ck('m009'), snack: fr('s004'), dinner: ck('m010') },
      '2026-11-27': { breakfast: fr('b007'), lunch: ck('m008'), snack: fr('s005'), dinner: ck('m009') },
      '2026-11-28': { breakfast: fr('b009'), lunch: ck('m010'), snack: fr('s006'), dinner: ck('m008') },
      '2026-11-30': { breakfast: fr('b008'), lunch: ck('m009'), snack: fr('s007'), dinner: ck('m008') },
    },
    cook: [
      { r: 'm008', servings: 4, uses: [
        { date: '2026-11-25', slot: 'dinner', storage: 'fridge' }, { date: '2026-11-27', slot: 'lunch', storage: 'fridge' },
        { date: '2026-11-28', slot: 'dinner', storage: 'freeze', thawOn: '2026-11-27' }, { date: '2026-11-30', slot: 'dinner', storage: 'freeze', thawOn: '2026-11-29' },
      ] },
      { r: 'm009', servings: 3, uses: [
        { date: '2026-11-26', slot: 'lunch', storage: 'fridge' }, { date: '2026-11-27', slot: 'dinner', storage: 'fridge' },
        { date: '2026-11-30', slot: 'lunch', storage: 'freeze', thawOn: '2026-11-29' },
      ] },
      { r: 'm010', servings: 2, uses: [
        { date: '2026-11-26', slot: 'dinner', storage: 'fridge' }, { date: '2026-11-28', slot: 'lunch', storage: 'freeze', thawOn: '2026-11-27' },
      ] },
    ],
    stockConfirmedAt: null,
    notes: [
      'Меню предварительно утверждено 24.11; окончательно — после проверки запасов.',
      'Время доставки 25.11 ещё не подтверждено.',
      'В морозилку — 4 плоских пакета: котлеты и курица на 28.11, тефтели и курица на 30.11.',
    ],
    createdAt: now,
  };
}

const NEW_TRIPS: Omit<Trip, 'createdAt' | 'updatedAt'>[] = [
  { id: 'trip-2026-12-01', city: 'Командировка', from: '2026-12-01', to: '2026-12-02', hotelBreakfast: true, fridge: false, canTrain: false, trainNextDay: false, comment: 'Добавлено версией 2.0 по сообщению 24.11; город и условия можно уточнить.' },
  { id: 'trip-2026-12-15', city: 'Командировка', from: '2026-12-15', to: '2026-12-22', hotelBreakfast: true, fridge: false, canTrain: false, trainNextDay: false, comment: 'Добавлено версией 2.0 по сообщению 24.11; город и условия можно уточнить.' },
];

function writeOffAll(data: AppData, pid: string, now: string, today: ISODate, note: string): Op[] {
  const rec: StockRec | undefined = data.stock[pid];
  const left = rec ? stockRemaining(data, pid) : 0;
  if (!rec || left <= 0.05) return [];
  return [{ store: 'stock', put: { ...rec, updatedAt: now, moves: [...rec.moves, { id: `wo-${pid}-${now}`, date: today, kind: 'writeoff', qty: Math.round(left * 10) / 10, source: 'версия 2.0', note, confirmed: true, at: now }] } }];
}

export interface V10Helpers { toStores: (d: AppData) => Record<string, unknown[]>; apply: (d: AppData, ops: Op[]) => AppData }

export function planV10Ops(data0: AppData, today: ISODate, now: string, appVersion: string, h: V10Helpers): Op[] {
  if (weeklyOf(data0) || !data0.settings.plan) return [];
  const ops: Op[] = [];
  let data = data0;
  const step = (more: Op[]) => { ops.push(...more); data = h.apply(data, more); };
  // резервная копия до изменений
  const backupId = `${V2_BACKUP_PREFIX}${now}`;
  const backup: BackupRec = {
    id: backupId, createdAt: now, reason: 'Переход на версию 2.0: недельный цикл питания', appVersion,
    fromMenu: data.settings.plan?.menuId ?? null, toMenu: 'weekly', stores: h.toStores(data) as Record<string, any[]>,
  };
  step([{ store: 'backups', put: backup }]);
  // командировки: 25–26.11 отменена, новые 1–2.12 и 15–22.12
  const trips = tripList(data);
  const tripOps: Op[] = [];
  for (const t of trips) if (t.from <= '2026-11-26' && t.to >= '2026-11-25' && t.from >= '2026-11-24') tripOps.push({ store: 'trips', del: t.id });
  for (const t of NEW_TRIPS) {
    if (trips.some((x) => x.from <= t.to && x.to >= t.from)) continue;
    tripOps.push({ store: 'trips', put: { ...t, createdAt: now, updatedAt: now } });
  }
  step(tripOps);
  // запасы по сообщению 24.11
  const stockOps: Op[] = [];
  const note = 'По вашему сообщению 24.11';
  stockOps.push(...setRemainingOps(data, 'pollock', 200, now, today, `${note}: около 200 г`));
  stockOps.push(...setRemainingOps(data, 'greenbeans', 400, now, today, `${note}: неоткрытая упаковка`));
  step(stockOps);
  const wo: Op[] = [];
  wo.push(...writeOffAll(data, 'beans', now, today, 'Открыта неделю назад — не используется (по вашему сообщению 24.11)'));
  wo.push(...writeOffAll(data, 'tomatopuree', now, today, 'Открыта неделю назад — не используется (по вашему сообщению 24.11)'));
  for (const pid of ['buckwheat', 'rice', 'bulgur', 'oats', 'broccoli', 'cherry', 'yogurt', 'curd', 'oliveoil']) {
    const rec = data.stock[pid];
    const p = PRODUCTS[pid];
    if (!p) continue;
    const base = rec ?? emptyStock(pid, now);
    wo.push({ store: 'stock', put: { ...base, confirmedAt: null, note: 'Есть дома, количество и срок уточнить перед закупкой (24.11)', updatedAt: now } });
  }
  step(wo);
  // недельный цикл: неделя 1 и черновики до горизонта
  const w1 = approvedWeek1(now);
  const weekly: WeeklySettings = {
    since: V2_SINCE, shopDay: 7, cookTime: '17:00', freezer: { capacity: null }, weeks: { [w1.id]: w1 },
    planner: 'local', ai: { mode: 'off' }, backupId, reportUnseen: true,
  };
  const settings = { ...data.settings, weekly, relaxOverrides: { ...data.settings.relaxOverrides, '2026-11': '2026-11-29', '2026-12': '2026-12-27' } } as AppData['settings'];
  step([{ store: 'settings', put: settings }]);
  const draftFrom = '2026-12-03' > today ? '2026-12-03' : addDays(today, 1);
  for (const c of planCycles(data, draftFrom, addDays(draftFrom, 34), 7)) {
    const w = draftWeek(data, c, { now });
    const s2 = { ...data.settings, weekly: { ...(weeklyOf(data) as WeeklySettings), weeks: { ...(weeklyOf(data) as WeeklySettings).weeks, [w.id]: w } } } as AppData['settings'];
    step([{ store: 'settings', put: s2 }]);
  }
  // записи приложения с сегодняшнего дня (прошедшее и отмеченное не меняется)
  step(weeklyReplanOps(data, today).ops);
  return ops;
}
