import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, freshData, NOW } from './helpers';
import { mealAdherence, mealRows, smoothedTrend, trainingRows, trainingStats, weeklyRate, weightSeries, weightSummary, workingWeights } from '../src/domain/stats';
import type { TrainingLog } from '../src/state/types';
import { templateFor } from '../src/domain/templates';

const w = (id: string, date: string, kg: number) => ({ store: 'weights', put: { id, date, kg, createdAt: NOW } });

test('вес: без замеров — нет данных; одна точка — без изменения', () => {
  let d = freshData();
  assert.equal(weightSummary(d).count, 0);
  assert.equal(weightSummary(d).change, null);
  d = apply(d, [w('a', '2026-11-02', 106.4)]);
  const s = weightSummary(d);
  assert.equal(s.last!.kg, 106.4);
  assert.equal(s.change, null);
});

test('вес: изменение от первого фактического замера, тенденция только при достаточных данных', () => {
  let d = freshData();
  d = apply(d, [w('a', '2026-11-02', 107), w('b', '2026-11-09', 106.2), w('c', '2026-11-16', 105.6)]);
  assert.equal(weightSummary(d).change, -1.4);
  assert.equal(smoothedTrend(weightSeries(d)).length, 0, '3 точки — тенденцию не строим');
  d = apply(d, [w('e', '2026-11-23', 105.1)]);
  assert.equal(smoothedTrend(weightSeries(d)).length, 4);
  const rate = weeklyRate(weightSeries(d))!;
  assert.ok(rate < -0.5 && rate > -0.8, String(rate));
});

test('вес: несколько записей в день — берётся последняя', () => {
  let d = freshData();
  d = apply(d, [
    { store: 'weights', put: { id: 'x', date: '2026-11-02', kg: 107, createdAt: '2026-11-02T05:00:00Z' } },
    { store: 'weights', put: { id: 'y', date: '2026-11-02', kg: 106.8, createdAt: '2026-11-02T06:00:00Z' } },
  ]);
  assert.deepEqual(weightSeries(d), [{ date: '2026-11-02', kg: 106.8 }]);
});

function log(d: ReturnType<typeof freshData>, id: string, date: string, tid: 'strength_a' | 'stepper', patch: Partial<TrainingLog> = {}): TrainingLog {
  const t = templateFor(d, tid, date)!;
  return {
    id, plannedDate: date, date, templateId: tid, templateVersionId: `${tid}@seed`, templateSnapshot: t, status: 'done',
    exercises: t.items.map((it, index) => ({ index, exerciseId: it.exerciseId, sets: Array.from({ length: it.sets }, () => true), weightKg: null, difficulty: null })),
    updatedAt: NOW, ...patch,
  };
}

test('тренировки: честная агрегация — нет отметки ≠ пропуск, план ≠ факт', () => {
  let d = freshData();
  const l = log(d, 'train:2026-11-02', '2026-11-02', 'strength_a');
  l.exercises[1].weightKg = 14;
  l.exercises[1].difficulty = 'easy';
  d = apply(d, [
    { store: 'trainingLogs', put: l },
    { store: 'trainingLogs', put: { ...log(d, 'train:2026-11-03', '2026-11-03', 'stepper'), stepperMinutes: 18 } },
    { store: 'trainingLogs', put: { ...log(d, 'train:2026-11-04', '2026-11-04', 'strength_a'), templateId: 'strength_b', status: 'skipped', exercises: [] } },
    { store: 'taskMoves', put: { taskId: 'train:2026-11-06', kind: 'training', fromDate: '2026-11-06', toDate: '2026-11-07', movedAt: NOW } },
  ]);
  const rows = trainingRows(d, '2026-11-02', '2026-11-08', '2026-11-08');
  const s = trainingStats(rows);
  assert.equal(s.done, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.moved, 1);
  assert.equal(s.stepperMinutes, 18);
  assert.equal(s.notLogged, 2, '06.11 (перенесена, без отметки) и 07.11 — без отметки');
  const ww = workingWeights(d);
  assert.deepEqual(ww.goblet_squat, [{ date: '2026-11-02', kg: 14, difficulty: 'easy', templateId: 'strength_a' }]);
  assert.equal(ww.kb_row, undefined, 'плановые 8–12 кг не выдаются за фактические');
});

test('питание: релакс-день и пустые отметки не штрафуются', () => {
  let d = freshData();
  d = apply(d, [
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-28:breakfast', date: '2026-11-28', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-28:lunch', date: '2026-11-28', kind: 'meal', status: 'skipped', updatedAt: NOW } },
  ]);
  const a = mealAdherence(mealRows(d, '2026-11-28', '2026-11-30', '2026-11-29'));
  assert.deepEqual(a.relaxDays, ['2026-11-29']);
  assert.equal(a.planned, 4);
  assert.equal(a.done, 1);
  assert.equal(a.skipped, 1);
  assert.equal(a.unknown, 2);
  assert.equal(a.future, 4);
  assert.equal(a.percentOfMarked, 50);
});
