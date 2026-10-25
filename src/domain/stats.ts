// Честная статистика: считаем только введённые данные. Пустая запись ≠ пропуск, план ≠ факт.
import type { AppData, Difficulty, Feeling, MealSlot, TemplateId, TrainingLog } from '../state/types';
import { MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, range, type ISODate } from '../lib/dates';
import { baseTasksForDate, statusOf, type DayTask } from './tasks';
import { exerciseName, isStrength, plannedSets, templateFor, TEMPLATE_NAMES } from './templates';
import { EXERCISES } from '../lib/seed';

// ------------------------------------------------------------------ вес

export interface WeightPoint { date: ISODate; kg: number }

/** Одна точка на дату (последняя введённая за день), по возрастанию даты. */
export function weightSeries(data: AppData, from?: ISODate, to?: ISODate): WeightPoint[] {
  const byDate = new Map<ISODate, { kg: number; at: string }>();
  for (const w of Object.values(data.weights)) {
    if ((from && w.date < from) || (to && w.date > to)) continue;
    const prev = byDate.get(w.date);
    if (!prev || w.createdAt > prev.at) byDate.set(w.date, { kg: w.kg, at: w.createdAt });
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, kg: v.kg }));
}

export const TREND_MIN_POINTS = 4;
export const TREND_MIN_SPAN_DAYS = 14;

export function trendAvailable(points: WeightPoint[]): boolean {
  if (points.length < TREND_MIN_POINTS) return false;
  return diffDays(points[points.length - 1].date, points[0].date) >= TREND_MIN_SPAN_DAYS;
}

/** Сглаживание скользящим средним по окну ±7 дней (по датам, не по числу точек). */
export function smoothedTrend(points: WeightPoint[], halfWindowDays = 7): WeightPoint[] {
  if (!trendAvailable(points)) return [];
  return points.map((p) => {
    const win = points.filter((q) => Math.abs(diffDays(q.date, p.date)) <= halfWindowDays);
    return { date: p.date, kg: win.reduce((s, q) => s + q.kg, 0) / win.length };
  });
}

/** Наклон линейной регрессии, кг в неделю. */
export function weeklyRate(points: WeightPoint[]): number | null {
  if (!trendAvailable(points)) return null;
  const x0 = points[0].date;
  const xs = points.map((p) => diffDays(p.date, x0));
  const ys = points.map((p) => p.kg);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 7;
}

export interface WeightSummary {
  count: number;
  first: WeightPoint | null;
  last: WeightPoint | null;
  change: number | null; // от первого фактического замера
  toTarget: number | null;
  rate: number | null;
}

export function weightSummary(data: AppData, from?: ISODate, to?: ISODate): WeightSummary {
  const pts = weightSeries(data, from, to);
  const first = pts[0] ?? null, last = pts[pts.length - 1] ?? null;
  return {
    count: pts.length,
    first, last,
    change: pts.length >= 2 ? +(last!.kg - first!.kg).toFixed(2) : null,
    toTarget: last ? +(last.kg - data.settings.goals.targetWeightKg).toFixed(2) : null,
    rate: weeklyRate(pts),
  };
}

// ------------------------------------------------------------------ тренировки

export type TrainingRowStatus = 'done' | 'skipped' | 'postponed' | 'not_logged' | 'planned' | 'in_progress';

export interface ExerciseRow {
  index: number;
  exerciseId: string;
  name: string;
  plannedSets: number;
  plannedReps: number | null;
  plannedSeconds: number | null;
  plannedMinutes: number | [number, number] | null;
  plannedWeightKg: [number, number] | null;
  perSide: string | null;
  setsDone: number;
  weightKgUsed: number | null;
  difficulty: Difficulty | null;
}

export interface TrainingRow {
  taskId: string;
  plannedDate: ISODate;
  actualDate: ISODate | null;
  templateId: TemplateId;
  name: string;
  kind: 'strength' | 'cardio' | 'recovery';
  status: TrainingRowStatus;
  moved: boolean;
  movedTo: ISODate | null;
  custom: boolean;
  quick: boolean;
  setsDone: number;
  setsPlanned: number;
  stepperMinutes: number | null;
  warmupMinutes: number | null;
  feeling: Feeling | null;
  note: string | null;
  exercises: ExerciseRow[];
}

