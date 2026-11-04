// Задачи дня строятся из плана (PlanDay, события готовки и закупок), настроек (взвешивание, фото,
// контейнеры) и пользовательских задач. Статусы и переносы хранятся отдельно и план не меняют.
import type {
  AppData, CookingEvent, MealSlot, PlanDay, PlanTraining, ShoppingEvent, TaskKind, TaskStatus, TemplateId,
} from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import {
  addDays, diffDays, isoWeekday, isWeekend, timeToMinutes, type ISODate,
} from '../lib/dates';
import { isStrength, TEMPLATE_NAMES } from './templates';
import { DISHES, PRODUCTS, fmtAmount } from './catalog';

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

/** Сколько дней недели из списка в интервале [from, to). */
function countWeekdays(from: ISODate, to: ISODate, days: number[]): number {
  const n = diffDays(to, from);
  if (n <= 0) return 0;
  let count = Math.floor(n / 7) * days.length;
  for (let i = Math.floor(n / 7) * 7; i < n; i++) if (days.includes(isoWeekday(addDays(from, i)))) count++;
  return count;
}

/**
 * Тренировка на дату: своё расписание (по умолчанию силовые пн/ср/пт с чередованием А/Б, степпер вт/сб),
 * не зависит от даты старта питания. Импортированный план может переопределить конкретный день.
 */
export function scheduledTraining(data: AppData, date: ISODate): PlanTraining | null {
  const override = data.planDays[date]?.training;
  if (override) return override;
  const tr = data.settings.training;
  if (!tr || date < tr.startDate) return null;
  const wd = isoWeekday(date);
  if (tr.strengthDays.includes(wd)) {
    const id: TemplateId = countWeekdays(tr.startDate, date, tr.strengthDays) % 2 === 0 ? 'strength_a' : 'strength_b';
    return { templateId: id, label: TEMPLATE_NAMES[id], time: null };
  }
  if (tr.cardioDays.includes(wd)) return { templateId: 'stepper', label: TEMPLATE_NAMES.stepper, time: null };
  return { templateId: 'recovery', label: TEMPLATE_NAMES.recovery, time: null };
}

/** Что достать из морозилки вечером date: сырое к завтрашней готовке и готовые порции к завтрашним приёмам. */
export function thawList(data: AppData, date: ISODate): string[] {
  const out: string[] = [];
  const next = addDays(date, 1);
  for (const e of Object.values(data.cookingEvents)) {
    const cookDay = e.date;
    // к утренней готовке — накануне вечером; к вечерней — тоже накануне (сутки в холодильнике)
    if (cookDay !== next) continue;
    for (const t of e.thawProducts ?? []) out.push(`${PRODUCTS[t.productId]?.name ?? t.productId} — ${fmtAmount(t.qty, PRODUCTS[t.productId]?.unit ?? 'g')} (к готовке ${e.time ?? ''})`.replace(' ()', ''));
  }
  const plan = data.planDays[next];
  if (plan?.mealCards) {
    for (const slot of MEAL_SLOTS) {
      for (const p of plan.mealCards[slot].parts) {
        if (p.storage !== 'freeze' || p.thawOn !== date) continue;
        const d = DISHES[p.dishId];
        out.push(`${d?.title ?? p.dishId} — ${d?.unit === 'g' ? `${Math.round(p.qty)} г` : `${p.qty} порц.`} (${MEAL_LABELS[slot].toLowerCase()})`);
      }
    }
  }
  return out;
}

function isPostponed(data: AppData, originDate: ISODate, templateId: string): boolean {
  const start = data.settings.trainingStartDate;
  if (!start || originDate >= start) return false;
  if (isStrength(templateId)) return true;
  return templateId === 'stepper' && data.settings.postponeCardio;
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

  const log = data.trainingLogs[`train:${date}`];
  const training = scheduledTraining(data, date) ?? (log ? { templateId: log.templateId, label: TEMPLATE_NAMES[log.templateId], time: null } : null);
  if (training && training.templateId !== 'rest') {
    const tid = (log?.templateId ?? training.templateId) as TemplateId;
    const time = tid === 'recovery' ? null : trainingTime(data, date, training.time);
    out.push({
      id: `train:${date}`, kind: 'training', originDate: date, date, templateId: tid,
      title: tid === 'recovery' ? TEMPLATE_NAMES.recovery : (log ? TEMPLATE_NAMES[tid] : training.label) || TEMPLATE_NAMES[tid],
      time, sortMin: timeToMinutes(time) ?? 1100,
      movable: true, optional: tid === 'recovery', postponed: isPostponed(data, date, tid),
    });
  }

  for (const e of cookingEventsOn(data, date)) {
    if (e.eventType !== 'meal_prep') continue;
    const subtitle = e.items?.length
      ? e.items.filter((i) => DISHES[i.dishId]?.unit === 'portion' && DISHES[i.dishId]?.category === 'main').map((i) => `${DISHES[i.dishId].short} ×${i.qty}`).join(', ')
      : e.dishes.map((d) => d.text).join(', ');
    out.push({
      id: `cook:${e.id}`, kind: 'cooking', originDate: date, date, eventId: e.id,
      title: e.kind === 'quick' ? 'Быстрая готовка' : 'Готовка', subtitle, time: e.time ?? null,
      sortMin: timeToMinutes(e.time) ?? (weekend ? 700 : 1090), movable: true,
    });
  }

  for (const e of shoppingEventsOn(data, date)) {
    out.push({
      id: `shop:${e.id}`, kind: 'shopping', originDate: date, date, eventId: e.id,
      title: e.kind === 'topup' ? 'Докупка свежего' : 'Закупка', subtitle: e.lines ? `${e.title}: ${e.lines.length} поз.` : e.title,
      time: e.time ?? null, sortMin: timeToMinutes(e.time) ?? (weekend ? 650 : 1080), movable: true,
    });
  }

  const thaw = thawList(data, date);
  if (thaw.length) {
    out.push({
      id: `thaw:${date}`, kind: 'thaw', originDate: date, date, title: 'Разморозка на завтра',
      subtitle: `переложить из морозилки в холодильник: ${thaw.length} поз.`, sortMin: 1300, movable: false,
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

  if (s.photo.enabled && isoWeekday(date) === s.photo.weekday && date >= installDate) {
    out.push({
      id: `photo:${date}`, kind: 'photo', originDate: date, date, title: 'Фото прогресса', subtitle: 'раз в неделю, при одинаковом свете',
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
  if (kind === 'meal' || kind === 'train' || kind === 'box' || kind === 'thaw' || kind === 'weigh' || kind === 'photo') origin = a;
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
