// Импорт plan_update.json от ChatGPT.
// Последовательность: строгая проверка → экран «Было → Станет» → подтверждение каждого изменения →
// снимок плана → запись только будущих плановых записей → история и откат.
// Файл — только данные: никакой код, HTML, ссылки и «инструкции» из него не исполняются.
import type {
  AppData, ChangeLine, ChangeSummary, CookingEvent, Goals, MealSlot, PatchRecord, PlanDay, PlanSnapshot, ShoppingEvent,
  ShoppingItem, TemplateId, TemplateItem, TemplateVersion, TrainingKind, WorkoutTemplate,
} from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS, TEMPLATE_IDS } from '../state/types';
import type { Op } from '../state/idb';
import { fmtShort, isISODate, isTime, type ISODate } from '../lib/dates';
import { EXERCISES, KETTLEBELL_MAX_KG } from '../lib/seed';
import { fmtNum, normText } from '../lib/util';
import { exerciseName, prescription, templateFor, templateVersionFor, TEMPLATE_NAMES, weightText } from './templates';
import { recipeById } from './meals';
import { statusOf, baseTasksForDate } from './tasks';
import { SEED_MEAL_MAP } from '../lib/seed';

export const PLAN_UPDATE_SCHEMA_VERSION = '1.0.0';
export const CHANGE_TYPES = ['workout_template', 'calendar_training', 'meal_plan', 'meal_prep_event', 'shopping_event', 'goal'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  workout_template: 'Шаблон тренировки',
  calendar_training: 'Расписание тренировок',
  meal_plan: 'Меню',
  meal_prep_event: 'Готовка',
  shopping_event: 'Закупка',
  goal: 'Цели',
};

const MAX_FILE_CHARS = 2_000_000;
const MAX_STR = 400;

export interface Issue { path: string; message: string }

export interface ParsedChange {
  key: string;
  index: number;
  type: ChangeType;
  title: string;
  reason: string | null;
  effectiveFrom: ISODate | null;
  lines: ChangeLine[];
  warnings: string[];
  danger: boolean;
  applicable: boolean;
  // подготовленные данные для применения
  payload: any;
}

export type ParseResult =
  | { ok: true; title: string; summary: string; schemaVersion: string; changes: ParsedChange[]; warnings: string[] }
  | { ok: false; errors: Issue[] };

// ------------------------------------------------------------------ проверки значений

class V {
  errors: Issue[] = [];
  err(path: string, message: string) { this.errors.push({ path, message }); }
  obj(x: any, path: string): x is Record<string, any> {
    if (x && typeof x === 'object' && !Array.isArray(x)) return true;
    this.err(path, 'ожидается объект { … }');
    return false;
  }
  arr(x: any, path: string, min: number, max: number): x is any[] {
    if (!Array.isArray(x)) { this.err(path, 'ожидается список [ … ]'); return false; }
    if (x.length < min) { this.err(path, `список пуст — нужен хотя бы ${min} элемент`); return false; }
    if (x.length > max) { this.err(path, `слишком много элементов (${x.length}, максимум ${max})`); return false; }
    return true;
  }
  str(x: any, path: string, opts: { required?: boolean; max?: number } = {}): string | null {
    if (x == null || x === '') {
      if (opts.required) this.err(path, 'обязательное текстовое поле');
      return null;
    }
    if (typeof x !== 'string') { this.err(path, 'ожидается текст'); return null; }
    const max = opts.max ?? MAX_STR;
    if (x.length > max) { this.err(path, `текст длиннее ${max} символов`); return null; }
    return x.trim();
  }
  int(x: any, path: string, min: number, max: number, required = false): number | null {
    if (x == null) { if (required) this.err(path, 'обязательное число'); return null; }
    if (typeof x !== 'number' || !Number.isInteger(x)) { this.err(path, 'ожидается целое число'); return null; }
    if (x < min || x > max) { this.err(path, `число вне диапазона ${min}–${max}`); return null; }
    return x;
  }
  num(x: any, path: string, min: number, max: number, required = false): number | null {
    if (x == null) { if (required) this.err(path, 'обязательное число'); return null; }
    if (typeof x !== 'number' || !Number.isFinite(x)) { this.err(path, 'ожидается число (например, 16 или 16.5)'); return null; }
    if (x < min || x > max) { this.err(path, `число вне диапазона ${min}–${max}`); return null; }
    return x;
  }
  date(x: any, path: string, required = true): ISODate | null {
    if (x == null) { if (required) this.err(path, 'обязательная дата в формате ГГГГ-ММ-ДД'); return null; }
    if (!isISODate(x)) { this.err(path, `некорректная дата «${String(x).slice(0, 30)}» — нужен формат ГГГГ-ММ-ДД`); return null; }
    return x;
  }
}

