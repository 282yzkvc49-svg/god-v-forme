// Все изменения данных проходят через эти функции → commit() → IndexedDB.
import { commit, forgetPhotoURL, getData, putPhotoBlob } from './store';
import type { Op } from './idb';
import type {
  CustomTask, Difficulty, ExerciseLog, ExportRecord, Feeling, MealMapEntry, PhotoMeta, PhotoPose, Recipe, Settings,
  TaskStatus, TemplateId, TrainingLog,
} from './types';
import type { DayTask } from '../domain/tasks';
import { templateVersionFor } from '../domain/templates';
import { processPhoto } from '../lib/image';
import { nowStamp, uid } from '../lib/util';
import type { ISODate } from '../lib/dates';

// ------------------------------------------------------------------ задачи

export function setTaskStatus(t: DayTask, status: TaskStatus) {
  if (status === 'planned') return commit([{ store: 'taskStatus', del: t.id }]);
  return commit([{ store: 'taskStatus', put: { taskId: t.id, date: t.originDate, kind: t.kind, status, updatedAt: nowStamp() } }]);
}

export function moveTask(t: DayTask, toDate: ISODate) {
  if (toDate === t.originDate) return commit([{ store: 'taskMoves', del: t.id }]);
  return commit([{ store: 'taskMoves', put: { taskId: t.id, kind: t.kind, fromDate: t.originDate, toDate, movedAt: nowStamp() } }]);
}

export function addCustomTask(input: Omit<CustomTask, 'id' | 'createdAt'>) {
  const rec: CustomTask = { ...input, id: uid('t'), createdAt: nowStamp() };
  return commit([{ store: 'customTasks', put: rec }]);
}

export function deleteCustomTask(id: string) {
  const taskId = `custom:${id}`;
  return commit([
    { store: 'customTasks', del: id },
    { store: 'taskStatus', del: taskId },
    { store: 'taskMoves', del: taskId },
  ]);
}

// ------------------------------------------------------------------ тренировки

function newLog(t: DayTask, status: TrainingLog['status'], actualDate: ISODate): TrainingLog | null {
  const d = getData();
  const tid = t.templateId as TemplateId;
  const v = templateVersionFor(d, tid, t.originDate) ?? templateVersionFor(d, tid, actualDate);
  if (!v) return null;
  const exercises: ExerciseLog[] = v.template.items.map((it, index) => ({
    index, exerciseId: it.exerciseId, sets: Array.from({ length: Math.max(1, it.sets || 1) }, () => false),
    weightKg: null, difficulty: null, minutes: null,
  }));
  const now = nowStamp();
  return {
    id: t.id, plannedDate: t.originDate, date: actualDate, templateId: tid, templateVersionId: v.id, templateSnapshot: v.template, status,
    startedAt: status === 'in_progress' ? now : null, finishedAt: null, feeling: null, note: null, stepperMinutes: null,
    exercises, quick: false, updatedAt: now,
  };
}

export function ensureTrainingLog(t: DayTask, actualDate: ISODate): TrainingLog | null {
  const d = getData();
  const existing = d.trainingLogs[t.id];
  if (existing) return existing;
  const log = newLog(t, 'in_progress', actualDate);
  if (log) commit([{ store: 'trainingLogs', put: log }]);
  return log;
}

export function saveTrainingLog(log: TrainingLog) {
  return commit([{ store: 'trainingLogs', put: { ...log, updatedAt: nowStamp() } }]);
}

export function updateExerciseLog(logId: string, index: number, patch: Partial<ExerciseLog>) {
  const log = getData().trainingLogs[logId];
  if (!log) return;
  const exercises = log.exercises.map((e) => (e.index === index ? { ...e, ...patch } : e));
  const status = log.status === 'skipped' && patch.sets?.some(Boolean) ? 'in_progress' : log.status;
  return saveTrainingLog({ ...log, exercises, status });
}

export function finishTraining(logId: string, feeling: Feeling | null, note: string | null, stepperMinutes?: number | null) {
  const log = getData().trainingLogs[logId];
  if (!log) return;
  return saveTrainingLog({
    ...log, status: 'done', feeling, note: note?.trim() || null, finishedAt: nowStamp(),
    stepperMinutes: stepperMinutes ?? log.stepperMinutes ?? null,
  });
}

