// Все изменения данных проходят через эти функции → commit() → IndexedDB.
import { commit, forgetPhotoURL, getData, putPhotoBlob } from './store';
import type { Op } from './idb';
import type {
  AvProductRec, ProductSub, CookingEvent, StockMove, StockRec,
  CustomTask, Difficulty, ExerciseLog, ExportRecord, Feeling, MealMapEntry, PhotoMeta, PhotoPose, PlanSettings, Recipe, Settings,
  TaskStatus, TemplateId, TrainingLog,
} from './types';
import { replanOps } from '../domain/plan';
import { applyOps as applyToData } from './model';
import { cookStockOps, emptyStock, mealStockOps, readyFoodOps, stockRemaining, type ReadyPortion } from '../domain/stock';
import { buildCorrection, correctionApplied, revisionBlocked, type CorrectionInput } from '../domain/correction';
import { productCheckOps, resetChecksOps } from '../domain/avCheck';
import { menuUpdateOps, rollbackMenuOps } from './model';
import { applyTripMoveOps, planTripMove } from '../domain/tripMove';
import { today as todayFn } from '../lib/clock';
import type { DayTask } from '../domain/tasks';
import { templateVersionFor } from '../domain/templates';
import { processPhoto } from '../lib/image';
import { nowStamp, uid } from '../lib/util';
import type { ISODate } from '../lib/dates';

// ------------------------------------------------------------------ задачи

export function setTaskStatus(t: DayTask, status: TaskStatus) {
  const data = getData();
  const now = nowStamp();
  const ops: Op[] = status === 'planned'
    ? [{ store: 'taskStatus', del: t.id }]
    : [{ store: 'taskStatus', put: { taskId: t.id, date: t.originDate, kind: t.kind, status, updatedAt: now } }];
  // учёт запасов: «Съедено» и «Приготовлено» списывают продукты по факту, снятая отметка — возвращает
  if (t.kind === 'meal' && t.slot) ops.push(...mealStockOps(data, t.originDate, t.slot, status, now));
  if (t.kind === 'cooking' && t.eventId && data.cookingEvents[t.eventId]) ops.push(...cookStockOps(data, data.cookingEvents[t.eventId], status === 'done', now).ops);
  return commit(ops);
}

// ------------------------------------------------------------------ запасы

/** Готовка по факту: «Приготовлено» (с заменами из проверки продуктов) или «Отменена» — продукты остаются. */
export function markCooked(e: CookingEvent, replace: Record<string, string>) {
  const data = getData();
  const now = nowStamp();
  const r = cookStockOps(data, e, true, now, replace);
  return commit([{ store: 'taskStatus', put: { taskId: `cook:${e.id}`, date: e.date, kind: 'cooking', status: 'done', updatedAt: now } }, ...r.ops]).then(() => r.deficits);
}

export function cancelCook(e: CookingEvent) {
  const data = getData();
  const now = nowStamp();
  return commit([{ store: 'taskStatus', put: { taskId: `cook:${e.id}`, date: e.date, kind: 'cooking', status: 'skipped', updatedAt: now } }, ...cookStockOps(data, e, false, now).ops]);
}

let mvSeq = 0;
const mv = (now: string, kind: StockMove['kind'], qty: number, note: string): StockMove => ({ id: `mv-${now.replace(/[^0-9]/g, '').slice(0, 14)}-u${(++mvSeq).toString(36)}`, date: todayFn(), kind, qty, source: 'manual', note, confirmed: true, at: now });

/** Пересчитать будущие закупки по запасам (прошедшее и отмеченное не меняется). */
export function recalcFromStock(extra: Op[] = []) {
  const data0 = getData();
  const cfg = data0.settings.plan;
  if (!cfg || !data0.settings.inventory) return commit(extra).then(() => [] as string[]);
  const data = extra.length ? applyToData(data0, extra) : data0;
  const rp = replanOps(data, cfg, todayFn(), { keepPast: true, now: nowStamp() });
  return commit([...extra, ...rp.ops]).then(() => rp.conflicts ?? []);
}