const FORBIDDEN: [RegExp, string][] = [
  [/<\s*\/?\s*[a-z!][^>]*>/i, 'HTML-разметка'],
  [/javascript\s*:/i, 'ссылка javascript:'],
  [/\b(?:https?|ftp):\/\//i, 'интернет-ссылка'],
  [/\bwww\.[a-z0-9-]+\./i, 'интернет-ссылка'],
  [/\bdata:[a-z]+\/[a-z0-9.+-]+/i, 'встроенные данные data:'],
];

function scanStrings(x: any, path: string, v: V, depth = 0) {
  if (depth > 12) { v.err(path, 'слишком глубокая вложенность'); return; }
  if (typeof x === 'string') {
    for (const [re, what] of FORBIDDEN) if (re.test(x)) { v.err(path, `${what} не допускается — файл должен содержать только данные плана`); return; }
    return;
  }
  if (Array.isArray(x)) x.forEach((y, i) => scanStrings(y, `${path}[${i}]`, v, depth + 1));
  else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') { v.err(`${path}.${k}`, 'недопустимое имя поля'); continue; }
    scanStrings(y, `${path}.${k}`, v, depth + 1);
  }
}

// ------------------------------------------------------------------ форматирование

function itemText(it: TemplateItem | undefined): string {
  if (!it) return '—';
  const w = weightText(it);
  return [prescription(it), w ? w : null].filter(Boolean).join(', ');
}

function maxWeight(it: TemplateItem | undefined): number | null {
  return it?.weightKg ? it.weightKg[1] : null;
}

/** Резкий рост нагрузки — требует отдельного подтверждения. */
export function loadJump(before: TemplateItem | undefined, after: TemplateItem): string | null {
  if (!before) {
    const w = maxWeight(after);
    return w != null && w > 16 ? `новое упражнение сразу с весом ${fmtNum(w)} кг` : null;
  }
  const reasons: string[] = [];
  if ((after.sets ?? 0) - (before.sets ?? 0) >= 2) reasons.push(`подходы +${after.sets - before.sets}`);
  if (before.reps && after.reps && after.reps > before.reps * 1.5 && after.reps - before.reps >= 3) reasons.push(`повторы ${before.reps} → ${after.reps}`);
  if (before.seconds && after.seconds && after.seconds > before.seconds * 2) reasons.push(`время ${before.seconds} → ${after.seconds} сек`);
  const wb = maxWeight(before), wa = maxWeight(after);
  if (wb != null && wa != null && (wa - wb > 4 || (wb > 0 && wa > wb * 1.3 && wa - wb >= 3))) reasons.push(`вес ${fmtNum(wb)} → ${fmtNum(wa)} кг`);
  if (wb == null && wa != null && wa > 16) reasons.push(`вес сразу ${fmtNum(wa)} кг`);
  return reasons.length ? reasons.join(', ') : null;
}

// ------------------------------------------------------------------ разбор изменений

function parseItem(x: any, path: string, v: V, partial: boolean): Partial<TemplateItem> & { occurrence?: number } | null {
  if (!v.obj(x, path)) return null;
  const id = v.str(x.exercise_id, `${path}.exercise_id`, { required: true, max: 60 });
  if (id && !EXERCISES[id]) v.err(`${path}.exercise_id`, `неизвестное упражнение «${id}». Допустимо: ${Object.keys(EXERCISES).join(', ')}`);
  const out: any = { exerciseId: id };
  const sets = v.int(x.sets, `${path}.sets`, 1, 10, !partial);
  if (sets != null) out.sets = sets;
  if ('reps' in x) out.reps = x.reps == null ? null : v.int(x.reps, `${path}.reps`, 1, 100);
  if ('seconds' in x) out.seconds = x.seconds == null ? null : v.int(x.seconds, `${path}.seconds`, 5, 900);
  if ('minutes' in x) {
    if (Array.isArray(x.minutes)) {
      const a = v.num(x.minutes[0], `${path}.minutes[0]`, 1, 180, true), b = v.num(x.minutes[1], `${path}.minutes[1]`, 1, 180, true);
      if (a != null && b != null) { if (a > b) v.err(`${path}.minutes`, 'начало диапазона больше конца'); out.minutes = [a, b]; }
    } else out.minutes = x.minutes == null ? null : v.num(x.minutes, `${path}.minutes`, 1, 180);
  }
  if ('per_side' in x) out.perSide = v.str(x.per_side, `${path}.per_side`, { max: 20 });
  if ('weight_kg' in x) {
    const w = x.weight_kg;
    if (w == null) out.weightKg = null;
    else if (Array.isArray(w)) {
      const a = v.num(w[0], `${path}.weight_kg[0]`, 0, KETTLEBELL_MAX_KG, true), b = v.num(w[1], `${path}.weight_kg[1]`, 0, KETTLEBELL_MAX_KG, true);
      if (a != null && b != null) { if (a > b) v.err(`${path}.weight_kg`, 'начало диапазона больше конца'); out.weightKg = [a, b]; }
    } else {
      const a = v.num(w, `${path}.weight_kg`, 0, KETTLEBELL_MAX_KG);
      if (typeof w === 'number' && w > KETTLEBELL_MAX_KG) v.err(`${path}.weight_kg`, `гиря разборная до ${KETTLEBELL_MAX_KG} кг`);
      if (a != null) out.weightKg = [a, a];
    }
  }
  if ('note' in x) out.note = v.str(x.note, `${path}.note`, { max: 300 });
  if ('weight_note' in x) out.weightNote = v.str(x.weight_note, `${path}.weight_note`, { max: 200 });
  if ('occurrence' in x) out.occurrence = v.int(x.occurrence, `${path}.occurrence`, 1, 10) ?? 1;
  if (id && EXERCISES[id] && EXERCISES[id].equipment.some((e) => /гантел|штанг|скам|тренаж/i.test(e))) v.err(path, 'допустимы только степпер, гиря и собственный вес');
  return out;
}

