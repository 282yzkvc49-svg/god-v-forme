import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { dayProgress, displayStatus, planDay, planRange, statusOf, tasksForDate, upcoming, type DayTask } from '../domain/tasks';
import { templateFor, itemSummary, exerciseName } from '../domain/templates';
import { diffDays, fmtDayMonth, fmtLong, nowMinutes, plural, weekdayShort, type ISODate } from '../lib/dates';
import { fmtNum, fmtSigned } from '../lib/util';
import { weightSummary } from '../domain/stats';
import { go, href } from '../app/router';
import { isStandalone } from '../lib/files';
import { Note, Ring, toast } from '../ui/kit';
import { AddTaskSheet, KindIcon, NoPlanCard, RelaxCard, TaskList, WeightSheet } from './shared';
import { MEAL_LABELS } from '../state/types';
import { PiCalendarBlank, PiPlus, PiShareNetwork, PiShieldCheck, PiX } from '../ui/icons';

function pickNow(data: ReturnType<typeof useApp>, tasks: DayTask[], date: ISODate, isToday: boolean): DayTask | null {
  const open = tasks.filter((t) => !t.optional && !t.postponed && (statusOf(data, t) === 'planned' || statusOf(data, t) === 'in_progress'));
  if (!open.length) return null;
  if (!isToday) return open[0];
  const now = nowMinutes();
  return open.find((t) => t.sortMin + 75 >= now) ?? open[0];
}

