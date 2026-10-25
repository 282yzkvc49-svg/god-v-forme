import { useMemo } from 'react';
import { useApp } from '../state/store';
import { useToday } from '../lib/clock';
import { href } from '../app/router';
import { EXERCISES } from '../lib/seed';
import { addDays, fmtDayMonth, fmtShort, weekdayShort } from '../lib/dates';
import { fmtNum } from '../lib/util';
import { tasksForDate, statusOf, displayStatus } from '../domain/tasks';
import { templateFor, itemSummary, exerciseName, TEMPLATE_NAMES } from '../domain/templates';
import { trainingRows, trainingStats, workingWeights } from '../domain/stats';
import { DIFFICULTY_LABELS, FEELING_LABELS, TEMPLATE_IDS, type Exercise, type TemplateId } from '../state/types';
import { ExerciseFigure, ExerciseThumb } from '../figures/ExerciseFigure';
import { Note, PageHead } from '../ui/kit';
import { KettlebellIcon, PiCalendarBlank, PiPersonSimpleWalk, StepperIcon } from '../ui/icons';

export function ExerciseTechnique({ ex, open = true }: { ex: Exercise; open?: boolean }) {
  if (!open) return null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <ExerciseFigure exerciseId={ex.id} />
      <div className="tech-cols">
        <div>
          <h4>Как выполнять</h4>
          <ol className="tech-list small">{ex.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div>
            <h4>Типичные ошибки</h4>
            <ul className="tech-list small">{ex.mistakes.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
          <div>
            <h4>Упрощённый вариант</h4>
            <p className="small mt0" style={{ marginBottom: 0 }}>{ex.easier}</p>
          </div>
        </div>
      </div>
      {ex.warnings.length > 0 && (
        <Note kind="warn">{ex.warnings.map((w, i) => <p key={i}>{w}</p>)}</Note>
      )}
      <p className="hint mt0">Работают: {ex.muscles}. Инвентарь: {ex.equipment.join(', ')}.</p>
    </div>
  );
}

function TemplateIcon({ id }: { id: TemplateId }) {
  if (id === 'stepper') return <StepperIcon />;
  if (id === 'recovery') return <PiPersonSimpleWalk />;
  return <KettlebellIcon />;
}

export function TrainingHub() {
  const data = useApp();
  const today = useToday();
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today]);
  const from = useMemo(() => addDays(today, -60), [today]);
  const rows = useMemo(() => trainingRows(data, from, today, today), [data, from, today]);
  const stats = trainingStats(rows);
  const ww = useMemo(() => workingWeights(data), [data]);
  const recent = Object.values(data.trainingLogs).filter((l) => l.status === 'done').sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  const s = data.settings;
  return (
    <div className="page">
      <PageHead title="Тренировки" sub="Мини-степпер, одна разборная гиря до 24 кг и собственный вес" />
      {s.trainingStartDate && s.trainingStartDate > today && (
        <div className="banner">
          <PiCalendarBlank />
          <span className="grow">Силовые отложены до {fmtDayMonth(s.trainingStartDate)}. До этой даты они не считаются пропусками.</span>
          <a className="btn small" href={href('/settings', { s: 'start' })}>Изменить</a>
        </div>
      )}
      <div className="cols">
        <div className="stack">
          <div className="card">
            <h2>Ближайшие 7 дней</h2>
            <div className="list">
              {week.map((d) => {
                const t = tasksForDate(data, d).filter((x) => x.kind === 'training');
                return (
                  <div className="li" key={d}>
                    <span className="num" style={{ width: 66, fontWeight: 650 }}>{weekdayShort(d)}, {fmtShort(d)}</span>
                    <span className="grow" style={{ display: 'grid', gap: 6 }}>
                      {t.length === 0 && <span className="muted small">{data.planDays[d]?.relax ? 'Релакс-день' : data.planDays[d] ? 'Без тренировки' : 'План пока не добавлен'}</span>}
                      {t.map((x) => {
                        const ds = displayStatus(data, x, today);
                        const label = ds === 'done' ? 'готово' : ds === 'skipped' ? 'пропущено' : ds === 'postponed' ? 'отложено' : ds === 'in_progress' ? 'начата' : '';
                        return x.templateId === 'recovery'
                          ? <span key={x.id} className="small">{TEMPLATE_NAMES.recovery}</span>
                          : (
                            <a key={x.id} className="row nowrap" style={{ color: 'inherit', textDecoration: 'none' }} href={href(`/workout/${encodeURIComponent(x.id)}`, { d })}>
                              <span className="task-icon" style={{ ['--c' as any]: 'var(--iron)', ['--c-soft' as any]: 'var(--iron-soft)', width: 32, height: 32 }}><TemplateIcon id={x.templateId!} /></span>
                              <span className="grow"><b>{x.title}</b>{x.time ? <span className="muted"> · {x.time}</span> : null}{x.movedFrom ? <span className="chip warn" style={{ marginLeft: 6 }}>перенесено</span> : null}</span>
                              {label && <span className={`chip ${ds === 'done' ? 'iron' : ''}`}>{label}</span>}
                            </a>
                          );
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {TEMPLATE_IDS.filter((t) => t !== 'recovery').map((tid) => {
            const t = templateFor(data, tid, today);
            if (!t) return null;
            return (
              <div className="card" key={tid}>
                <div className="card-head">
                  <h2>{t.name}</h2>
                  <span className="chip iron">{t.durationMin ? `${t.durationMin[0]}–${t.durationMin[1]} мин` : ''}{t.restSec ? `, отдых ${t.restSec[0]}–${t.restSec[1]} с` : ''}</span>
                </div>
                <p className="muted mt0">{t.description}</p>
                <div className="list">
                  {t.items.map((it, i) => (
                    <a key={i} className="li" href={href(`/exercise/${it.exerciseId}`)}>
                      <span style={{ width: 84, flex: 'none' }} className="figure-frame"><ExerciseThumb exerciseId={EXERCISES[it.exerciseId]?.figure ? it.exerciseId : it.exerciseId} /></span>
                      <span className="grow">
                        <span style={{ display: 'block', fontWeight: 600 }}>{exerciseName(it.exerciseId)}</span>
                        <span className="small muted">{itemSummary(it)}{it.weightNote ? ` (${it.weightNote})` : ''}{it.note ? ` · ${it.note}` : ''}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
          <Note kind="plain">Гиря разборная, до 24 кг. Стартовый вес для приседа и тяг — около 12–16 кг, для жима легче (6–10 кг). Вес увеличивайте постепенно, только при чистой технике и без боли. Дни восстановления — прогулка по самочувствию.</Note>
        </div>

        <div className="stack sticky-col">
          <div className="card">
            <h3>За 60 дней</h3>
            {stats.planned + stats.done === 0 ? <p className="muted small mt0">Отметок пока нет. Статистика появится после первых тренировок.</p> : (
              <table className="table">
                <tbody>
                  <tr><td>Выполнено</td><td className="n">{stats.done}</td></tr>
                  <tr><td>Срок наступил</td><td className="n">{stats.planned}</td></tr>
                  <tr><td>Перенесено</td><td className="n">{stats.moved}</td></tr>
                  <tr><td>Пропущено</td><td className="n">{stats.skipped}</td></tr>
                  <tr><td>Без отметки</td><td className="n">{stats.notLogged}</td></tr>
                  {stats.postponed > 0 && <tr><td>Отложено</td><td className="n">{stats.postponed}</td></tr>}
                  <tr><td>Минуты степпера</td><td className="n">{stats.stepperMinutes}</td></tr>
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h3>Рабочие веса</h3>
            {Object.keys(ww).length === 0 ? <p className="muted small mt0">Появятся, когда вы введёте фактический вес гири в тренировке (по желанию).</p> : (
              <div className="list">
                {Object.entries(ww).map(([id, xs]) => {
                  const last = xs[xs.length - 1];
                  return (
                    <div className="li" key={id}>
                      <span className="grow"><b>{exerciseName(id)}</b><span className="small muted" style={{ display: 'block' }}>{xs.length} {xs.length === 1 ? 'запись' : 'записей'}, последняя {fmtDayMonth(last.date)}{last.difficulty ? `, ${DIFFICULTY_LABELS[last.difficulty]}` : ''}</span></span>
                      <span className="num" style={{ fontWeight: 700 }}>{fmtNum(last.kg)} кг</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="card">
            <h3>История</h3>
            {recent.length === 0 ? <p className="muted small mt0">Завершённых тренировок пока нет.</p> : (
              <div className="list">
                {recent.map((l) => (
                  <a key={l.id} className="li" href={href(`/workout/${encodeURIComponent(l.id)}`, { d: l.date })}>
                    <span className="grow"><b>{l.templateSnapshot?.name ?? TEMPLATE_NAMES[l.templateId]}</b><span className="small muted" style={{ display: 'block' }}>{fmtDayMonth(l.date)}{l.quick ? ', быстрая отметка' : `, подходов ${l.exercises.reduce((s, e) => s + e.sets.filter(Boolean).length, 0)}`}{l.feeling ? `, ${FEELING_LABELS[l.feeling]}` : ''}</span></span>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <h3>Все упражнения</h3>
            <div className="chips">
              {Object.values(EXERCISES).filter((e) => e.id !== 'walk').map((e) => <a key={e.id} className="chip iron" href={href(`/exercise/${e.id}`)}>{e.name}</a>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ExercisePage({ id }: { id: string }) {
  const ex = EXERCISES[id];
  if (!ex) return <div className="page"><PageHead title="Упражнение не найдено" backTo="/training" /></div>;
  return (
    <div className="page narrow">
      <PageHead title={ex.name} sub={ex.equipment.join(', ')} backTo="/training" />
      <div className="card"><ExerciseTechnique ex={ex} /></div>
    </div>
  );
}

export { statusOf };
