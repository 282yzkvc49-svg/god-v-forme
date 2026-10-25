// Задачи дня строятся из плана (PlanDay, события готовки и закупок), настроек (взвешивание, фото,
// контейнеры) и пользовательских задач. Статусы и переносы хранятся отдельно и план не меняют.
import type {
  AppData, CookingEvent, MealSlot, PlanDay, ShoppingEvent, TaskKind, TaskStatus, TemplateId,
} from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import {
  addDays, daysInMonth, isoWeekday, isWeekend, parts, timeToMinutes, type ISODate,
} from '../lib/dates';
import { isStrength, TEMPLATE_NAMES } from './templates';

export interface DayTask {
  id: string;
  kind: TaskKind;
  originDate: ISODate;
  date: ISODate;
  title: string;
  subtitle?: string | null;
  time?: string | null;
  sortMin: number;
  slot?: MealSlot;
  dish?: string;
  templateId?: TemplateId;
  eventId?: string;
  customId?: string;
  movable: boolean;
  optional?: boolean;
  postponed?: boolean;
  movedFrom?: ISODate | null;
  movedTo?: ISODate | null;
}

export type DisplayStatus = 'planned' | 'done' | 'skipped' | 'in_progress' | 'postponed' | 'unknown';

const BOX_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'snack'];

export function planDay(data: AppData, date: ISODate): PlanDay | null {
  return data.planDays[date] ?? null;
}

export function isRelaxDay(data: AppData, date: ISODate): boolean {
  return !!data.planDays[date]?.relax;
}

export function cookingEventsOn(data: AppData, date: ISODate): CookingEvent[] {
  return Object.values(data.cookingEvents).filter((e) => e.date === date);
}

export function shoppingEventsOn(data: AppData, date: ISODate): ShoppingEvent[] {
  return Object.values(data.shoppingEvents).filter((e) => e.date === date);
}

function trainingTime(data: AppData, date: ISODate, planTime?: string | null): string {
  if (planTime) return planTime;
  return isWeekend(date) ? data.settings.trainingTimeWeekend : data.settings.trainingTimeWeekday;
}

function isPostponed(data: AppData, originDate: ISODate, templateId: string): boolean {
  const start = data.settings.trainingStartDate;
  if (!start || originDate >= start) return false;
  if (isStrength(templateId)) return true;
  return templateId === 'stepper' && data.settings.postponeCardio;
}

function photoDayFor(date: ISODate, dayOfMonth: number): boolean {
  const { y, m, d } = parts(date);
  return d === Math.min(dayOfMonth, daysInMonth(y, m));
}

/** Задачи, запланированные на дату (до учёта переносов). */
export function baseTasksForDate(data: AppData, date: ISODate): DayTask[] {
  const out: DayTask[] = [];
  const s = data.settings;
  const plan = data.planDays[date];
  const weekend = isWeekend(date);
  const installDate = data.meta?.installDate ?? '0000-00-00';

  if (plan && !plan.relax && plan.meals) {
    for (const slot of MEAL_SLOTS) {
      const dish = plan.meals[slot];
      if (!dish) continue;
      const time = weekend ? null : s.mealTimes[slot];
      out.push({
        id: `meal:${date}:${slot}`, kind: 'meal', originDate: date, date, slot, dish,
        title: MEAL_LABELS[slot], time,
        sortMin: timeToMinutes(s.mealTimes[slot]) ?? 0,
        movable: false,
      });
    }
  }

  if (plan?.training && plan.training.templateId !== 'rest') {
    const tid = plan.training.templateId as TemplateId;
    const time = tid === 'recovery' ? null : trainingTime(data, date, plan.training.time);
    out.push({
      id: `train:${date}`, kind: 'training', originDate: date, date, templateId: tid,
      title: tid === 'recovery' ? TEMPLATE_NAMES.recovery : plan.training.label || TEMPLATE_NAMES[tid],
      time, sortMin: timeToMinutes(time) ?? 1100,
      movable: true, optional: tid === 'recovery', postponed: isPostponed(data, date, tid),
    });
  }

  for (const e of cookingEventsOn(data, date)) {
    if (e.eventType !== 'meal_prep') continue;
    out.push({
      id: `cook:${e.id}`, kind: 'cooking', originDate: date, date, eventId: e.id,
      title: 'Готовка', subtitle: e.dishes.map((d) => d.text).join(', '),
      sortMin: weekend ? 700 : 1090, movable: true,
    });
  }

  for (const e of shoppingEventsOn(data, date)) {
    out.push({
      id: `shop:${e.id}`, kind: 'shopping', originDate: date, date, eventId: e.id,
      title: 'Закупка', subtitle: e.title, sortMin: weekend ? 650 : 1080, movable: true,
    });
  }

  if (s.containersEnabled && !plan?.relax) {
    const tomorrow = addDays(date, 1);
    const tp = data.planDays[tomorrow];
    if (tp && !tp.relax && tp.meals && !isWeekend(tomorrow)) {
      out.push({
        id: `box:${date}`, kind: 'containers', originDate: date, date,
        title: 'Подготовить контейнеры на завтра', subtitle: BOX_SLOTS.map((sl) => MEAL_LABELS[sl].toLowerCase()).join(', '),
        sortMin: 1305, movable: false,
      });
    }
  }

  if (s.weighIn.enabled && isoWeekday(date) === s.weighIn.weekday && date >= installDate) {
    out.push({
      id: `weigh:${date}`, kind: 'weigh', originDate: date, date, title: 'Взвешивание', subtitle: 'утром, натощак',
      time: s.weighIn.time, sortMin: timeToMinutes(s.weighIn.time) ?? 450, movable: true,
    });
  }

  if (s.photo.enabled && photoDayFor(date, s.photo.dayOfMonth) && date >= installDate) {
    out.push({
      id: `photo:${date}`, kind: 'photo', originDate: date, date, title: 'Фото прогресса', subtitle: 'раз в месяц, при одинаковом свете',
      sortMin: (timeToMinutes(s.weighIn.time) ?? 450) + 5, movable: true,
    });
  }

  for (const c of Object.values(data.customTasks)) {
    if (c.date !== date) continue;
    out.push({
      id: `custom:${c.id}`, kind: c.kind === 'training' ? 'training' : 'custom', originDate: date, date, customId: c.id,
      templateId: c.templateId ?? undefined,
      title: c.title, subtitle: c.note ?? null, time: c.time ?? null, sortMin: timeToMinutes(c.time) ?? 1350, movable: true,
    });
  }
  return out;
}

