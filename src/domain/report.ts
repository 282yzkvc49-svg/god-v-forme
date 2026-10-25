// Ежемесячный отчёт для разбора в ChatGPT: monthly_report.json + monthly_summary.md + manifest.json (+ фото по согласию).
// Только фактические, введённые пользователем данные. Плановые значения помечены как план.
import type { AppData, PhotoMeta } from '../state/types';
import { DIFFICULTY_LABELS, FEELING_LABELS, MEAL_LABELS, POSE_LABELS } from '../state/types';
import { diffDays, fmtFull, fmtShort, range, type ISODate } from '../lib/dates';
import { fmtNum } from '../lib/util';
import {
  mealAdherence, mealRows, trainingRows, trainingStats, weightSeries, weightSummary, workingWeights, exerciseLabel,
  type TrainingRow,
} from './stats';
import { templatesForExport, PLAN_UPDATE_SCHEMA_VERSION } from './planUpdate';
import { EXERCISES, KETTLEBELL_MAX_KG } from '../lib/seed';
import { TEMPLATE_IDS } from '../state/types';

export const REPORT_SCHEMA_VERSION = '1.0.0';

export const CHATGPT_PROMPT = `Проанализируй мой месячный отчёт из приложения «Мой год в форме». Цель — снизить вес со 107 до 82 кг примерно за год, сохранить мышцы и улучшить силу. Использую только мини-степпер, одну регулируемую гирю и собственный вес. Сначала дай краткую оценку динамики веса, посещаемости тренировок, выполнения питания и самочувствия. Укажи, где недостаточно фактических данных. Затем предложи корректировку следующего месяца: упражнения, подходы, повторы, рабочие веса и расписание; питание корректируй осторожно, без экстремальных диет. Учитывай возможные дни болезни и переносы, не считай их ленью. Отдельно подготовь файл \`plan_update.json\` строго по схеме импорта приложения, чтобы я мог его загрузить обратно. Не утверждай, что я выполнил то, чего нет в отчёте.`;

export interface ReportOptions {
  from: ISODate;
  to: ISODate;
  today: ISODate;
  photos: PhotoMeta[]; // выбранные пользователем; пусто — фото не передаются
  notes: string;
  include: { weights: boolean; workouts: boolean; nutrition: boolean; notes: boolean };
  appVersion: string;
  generatedAt: string;
}

const STATUS_RU: Record<string, string> = {
  done: 'выполнено', skipped: 'пропущено', postponed: 'отложено', not_logged: 'нет отметки', planned: 'впереди', in_progress: 'начато, не завершено',
};

export function photoFileName(p: PhotoMeta): string {
  return `photos/${p.date}${p.pose ? `_${p.pose}` : ''}_${p.id.slice(-6)}.jpg`;
}

function workoutJson(r: TrainingRow) {
  return {
    planned_date: r.plannedDate,
    actual_date: r.actualDate,
    template_id: r.templateId,
    template_name: r.name,
    kind: r.kind,
    status: r.status,
    moved: r.moved,
    moved_to: r.movedTo,
    added_manually: r.custom,
    quick_check_without_sets: r.quick,
    sets_marked: r.setsDone,
    sets_planned: r.setsPlanned,
    stepper_minutes: r.stepperMinutes,
    warmup_stepper_minutes: r.warmupMinutes,
    feeling: r.feeling,
    note: r.note,
    exercises: r.status === 'done' || r.status === 'in_progress' ? r.exercises.map((e) => ({
      exercise_id: e.exerciseId,
      name: e.name,
      planned: { sets: e.plannedSets, reps: e.plannedReps, seconds: e.plannedSeconds, minutes: e.plannedMinutes, weight_kg_range: e.plannedWeightKg, per_side: e.perSide },
      sets_marked: e.setsDone,
      weight_kg_used: e.weightKgUsed,
      difficulty: e.difficulty,
    })) : [],
  };
}