export function Today() {
  const data = useApp();
  const today = useToday();
  const [adding, setAdding] = useState(false);
  const [weigh, setWeigh] = useState(false);
  const range = planRange(data);
  const p = planDay(data, today);
  const beforePlan = !!range && today < range.from;
  const tasks = useMemo(() => tasksForDate(data, today), [data, today]);
  const prog = dayProgress(data, today);
  const now = pickNow(data, tasks, today, true);
  const ups = useMemo(() => upcoming(data, today, 10).filter((u) => u.date > today || u.kind === 'cooking' || u.kind === 'shopping').slice(0, 5), [data, today]);
  const ws = weightSummary(data);
  const firstPrep = beforePlan ? ups.find((u) => u.kind === 'shopping' || u.kind === 'cooking') ?? null : null;

  let sub: string;
  if (p?.dayNumber) sub = `День ${p.dayNumber} из ${Object.values(data.planDays).filter((d) => d.dayNumber).length} стартового плана`;
  else if (p) sub = 'План загружен из обновления';
  else if (beforePlan) sub = `До начала плана ${diffDays(range!.from, today)} ${plural(diffDays(range!.from, today), 'день', 'дня', 'дней')}`;
  else sub = 'План на этот день пока не добавлен';

  const trainTask = tasks.find((t) => t.kind === 'training' && t.templateId && t.templateId !== 'recovery');
  const preview = !!(window as any).__SINGLE_FILE__;
  const showInstall = !preview && !isStandalone() && !data.settings.installHintDismissed;
  const userDataCount = Object.keys(data.weights).length + Object.keys(data.trainingLogs).length + Object.keys(data.taskStatus).length + Object.keys(data.photos).length;
  const backupDays = data.settings.lastBackupAt ? Math.floor((Date.now() - Date.parse(data.settings.lastBackupAt)) / 86400000) : null;
  const needBackup = userDataCount >= 10 && (backupDays == null || backupDays >= 14);

  return (
    <div className="page">
      <div className="today-hero">
        <div className="grow">
          <div className="date-big">{fmtLong(today)}</div>
          <div className="date-sub">{sub}</div>
        </div>
        {prog.total > 0 && <Ring done={prog.done} total={prog.total} />}
      </div>

      {showInstall && (
        <div className="banner">
          <PiShareNetwork />
          <span className="grow">Чтобы приложение открывалось иконкой и работало без интернета: в Safari нажмите «Поделиться» → «На экран „Домой“». Данные во вкладке Safari и в установленном приложении хранятся раздельно — начните вести записи уже в установленном.</span>
          <button className="icon-btn" aria-label="Скрыть подсказку" onClick={() => A.updateSettings({ installHintDismissed: true })}><PiX /></button>
        </div>
      )}
      {preview && (
        <div className="banner">
          <PiShareNetwork />
          <span className="grow">Это предпросмотр. Офлайн-режим, значок на экране «Домой», сохранение отчётов и копий в «Файлы» работают в версии, опубликованной на GitHub Pages.</span>
        </div>
      )}
      {needBackup && (
        <div className="banner">
          <PiShieldCheck />
          <span className="grow">{backupDays == null ? 'Резервной копии ещё нет.' : `Последняя резервная копия — ${backupDays} дн. назад.`} Сохраните копию в «Файлы»: данные хранятся только на этом устройстве.</span>
          <a className="btn small" href={href('/analysis', { tab: 'backup' })}>Сделать</a>
        </div>
      )}

      <div className="cols">
        <div className="stack">
          {beforePlan && (
            <div className="card">
              <h2>Старт {fmtDayMonth(range!.from)}</h2>
              <p className="muted mt0">{firstPrep ? `До начала: ${firstPrep.kind === 'shopping' ? 'закупка' : 'готовка'} ${fmtDayMonth(firstPrep.date)}. ` : ''}Можно заранее посмотреть меню, рецепты и технику упражнений, сделать первое взвешивание и фото.</p>
              <div className="btn-row">
                <a className="btn primary" href={href(`/day/${range!.from}`)}><PiCalendarBlank /> Первый день плана</a>
                <button className="btn" onClick={() => setWeigh(true)}>Записать вес</button>
              </div>
            </div>
          )}
          {p?.relax && <RelaxCard date={today} />}
          {now && !p?.relax && <NowCard task={now} />}
          {!p && !beforePlan && <NoPlanCard date={today} onAdd={() => setAdding(true)} />}
          {tasks.length > 0 && (
            <>
              <h2 className="section-title mt0" style={{ marginTop: 6 }}>{p?.relax ? 'На сегодня' : 'План дня'}</h2>
              <TaskList date={today} />
            </>
          )}
          {tasks.length === 0 && (p || beforePlan) && !p?.relax && (
            <div className="card flat"><p className="muted mt0" style={{ marginBottom: 0 }}>На сегодня задач нет.</p></div>
          )}
          <button className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setAdding(true)}><PiPlus /> Добавить задачу</button>
        </div>

        <div className="stack sticky-col">
          {trainTask && <WorkoutPreview task={trainTask} />}
          <div className="card">
            <div className="card-head"><h3>Ближайшее</h3><a className="btn ghost small" href={href('/calendar')}>Календарь</a></div>
            {ups.length === 0 ? <p className="muted small mt0">В ближайшие дни закупок, готовки и замеров нет.</p> : (
              <div className="list">
                {ups.map((u) => (
                  <a key={u.id + u.date} className="li" href={href(`/day/${u.date}`)}>
                    <span className={`task-icon`} style={{ ['--c' as any]: u.kind === 'cooking' ? 'var(--amber)' : u.kind === 'shopping' ? 'var(--sea)' : 'var(--plum)', ['--c-soft' as any]: u.kind === 'cooking' ? 'var(--amber-soft)' : u.kind === 'shopping' ? 'var(--sea-soft)' : 'var(--plum-soft)' }}><KindIcon t={{ kind: u.kind }} /></span>
                    <span className="grow">
                      <span style={{ display: 'block', fontWeight: 600 }}>{u.title.split(':')[0]}</span>
                      <span className="small muted" style={{ display: 'block' }}>{u.date === today ? 'Сегодня' : `${weekdayShort(u.date)}, ${fmtDayMonth(u.date)}`}</span>
                      {u.title.includes(':') && <span className="small ellipsis" style={{ display: 'block', color: 'var(--ink-2)' }}>{u.title.split(':').slice(1).join(':').trim()}</span>}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h3>Вес</h3><a className="btn ghost small" href={href('/progress')}>Прогресс</a></div>
            {ws.last ? (
              <div className="row between">
                <div>
                  <div className="num" style={{ fontSize: 28, fontWeight: 700 }}>{fmtNum(ws.last.kg)} кг</div>
                  <div className="small muted">{fmtDayMonth(ws.last.date)}{ws.change != null ? ` · ${fmtSigned(ws.change)} кг от первого замера` : ''}</div>
                </div>
                <button className="btn soft" onClick={() => setWeigh(true)}>Записать</button>
              </div>
            ) : (
              <div>
                <p className="muted small mt0">Замеров пока нет — динамика появится после первых взвешиваний.</p>
                <button className="btn soft" onClick={() => setWeigh(true)}>Записать вес</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <AddTaskSheet open={adding} date={today} onClose={() => setAdding(false)} />
      <WeightSheet open={weigh} date={today} onClose={() => setWeigh(false)} />
    </div>
  );
}

function NowCard({ task }: { task: DayTask }) {
  const data = useApp();
  const today = useToday();
  const ds = displayStatus(data, task, today);
  const color = task.kind === 'training' ? 'var(--iron)' : task.kind === 'cooking' ? 'var(--amber)' : task.kind === 'shopping' ? 'var(--sea)' : task.kind === 'weigh' || task.kind === 'photo' ? 'var(--plum)' : 'var(--accent)';
  let action: { label: string; run: () => void };
  switch (task.kind) {
    case 'training':
      action = { label: ds === 'in_progress' ? 'Продолжить тренировку' : 'Начать тренировку', run: () => go(`/workout/${encodeURIComponent(task.id)}`, { d: task.date }) };
      break;
    case 'shopping': action = { label: 'Сегодня закупка — открыть список', run: () => go(`/shop/${task.eventId}`) }; break;
    case 'cooking': action = { label: 'Открыть план готовки', run: () => go(`/cook/${task.eventId}`) }; break;
    case 'weigh': action = { label: 'Записать вес', run: () => go('/progress', { add: 'weight' }) }; break;
    case 'photo': action = { label: 'Добавить фото', run: () => go('/progress', { tab: 'photos', add: task.date }) }; break;
    case 'meal': action = { label: 'Съел', run: () => { A.setTaskStatus(task, 'done'); toast(`${task.title}: отмечено`, { label: 'Отменить', run: () => A.setTaskStatus(task, 'planned') }); } }; break;
    default: action = { label: 'Готово', run: () => A.setTaskStatus(task, 'done') };
  }
  return (
    <div className="card now-card" style={{ ['--c' as any]: color }}>
      <div className="now-label">{task.time ? `Сейчас, ${task.time}` : 'Сейчас'}</div>
      <div className="now-title">{task.kind === 'meal' ? MEAL_LABELS[task.slot!] : task.title}</div>
      {(task.dish || task.subtitle) && <p className="mt0" style={{ color: 'var(--ink-2)' }}>{task.dish || task.subtitle}</p>}
      <div className="btn-row">
        <button className={`btn ${task.kind === 'training' ? 'iron' : 'primary'}`} onClick={action.run}>{action.label}</button>
        {task.kind === 'meal' && <a className="btn ghost" href={href('/nutrition', { d: task.date })}>Рецепты дня</a>}
      </div>
    </div>
  );
}

function WorkoutPreview({ task }: { task: DayTask }) {
  const data = useApp();
  const t = templateFor(data, task.templateId!, task.originDate);
  if (!t) return null;
  const st = statusOf(data, task);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t.name}</h3>
        <span className="chip iron">{t.durationMin ? `${t.durationMin[0]}–${t.durationMin[1]} мин` : ''}</span>
      </div>
      {task.postponed && st === 'planned' && <Note kind="plain">Силовые отложены до {fmtDayMonth(data.settings.trainingStartDate!)} (настройка «Начало силовых»).</Note>}
      <ol className="tech-list small" style={{ marginBottom: 12 }}>
        {t.items.map((it, i) => <li key={i}><b>{exerciseName(it.exerciseId)}</b> — {itemSummary(it)}</li>)}
      </ol>
      <a className="btn iron block" href={href(`/workout/${encodeURIComponent(task.id)}`, { d: task.date })}>
        {st === 'done' ? 'Посмотреть тренировку' : st === 'in_progress' ? 'Продолжить' : 'Перейти к упражнениям'}
      </a>
    </div>
  );
}