function clampFrom(date: ISODate, today: ISODate, warnings: string[]): ISODate {
  if (date < today) {
    warnings.push(`Дата начала ${fmtShort(date)} уже прошла — изменение начнёт действовать с сегодняшнего дня (${fmtShort(today)}). Прошлые записи не меняются.`);
    return today;
  }
  return date;
}

function dayHasTrainingMarks(data: AppData, date: ISODate): boolean {
  const t = baseTasksForDate(data, date).find((x) => x.id === `train:${date}`);
  if (!t) return false;
  return !!data.trainingLogs[t.id] || !!data.taskMoves[t.id] || statusOf(data, t) !== 'planned';
}

function dayHasMealMarks(data: AppData, date: ISODate): boolean {
  return MEAL_SLOTS.some((s) => !!data.taskStatus[`meal:${date}:${s}`]);
}

function parseWorkoutTemplate(c: any, path: string, v: V, data: AppData, today: ISODate, base: Pick<ParsedChange, 'key' | 'index' | 'type' | 'reason'>): ParsedChange | null {
  const tid = v.str(c.template_id, `${path}.template_id`, { required: true, max: 30 }) as TemplateId | null;
  if (tid && !TEMPLATE_IDS.includes(tid)) v.err(`${path}.template_id`, `неизвестный шаблон «${tid}». Допустимо: ${TEMPLATE_IDS.join(', ')}`);
  const eff0 = v.date(c.effective_from, `${path}.effective_from`, true);
  const hasItems = c.items != null, hasUpdates = c.item_updates != null;
  if (!hasItems && !hasUpdates) v.err(path, 'нужно поле items (полный список упражнений) или item_updates (изменения отдельных упражнений)');
  if (hasItems && hasUpdates) v.err(path, 'укажите либо items, либо item_updates, но не оба');
  const items: any[] = [];
  if (hasItems && v.arr(c.items, `${path}.items`, 1, 20)) c.items.forEach((x: any, i: number) => items.push(parseItem(x, `${path}.items[${i}]`, v, false)));
  const updates: any[] = [];
  if (hasUpdates && v.arr(c.item_updates, `${path}.item_updates`, 1, 20)) c.item_updates.forEach((x: any, i: number) => updates.push(parseItem(x, `${path}.item_updates[${i}]`, v, true)));
  const name = v.str(c.name, `${path}.name`, { max: 60 });
  const description = v.str(c.description, `${path}.description`, { max: 400 });
  let restSec: [number, number] | null | undefined;
  if (c.rest_sec != null) {
    if (Array.isArray(c.rest_sec)) {
      const a = v.int(c.rest_sec[0], `${path}.rest_sec[0]`, 15, 300, true), b = v.int(c.rest_sec[1], `${path}.rest_sec[1]`, 15, 300, true);
      if (a != null && b != null) restSec = [a, b];
    } else v.err(`${path}.rest_sec`, 'ожидается диапазон [60, 90]');
  }
  if (!tid || !eff0 || v.errors.length) return null;
  const warnings: string[] = [];
  const eff = clampFrom(eff0, today, warnings);
  const cur = templateFor(data, tid, eff);
  if (!cur) { v.err(`${path}.template_id`, 'шаблон не найден в текущем плане'); return null; }

  let newItems: TemplateItem[];
  if (hasItems) {
    newItems = items.map((x) => ({
      exerciseId: x.exerciseId, sets: x.sets, reps: x.reps ?? null, seconds: x.seconds ?? null, minutes: x.minutes ?? null,
      perSide: x.perSide ?? EXERCISES[x.exerciseId]?.per_side ?? null, weightKg: x.weightKg ?? null, weightNote: x.weightNote ?? null, note: x.note ?? null,
    }));
  } else {
    newItems = cur.items.map((x) => ({ ...x }));
    for (const [i, u] of updates.entries()) {
      const occ = u.occurrence ?? 1;
      let seen = 0;
      const idx = newItems.findIndex((it) => it.exerciseId === u.exerciseId && ++seen === occ);
      if (idx < 0) { v.err(`${path}.item_updates[${i}].exercise_id`, `в шаблоне «${cur.name}» нет упражнения «${exerciseName(u.exerciseId)}»${occ > 1 ? ` (вхождение ${occ})` : ''}`); continue; }
      const { occurrence: _o, exerciseId: _e, ...patch } = u;
      newItems[idx] = { ...newItems[idx], ...patch };
    }
    if (v.errors.length) return null;
  }

  const lines: ChangeLine[] = [];
  let danger = false;
  const used = new Set<number>();
  newItems.forEach((it) => {
    const bi = cur.items.findIndex((b, j) => !used.has(j) && b.exerciseId === it.exerciseId);
    const before = bi >= 0 ? cur.items[bi] : undefined;
    if (bi >= 0) used.add(bi);
    const jump = loadJump(before, it);
    const changed = itemText(before) !== itemText(it) || (before?.note ?? null) !== (it.note ?? null);
    if (!changed && !jump) return;
    if (jump) danger = true;
    lines.push({ label: exerciseName(it.exerciseId), before: before ? itemText(before) : 'нет в шаблоне', after: itemText(it) + (it.note && it.note !== before?.note ? ` (${it.note})` : ''), danger: !!jump });
    if (jump) warnings.push(`${exerciseName(it.exerciseId)}: резкий рост нагрузки (${jump}). Применяйте только при чистой технике и без боли.`);
  });
  cur.items.forEach((b, j) => { if (!used.has(j)) lines.push({ label: exerciseName(b.exerciseId), before: itemText(b), after: 'убрано из шаблона' }); });
  if (name && name !== cur.name) lines.unshift({ label: 'Название', before: cur.name, after: name });
  if (restSec && (!cur.restSec || restSec.join() !== cur.restSec.join())) lines.push({ label: 'Отдых между подходами', before: cur.restSec ? `${cur.restSec[0]}–${cur.restSec[1]} сек` : '—', after: `${restSec[0]}–${restSec[1]} сек` });
  const totalBefore = cur.items.reduce((s, x) => s + x.sets, 0), totalAfter = newItems.reduce((s, x) => s + x.sets, 0);
  if (totalAfter > totalBefore * 1.5 && totalAfter - totalBefore >= 4) {
    danger = true;
    warnings.push(`Общее число подходов растёт с ${totalBefore} до ${totalAfter} — это резкий скачок объёма.`);
  }
  if (!lines.length) warnings.push('Шаблон совпадает с текущим — изменений нет.');

  const template: WorkoutTemplate = {
    ...cur, name: name || cur.name, description: description || cur.description, restSec: restSec ?? cur.restSec, items: newItems,
  };
  return {
    ...base, title: `${template.name}: новые подходы и веса`, effectiveFrom: eff, lines, warnings, danger, applicable: lines.length > 0,
    payload: { templateId: tid, effectiveFrom: eff, template },
  };
}