export function buildReport(data: AppData, o: ReportOptions) {
  const { from, to, today } = o;
  const rows = trainingRows(data, from, to, today);
  const tstats = trainingStats(rows);
  const mrows = mealRows(data, from, to, today);
  const madh = mealAdherence(mrows);
  const weights = weightSeries(data, from, to);
  const wsum = weightSummary(data, from, to);
  const allW = weightSeries(data);
  const ww = workingWeights(data, from, to);

  const cooking = Object.values(data.cookingEvents).filter((e) => e.date >= from && e.date <= to && e.eventType === 'meal_prep').map((e) => {
    const taskId = `cook:${e.id}`;
    const st = data.taskStatus[taskId]?.status;
    return { type: 'cooking', date: e.date, moved_to: data.taskMoves[taskId]?.toDate ?? null, title: e.dishes.map((d) => d.text).join(', '), status: st === 'done' || st === 'skipped' ? st : e.date <= today ? 'not_logged' : 'planned' };
  });
  const shopping = Object.values(data.shoppingEvents).filter((e) => e.date >= from && e.date <= to).map((e) => {
    const taskId = `shop:${e.id}`;
    const st = data.taskStatus[taskId]?.status;
    const checks = e.items.map((it) => data.shoppingChecks[`${e.id}:${it.itemId}`]);
    const bought = checks.filter((c) => c?.bought).length;
    const actual = checks.reduce((s, c) => s + (c?.actualPrice ?? 0), 0);
    const actualCount = checks.filter((c) => c?.actualPrice != null).length;
    const est = e.items.reduce((s, it) => s + (it.priceEstimate ?? 0), 0);
    return {
      type: 'shopping', date: e.date, title: e.title, status: st === 'done' || st === 'skipped' ? st : e.date <= today ? 'not_logged' : 'planned',
      items_total: e.items.length, items_marked_bought: bought, estimate_sum_rub: Math.round(est),
      actual_prices_entered: actualCount, actual_sum_rub: actualCount ? Math.round(actual * 100) / 100 : null,
    };
  });

  const dayNotes = Object.values(data.dayNotes).filter((n) => n.date >= from && n.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1)).map((n) => ({ date: n.date, text: n.text }));
  const waist = data.settings.showWaist ? Object.values(data.measurements).filter((m) => m.date >= from && m.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1)).map((m) => ({ date: m.date, waist_cm: m.waistCm })) : [];

  // фактические наблюдения (без советов)
  const obs: string[] = [];
  if (wsum.count === 0) obs.push('За период нет ни одного взвешивания — динамику веса оценить нельзя.');
  else if (wsum.count === 1) obs.push('За период только одно взвешивание — изменение веса за месяц не рассчитать.');
  else if (wsum.count < 4) obs.push(`Взвешиваний за период: ${wsum.count} — тенденцию оценивать осторожно.`);
  if (tstats.notLogged) obs.push(`${tstats.notLogged} тренировок без отметки — неизвестно, выполнялись ли они; не считать их ни выполненными, ни пропущенными.`);
  if (tstats.postponed) obs.push(`${tstats.postponed} тренировок отложено пользователем до начала занятий${data.settings.trainingStartDate ? ` (${fmtFull(data.settings.trainingStartDate)})` : ''}.`);
  if (tstats.moved) obs.push(`Перенесено тренировок: ${tstats.moved}.`);
  const quick = rows.filter((r) => r.status === 'done' && r.quick).length;
  if (quick) obs.push(`${quick} тренировок отмечены быстрой галочкой без данных по подходам.`);
  const wwCount = Object.values(ww).reduce((s, x) => s + x.length, 0);
  if (!wwCount) obs.push('Фактические рабочие веса гири не вводились — плановые диапазоны не являются поднятым весом.');
  const diffCount = rows.reduce((s, r) => s + r.exercises.filter((e) => e.difficulty).length, 0);
  if (!diffCount) obs.push('Оценки сложности упражнений (легко/нормально/тяжело) не вводились.');
  if (madh.unknown) obs.push(`${madh.unknown} плановых приёмов пищи без отметки — они не считаются ни выполненными, ни пропущенными.`);
  if (madh.relaxDays.length) obs.push(`Релакс-день (${madh.relaxDays.map(fmtShort).join(', ')}) не учитывается в выполнении плана питания.`);
  const futureDays = to > today ? diffDays(to, today) : 0;
  if (futureDays > 0) obs.push(`Период ещё не закончился: ${futureDays} дн. впереди; будущие задачи в статистику не входят.`);

  const json = {
    schema_version: REPORT_SCHEMA_VERSION,
    report_type: 'monthly_review',
    app: { name: 'Мой год в форме', version: o.appVersion },
    generated_at: o.generatedAt,
    period: { from, to, days: range(from, to).length },
    goals: {
      start_weight_kg: data.settings.goals.startWeightKg,
      target_weight_kg: data.settings.goals.targetWeightKg,
      kcal_reference_per_day: data.settings.goals.kcalReference,
      kcal_note: 'Оценочный стартовый ориентир, калории по блюдам не считаются.',
      equipment: ['мини-степпер', `одна разборная гиря до ${KETTLEBELL_MAX_KG} кг`, 'собственный вес'],
      training_start_date: data.settings.trainingStartDate,
    },
    weights: o.include.weights ? weights.map((w) => ({ date: w.date, kg: w.kg })) : [],
    weight_summary: o.include.weights ? {
      entries: wsum.count,
      first: wsum.first, last: wsum.last,
      change_kg: wsum.change,
      weekly_rate_kg: wsum.rate != null ? +wsum.rate.toFixed(2) : null,
      last_known_before_period: allW.filter((w) => w.date < from).slice(-1)[0] ?? null,
    } : null,
    waist: waist,
    photos: o.photos.map((p) => ({ file: photoFileName(p), date: p.date, pose: p.pose })),
    workouts: o.include.workouts ? rows.filter((r) => r.status !== 'planned').map(workoutJson) : [],
    workout_summary: o.include.workouts ? {
      due: tstats.planned, done: tstats.done, skipped: tstats.skipped, not_logged: tstats.notLogged, moved: tstats.moved,
      postponed: tstats.postponed, upcoming: tstats.upcoming, strength_done: tstats.strengthDone, stepper_done: tstats.cardioDone,
      recovery_marked: tstats.recoveryDone, stepper_minutes: tstats.stepperMinutes, warmup_minutes: tstats.warmupMinutes, sets_marked: tstats.setsDone,
    } : null,
    working_weights: o.include.workouts ? Object.fromEntries(Object.entries(ww).map(([k, xs]) => [k, xs.map((x) => ({ date: x.date, kg: x.kg, difficulty: x.difficulty }))])) : {},
    nutrition_adherence: o.include.nutrition
      ? { planned: madh.planned, done: madh.done, skipped: madh.skipped, unknown: madh.unknown, future_not_counted: madh.future, relax_days: madh.relaxDays, percent_of_marked: madh.percentOfMarked }
      : { planned: 0, done: 0, skipped: 0, unknown: 0 },
    nutrition_days: o.include.nutrition ? mrows.map((r) => ({ date: r.date, relax_day: r.relax, meals: r.meals.map((m) => ({ slot: m.slot, dish: m.dish, status: m.status })) })) : [],
    cooking_and_shopping: [...cooking, ...shopping].sort((a, b) => (a.date < b.date ? -1 : 1)),
    day_notes: o.include.notes ? dayNotes : [],
    observations: obs,
    notes_for_chatgpt: o.notes.trim(),
    current_plan: {
      templates: templatesForExport(data, to),
      allowed_exercise_ids: Object.keys(EXERCISES),
      allowed_template_ids: TEMPLATE_IDS,
      kettlebell_max_kg: KETTLEBELL_MAX_KG,
      plan_days_loaded_until: Object.keys(data.planDays).sort().slice(-1)[0] ?? null,
    },
    plan_update_schema_version: PLAN_UPDATE_SCHEMA_VERSION,
  };

  const md = buildMarkdown(data, o, json, rows);
  return { json, md, stats: { tstats, madh, wsum } };
}

