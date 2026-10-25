import type { AppData, TemplateId, TemplateItem, TemplateVersion, WorkoutTemplate } from '../state/types';
import type { ISODate } from '../lib/dates';
import { EXERCISES } from '../lib/seed';
import { fmtNum } from '../lib/util';

export const TEMPLATE_NAMES: Record<string, string> = {
  strength_a: 'Силовая А',
  strength_b: 'Силовая Б',
  stepper: 'Степпер',
  recovery: 'Восстановление / прогулка',
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

export function weightText(it: TemplateItem): string | null {
  if (!it.weightKg) return null;
  const [a, b] = it.weightKg;
  return a === b ? `${fmtNum(a)} кг` : `${fmtNum(a)}–${fmtNum(b)} кг`;
}

export function exerciseName(id: string): string {
  return EXERCISES[id]?.name ?? id;
}

export function plannedSets(t: WorkoutTemplate): number {
  return t.items.reduce((s, it) => s + (it.sets || 1), 0);
}

export function itemSummary(it: TemplateItem): string {
  const w = weightText(it);
  return [prescription(it), w ? `ориентир ${w}` : null].filter(Boolean).join(', ');
}
