// Общие блоки: список задач дня, меню задачи, карточка релакс-дня, «плана нет», вес, контейнеры, своя задача.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import type { MealSlot, TemplateId } from '../state/types';
import { MEAL_LABELS } from '../state/types';
import {
  displayStatus, planDay, statusOf, tasksForDate, type DayTask, type DisplayStatus,
} from '../domain/tasks';
import { mealRecipes, needsRecipe, resolveMeal, type MealPart } from '../domain/meals';
import { addDays, fmtDayMonth, fmtLong, fmtShort, isWeekend, type ISODate } from '../lib/dates';
import { fmtNum, parseNum } from '../lib/util';
import { today as todayFn } from '../lib/clock';
import { go, href } from '../app/router';
import { CheckButton, Empty, Note, Sheet, Switch, toast, type CheckState } from '../ui/kit';
import {
  KettlebellIcon, PiArrowsLeftRight, PiCamera, PiCheck, PiCookingPot, PiDotsThreeBold, PiForkKnife, PiListChecks,
  PiPackage, PiPersonSimpleWalk, PiScales, PiShoppingCart, PiSkipForward, PiArrowCounterClockwise, PiTrash, PiUploadSimple,
  PiPlus, PiSun, PiBookOpen, StepperIcon,
} from '../ui/icons';
import { TEMPLATE_NAMES } from '../domain/templates';

export function KindIcon({ t }: { t: Pick<DayTask, 'kind' | 'templateId'> }) {
  switch (t.kind) {
    case 'meal': return <PiForkKnife />;
    case 'training':
      if (t.templateId === 'stepper') return <StepperIcon />;
      if (t.templateId === 'recovery') return <PiPersonSimpleWalk />;
      return <KettlebellIcon />;
    case 'cooking': return <PiCookingPot />;
    case 'shopping': return <PiShoppingCart />;
    case 'containers': return <PiPackage />;
    case 'weigh': return <PiScales />;
    case 'photo': return <PiCamera />;
    default: return <PiListChecks />;
  }
}

const STATUS_TEXT: Record<DisplayStatus, string> = {
  planned: '', done: 'готово', skipped: 'пропущено', in_progress: 'начата', postponed: 'отложено', unknown: 'не отмечено',
};

function checkState(s: DisplayStatus): CheckState {
  if (s === 'done') return 'on';
  if (s === 'skipped') return 'skip';
  if (s === 'unknown' || s === 'postponed') return 'idle';
  return 'off';
}

// ------------------------------------------------------------------ список задач

export function TaskList({ date, compact }: { date: ISODate; compact?: boolean }) {
  const data = useApp();
  const tasks = useMemo(() => tasksForDate(data, date), [data, date]);
  const [menu, setMenu] = useState<DayTask | null>(null);
  const [meal, setMeal] = useState<DayTask | null>(null);
  const [weigh, setWeigh] = useState<DayTask | null>(null);
  const [box, setBox] = useState<DayTask | null>(null);
  if (!tasks.length) return null;
  return (
    <>
      <div className="tasks">
        {tasks.map((t) => (
          <TaskRow key={t.id} t={t} compact={compact}
            onMenu={() => setMenu(t)} onOpenMeal={() => setMeal(t)} onOpenWeigh={() => setWeigh(t)} onOpenBox={() => setBox(t)} />
        ))}
      </div>
      <TaskMenu task={menu} onClose={() => setMenu(null)} />
      <MealSheet task={meal} onClose={() => setMeal(null)} />
      <WeightSheet open={!!weigh} date={weigh?.date ?? date} task={weigh} onClose={() => setWeigh(null)} />
      <ContainersSheet task={box} onClose={() => setBox(null)} />
    </>
  );
}