/** Исправить остаток вручную (подтверждён). */
export function setStockRemaining(productId: string, qty: number) {
  const data = getData();
  const now = nowStamp();
  const rec = data.stock[productId] ?? emptyStock(productId, now);
  const have = stockRemaining(data, productId);
  const delta = Math.round((qty - have) * 10) / 10;
  const put: StockRec = { ...rec, confirmedAt: now, updatedAt: now, moves: Math.abs(delta) > 0.05 ? [...rec.moves, mv(now, 'adjust', delta, 'Остаток исправлен вручную')] : rec.moves };
  return recalcFromStock([{ store: 'stock', put }]);
}

export function confirmStock(productId: string) {
  const rec = getData().stock[productId];
  if (!rec) return Promise.resolve([] as string[]);
  return commit([{ store: 'stock', put: { ...rec, confirmedAt: nowStamp(), updatedAt: nowStamp() } }]).then(() => [] as string[]);
}

export function updateStock(productId: string, patch: Partial<Pick<StockRec, 'expiresOn' | 'location' | 'note'>>) {
  const rec = getData().stock[productId] ?? emptyStock(productId, nowStamp());
  return recalcFromStock([{ store: 'stock', put: { ...rec, ...patch, updatedAt: nowStamp() } }]);
}

/** Списать (испорчено): весь остаток или часть. */
export function writeOffStock(productId: string, qty: number, note = 'Испорчено — списано') {
  const data = getData();
  const rec = data.stock[productId];
  if (!rec || !(qty > 0)) return Promise.resolve([] as string[]);
  const now = nowStamp();
  return recalcFromStock([{ store: 'stock', put: { ...rec, updatedAt: now, moves: [...rec.moves, mv(now, 'writeoff', Math.round(qty * 10) / 10, note)] } }]);
}

export function readyFoodAction(p: ReadyPortion, status: 'frozen' | 'writeoff' | 'eaten') {
  return commit(readyFoodOps(p, status, nowStamp()));
}

/** Корректировка по фактическим покупкам: резервная копия, затем изменения (после предпросмотра). */
export function applyCorrection(input: CorrectionInput) {
  const data = getData();
  // уже применено (вторая вкладка, двойное нажатие) или обновление потеряло бы отметки — ничего не делаем
  if (correctionApplied(data) || revisionBlocked(data)) return Promise.resolve(null);
  const res = buildCorrection(data, todayFn(), nowStamp(), input, __APP_VERSION__);
  return commit(res.ops).then(() => res.report);
}

export function markCorrectionReportSeen() {
  const s = getData().settings;
  if (!s.correctionReportUnseen) return Promise.resolve();
  return commit([{ store: 'settings', put: { ...s, correctionReportUnseen: null } }]);
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
  return commit([{ store: 'shoppingChecks', put: { id, eventId, itemId, actualPrice: prev?.actualPrice ?? null, atHome: bought ? false : prev?.atHome ?? false, bought, updatedAt: nowStamp() } }]);
}

/** «Есть дома» — позицию не покупать, в сумму не входит. */
export function setAtHome(eventId: string, itemId: string, atHome: boolean) {
  const id = `${eventId}:${itemId}`;
  const prev = getData().shoppingChecks[id];
  return commit([{ store: 'shoppingChecks', put: { id, eventId, itemId, actualPrice: prev?.actualPrice ?? null, bought: atHome ? false : prev?.bought ?? false, atHome, updatedAt: nowStamp() } }]);
}

/** Применить подготовленные операции (командировка, релакс-день) — после предпросмотра. */
export function applyOps(ops: Op[]) {
  return commit(ops);
}

/** Командировочный приём пищи: предложенный вариант, другое подходящее блюдо или пропуск. */
export function setTripMeal(t: DayTask, choice: 'suggested' | 'other' | 'skipped' | null, variantId: string | null, comment: string | null) {
  if (!choice) return commit([{ store: 'taskStatus', del: t.id }]);
  return commit([{ store: 'taskStatus', put: {
    taskId: t.id, date: t.originDate, kind: t.kind, status: choice === 'skipped' ? 'skipped' : 'done',
    choice: choice === 'skipped' ? null : choice, variantId: choice === 'suggested' ? variantId : null, comment: comment?.trim() || null, updatedAt: nowStamp(),
  } }]);
}