function parseCalendarTraining(c: any, path: string, v: V, data: AppData, today: ISODate, base: any): ParsedChange | null {
  if (!v.arr(c.days, `${path}.days`, 1, 400)) return null;
  const days: { date: ISODate; templateId: TrainingKind; time: string | null }[] = [];
  c.days.forEach((d: any, i: number) => {
    const p = `${path}.days[${i}]`;
    if (!v.obj(d, p)) return;
    const date = v.date(d.date, `${p}.date`);
    const tid = v.str(d.template_id, `${p}.template_id`, { required: true, max: 30 });
    if (tid && ![...TEMPLATE_IDS, 'rest'].includes(tid)) v.err(`${p}.template_id`, `неизвестный тип «${tid}». Допустимо: ${[...TEMPLATE_IDS, 'rest'].join(', ')}`);
    let time: string | null = null;
    if (d.time != null) { if (!isTime(d.time)) v.err(`${p}.time`, 'время в формате ЧЧ:ММ'); else time = d.time; }
    if (date && tid) days.push({ date, templateId: tid as TrainingKind, time });
  });
  if (v.errors.length) return null;
  const warnings: string[] = [];
  const lines: ChangeLine[] = [];
  const apply: typeof days = [];
  const seen = new Set<string>();
  for (const d of days) {
    if (seen.has(d.date)) { warnings.push(`${fmtShort(d.date)} указан несколько раз — берётся последний вариант.`); }
    seen.add(d.date);
    if (d.date < today) { warnings.push(`${fmtShort(d.date)} — дата прошла, не меняем.`); continue; }
    if (dayHasTrainingMarks(data, d.date)) { warnings.push(`${fmtShort(d.date)} — по тренировке уже есть отметки, день не меняем.`); continue; }
    const cur = data.planDays[d.date]?.training;
    const before = cur ? (cur.templateId === 'rest' ? 'отдых' : TEMPLATE_NAMES[cur.templateId] ?? cur.label) : 'нет плана';
    const after = (TEMPLATE_NAMES[d.templateId] ?? d.templateId) + (d.time ? `, ${d.time}` : '');
    if (cur && cur.templateId === d.templateId && (cur.time ?? null) === d.time) continue;
    lines.push({ label: fmtShort(d.date), before, after });
    apply.push(d);
  }
  const dedup = new Map(apply.map((d) => [d.date, d]));
  const sorted = [...dedup.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    ...base, title: `Расписание тренировок: ${sorted.length} ${sorted.length === 1 ? 'день' : 'дн.'}`,
    effectiveFrom: sorted[0]?.date ?? null, lines, warnings, danger: false, applicable: sorted.length > 0,
    payload: { days: sorted },
  };
}