function trainingTasksInRange(data: AppData, from: ISODate, to: ISODate): DayTask[] {
  const out: DayTask[] = [];
  for (const date of range(from, to)) for (const t of baseTasksForDate(data, date)) if (t.kind === 'training' && t.templateId) out.push(t);
  return out;
}

function kindOf(tid: TemplateId): TrainingRow['kind'] {
  return isStrength(tid) ? 'strength' : tid === 'stepper' ? 'cardio' : 'recovery';
}

export function trainingRows(data: AppData, from: ISODate, to: ISODate, today: ISODate): TrainingRow[] {
  return trainingTasksInRange(data, from, to).map((t) => {
    const log: TrainingLog | undefined = data.trainingLogs[t.id];
    const tid = t.templateId!;
    const tpl = log?.templateSnapshot ?? data.templateVersions[log?.templateVersionId ?? '']?.template ?? templateFor(data, tid, t.originDate);
    const mv = data.taskMoves[t.id];
    const effectiveDate = mv?.toDate ?? t.originDate;
    const raw = statusOf(data, t);
    let status: TrainingRowStatus;
    if (raw === 'done' || raw === 'skipped' || raw === 'in_progress') status = raw;
    else if (t.postponed) status = 'postponed';
    else status = effectiveDate < today ? 'not_logged' : 'planned';

    const exercises: ExerciseRow[] = (tpl?.items ?? []).map((it, index) => {
      const el = log?.exercises.find((e) => e.index === index);
      return {
        index, exerciseId: it.exerciseId, name: exerciseName(it.exerciseId),
        plannedSets: it.sets, plannedReps: it.reps ?? null, plannedSeconds: it.seconds ?? null, plannedMinutes: it.minutes ?? null,
        plannedWeightKg: it.weightKg ?? null, perSide: it.perSide ?? null,
        setsDone: el ? el.sets.filter(Boolean).length : 0,
        weightKgUsed: el?.weightKg ?? null,
        difficulty: el?.difficulty ?? null,
      };
    });
    const setsDone = exercises.reduce((s, e) => s + e.setsDone, 0);
    const warm = exercises.find((e) => e.exerciseId === 'warmup_stepper');
    const warmMinutes = warm && warm.setsDone > 0 && typeof warm.plannedMinutes === 'number' ? warm.plannedMinutes : null;
    const cardioMinutes = log?.stepperMinutes ?? (log?.exercises.find((e) => e.exerciseId === 'stepper_cardio')?.minutes ?? null);
    return {
      taskId: t.id,
      plannedDate: t.originDate,
      actualDate: log && (log.status === 'done' || log.status === 'in_progress') ? log.date : null,
      templateId: tid,
      name: tpl?.name ?? TEMPLATE_NAMES[tid],
      kind: kindOf(tid),
      status,
      moved: !!mv,
      movedTo: mv?.toDate ?? null,
      custom: t.id.startsWith('custom:'),
      quick: !!log?.quick,
      setsDone,
      setsPlanned: tpl ? plannedSets(tpl) : 0,
      stepperMinutes: cardioMinutes,
      warmupMinutes: warmMinutes,
      feeling: log?.feeling ?? null,
      note: log?.note ?? null,
      exercises,
    };
  });
}

export interface TrainingStats {
  planned: number; // силовые + степпер, срок которых наступил (без отложенных)
  done: number;
  skipped: number;
  notLogged: number;
  moved: number;
  postponed: number;
  upcoming: number;
  strengthDone: number;
  cardioDone: number;
  recoveryDone: number;
  stepperMinutes: number;
  warmupMinutes: number;
  setsDone: number;
}