function TaskRow({ t, compact, onMenu, onOpenMeal, onOpenWeigh, onOpenBox }: {
  t: DayTask; compact?: boolean; onMenu: () => void; onOpenMeal: () => void; onOpenWeigh: () => void; onOpenBox: () => void;
}) {
  const data = useApp();
  const ds = displayStatus(data, t, todayFn());
  const raw = statusOf(data, t);

  const open = () => {
    switch (t.kind) {
      case 'meal': return onOpenMeal();
      case 'training': return t.templateId === 'recovery' ? onMenu() : go(`/workout/${encodeURIComponent(t.id)}`, { d: t.date });
      case 'cooking': return go(`/cook/${t.eventId}`);
      case 'shopping': return go(`/shop/${t.eventId}`);
      case 'weigh': return onOpenWeigh();
      case 'photo': return go('/progress', { tab: 'photos', add: t.date });
      case 'containers': return onOpenBox();
      default: return onMenu();
    }
  };

  const toggle = () => {
    if (t.postponed && raw === 'planned') { onMenu(); return; }
    if (t.kind === 'weigh' && raw !== 'done') { onOpenWeigh(); return; }
    if (t.kind === 'photo' && raw !== 'done') { go('/progress', { tab: 'photos', add: t.date }); return; }
    if (t.kind === 'training') {
      if (raw === 'done' || raw === 'skipped') {
        const log = data.trainingLogs[t.id];
        const detailed = log?.exercises.some((e) => e.sets.some(Boolean));
        if (detailed && !confirm('Снять отметку? Подходы и веса этой тренировки сохранятся, тренировка станет «начатой».')) return;
        if (detailed) A.reopenTraining(t.id); else A.resetTraining(t.id);
        return;
      }
      A.quickDoneTraining(t, todayFn() < t.date ? t.date : todayFn());
      toast(`${t.title}: отмечено`, { label: 'Отменить', run: () => A.resetTraining(t.id) });
      return;
    }
    if (raw === 'done') A.setTaskStatus(t, 'planned');
    else {
      A.setTaskStatus(t, 'done');
    }
  };

  const sub = t.kind === 'meal' ? t.dish : t.subtitle;
  const time = t.time ?? (t.kind === 'meal' && isWeekend(t.date) ? 'по голоду' : null);
  return (
    <div className={`task k-${t.kind} is-${ds}`}>
      <CheckButton state={checkState(ds)} onClick={toggle} label={`${t.title}: ${ds === 'done' ? 'снять отметку' : 'отметить выполненным'}`} />
      <button type="button" className="task-main" onClick={open}>
        <span className="task-top">
          <span className="task-title">{t.title}</span>
          {time && <span className="task-time">{time}</span>}
          {STATUS_TEXT[ds] && <span className={`status-tag ${ds === 'done' ? 'done' : ''}`}>{STATUS_TEXT[ds]}{ds === 'postponed' && data.settings.trainingStartDate ? ` до ${fmtShort(data.settings.trainingStartDate)}` : ''}</span>}
        </span>
        {sub && !compact && <span className="task-sub">{sub}</span>}
        {(t.movedFrom || data.taskMoves[t.id]) && (
          <span className="task-meta">
            {t.movedFrom ? <span className="chip warn">перенесено с {fmtShort(t.movedFrom)}</span> : null}
          </span>
        )}
      </button>
      <span className="task-icon" aria-hidden="true"><KindIcon t={t} /></span>
      <button className="icon-btn" onClick={onMenu} aria-label={`Действия: ${t.title}`}><PiDotsThreeBold /></button>
    </div>
  );
}

// ------------------------------------------------------------------ меню задачи

