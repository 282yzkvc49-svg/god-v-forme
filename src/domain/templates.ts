import type { AppData, TemplateId, TemplateItem, TemplateVersion, WorkoutTemplate } from '../state/types';
import type { ISODate } from '../lib/dates';
import { EXERCISES } from '../lib/seed';
import { fmtNum } from '../lib/util';

export const TEMPLATE_NAMES: Record<string, string> = {
  strength_a: 'Силовая А',
  strength_b: 'Силовая Б',
  stepper: 'Степпер',
  recovery: 'Восстановление / прогулка',
  trip: 'Командировка: плановый отдых',
  rest: 'Отдых',
};

/** Версия шаблона, действующая на дату: последняя с effectiveFrom ≤ даты. */
export function templateVersionFor(data: AppData, templateId: TemplateId, date: ISODate): TemplateVersion | null {
  let best: TemplateVersion | null = null;
  for (const v of Object.values(data.templateVersions)) {
    if (v.templateId !== templateId || v.effectiveFrom > date) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.createdAt > best.createdAt)) best = v;
  }
  return best;
}

export function templateFor(data: AppData, templateId: TemplateId, date: ISODate): WorkoutTemplate | null {
  return templateVersionFor(data, templateId, date)?.template ?? null;
}

export function isStrength(id: string | null | undefined): boolean {
  return id === 'strength_a' || id === 'strength_b';
}

/** «2 × 8 на руку», «2 × 20 сек на сторону», «5 мин», «15–20 мин» */
export function prescription(it: TemplateItem): string {
  const side = it.perSide ? ` на ${it.perSide}` : '';
  if (it.minutes != null) {
    const m = Array.isArray(it.minutes) ? `${it.minutes[0]}–${it.minutes[1]}` : `${it.minutes}`;
    return `${m} мин`;
  }
  if (it.seconds != null) return `${it.sets} × ${it.seconds} сек${side}`;
  if (it.reps != null) return `${it.sets} × ${it.reps}${side}`;
  return it.note || `${it.sets} подход`;
}

/** «гиря 12 кг», «гиря 16 кг (при нарушении техники — 12 кг)», «без гири»; для степпера — null. */
export function weightText(it: TemplateItem): string | null {
  if (it.kettlebellKg != null) return `гиря ${fmtNum(it.kettlebellKg)} кг${it.fallbackKg ? ` (при нарушении техники — ${fmtNum(it.fallbackKg)} кг)` : ''}`;
  if (it.weightKg) {
    const [a, b] = it.weightKg;
    return a === b ? `гиря ${fmtNum(a)} кг` : `гиря ${fmtNum(a)}–${fmtNum(b)} кг`;
  }
  const ex = EXERCISES[it.exerciseId];
  if (!ex || ex.kind === 'cardio' || !ex.steps.length) return null;
  return 'без гири';
}

/** Вес по плану для записи в журнал (12, 16 или null — без гири). */
export function plannedKg(it: TemplateItem): number | null {
  if (it.kettlebellKg != null) return it.kettlebellKg;
  if (it.weightKg && it.weightKg[0] === it.weightKg[1]) return it.weightKg[0];
  return null;
}

export function exerciseName(id: string): string {
  return EXERCISES[id]?.name ?? id;
}

export function plannedSets(t: WorkoutTemplate): number {
  return t.items.reduce((s, it) => s + (it.sets || 1), 0);
}

export function itemSummary(it: TemplateItem): string {
  return [prescription(it), weightText(it)].filter(Boolean).join(', ');
}

/**
 * Постепенное увеличение нагрузки: подсказка по прошлой тренировке того же упражнения.
 * Ничего не меняется автоматически — решает пользователь.
 */
export function progressionHint(data: AppData, exerciseId: string, beforeDate: ISODate): string | null {
  const logs = Object.values(data.trainingLogs)
    .filter((l) => l.status === 'done' && l.date < beforeDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const l of logs) {
    const idx = l.templateSnapshot?.items.findIndex((x) => x.exerciseId === exerciseId) ?? -1;
    if (idx < 0) continue;
    const el = l.exercises.find((e) => e.index === idx);
    if (!el) continue;
    const allDone = el.sets.length > 0 && el.sets.every(Boolean);
    if (exerciseId === 'stepper_cardio') return allDone ? 'В прошлый раз степпер дался — можно добавить 1–2 минуты, если самочувствие хорошее.' : null;
    if (el.difficulty === 'easy' && allDone) return 'В прошлый раз было легко: можно добавить 1–2 повтора в подходе. Вес гири меняйте только осознанно, при чистой технике.';
    if (el.difficulty === 'hard') return 'В прошлый раз было тяжело: оставьте те же повторы и вес, без форсирования.';
    return null;
  }
  return null;
}