export function setTripExpenses(tripId: string, rub: number | null) {
  const t = getData().trips[tripId];
  if (!t) return Promise.resolve();
  return commit([{ store: 'trips', put: { ...t, foodExpensesRub: rub, updatedAt: nowStamp() } }]);
}

/** Применить новую дату старта или релакс-день: план пересобирается, история и отметки остаются. */
export function applyPlan(cfg: PlanSettings) {
  const res = replanOps(getData(), cfg, todayFn());
  return commit(res.ops);
}

export function previewPlan(cfg: PlanSettings) {
  return replanOps(getData(), cfg, todayFn());
}

export function setActualPrice(eventId: string, itemId: string, price: number | null) {
  const id = `${eventId}:${itemId}`;
  const prev = getData().shoppingChecks[id];
  return commit([{ store: 'shoppingChecks', put: { id, eventId, itemId, bought: prev?.bought ?? false, atHome: prev?.atHome ?? false, actualPrice: price, updatedAt: nowStamp() } }]);
}

export function setAllBought(eventId: string, itemIds: string[], bought: boolean) {
  const d = getData();
  const ops: Op[] = itemIds.map((itemId) => {
    const id = `${eventId}:${itemId}`;
    const prev = d.shoppingChecks[id];
    return { store: 'shoppingChecks', put: { id, eventId, itemId, actualPrice: prev?.actualPrice ?? null, bought, atHome: bought ? false : prev?.atHome ?? false, updatedAt: nowStamp() } };
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

// ------------------------------------------------------------------ проверка товаров av.ru и замены

export function setAvStatus(productId: string, status: 'available' | 'unavailable' | null) {
  return commit(productCheckOps(getData(), productId, { status }, todayFn(), nowStamp()));
}

export function setAvSub(productId: string, sub: ProductSub | null) {
  const patch: Partial<Pick<AvProductRec, 'status' | 'sub'>> = sub ? { sub } : { sub: null };
  return commit(productCheckOps(getData(), productId, patch, todayFn(), nowStamp()));
}

export function resetAvChecks(ids: string[]) {
  return commit(resetChecksOps(getData(), ids, nowStamp()));
}

// ------------------------------------------------------------------ обновление меню с резервной копией

export function applyMenuUpdate(startDate: ISODate) {
  const res = menuUpdateOps(getData(), startDate, todayFn(), nowStamp(), __APP_VERSION__);
  return commit(res.ops).then(() => res);
}

/** Отчёт о переносе командировки показан. */
export function markTripReportSeen() {
  const s = getData().settings;
  if (!s.tripReportUnseen) return Promise.resolve();
  return commit([{ store: 'settings', put: { ...s, tripReportUnseen: null } }]);
}

/** Перенос командировки, который ждал подтверждения (затрагивает отмеченное): применить. */
export function confirmTripMove() {
  const data = getData();
  const p = data.settings.tripMovePending;
  const trip = p ? data.trips[p.tripId] : null;
  if (!p || !trip) return Promise.resolve();
  const now = nowStamp();
  const mv = planTripMove(data, trip, p, todayFn(), now);
  return commit(applyTripMoveOps(data, mv, now, __APP_VERSION__, mv.conflicts).ops);
}

/** Не переносить командировку (даты можно поменять позже вручную). */
export function dismissTripMove() {
  const s = getData().settings;
  return commit([{ store: 'settings', put: { ...s, tripMovePending: null } }]);
}

export function rollbackMenuUpdate(backupId: string) {
  return commit(rollbackMenuOps(getData(), backupId, todayFn()));
}

/** Отчёт об автоматическом обновлении меню показан. */
export function markMenuReportSeen() {
  const s = getData().settings;
  if (!s.menuReportUnseen) return Promise.resolve();
  return commit([{ store: 'settings', put: { ...s, menuReportUnseen: null } }]);
}