export function trainingStats(rows: TrainingRow[]): TrainingStats {
  const s: TrainingStats = {
    planned: 0, done: 0, skipped: 0, notLogged: 0, moved: 0, postponed: 0, upcoming: 0,
    strengthDone: 0, cardioDone: 0, recoveryDone: 0, stepperMinutes: 0, warmupMinutes: 0, setsDone: 0,
  };
  for (const r of rows) {
    if (r.kind === 'recovery') {
      if (r.status === 'done') s.recoveryDone++;
      continue;
    }
    if (r.moved) s.moved++;
    if (r.status === 'postponed') { s.postponed++; continue; }
    if (r.status === 'planned') { s.upcoming++; continue; }
    s.planned++;
    if (r.status === 'done') {
      s.done++;
      if (r.kind === 'strength') s.strengthDone++; else s.cardioDone++;
    }
    if (r.status === 'skipped') s.skipped++;
    if (r.status === 'not_logged') s.notLogged++;
    s.setsDone += r.setsDone;
    s.stepperMinutes += r.stepperMinutes ?? 0;
    s.warmupMinutes += r.warmupMinutes ?? 0;
  }
  return s;
}

export interface WorkingWeightEntry { date: ISODate; kg: number; difficulty: Difficulty | null; templateId: TemplateId }

/** Рабочие веса — только введённые пользователем значения. */
export function workingWeights(data: AppData, from?: ISODate, to?: ISODate): Record<string, WorkingWeightEntry[]> {
  const out: Record<string, WorkingWeightEntry[]> = {};
  for (const log of Object.values(data.trainingLogs)) {
    if ((from && log.date < from) || (to && log.date > to)) continue;
    for (const e of log.exercises) {
      if (e.weightKg == null) continue;
      (out[e.exerciseId] ||= []).push({ date: log.date, kg: e.weightKg, difficulty: e.difficulty ?? null, templateId: log.templateId });
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export function exerciseLabel(id: string): string {
  return EXERCISES[id]?.name ?? id;
}

// ------------------------------------------------------------------ питание

export interface MealAdherence {
  planned: number; // плановые приёмы пищи с датой ≤ сегодня (без релакс-дней)
  done: number;
  skipped: number;
  unknown: number; // нет отметки — не считается ни выполнением, ни пропуском
  future: number;
  relaxDays: ISODate[];
  percentOfMarked: number | null;
}

export interface MealDayRow { date: ISODate; relax: boolean; meals: { slot: MealSlot; dish: string; status: 'done' | 'skipped' | 'unknown' | 'planned' }[] }

export function mealRows(data: AppData, from: ISODate, to: ISODate, today: ISODate): MealDayRow[] {
  const out: MealDayRow[] = [];
  for (const date of range(from, to)) {
    const p = data.planDays[date];
    if (!p) continue;
    if (p.relax || !p.meals) { out.push({ date, relax: true, meals: [] }); continue; }
    out.push({
      date, relax: false,
      meals: MEAL_SLOTS.filter((s) => p.meals![s]).map((slot) => {
        const st = data.taskStatus[`meal:${date}:${slot}`]?.status;
        const status = st === 'done' || st === 'skipped' ? st : date > today ? 'planned' : 'unknown';
        return { slot, dish: p.meals![slot], status };
      }),
    });
  }
  return out;
}

export function mealAdherence(rows: MealDayRow[]): MealAdherence {
  const a: MealAdherence = { planned: 0, done: 0, skipped: 0, unknown: 0, future: 0, relaxDays: [], percentOfMarked: null };
  for (const r of rows) {
    if (r.relax) { a.relaxDays.push(r.date); continue; }
    for (const m of r.meals) {
      if (m.status === 'planned') { a.future++; continue; }
      a.planned++;
      if (m.status === 'done') a.done++;
      else if (m.status === 'skipped') a.skipped++;
      else a.unknown++;
    }
  }
  const marked = a.done + a.skipped;
  a.percentOfMarked = marked > 0 ? Math.round((a.done / marked) * 100) : null;
  return a;
}

// ------------------------------------------------------------------ контрольные дни

export function nextControlDay(data: AppData, today: ISODate): { date: ISODate; kind: 'weigh' | 'photo' } | null {
  for (let i = 0; i < 62; i++) {
    const date = addDays(today, i);
    const ts = baseTasksForDate(data, date).filter((t) => t.kind === 'weigh' || t.kind === 'photo');
    const open = ts.filter((t) => statusOf(data, t) !== 'done');
    if (open.length) return { date, kind: open[0].kind as 'weigh' | 'photo' };
  }
  return null;
}