function parseMealPlan(c: any, path: string, v: V, data: AppData, today: ISODate, base: any): ParsedChange | null {
  if (!v.arr(c.days, `${path}.days`, 1, 400)) return null;
  const days: any[] = [];
  c.days.forEach((d: any, i: number) => {
    const p = `${path}.days[${i}]`;
    if (!v.obj(d, p)) return;
    const date = v.date(d.date, `${p}.date`);
    const relax = d.relax_day === true;
    if (d.relax_day != null && typeof d.relax_day !== 'boolean') v.err(`${p}.relax_day`, 'ожидается true или false');
    const meals: Partial<Record<MealSlot, string>> = {};
    for (const s of MEAL_SLOTS) {
      const t = v.str(d[s], `${p}.${s}`, { max: 200 });
      if (t) meals[s] = t;
    }
    if (!relax && !Object.keys(meals).length) v.err(p, 'нужен хотя бы один приём пищи (breakfast, lunch, snack, dinner) или relax_day: true');
    const note = v.str(d.note, `${p}.note`, { max: 300 });
    const drinks = v.str(d.drinks, `${p}.drinks`, { max: 200 });
    if (date) days.push({ date, relax, meals, note, drinks });
  });
  if (v.errors.length) return null;
  const warnings: string[] = [];
  const lines: ChangeLine[] = [];
  const apply: any[] = [];
  for (const d of days) {
    if (d.date < today) { warnings.push(`${fmtShort(d.date)} — дата прошла, меню не меняем.`); continue; }
    if (dayHasMealMarks(data, d.date)) { warnings.push(`${fmtShort(d.date)} — уже есть отметки о еде, день не меняем.`); continue; }
    const cur = data.planDays[d.date];
    if (d.relax) {
      if (!cur?.relax) lines.push({ label: fmtShort(d.date), before: cur ? 'обычный день' : 'нет плана', after: 'релакс-день' });
    } else {
      for (const s of MEAL_SLOTS) {
        if (!d.meals[s]) continue;
        const before = cur?.meals?.[s] ?? (cur?.relax ? 'релакс-день' : 'нет плана');
        if (before === d.meals[s]) continue;
        lines.push({ label: `${fmtShort(d.date)} · ${MEAL_LABELS[s]}`, before, after: d.meals[s] });
      }
    }
    apply.push(d);
  }
  return {
    ...base, title: `Меню: ${apply.length} ${apply.length === 1 ? 'день' : 'дн.'}`, effectiveFrom: apply[0]?.date ?? null,
    lines, warnings, danger: false, applicable: apply.length > 0 && lines.length > 0, payload: { days: apply },
  };
}

function resolveDishRecipes(text: string): string[] {
  const n = normText(text);
  const e = SEED_MEAL_MAP.find((m) => m.scope === 'component' && m.match === n && (m.kind === 'exact' || m.kind === 'alias'));
  return e?.recipe_id ? [e.recipe_id] : [];
}

function parseMealPrep(c: any, path: string, v: V, data: AppData, today: ISODate, base: any): ParsedChange | null {
  if (!v.arr(c.events, `${path}.events`, 1, 60)) return null;
  const events: any[] = [];
  c.events.forEach((e: any, i: number) => {
    const p = `${path}.events[${i}]`;
    if (!v.obj(e, p)) return;
    const date = v.date(e.date, `${p}.date`);
    const action = e.action ?? 'upsert';
    if (!['upsert', 'remove'].includes(action)) v.err(`${p}.action`, 'допустимо: upsert или remove');
    const dishes: { text: string; recipeIds: string[] }[] = [];
    if (action === 'upsert' && v.arr(e.dishes, `${p}.dishes`, 1, 20)) {
      e.dishes.forEach((d: any, j: number) => {
        if (typeof d === 'string') { const t = v.str(d, `${p}.dishes[${j}]`, { required: true, max: 120 }); if (t) dishes.push({ text: t, recipeIds: resolveDishRecipes(t) }); return; }
        if (!v.obj(d, `${p}.dishes[${j}]`)) return;
        const t = v.str(d.text, `${p}.dishes[${j}].text`, { required: true, max: 120 });
        const ids: string[] = [];
        if (d.recipe_ids != null && v.arr(d.recipe_ids, `${p}.dishes[${j}].recipe_ids`, 0, 5)) {
          d.recipe_ids.forEach((rid: any, k: number) => {
            if (typeof rid !== 'string' || !recipeById(data, rid)) v.err(`${p}.dishes[${j}].recipe_ids[${k}]`, `рецепт «${String(rid)}» не найден в приложении`);
            else ids.push(rid);
          });
        }
        if (t) dishes.push({ text: t, recipeIds: ids.length ? ids : resolveDishRecipes(t) });
      });
    }
    const forDates: ISODate[] = [];
    if (e.for_dates != null && v.arr(e.for_dates, `${p}.for_dates`, 0, 14)) e.for_dates.forEach((x: any, k: number) => { const d = v.date(x, `${p}.for_dates[${k}]`); if (d) forDates.push(d); });
    const forText = v.str(e.for_days_text, `${p}.for_days_text`, { max: 100 });
    const storage = v.str(e.storage, `${p}.storage`, { max: 300 });
    const title = v.str(e.title, `${p}.title`, { max: 80 });
    if (date) events.push({ date, action, dishes, forDates, forText, storage, title });
  });
  if (v.errors.length) return null;
  const warnings: string[] = [];
  const lines: ChangeLine[] = [];
  const apply: any[] = [];
  for (const e of events) {
    if (e.date < today) { warnings.push(`${fmtShort(e.date)} — дата прошла, готовку не меняем.`); continue; }
    const cur = Object.values(data.cookingEvents).filter((x) => x.date === e.date && x.eventType === 'meal_prep');
    const before = cur.length ? cur.map((x) => x.dishes.map((d) => d.text).join(', ')).join('; ') : 'нет готовки';
    const after = e.action === 'remove' ? 'готовка отменена' : e.dishes.map((d: any) => d.text).join(', ');
    if (before === after) continue;
    lines.push({ label: `Готовка ${fmtShort(e.date)}`, before, after });
    apply.push(e);
  }
  return {
    ...base, title: `Готовка: ${apply.length} ${apply.length === 1 ? 'событие' : 'соб.'}`, effectiveFrom: apply[0]?.date ?? null,
    lines, warnings, danger: false, applicable: apply.length > 0, payload: { events: apply },
  };
}

