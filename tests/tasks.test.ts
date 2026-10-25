import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, freshData, NOW } from './helpers';
import { displayStatus, statusOf, tasksForDate, dayProgress, baseTasksForDate } from '../src/domain/tasks';

test('день плана: 4 приёма пищи, тренировка, контейнеры, взвешивание по понедельникам', () => {
  const d = freshData();
  const t = tasksForDate(d, '2026-11-02');
  const kinds = t.map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'meal').length, 4);
  assert.ok(kinds.includes('training'));
  assert.ok(kinds.includes('weigh'));
  assert.ok(kinds.includes('containers'));
  assert.equal(t.find((x) => x.kind === 'training')!.title, 'Силовая А');
});

test('04.11 — готовка, 16.11 — закупка, 01.11 — закупка и готовка', () => {
  const d = freshData();
  assert.ok(tasksForDate(d, '2026-11-04').some((t) => t.kind === 'cooking'));
  assert.ok(tasksForDate(d, '2026-11-16').some((t) => t.kind === 'shopping'));
  const nov1 = tasksForDate(d, '2026-11-01').map((t) => t.kind);
  assert.ok(nov1.includes('shopping') && nov1.includes('cooking'));
  assert.ok(tasksForDate(d, '2026-11-28').some((t) => t.kind === 'cooking'), '28.11 — сдвинутая готовка');
});

test('29.11 — релакс-день: нет приёмов пищи, тренировки и готовки', () => {
  const d = freshData();
  const t = tasksForDate(d, '2026-11-29');
  assert.ok(!t.some((x) => x.kind === 'meal' || x.kind === 'training' || x.kind === 'cooking' || x.kind === 'containers'));
});

test('после 01.12 план не копируется', () => {
  const d = freshData();
  assert.equal(d.planDays['2026-12-02'], undefined);
  const t = tasksForDate(d, '2026-12-02');
  assert.ok(!t.some((x) => x.kind === 'meal' || x.kind === 'training'));
  // взвешивания и фото работают бессрочно
  assert.ok(baseTasksForDate(d, '2027-06-07').some((x) => x.kind === 'weigh'));
  assert.ok(baseTasksForDate(d, '2027-06-02').some((x) => x.kind === 'photo'));
});

test('пустая отметка — не пропуск; перенос сохраняет задачу', () => {
  let d = freshData();
  const tr = tasksForDate(d, '2026-11-02').find((t) => t.kind === 'training')!;
  assert.equal(displayStatus(d, tr, '2026-11-05'), 'unknown');
  assert.equal(displayStatus(d, tr, '2026-11-02'), 'planned');
  d = apply(d, [{ store: 'taskMoves', put: { taskId: tr.id, kind: 'training', fromDate: '2026-11-02', toDate: '2026-11-03', movedAt: NOW } }]);
  assert.ok(!tasksForDate(d, '2026-11-02').some((t) => t.id === tr.id));
  const moved = tasksForDate(d, '2026-11-03').find((t) => t.id === tr.id)!;
  assert.equal(moved.movedFrom, '2026-11-02');
  assert.equal(moved.templateId, 'strength_a');
});

test('статусы: съел, пропустил, вес закрывает взвешивание', () => {
  let d = freshData();
  const meal = tasksForDate(d, '2026-11-02').find((t) => t.kind === 'meal')!;
  d = apply(d, [{ store: 'taskStatus', put: { taskId: meal.id, date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } }]);
  assert.equal(statusOf(d, meal), 'done');
  const w = tasksForDate(d, '2026-11-02').find((t) => t.kind === 'weigh')!;
  assert.equal(statusOf(d, w), 'planned');
  d = apply(d, [{ store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } }]);
  assert.equal(statusOf(d, w), 'done');
  const p = dayProgress(d, '2026-11-02');
  assert.equal(p.done, 2);
});

test('отложенные силовые до даты начала занятий', () => {
  let d = freshData();
  d = apply(d, [{ store: 'settings', put: { ...d.settings, trainingStartDate: '2026-11-10' } }]);
  const tr = tasksForDate(d, '2026-11-02').find((t) => t.kind === 'training')!;
  assert.ok(tr.postponed);
  assert.equal(displayStatus(d, tr, '2026-11-20'), 'postponed');
  const stepper = tasksForDate(d, '2026-11-03').find((t) => t.kind === 'training')!;
  assert.ok(!stepper.postponed, 'степпер по умолчанию не откладывается');
});
