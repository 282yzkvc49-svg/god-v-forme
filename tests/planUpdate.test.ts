import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apply, freshData, NOW } from './helpers';
import { buildApplyOps, latestAppliedPatch, loadJump, parsePlanUpdate, rollbackOps } from '../src/domain/planUpdate';
import { templateFor } from '../src/domain/templates';
import { tasksForDate } from '../src/domain/tasks';

const example = fs.readFileSync(new URL('../examples/plan_update_example.json', import.meta.url), 'utf8');
const TODAY = '2026-12-01';

test('пример plan_update.json проходит проверку и показывает «Было → Станет»', () => {
  const d = freshData();
  const r = parsePlanUpdate(example, d, TODAY);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) return;
  assert.equal(r.changes.length, 6);
  const wt = r.changes.find((c) => c.type === 'workout_template')!;
  const squat = wt.lines.find((l) => l.label.startsWith('Присед'))!;
  assert.match(squat.before, /2 × 8/);
  assert.match(squat.after, /3 × 8/);
  assert.equal(wt.effectiveFrom, '2026-12-02');
});

test('применение меняет только будущее, откат возвращает план, история не исчезает', () => {
  let d = freshData();
  // фактические данные до импорта
  d = apply(d, [
    { store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-02:lunch', date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } },
  ]);
  const r = parsePlanUpdate(example, d, TODAY);
  assert.ok(r.ok);
  if (!r.ok) return;
  const sel = new Set(r.changes.map((c) => c.key));
  const { ops } = buildApplyOps(d, r, sel, 'plan_update.json', NOW, 'p1');
  const d2 = apply(d, ops);
  // ноябрь — прежний шаблон, со 2 декабря — новый
  assert.equal(templateFor(d2, 'strength_a', '2026-11-30')!.items[1].sets, 2);
  assert.equal(templateFor(d2, 'strength_a', '2026-12-04')!.items[1].sets, 3);
  assert.equal(d2.planDays['2026-12-02'].training!.templateId, 'strength_b');
  assert.equal(d2.planDays['2026-12-02'].meals!.dinner, 'Форель + салат');
  assert.ok(tasksForDate(d2, '2026-12-02').some((t) => t.kind === 'shopping'));
  assert.equal(d2.weights.w1.kg, 106.4);
  assert.equal(d2.taskStatus['meal:2026-11-02:lunch'].status, 'done');
  assert.equal(latestAppliedPatch(d2)!.id, 'p1');
  // откат
  const d3 = apply(d2, rollbackOps(d2, 'p1', NOW));
  assert.equal(d3.planDays['2026-12-02'], undefined);
  assert.equal(templateFor(d3, 'strength_a', '2026-12-04')!.items[1].sets, 2);
  assert.equal(d3.patches.p1.status, 'rolled_back');
  assert.equal(d3.weights.w1.kg, 106.4);
});

test('выбор отдельных изменений: отклонённые не применяются', () => {
  const d = freshData();
  const r = parsePlanUpdate(example, d, TODAY);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.changes.find((c) => c.type === 'goal')!.applicable, false, 'цель 82 кг совпадает с текущей — применять нечего');
  const only = new Set([r.changes.find((c) => c.type === 'meal_plan')!.key]);
  const { ops, record } = buildApplyOps(d, r, only, 'f.json', NOW, 'p2');
  const d2 = apply(d, ops);
  assert.equal(d2.planDays['2026-12-02'].meals!.lunch, 'Куриные котлеты + булгур + брокколи + морковь');
  assert.equal(d2.planDays['2026-12-02'].training, null, 'расписание тренировок не выбрано — не применено');
  assert.equal(templateFor(d2, 'strength_a', '2026-12-04')!.items[1].sets, 2);
  assert.equal(record.applied.length, 1);
  assert.equal(record.rejected.length, 5);
});