function parseShopping(c: any, path: string, v: V, data: AppData, today: ISODate, base: any): ParsedChange | null {
  if (!v.arr(c.events, `${path}.events`, 1, 12)) return null;
  const events: any[] = [];
  c.events.forEach((e: any, i: number) => {
    const p = `${path}.events[${i}]`;
    if (!v.obj(e, p)) return;
    const date = v.date(e.date, `${p}.date`);
    const action = e.action ?? 'upsert';
    if (!['upsert', 'remove'].includes(action)) v.err(`${p}.action`, 'допустимо: upsert или remove');
    const title = v.str(e.title, `${p}.title`, { max: 80 });
    const forText = v.str(e.for_dates_text, `${p}.for_dates_text`, { max: 60 });
    const items: ShoppingItem[] = [];
    if (action === 'upsert' && v.arr(e.items, `${p}.items`, 1, 200)) {
      e.items.forEach((it: any, j: number) => {
        const q = `${p}.items[${j}]`;
        if (!v.obj(it, q)) return;
        const name = v.str(it.name, `${q}.name`, { required: true, max: 80 });
        const unit = v.str(it.unit, `${q}.unit`, { required: true, max: 12 });
        const qty = v.num(it.qty, `${q}.qty`, 0, 1000, true);
        const category = v.str(it.category, `${q}.category`, { max: 30 }) || 'Прочее';
        const ppu = v.num(it.price_per_unit_rub, `${q}.price_per_unit_rub`, 0, 100000);
        let est = v.num(it.price_estimate_rub, `${q}.price_estimate_rub`, 0, 100000);
        if (est == null && ppu != null && qty != null) est = Math.round(ppu * qty * 100) / 100;
        const note = v.str(it.note, `${q}.note`, { max: 160 });
        if (name && unit && qty != null) items.push({ itemId: `i${String(j + 1).padStart(3, '0')}`, category, name, unit, qty, pricePerUnit: ppu, priceEstimate: est, note });
      });
    }
    if (date) events.push({ date, action, title, forText, items });
  });
  if (v.errors.length) return null;
  const warnings: string[] = [];
  const lines: ChangeLine[] = [];
  const apply: any[] = [];
  for (const e of events) {
    if (e.date < today) { warnings.push(`${fmtShort(e.date)} — дата прошла, закупку не меняем.`); continue; }
    const cur = Object.values(data.shoppingEvents).filter((x) => x.date === e.date);
    const before = cur.length ? cur.map((x) => `${x.title}: ${x.items.length} поз.`).join('; ') : 'нет закупки';
    const total = e.items.reduce((s: number, it: ShoppingItem) => s + (it.priceEstimate ?? 0), 0);
    const after = e.action === 'remove' ? 'закупка отменена' : `${e.title || 'Закупка'}: ${e.items.length} поз., ориентир ${Math.round(total).toLocaleString('ru-RU')} ₽`;
    lines.push({ label: `Закупка ${fmtShort(e.date)}`, before, after });
    apply.push(e);
  }
  return {
    ...base, title: `Закупки: ${apply.length}`, effectiveFrom: apply[0]?.date ?? null,
    lines, warnings, danger: false, applicable: apply.length > 0, payload: { events: apply },
  };
}

function parseGoal(c: any, path: string, v: V, data: AppData, _today: ISODate, base: any): ParsedChange | null {
  const g = data.settings.goals;
  const target = v.num(c.target_weight_kg, `${path}.target_weight_kg`, 40, 250);
  const start = v.num(c.start_weight_kg, `${path}.start_weight_kg`, 40, 300);
  const kcal = v.int(c.kcal_reference, `${path}.kcal_reference`, 1200, 5000);
  if (target == null && start == null && kcal == null) v.err(path, 'нужно хотя бы одно поле: target_weight_kg, start_weight_kg, kcal_reference');
  if (v.errors.length) return null;
  const lines: ChangeLine[] = [];
  const warnings: string[] = [];
  let danger = false;
  if (target != null && target !== g.targetWeightKg) lines.push({ label: 'Целевой вес', before: `${fmtNum(g.targetWeightKg)} кг`, after: `${fmtNum(target)} кг` });
  if (start != null && start !== g.startWeightKg) lines.push({ label: 'Стартовый вес', before: `${fmtNum(g.startWeightKg)} кг`, after: `${fmtNum(start)} кг` });
  if (kcal != null && kcal !== g.kcalReference) {
    const jump = kcal < 1800 || Math.abs(kcal - g.kcalReference) > 300;
    if (jump) { danger = true; warnings.push(`Ориентир калорий меняется резко (${g.kcalReference} → ${kcal}). Применяйте осознанно, без экстремальных диет.`); }
    lines.push({ label: 'Ориентир, ккал/сутки', before: String(g.kcalReference), after: String(kcal), danger: jump });
  }
  return {
    ...base, title: 'Цели', effectiveFrom: null, lines, warnings, danger, applicable: lines.length > 0,
    payload: { goals: { startWeightKg: start ?? g.startWeightKg, targetWeightKg: target ?? g.targetWeightKg, kcalReference: kcal ?? g.kcalReference } as Goals },
  };
}

// ------------------------------------------------------------------ точка входа