export function TaskMenu({ task, onClose }: { task: DayTask | null; onClose: () => void }) {
  const data = useApp();
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState('');
  if (!task) return null;
  const t = task;
  const raw = statusOf(data, t);
  const isTraining = t.kind === 'training';
  const done = () => {
    if (isTraining) A.quickDoneTraining(t, todayFn() < t.date ? t.date : todayFn());
    else A.setTaskStatus(t, 'done');
    onClose();
  };
  const skip = () => {
    if (isTraining) A.skipTraining(t, t.date);
    else A.setTaskStatus(t, 'skipped');
    toast(`${t.title}: пропущено`);
    onClose();
  };
  const reset = () => {
    if (isTraining) {
      const log = data.trainingLogs[t.id];
      if (log?.exercises.some((e) => e.sets.some(Boolean))) {
        if (!confirm('Удалить отметки подходов и весов этой тренировки?')) return;
      }
      A.resetTraining(t.id);
    } else A.setTaskStatus(t, 'planned');
    onClose();
  };
  const doMove = () => {
    if (!to) return;
    A.moveTask(t, to);
    toast(`${t.title}: перенесено на ${fmtDayMonth(to)}`);
    setMoving(false);
    onClose();
  };
  return (
    <Sheet open onClose={() => { setMoving(false); onClose(); }} title={t.title}>
      <p className="muted mt0">{fmtLong(t.date)}{t.movedFrom ? ` · перенесено с ${fmtDayMonth(t.movedFrom)}` : ''}</p>
      {t.postponed && raw === 'planned' && (
        <Note kind="plain">Тренировка отложена до {data.settings.trainingStartDate ? fmtDayMonth(data.settings.trainingStartDate) : 'начала занятий'} (настройка «Начало силовых»). При желании её можно отметить вручную.</Note>
      )}
      {!moving ? (
        <div className="menu-list" style={{ marginTop: 12 }}>
          {isTraining && t.templateId !== 'recovery' && (
            <button onClick={() => { onClose(); go(`/workout/${encodeURIComponent(t.id)}`, { d: t.date }); }}><KettlebellIcon /> Открыть тренировку</button>
          )}
          {raw !== 'done' && <button onClick={done}><PiCheck /> Отметить выполненным</button>}
          {raw !== 'skipped' && t.kind !== 'containers' && <button onClick={skip}><PiSkipForward /> Пропустить</button>}
          {raw !== 'planned' && <button onClick={reset}><PiArrowCounterClockwise /> Снять отметку</button>}
          {t.movable && <button onClick={() => { setTo(addDays(t.date, 1)); setMoving(true); }}><PiArrowsLeftRight /> Перенести на другой день</button>}
          {t.movable && data.taskMoves[t.id] && (
            <button onClick={() => { A.moveTask(t, t.originDate); onClose(); }}><PiArrowCounterClockwise /> Вернуть на {fmtDayMonth(t.originDate)}</button>
          )}
          {t.customId && <button className="danger" onClick={() => { if (confirm('Удалить эту задачу?')) { A.deleteCustomTask(t.customId!); onClose(); } }}><PiTrash /> Удалить задачу</button>}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <label className="field">
            <span>Новая дата</span>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="chips" style={{ marginBottom: 14 }}>
            {[1, 2, 3].map((n) => (
              <button key={n} className="chip" onClick={() => setTo(addDays(t.date, n))}>+{n} {n === 1 ? 'день' : 'дня'} ({fmtShort(addDays(t.date, n))})</button>
            ))}
          </div>
          <p className="hint">Статистика сохранится: тренировка будет учтена как перенесённая, а не пропущенная.</p>
          <div className="btn-row">
            <button className="btn primary" onClick={doMove} disabled={!to}>Перенести</button>
            <button className="btn" onClick={() => setMoving(false)}>Отмена</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ блюдо

export function MealParts({ parts, date }: { parts: MealPart[]; date?: ISODate }) {
  return (
    <div className="meal-parts">
      {parts.map((p, i) => {
        if (p.status === 'recipe' && p.recipe) {
          return <a key={i} className="chip accent" href={href(`/recipe/${p.recipe.id}`, { d: date })}><PiBookOpen /> {parts.length > 1 ? p.text : p.recipe.title}</a>;
        }
        if (p.status === 'simple') return <span key={i} className="chip" title={p.comment ?? ''}>{parts.length > 1 ? p.text : (p.comment ?? 'из готовых продуктов')}</span>;
        return (
          <a key={i} className="chip warn" href={href('/recipe-needed', { k: p.key, t: p.text, sim: p.recipe?.id })}>
            {p.text}: нужно уточнить рецепт
          </a>
        );
      })}
    </div>
  );
}

export function MealSheet({ task, onClose }: { task: DayTask | null; onClose: () => void }) {
  const data = useApp();
  if (!task || !task.slot || !task.dish) return null;
  const parts = resolveMeal(data, task.slot, task.dish);
  const recipes = mealRecipes(parts);
  const needs = needsRecipe(parts);
  const raw = statusOf(data, task);
  return (
    <Sheet open onClose={onClose} title={`${MEAL_LABELS[task.slot]}${task.time ? ` в ${task.time}` : ''}`}>
      <p className="muted mt0">{fmtLong(task.date)}</p>
      <div className="meal-dish" style={{ marginBottom: 10 }}>{task.dish}</div>
      <MealParts parts={parts} date={task.date} />
      {needs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Note kind="warn">
            Для части блюда нет точного рецепта в исходных файлах. Приложение не придумывает его: можно добавить свой рецепт{needs.some((n) => n.recipe) ? ' или открыть похожий' : ''}.
          </Note>
        </div>
      )}
      {recipes.length === 0 && needs.length === 0 && <p className="hint">Собирается из готовых продуктов — отдельный рецепт не нужен.</p>}
      <div className="btn-row" style={{ marginTop: 16 }}>
        {raw !== 'done'
          ? <button className="btn primary" onClick={() => { A.setTaskStatus(task, 'done'); onClose(); }}><PiCheck /> Съел</button>
          : <button className="btn" onClick={() => { A.setTaskStatus(task, 'planned'); onClose(); }}><PiArrowCounterClockwise /> Снять отметку</button>}
        {raw !== 'skipped' && <button className="btn" onClick={() => { A.setTaskStatus(task, 'skipped'); onClose(); }}>Пропустил или заменил</button>}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ вес

export function WeightSheet({ open, date, task, onClose }: { open: boolean; date: ISODate; task?: DayTask | null; onClose: () => void }) {
  const data = useApp();
  const last = useMemo(() => Object.values(data.weights).sort((a, b) => (a.date + a.createdAt < b.date + b.createdAt ? 1 : -1))[0], [data.weights]);
  const [text, setText] = useState('');
  const [d, setD] = useState(date);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setD(date); setErr(''); } }, [open, date]);
  const save = () => {
    const kg = parseNum(text);
    if (kg == null || kg < 30 || kg > 300) { setErr('Введите вес в килограммах, например 106,4'); return; }
    A.addWeight(d, Math.round(kg * 10) / 10);
    toast(`Вес ${fmtNum(kg)} кг сохранён`);
    setText('');
    setErr('');
    onClose();
  };
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title="Взвешивание">
      <p className="muted mt0">Утром, натощак, в одно и то же время — так тенденция честнее.</p>
      <label className="field">
        <span>Вес, кг</span>
        <input className="input num-input" inputMode="decimal" enterKeyHint="done" autoComplete="off" autoFocus placeholder={last ? fmtNum(last.kg) : '—'}
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} aria-label="Вес в килограммах" />
      </label>
      <label className="field">
        <span>Дата</span>
        <input className="input" type="date" value={d} onChange={(e) => setD(e.target.value || date)} />
      </label>
      {err && <p className="error-text">{err}</p>}
      {last && <p className="hint">Последний замер: {fmtNum(last.kg)} кг, {fmtDayMonth(last.date)}.</p>}
      <div className="btn-row">
        <button className="btn primary big" onClick={save}>Сохранить</button>
        {task && statusOf(data, task) !== 'done' && (
          <button className="btn" onClick={() => { A.setTaskStatus(task, 'skipped'); onClose(); }}>Пропустить взвешивание</button>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ контейнеры на завтра

const BOX_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'snack'];

export function ContainersSheet({ task, onClose }: { task: DayTask | null; onClose: () => void }) {
  const data = useApp();
  if (!task) return null;
  const tomorrow = addDays(task.originDate, 1);
  const tp = planDay(data, tomorrow);
  const raw = statusOf(data, task);
  return (
    <Sheet open onClose={onClose} title="Контейнеры на завтра">
      <p className="muted mt0">На {fmtLong(tomorrow).toLowerCase()} — завтрак, обед и перекус на работу. Горячее и салат — в разные контейнеры.</p>
      <div className="list">
        {BOX_SLOTS.map((s) => {
          const id = `box:${task.originDate}:${s}`;
          const on = !!data.checks[id];
          const dish = tp?.meals?.[s];
          if (!dish) return null;
          return (
            <div className="li" key={s}>
              <CheckButton small state={on ? 'on' : 'off'} label={`${MEAL_LABELS[s]} упакован`} onClick={() => A.setCheck(id, !on)} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{MEAL_LABELS[s]} <span className="muted small">{data.settings.mealTimes[s]}</span></div>
                <div className="small muted">{dish}</div>
              </div>
            </div>
          );
        })}
      </div>
      <Note kind="plain">Остывшее блюдо — сразу в холодильник. На работе: холодильник и микроволновка, разогревать до горячего.</Note>
      <div className="btn-row" style={{ marginTop: 14 }}>
        {raw !== 'done'
          ? <button className="btn primary" onClick={() => { A.setTaskStatus(task, 'done'); onClose(); }}><PiCheck /> Всё собрано</button>
          : <button className="btn" onClick={() => { A.setTaskStatus(task, 'planned'); onClose(); }}>Снять отметку</button>}
        <a className="btn ghost" href={href('/nutrition', { d: tomorrow })}>Меню на завтра</a>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ релакс-день и пустой день

export function RelaxCard({ date }: { date: ISODate }) {
  const data = useApp();
  const p = planDay(data, date);
  return (
    <div className="relax-card">
      <div className="row" style={{ color: 'var(--rose)' }}><PiSun size={28} /></div>
      <h2>Релакс-день</h2>
      <p>Еда по желанию, без подсчёта и без обязательных отметок. Специально переедать или «отрабатывать» потом не нужно.</p>
      {p?.note && <p className="small">{p.note}</p>}
      <p className="small">Напитки: {p?.drinks ?? 'вода, травяной чай, морс без сахара'}.</p>
      {date === '2026-11-29' && <p className="small">Готовка на 30.11–01.12 перенесена на субботу 28.11.</p>}
    </div>
  );
}

export function NoPlanCard({ date, onAdd }: { date: ISODate; onAdd?: () => void }) {
  return (
    <div className="card">
      <Empty
        title="План на этот день пока не добавлен"
        actions={<>
          <a className="btn primary" href={href('/analysis', { tab: 'import' })}><PiUploadSimple /> Загрузить план от ChatGPT</a>
          {onAdd && <button className="btn" onClick={onAdd}><PiPlus /> Добавить задачу</button>}
        </>}
      >
        Предыдущий месяц не копируется автоматически. Загрузите обновлённый план или добавьте задачу вручную — взвешивания, фото и отметки работают в любой день.
      </Empty>
    </div>
  );
}

// ------------------------------------------------------------------ своя задача

export function AddTaskSheet({ open, date, onClose }: { open: boolean; date: ISODate; onClose: () => void }) {
  const [kind, setKind] = useState<'custom' | 'training'>('custom');
  const [title, setTitle] = useState('');
  const [tid, setTid] = useState<TemplateId>('strength_a');
  const [d, setD] = useState(date);
  const [time, setTime] = useState('');
  useEffect(() => { if (open) setD(date); }, [open, date]);
  const save = () => {
    const t = kind === 'training' ? TEMPLATE_NAMES[tid] : title.trim();
    if (!t) return;
    A.addCustomTask({ date: d, title: t, kind, templateId: kind === 'training' ? tid : null, time: time || null, note: null });
    toast('Задача добавлена');
    setTitle('');
    onClose();
  };
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title="Новая задача">
      <div className="seg full" style={{ marginBottom: 14 }}>
        <button aria-pressed={kind === 'custom'} onClick={() => setKind('custom')}>Задача</button>
        <button aria-pressed={kind === 'training'} onClick={() => setKind('training')}>Тренировка</button>
      </div>
      {kind === 'custom' ? (
        <label className="field">
          <span>Что сделать</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, купить контейнеры" enterKeyHint="done" />
        </label>
      ) : (
        <label className="field">
          <span>Тренировка</span>
          <select className="input" value={tid} onChange={(e) => setTid(e.target.value as TemplateId)}>
            <option value="strength_a">Силовая А</option>
            <option value="strength_b">Силовая Б</option>
            <option value="stepper">Степпер</option>
            <option value="recovery">Восстановление / прогулка</option>
          </select>
        </label>
      )}
      <div className="row nowrap">
        <label className="field grow"><span>Дата</span><input className="input" type="date" value={d} onChange={(e) => setD(e.target.value || date)} /></label>
        <label className="field grow"><span>Время (необязательно)</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      </div>
      <button className="btn primary block" onClick={save} disabled={kind === 'custom' && !title.trim()}>Добавить</button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ день целиком (календарь и отдельная страница)

export function DayDetail({ date, header }: { date: ISODate; header?: ReactNode }) {
  const data = useApp();
  const p = planDay(data, date);
  const [adding, setAdding] = useState(false);
  const tasks = tasksForDate(data, date);
  const note = data.dayNotes[date]?.text ?? '';
  return (
    <div className="stack">
      {header}
      {p?.relax && <RelaxCard date={date} />}
      {!p && <NoPlanCard date={date} onAdd={() => setAdding(true)} />}
      {tasks.length > 0 && <TaskList date={date} />}
      {p && !p.relax && p.note && <Note kind="plain">{p.note}</Note>}
      <DayNoteField key={date} date={date} initial={note} />
      {p && <button className="btn ghost" onClick={() => setAdding(true)}><PiPlus /> Добавить задачу на этот день</button>}
      <AddTaskSheet open={adding} date={date} onClose={() => setAdding(false)} />
    </div>
  );
}

function DayNoteField({ date, initial }: { date: ISODate; initial: string }) {
  const [text, setText] = useState(initial);
  const [shown, setShown] = useState(!!initial);
  if (!shown) return <button className="btn ghost small" style={{ justifySelf: 'start' }} onClick={() => setShown(true)}>Заметка к дню</button>;
  return (
    <label className="field">
      <span>Заметка к дню (самочувствие, болезнь, поездка)</span>
      <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => A.setDayNote(date, text)} placeholder="Попадёт в отчёт для ChatGPT, если включить заметки" />
    </label>
  );
}

export function useTodayRelax(date: ISODate): boolean {
  const data = useApp();
  return !!planDay(data, date)?.relax;
}

export { Switch };