test('ошибки проверки: ничего не меняется, ошибка конкретная', () => {
  const d = freshData();
  const bad = (o: any) => parsePlanUpdate(JSON.stringify(o), d, TODAY);
  const base = { schema_version: '1.0.0', update_type: 'plan_update', changes: [] as any[] };
  assert.equal(parsePlanUpdate('{ not json', d, TODAY).ok, false);
  let r = bad({ ...base, schema_version: '2.0.0', changes: [{ type: 'goal', target_weight_kg: 80 }] });
  assert.ok(!r.ok && r.errors[0].path === '$.schema_version');
  r = bad({ ...base, changes: [{ type: 'workout_template', template_id: 'strength_a', effective_from: '2026-12-02', item_updates: [{ exercise_id: 'dumbbell_press', sets: 3 }] }] });
  assert.ok(!r.ok && r.errors.some((e) => /неизвестное упражнение/.test(e.message)));
  r = bad({ ...base, changes: [{ type: 'workout_template', template_id: 'strength_a', effective_from: '2026-12-02', item_updates: [{ exercise_id: 'goblet_squat', weight_kg: 32 }] }] });
  assert.ok(!r.ok && r.errors.some((e) => /24/.test(e.message)));
  r = bad({ ...base, changes: [{ type: 'meal_plan', days: [{ date: '02.12.2026', breakfast: 'x' }] }] });
  assert.ok(!r.ok && r.errors.some((e) => /ГГГГ-ММ-ДД/.test(e.message)));
  r = bad({ ...base, changes: [{ type: 'meal_plan', days: [{ date: '2026-12-02', breakfast: '<script>alert(1)</script>' }] }] });
  assert.ok(!r.ok && r.errors.some((e) => /HTML/.test(e.message)));
  r = bad({ ...base, changes: [{ type: 'goal', reason: 'см. https://example.com', target_weight_kg: 80 }] });
  assert.ok(!r.ok && r.errors.some((e) => /ссылка/.test(e.message)));
  r = bad({ ...base, changes: [{ type: 'delete_everything' }] });
  assert.ok(!r.ok && r.errors.some((e) => /неизвестный тип/.test(e.message)));
});

test('прошлые даты и дни с отметками не перезаписываются', () => {
  let d = freshData();
  d = apply(d, [{ store: 'taskStatus', put: { taskId: 'meal:2026-11-20:lunch', date: '2026-11-20', kind: 'meal', status: 'done', updatedAt: NOW } }]);
  const upd = { schema_version: '1.0.0', update_type: 'plan_update', changes: [
    { type: 'meal_plan', days: [{ date: '2026-11-10', lunch: 'Новый обед' }, { date: '2026-11-20', lunch: 'Новый обед' }, { date: '2026-11-25', lunch: 'Новый обед' }] },
  ] };
  const r = parsePlanUpdate(JSON.stringify(upd), d, '2026-11-15');
  assert.ok(r.ok);
  if (!r.ok) return;
  const c = r.changes[0];
  assert.equal(c.payload.days.length, 1);
  assert.equal(c.payload.days[0].date, '2026-11-25');
  assert.equal(c.warnings.length, 2);
});

test('резкий рост нагрузки подсвечивается и не выбран по умолчанию', () => {
  const d = freshData();
  assert.ok(loadJump({ exerciseId: 'goblet_squat', sets: 2, reps: 8, weightKg: [12, 16] }, { exerciseId: 'goblet_squat', sets: 4, reps: 8, weightKg: [12, 16] }));
  assert.ok(loadJump({ exerciseId: 'goblet_squat', sets: 2, reps: 8, weightKg: [12, 16] }, { exerciseId: 'goblet_squat', sets: 2, reps: 8, weightKg: [22, 22] }));
  assert.equal(loadJump({ exerciseId: 'goblet_squat', sets: 2, reps: 8, weightKg: [12, 16] }, { exerciseId: 'goblet_squat', sets: 3, reps: 8, weightKg: [14, 16] }), null);
  const r = parsePlanUpdate(JSON.stringify({ schema_version: '1.0.0', update_type: 'plan_update', changes: [
    { type: 'workout_template', template_id: 'strength_b', effective_from: '2026-12-02', item_updates: [{ exercise_id: 'kb_rdl', sets: 4, reps: 10, weight_kg: 24 }] },
  ] }), d, TODAY);
  assert.ok(r.ok && r.changes[0].danger);
});