/** Быстрая отметка «выполнено» без подробностей по подходам. */
export function quickDoneTraining(t: DayTask, actualDate: ISODate) {
  const d = getData();
  const existing = d.trainingLogs[t.id];
  const log = existing ?? newLog(t, 'done', actualDate);
  if (!log) return;
  const anySet = log.exercises.some((e) => e.sets.some(Boolean));
  return saveTrainingLog({ ...log, status: 'done', quick: !anySet, finishedAt: nowStamp(), date: existing?.date || actualDate });
}

export function skipTraining(t: DayTask, actualDate: ISODate) {
  const d = getData();
  const log = d.trainingLogs[t.id] ?? newLog(t, 'skipped', actualDate);
  if (!log) return;
  return saveTrainingLog({ ...log, status: 'skipped' });
}

/** Снять отметку (вернуть в «запланировано»). Подробные данные подходов удаляются только по явному действию. */
export function resetTraining(id: string) {
  return commit([{ store: 'trainingLogs', del: id }, { store: 'taskStatus', del: id }]);
}

export function reopenTraining(id: string) {
  const log = getData().trainingLogs[id];
  if (!log) return;
  return saveTrainingLog({ ...log, status: 'in_progress', finishedAt: null });
}

export function setExerciseDifficulty(logId: string, index: number, difficulty: Difficulty | null) {
  return updateExerciseLog(logId, index, { difficulty });
}

// ------------------------------------------------------------------ вес, талия, фото

export function addWeight(date: ISODate, kg: number, note?: string | null) {
  return commit([{ store: 'weights', put: { id: uid('w'), date, kg, note: note || null, createdAt: nowStamp() } }]);
}
export function updateWeight(id: string, date: ISODate, kg: number) {
  const w = getData().weights[id];
  if (!w) return;
  return commit([{ store: 'weights', put: { ...w, date, kg } }]);
}
export function deleteWeight(id: string) {
  return commit([{ store: 'weights', del: id }]);
}

export function addWaist(date: ISODate, waistCm: number) {
  return commit([{ store: 'measurements', put: { id: uid('m'), date, waistCm, createdAt: nowStamp() } }]);
}
export function deleteWaist(id: string) {
  return commit([{ store: 'measurements', del: id }]);
}

export async function addPhoto(file: File, date: ISODate, pose: PhotoPose | null): Promise<PhotoMeta> {
  const maxSide = getData().settings.photoMaxSide;
  const p = await processPhoto(file, maxSide);
  const id = uid('p');
  const meta: PhotoMeta = {
    id, date, pose, width: p.width, height: p.height, bytes: p.full.size, type: p.type, createdAt: nowStamp(),
  };
  await putPhotoBlob({ id, full: p.full, thumb: p.thumb }, [{ store: 'photos', put: meta }]);
  return meta;
}

export function updatePhoto(id: string, patch: Partial<Pick<PhotoMeta, 'date' | 'pose'>>) {
  const p = getData().photos[id];
  if (!p) return;
  return commit([{ store: 'photos', put: { ...p, ...patch } }]);
}

export function deletePhoto(id: string) {
  forgetPhotoURL(id);
  return commit([{ store: 'photos', del: id }, { store: 'photoBlobs', del: id }]);
}

export function deleteAllPhotos() {
  for (const id of Object.keys(getData().photos)) forgetPhotoURL(id);
  return commit([{ store: 'photos', clear: true }, { store: 'photoBlobs', clear: true }]);
}

// ------------------------------------------------------------------ закупки и чек-листы

export function setBought(eventId: string, itemId: string, bought: boolean) {
  const id = `${eventId}:${itemId}`;
  const prev = getData().shoppingChecks[id];
  return commit([{ store: 'shoppingChecks', put: { id, eventId, itemId, actualPrice: prev?.actualPrice ?? null, bought, updatedAt: nowStamp() } }]);
}

export function setActualPrice(eventId: string, itemId: string, price: number | null) {
  const id = `${eventId}:${itemId}`;
  const prev = getData().shoppingChecks[id];
  return commit([{ store: 'shoppingChecks', put: { id, eventId, itemId, bought: prev?.bought ?? false, actualPrice: price, updatedAt: nowStamp() } }]);
}

export function setAllBought(eventId: string, itemIds: string[], bought: boolean) {
  const d = getData();
  const ops: Op[] = itemIds.map((itemId) => {
    const id = `${eventId}:${itemId}`;
    const prev = d.shoppingChecks[id];
    return { store: 'shoppingChecks', put: { id, eventId, itemId, actualPrice: prev?.actualPrice ?? null, bought, updatedAt: nowStamp() } };
  });
  return commit(ops);
}

export function setCheck(id: string, done: boolean) {
  if (!done) return commit([{ store: 'checks', del: id }]);
  return commit([{ store: 'checks', put: { id, done: true, updatedAt: nowStamp() } }]);
}