/** Найти задачу по id (нужно для перенесённых задач). */
export function taskById(data: AppData, taskId: string): DayTask | null {
  const [kind, a] = taskId.split(':');
  let origin: ISODate | null = null;
  if (kind === 'meal' || kind === 'train' || kind === 'box' || kind === 'weigh' || kind === 'photo') origin = a;
  else if (kind === 'cook') origin = data.cookingEvents[taskId.slice(5)]?.date ?? null;
  else if (kind === 'shop') origin = data.shoppingEvents[taskId.slice(5)]?.date ?? null;
  else if (kind === 'custom') origin = data.customTasks[taskId.slice(7)]?.date ?? null;
  if (!origin) return null;
  return baseTasksForDate(data, origin).find((t) => t.id === taskId) ?? null;
}

/** Задачи дня с учётом переносов. */
export function tasksForDate(data: AppData, date: ISODate): DayTask[] {
  const out: DayTask[] = [];
  for (const t of baseTasksForDate(data, date)) {
    const mv = data.taskMoves[t.id];
    if (mv && mv.toDate !== date) continue;
    out.push(t);
  }
  for (const mv of Object.values(data.taskMoves)) {
    if (mv.toDate !== date || mv.fromDate === date) continue;
    const t = taskById(data, mv.taskId);
    if (t) out.push({ ...t, date, movedFrom: t.originDate });
  }
  return out.sort((a, b) => a.sortMin - b.sortMin);
}

/** Сырой статус задачи. Отсутствие записи — «запланировано», а не пропуск. */
export function statusOf(data: AppData, t: DayTask): TaskStatus | 'in_progress' {
  if (t.kind === 'training') {
    const log = data.trainingLogs[t.id];
    if (log) return log.status;
    return data.taskStatus[t.id]?.status ?? 'planned';
  }
  const rec = data.taskStatus[t.id]?.status;
  if (rec && rec !== 'planned') return rec;
  if (t.kind === 'weigh' && Object.values(data.weights).some((w) => w.date === t.date)) return 'done';
  if (t.kind === 'photo' && Object.values(data.photos).some((p) => p.date === t.date)) return 'done';
  return 'planned';
}

/** Статус для отображения: прошедшие неотмеченные задачи — «не отмечено» (нейтрально), не «пропуск». */
export function displayStatus(data: AppData, t: DayTask, today: ISODate): DisplayStatus {
  const s = statusOf(data, t);
  if (s === 'done' || s === 'skipped' || s === 'in_progress') return s;
  if (t.postponed) return 'postponed';
  if (t.date < today) return 'unknown';
  return 'planned';
}

export interface DayProgress { done: number; total: number }

/** Прогресс дня: без необязательных и отложенных задач. */
export function dayProgress(data: AppData, date: ISODate): DayProgress {
  let done = 0, total = 0;
  for (const t of tasksForDate(data, date)) {
    if (t.optional || t.postponed) continue;
    total++;
    if (statusOf(data, t) === 'done') done++;
  }
  return { done, total };
}

export interface UpcomingEvent { date: ISODate; kind: 'cooking' | 'shopping' | 'weigh' | 'photo'; title: string; id: string }

/** Ближайшие события начиная с даты (учитывая переносы). */
export function upcoming(data: AppData, from: ISODate, days = 21, kinds: UpcomingEvent['kind'][] = ['cooking', 'shopping', 'weigh', 'photo']): UpcomingEvent[] {
  const out: UpcomingEvent[] = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(from, i);
    for (const t of tasksForDate(data, date)) {
      if (!(kinds as string[]).includes(t.kind)) continue;
      if (statusOf(data, t) === 'done') continue;
      out.push({ date, kind: t.kind as UpcomingEvent['kind'], title: t.subtitle ? `${t.title}: ${t.subtitle}` : t.title, id: t.id });
    }
  }
  return out;
}

export function hasPlan(data: AppData, date: ISODate): boolean {
  return !!data.planDays[date];
}

export function planRange(data: AppData): { from: ISODate; to: ISODate } | null {
  const ds = Object.keys(data.planDays).sort();
  if (!ds.length) return null;
  return { from: ds[0], to: ds[ds.length - 1] };
}