export function parsePlanUpdate(text: string, data: AppData, today: ISODate): ParseResult {
  if (text.length > MAX_FILE_CHARS) return { ok: false, errors: [{ path: 'файл', message: 'файл слишком большой (больше 2 МБ)' }] };
  let root: any;
  try {
    root = JSON.parse(text.replace(/^﻿/, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (e: any) {
    return { ok: false, errors: [{ path: 'файл', message: `это не JSON: ${e?.message || e}` }] };
  }
  const v = new V();
  if (!v.obj(root, '$')) return { ok: false, errors: v.errors };
  scanStrings(root, '$', v);
  const sv = root.schema_version;
  if (typeof sv !== 'string' || !/^\d+\.\d+\.\d+$/.test(sv)) v.err('$.schema_version', 'нужна версия схемы, например "1.0.0"');
  else if (sv.split('.')[0] !== PLAN_UPDATE_SCHEMA_VERSION.split('.')[0]) v.err('$.schema_version', `версия ${sv} не поддерживается (приложение понимает ${PLAN_UPDATE_SCHEMA_VERSION.split('.')[0]}.x)`);
  if (root.update_type !== 'plan_update') v.err('$.update_type', 'должно быть "plan_update"');
  const title = v.str(root.title, '$.title', { max: 200 }) || 'Обновление плана';
  const summary = v.str(root.summary, '$.summary', { max: 3000 }) || '';
  if (v.errors.length) return { ok: false, errors: v.errors };
  if (!v.arr(root.changes, '$.changes', 1, 200)) return { ok: false, errors: v.errors };

  const known = new Set(['schema_version', 'update_type', 'title', 'summary', 'changes', 'based_on_period', 'created_by', 'created_at', 'notes']);
  const warnings: string[] = Object.keys(root).filter((k) => !known.has(k)).map((k) => `Поле «${k}» не используется и будет проигнорировано.`);

  const changes: ParsedChange[] = [];
  root.changes.forEach((c: any, i: number) => {
    const path = `$.changes[${i}]`;
    if (!v.obj(c, path)) return;
    const type = c.type;
    if (!CHANGE_TYPES.includes(type)) { v.err(`${path}.type`, `неизвестный тип изменения «${String(type).slice(0, 40)}». Допустимо: ${CHANGE_TYPES.join(', ')}`); return; }
    const reason = v.str(c.reason, `${path}.reason`, { max: 1000 });
    const base = { key: `c${i}`, index: i, type, reason };
    const before = v.errors.length;
    let parsed: ParsedChange | null = null;
    switch (type as ChangeType) {
      case 'workout_template': parsed = parseWorkoutTemplate(c, path, v, data, today, base); break;
      case 'calendar_training': parsed = parseCalendarTraining(c, path, v, data, today, base); break;
      case 'meal_plan': parsed = parseMealPlan(c, path, v, data, today, base); break;
      case 'meal_prep_event': parsed = parseMealPrep(c, path, v, data, today, base); break;
      case 'shopping_event': parsed = parseShopping(c, path, v, data, today, base); break;
      case 'goal': parsed = parseGoal(c, path, v, data, today, base); break;
    }
    if (parsed && v.errors.length === before) changes.push(parsed);
  });
  if (v.errors.length) return { ok: false, errors: v.errors };
  return { ok: true, title, summary, schemaVersion: sv, changes, warnings };
}

// ------------------------------------------------------------------ применение и откат

export function planSnapshot(data: AppData): PlanSnapshot {
  return {
    planDays: Object.values(data.planDays),
    templateVersions: Object.values(data.templateVersions),
    shoppingEvents: Object.values(data.shoppingEvents),
    cookingEvents: Object.values(data.cookingEvents),
    goals: { ...data.settings.goals },
  };
}

function summaryOf(c: ParsedChange): ChangeSummary {
  return { id: c.key, type: c.type, title: c.title, effectiveFrom: c.effectiveFrom, reason: c.reason, lines: c.lines };
}

export function buildApplyOps(
  data: AppData, parsed: Extract<ParseResult, { ok: true }>, selected: Set<string>, fileName: string, now: string, patchId: string,
): { ops: Op[]; record: PatchRecord } {
  const ops: Op[] = [];
  const days = new Map<ISODate, PlanDay>();
  const getDay = (date: ISODate): PlanDay => {
    if (days.has(date)) return days.get(date)!;
    const cur = data.planDays[date];
    const d: PlanDay = cur ? { ...cur } : { date, source: 'import', patchId, dayNumber: null, relax: false, meals: null, training: null };
    days.set(date, d);
    return d;
  };
  const applied: ChangeSummary[] = [], rejected: ChangeSummary[] = [];
  let goals: Goals | null = null;

  for (const c of parsed.changes) {
    if (!selected.has(c.key) || !c.applicable) { rejected.push(summaryOf(c)); continue; }
    applied.push(summaryOf(c));
    const p = c.payload;
    switch (c.type) {
      case 'workout_template': {
        const tv: TemplateVersion = {
          id: `${p.templateId}@${patchId}`, templateId: p.templateId, effectiveFrom: p.effectiveFrom, template: p.template,
          source: 'import', patchId, reason: c.reason, createdAt: now,
        };
        ops.push({ store: 'templateVersions', put: tv });
        break;
      }
      case 'calendar_training':
        for (const d of p.days) {
          const day = getDay(d.date);
          day.training = { templateId: d.templateId, label: TEMPLATE_NAMES[d.templateId] ?? d.templateId, time: d.time };
          day.patchId = patchId;
        }
        break;
      case 'meal_plan':
        for (const d of p.days) {
          const day = getDay(d.date);
          day.relax = d.relax;
          if (d.relax) {
            day.meals = null;
            if (!day.training) day.training = { templateId: 'rest', label: 'Релакс-день / отдых' };
          } else {
            const base = day.meals ?? ({} as Record<MealSlot, string>);
            day.meals = { ...base, ...d.meals } as Record<MealSlot, string>;
          }
          if (d.note) day.note = d.note;
          if (d.drinks) day.drinks = d.drinks;
          day.patchId = patchId;
        }
        break;
      case 'meal_prep_event':
        for (const e of p.events) {
          for (const x of Object.values(data.cookingEvents)) if (x.date === e.date && x.eventType === 'meal_prep') ops.push({ store: 'cookingEvents', del: x.id });
          if (e.action === 'remove') continue;
          const ev: CookingEvent = {
            id: `cook-${e.date}-${patchId}`, date: e.date, eventType: 'meal_prep', title: e.title || 'Готовка',
            sourceText: e.dishes.map((d: any) => d.text).join('; '), forDaysText: e.forText || (e.forDates.length ? `На ${e.forDates.map(fmtShort).join(', ')}` : ''),
            forDates: e.forDates, storage: e.storage || 'Порционно остудить; хранить до 3 дней; лишнее — в морозилку',
            dishes: e.dishes.map((d: any) => ({ text: d.text, recipeIds: d.recipeIds, comment: null })), source: 'import', patchId,
          };
          ops.push({ store: 'cookingEvents', put: ev });
        }
        break;
      case 'shopping_event':
        for (const e of p.events) {
          for (const x of Object.values(data.shoppingEvents)) if (x.date === e.date) ops.push({ store: 'shoppingEvents', del: x.id });
          if (e.action === 'remove') continue;
          const ev: ShoppingEvent = {
            id: `shop-${e.date}-${patchId}`, date: e.date, title: e.title || 'Закупка', forDatesText: e.forText, items: e.items, source: 'import', patchId,
          };
          ops.push({ store: 'shoppingEvents', put: ev });
        }
        break;
      case 'goal':
        goals = p.goals;
        break;
    }
  }
  for (const d of days.values()) ops.push({ store: 'planDays', put: d });
  if (goals) ops.push({ store: 'settings', put: { ...data.settings, goals } });

  const record: PatchRecord = {
    id: patchId, importedAt: now, fileName, title: parsed.title, summary: parsed.summary, schemaVersion: parsed.schemaVersion,
    status: 'applied', applied, rejected, snapshot: planSnapshot(data), rolledBackAt: null,
  };
  ops.push({ store: 'patches', put: record });
  return { ops, record };
}

/** Последнее применённое обновление — откатывать можно только его (иначе сломается порядок изменений). */
export function latestAppliedPatch(data: AppData): PatchRecord | null {
  const ps = Object.values(data.patches).filter((p) => p.status === 'applied').sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  return ps[0] ?? null;
}

export function rollbackOps(data: AppData, patchId: string, now: string): Op[] {
  const p = data.patches[patchId];
  if (!p || p.status !== 'applied') throw new Error('Обновление уже откатано или не найдено');
  const latest = latestAppliedPatch(data);
  if (latest?.id !== patchId) throw new Error('Сначала откатите более позднее обновление');
  const ops: Op[] = [];
  for (const s of ['planDays', 'templateVersions', 'shoppingEvents', 'cookingEvents'] as const) ops.push({ store: s, clear: true });
  for (const d of p.snapshot.planDays) ops.push({ store: 'planDays', put: d });
  for (const t of p.snapshot.templateVersions) ops.push({ store: 'templateVersions', put: t });
  for (const e of p.snapshot.shoppingEvents) ops.push({ store: 'shoppingEvents', put: e });
  for (const e of p.snapshot.cookingEvents) ops.push({ store: 'cookingEvents', put: e });
  ops.push({ store: 'settings', put: { ...data.settings, goals: p.snapshot.goals } });
  ops.push({ store: 'patches', put: { ...p, status: 'rolled_back', rolledBackAt: now } });
  return ops;
}

/** Текущие шаблоны в формате схемы импорта — для отчёта и подсказки ChatGPT. */
export function templatesForExport(data: AppData, date: ISODate) {
  return TEMPLATE_IDS.map((tid) => {
    const v = templateVersionFor(data, tid, date);
    const t = v?.template;
    return {
      template_id: tid,
      name: t?.name ?? TEMPLATE_NAMES[tid],
      effective_from: v?.effectiveFrom === '1970-01-01' ? null : v?.effectiveFrom ?? null,
      rest_sec: t?.restSec ?? null,
      items: (t?.items ?? []).map((it) => ({
        exercise_id: it.exerciseId, name: exerciseName(it.exerciseId), sets: it.sets, reps: it.reps ?? null, seconds: it.seconds ?? null,
        minutes: it.minutes ?? null, per_side: it.perSide ?? null, weight_kg: it.weightKg ?? null, note: it.note ?? null,
      })),
    };
  });
}