export function resetChecks(prefix: string) {
  const ops: Op[] = Object.keys(getData().checks).filter((k) => k.startsWith(prefix)).map((k) => ({ store: 'checks', del: k }));
  return commit(ops);
}

export function setDayNote(date: ISODate, text: string) {
  if (!text.trim()) return commit([{ store: 'dayNotes', del: date }]);
  return commit([{ store: 'dayNotes', put: { date, text, updatedAt: nowStamp() } }]);
}

// ------------------------------------------------------------------ рецепты

export function saveUserRecipe(r: Omit<Recipe, 'id' | 'user' | 'createdAt' | 'source'> & { id?: string }, linkKey?: string | null) {
  const id = r.id || uid('r');
  const rec: Recipe = { ...r, id, user: true, createdAt: nowStamp(), source: 'Добавлено вручную' } as Recipe;
  const ops: Op[] = [{ store: 'userRecipes', put: rec }];
  if (linkKey) {
    const [scope, ...rest] = linkKey.split('|');
    const link: MealMapEntry = { id: linkKey, match: rest.join('|'), scope: scope as MealMapEntry['scope'], kind: 'exact', recipe_id: id, comment: 'Рецепт добавлен вручную', user: true };
    ops.push({ store: 'mealLinks', put: link });
  }
  return commit(ops).then(() => id);
}

export function linkMealToRecipe(linkKey: string, recipeId: string) {
  const [scope, ...rest] = linkKey.split('|');
  const link: MealMapEntry = { id: linkKey, match: rest.join('|'), scope: scope as MealMapEntry['scope'], kind: 'exact', recipe_id: recipeId, comment: 'Связь подтверждена вручную', user: true };
  return commit([{ store: 'mealLinks', put: link }]);
}

export function deleteUserRecipe(id: string) {
  const d = getData();
  const ops: Op[] = [{ store: 'userRecipes', del: id }];
  for (const l of Object.values(d.mealLinks)) if (l.recipe_id === id) ops.push({ store: 'mealLinks', del: l.id! });
  return commit(ops);
}

// ------------------------------------------------------------------ настройки и история

export function updateSettings(patch: Partial<Settings>) {
  return commit([{ store: 'settings', put: { ...getData().settings, ...patch } }]);
}

export function addExportRecord(rec: Omit<ExportRecord, 'id' | 'createdAt'>) {
  return commit([{ store: 'exportHistory', put: { ...rec, id: uid('x'), createdAt: nowStamp() } }]);
}

export function deleteExportRecord(id: string) {
  return commit([{ store: 'exportHistory', del: id }]);
}

/** Удалить пользовательские записи за период (план и рецепты не трогаются). */
export function deleteDataForPeriod(from: ISODate, to: ISODate) {
  const d = getData();
  const inR = (x?: string | null) => !!x && x >= from && x <= to;
  const ops: Op[] = [];
  for (const r of Object.values(d.taskStatus)) if (inR(r.date)) ops.push({ store: 'taskStatus', del: r.taskId });
  for (const r of Object.values(d.taskMoves)) if (inR(r.fromDate) || inR(r.toDate)) ops.push({ store: 'taskMoves', del: r.taskId });
  for (const r of Object.values(d.customTasks)) if (inR(r.date)) ops.push({ store: 'customTasks', del: r.id });
  for (const r of Object.values(d.trainingLogs)) if (inR(r.date) || inR(r.plannedDate)) ops.push({ store: 'trainingLogs', del: r.id });
  for (const r of Object.values(d.weights)) if (inR(r.date)) ops.push({ store: 'weights', del: r.id });
  for (const r of Object.values(d.measurements)) if (inR(r.date)) ops.push({ store: 'measurements', del: r.id });
  for (const r of Object.values(d.photos)) if (inR(r.date)) {
    forgetPhotoURL(r.id);
    ops.push({ store: 'photos', del: r.id }, { store: 'photoBlobs', del: r.id });
  }
  for (const r of Object.values(d.dayNotes)) if (inR(r.date)) ops.push({ store: 'dayNotes', del: r.date });
  for (const r of Object.values(d.shoppingChecks)) if (inR(d.shoppingEvents[r.eventId]?.date)) ops.push({ store: 'shoppingChecks', del: r.id });
  for (const k of Object.keys(d.checks)) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(k);
    if (m && inR(m[1])) ops.push({ store: 'checks', del: k });
  }
  return commit(ops).then(() => ops.length);
}