function tableRow(cells: (string | number | null | undefined)[]): string {
  return `| ${cells.map((c) => (c == null || c === '' ? '—' : String(c).replace(/\|/g, '/'))).join(' | ')} |`;
}

function buildMarkdown(data: AppData, o: ReportOptions, j: any, rows: TrainingRow[]): string {
  const L: string[] = [];
  L.push(`# Отчёт за период ${fmtFull(o.from)} — ${fmtFull(o.to)}`);
  L.push('');
  L.push(`Приложение «Мой год в форме», версия ${o.appVersion}. Сформирован ${o.generatedAt.slice(0, 16).replace('T', ' ')}.`);
  L.push(`Цель: ${fmtNum(j.goals.start_weight_kg)} → ${fmtNum(j.goals.target_weight_kg)} кг примерно за год. Инвентарь: мини-степпер, одна разборная гиря до 24 кг, собственный вес.`);
  L.push('В отчёт попали только введённые данные. Отсутствие отметки не означает пропуск.');
  L.push('');
  L.push('## Вес');
  if (!o.include.weights) L.push('Пользователь не включил вес в отчёт.');
  else if (!j.weights.length) L.push('Взвешиваний за период нет.');
  else {
    L.push(tableRow(['Дата', 'Вес, кг']));
    L.push('|---|---|');
    for (const w of j.weights) L.push(tableRow([fmtFull(w.date), fmtNum(w.kg)]));
    const s = j.weight_summary;
    L.push('');
    L.push(`Записей: ${s.entries}. ${s.change_kg != null ? `Изменение за период: ${s.change_kg > 0 ? '+' : ''}${fmtNum(s.change_kg)} кг.` : 'Изменение рассчитать нельзя (меньше двух замеров).'}${s.weekly_rate_kg != null ? ` Темп по линейной тенденции: ${fmtNum(s.weekly_rate_kg, 2)} кг/нед.` : ''}`);
  }
  L.push('');
  L.push('## Тренировки');
  if (!o.include.workouts) L.push('Пользователь не включил тренировки в отчёт.');
  else {
    const s = j.workout_summary;
    L.push(`Срок наступил: ${s.due}. Выполнено: ${s.done} (силовых ${s.strength_done}, степпер ${s.stepper_done}). Пропущено: ${s.skipped}. Без отметки: ${s.not_logged}. Перенесено: ${s.moved}. Отложено: ${s.postponed}. Впереди: ${s.upcoming}.`);
    L.push(`Минуты степпера (кардио): ${s.stepper_minutes}; разминка: ${s.warmup_minutes}. Отмечено подходов: ${s.sets_marked}. Дни восстановления отмечены: ${s.recovery_marked}.`);
    L.push('');
    const shown = rows.filter((r) => r.status !== 'planned' && r.kind !== 'recovery');
    if (shown.length) {
      L.push(tableRow(['План', 'Факт', 'Тренировка', 'Статус', 'Подходы', 'Самочувствие', 'Заметка']));
      L.push('|---|---|---|---|---|---|---|');
      for (const r of shown) {
        L.push(tableRow([
          fmtShort(r.plannedDate), r.actualDate ? fmtShort(r.actualDate) : null, r.name,
          `${STATUS_RU[r.status]}${r.moved ? `, перенос на ${fmtShort(r.movedTo!)}` : ''}${r.quick ? ', быстрая отметка' : ''}`,
          r.kind === 'cardio' ? (r.stepperMinutes ? `${r.stepperMinutes} мин` : null) : `${r.setsDone}/${r.setsPlanned}`,
          r.feeling ? FEELING_LABELS[r.feeling] : null, r.note,
        ]));
      }
    }
    const ww = j.working_weights as Record<string, { date: string; kg: number; difficulty: string | null }[]>;
    L.push('');
    L.push('### Рабочие веса (введены вручную)');
    if (!Object.keys(ww).length) L.push('Не вводились.');
    else for (const [id, xs] of Object.entries(ww)) L.push(`- ${exerciseLabel(id)}: ${xs.map((x) => `${fmtShort(x.date)} — ${fmtNum(x.kg)} кг${x.difficulty ? ` (${DIFFICULTY_LABELS[x.difficulty as 'easy']})` : ''}`).join('; ')}`);
  }
  L.push('');
  L.push('## Питание');
  if (!o.include.nutrition) L.push('Пользователь не включил питание в отчёт.');
  else {
    const n = j.nutrition_adherence;
    L.push(`Плановых приёмов пищи (по сегодняшний день): ${n.planned}. Съедено по плану: ${n.done}. Пропущено/заменено: ${n.skipped}. Без отметки: ${n.unknown}.${n.percent_of_marked != null ? ` Выполнение среди отмеченных: ${n.percent_of_marked}%.` : ''}`);
    if (n.relax_days?.length) L.push(`Релакс-дни без учёта: ${n.relax_days.map(fmtShort).join(', ')}.`);
    L.push('КБЖУ не ведётся; ориентир ≈' + data.settings.goals.kcalReference + ' ккал/сутки — оценочный.');
  }
  L.push('');
  L.push('## Готовка и закупки');
  if (!j.cooking_and_shopping.length) L.push('Событий за период нет.');
  for (const e of j.cooking_and_shopping) {
    if (e.type === 'cooking') L.push(`- ${fmtShort(e.date)} готовка (${e.title}): ${STATUS_RU[e.status] ?? e.status}${e.moved_to ? `, перенесена на ${fmtShort(e.moved_to)}` : ''}`);
    else L.push(`- ${fmtShort(e.date)} ${e.title}: ${STATUS_RU[e.status] ?? e.status}; отмечено купленным ${e.items_marked_bought} из ${e.items_total}; ориентир ${e.estimate_sum_rub} ₽${e.actual_sum_rub != null ? `; фактические цены введены для ${e.actual_prices_entered} поз. на ${fmtNum(e.actual_sum_rub, 0)} ₽` : ''}`);
  }
  if (j.photos.length) {
    L.push('');
    L.push('## Фото');
    for (const p of j.photos) L.push(`- ${p.file} — ${fmtShort(p.date)}${p.pose ? `, ${POSE_LABELS[p.pose as 'front']}` : ''}`);
  }
  if (j.day_notes.length) {
    L.push('');
    L.push('## Заметки по дням');
    for (const n of j.day_notes) L.push(`- ${fmtShort(n.date)}: ${n.text}`);
  }
  L.push('');
  L.push('## Наблюдения по данным');
  for (const s of j.observations) L.push(`- ${s}`);
  if (j.notes_for_chatgpt) {
    L.push('');
    L.push('## Комментарий пользователя');
    L.push(j.notes_for_chatgpt);
  }
  L.push('');
  L.push('## Текущие шаблоны тренировок');
  for (const t of j.current_plan.templates) {
    L.push(`- **${t.name}** (\`${t.template_id}\`): ${t.items.map((it: any) => `${it.name} (\`${it.exercise_id}\`) ${it.minutes != null ? `${Array.isArray(it.minutes) ? it.minutes.join('–') : it.minutes} мин` : `${it.sets}×${it.reps ?? `${it.seconds} сек`}`}${it.per_side ? ` на ${it.per_side}` : ''}${it.weight_kg ? `, ${it.weight_kg[0] === it.weight_kg[1] ? it.weight_kg[0] : it.weight_kg.join('–')} кг` : ''}`).join('; ')}`);
  }
  L.push('');
  L.push('## Запрос');
  L.push(CHATGPT_PROMPT);
  L.push('');
  L.push(PLAN_UPDATE_SCHEMA_DOC);
  return L.join('\n');
}

export const PLAN_UPDATE_SCHEMA_DOC = `## Схема plan_update.json для обратного импорта (версия ${PLAN_UPDATE_SCHEMA_VERSION})

Приложение принимает только данные — без HTML, ссылок и кода. Каждое изменение пользователь подтверждает отдельно; меняются только будущие плановые записи, начиная с указанной даты; фактические отметки, вес и фото не затрагиваются. Даты — строго \`ГГГГ-ММ-ДД\`, числа — числами.

\`\`\`json
{
  "schema_version": "1.0.0",
  "update_type": "plan_update",
  "title": "Корректировка на декабрь 2026",
  "summary": "Коротко: что и почему меняется",
  "changes": [
    {
      "type": "workout_template",
      "template_id": "strength_a",
      "effective_from": "2026-12-02",
      "reason": "Присед 2×8 с 12 кг оценён как «легко» три раза подряд",
      "item_updates": [
        { "exercise_id": "goblet_squat", "sets": 3, "reps": 8, "weight_kg": [12, 14] }
      ]
    },
    {
      "type": "calendar_training",
      "reason": "Расписание на следующую неделю",
      "days": [ { "date": "2026-12-02", "template_id": "strength_b", "time": "19:00" } ]
    },
    {
      "type": "meal_plan",
      "days": [
        { "date": "2026-12-02", "breakfast": "…", "lunch": "… + … + …", "snack": "…", "dinner": "… + …" },
        { "date": "2026-12-27", "relax_day": true }
      ]
    },
    { "type": "meal_prep_event", "events": [ { "date": "2026-12-06", "dishes": ["Куриные котлеты", "Булгур"], "for_dates": ["2026-12-07", "2026-12-08"], "storage": "…" } ] },
    { "type": "shopping_event", "events": [ { "date": "2026-12-01", "title": "Закупка на 1–15 дни", "items": [ { "category": "Белок", "name": "Куриная грудка", "unit": "кг", "qty": 1.8, "price_per_unit_rub": 420 } ] } ] },
    { "type": "goal", "target_weight_kg": 82 }
  ]
}
\`\`\`

Правила:
- \`template_id\`: ${['strength_a', 'strength_b', 'stepper', 'recovery'].join(', ')}; в расписании ещё \`rest\` (отдых).
- \`exercise_id\`: ${Object.keys(EXERCISES).join(', ')}. Других упражнений и инвентаря (гантели, штанга, скамья, тренажёры) нет.
- \`workout_template\`: либо \`item_updates\` (меняются только перечисленные упражнения), либо \`items\` (полный новый список). Поля упражнения: \`sets\`, \`reps\` или \`seconds\` или \`minutes\`, \`per_side\` («руку», «ногу», «сторону»), \`weight_kg\` — число или диапазон \`[от, до]\`, не больше 24, \`note\`.
- Резкий рост нагрузки (+2 подхода, +50 % повторов, +4 кг и т. п.) приложение подсвечивает и требует отдельного подтверждения.
- \`meal_prep_event\` и \`shopping_event\`: событие с той же датой заменяется; \`"action": "remove"\` — отменить.
- Приём пищи в \`meal_plan\` — текст блюда; составные обеды и ужины записывайте через « + ».
`;
