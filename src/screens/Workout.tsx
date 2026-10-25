import { useEffect, useMemo, useState } from 'react';
import { useApp, getData } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { go, href } from '../app/router';
import { taskById, statusOf, type DayTask } from '../domain/tasks';
import { templateFor, prescription, weightText, exerciseName } from '../domain/templates';
import { EXERCISES } from '../lib/seed';
import { fmtDayMonth, fmtLong } from '../lib/dates';
import type { Difficulty, Feeling, TemplateItem, TrainingLog, WorkoutTemplate } from '../state/types';
import { DIFFICULTY_LABELS, FEELING_LABELS } from '../state/types';
import { NumberStepper, Note, PageHead, Seg, Sheet, toast } from '../ui/kit';
import { ExerciseTechnique } from './Training';
import { TaskMenu } from './shared';
import { PiCaretDown, PiCaretUp, PiCheckBold, PiPause, PiPlay, PiStop, PiTimer, PiShieldCheck } from '../ui/icons';
import {
  pauseTimer, remainingMs, resumeTimer, setDuration, setSound, startTimer, stopTimer, unlockAudio, useTimer,
} from './restTimer';

function fmtClock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function WorkoutScreen({ taskId }: { taskId: string }) {
  const data = useApp();
  const today = useToday();
  const task = useMemo(() => taskById(data, taskId), [data, taskId]);
  const log = data.trainingLogs[taskId];
  const [finishing, setFinishing] = useState(false);
  const [menu, setMenu] = useState<DayTask | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { setSound(data.settings.restSound); }, [data.settings.restSound]);

  if (!task || !task.templateId) {
    return (
      <div className="page narrow">
        <PageHead title="Тренировка не найдена" backTo="/training" />
        <Note>Возможно, план этого дня изменился после импорта обновления. Отметки и история сохранены.</Note>
      </div>
    );
  }
  const tpl: WorkoutTemplate | null = log?.templateSnapshot ?? templateFor(data, task.templateId, task.originDate);
  if (!tpl) return <div className="page"><PageHead title="Шаблон не найден" backTo="/training" /></div>;
  const status = statusOf(data, task);
  const shownDate = data.taskMoves[task.id]?.toDate ?? task.originDate;
  const restRange = tpl.restSec ?? [60, 90];

  const setsTotal = tpl.items.reduce((s, it) => s + it.sets, 0);
  const setsDone = log ? log.exercises.reduce((s, e) => s + e.sets.filter(Boolean).length, 0) : 0;

  const ensure = (): TrainingLog | null => {
    unlockAudio();
    const l = getData().trainingLogs[task.id] ?? A.ensureTrainingLog(task, today);
    return l;
  };

  const toggleSet = (idx: number, si: number) => {
    const l = ensure();
    if (!l) return;
    const ex = l.exercises.find((e) => e.index === idx)!;
    const sets = ex.sets.slice();
    sets[si] = !sets[si];
    A.updateExerciseLog(l.id, idx, { sets });
    if (sets[si]) {
      const remainingSets = getData().trainingLogs[l.id].exercises.reduce((s, e) => s + e.sets.filter((x) => !x).length, 0);
      const it = tpl.items[idx];
      const isCardio = EXERCISES[it.exerciseId]?.kind === 'cardio';
      if (data.settings.restAutoStart && remainingSets > 0 && !isCardio && tpl.type === 'strength') {
        startTimer(data.settings.restDefaultSec * 1000, 'rest', 'Отдых');
      }
    }
  };

  return (
    <div className="page narrow">
      <PageHead
        title={tpl.name}
        sub={`${fmtLong(shownDate)}${task.movedFrom || data.taskMoves[task.id] ? ` · перенесено с ${fmtDayMonth(task.originDate)}` : ''}`}
        backTo="/training"
        right={<button className="btn small" onClick={() => setMenu(task)}>Перенести или пропустить</button>}
      />
      {task.postponed && status === 'planned' && (
        <div className="banner"><PiShieldCheck /><span className="grow">Силовые отложены до {fmtDayMonth(data.settings.trainingStartDate!)} (настройка «Начало силовых»). Технику можно посмотреть уже сейчас.</span></div>
      )}
      {status === 'done' && (
        <Note kind="ok">
          Тренировка отмечена выполненной{log?.date ? ` ${fmtDayMonth(log.date)}` : ''}{log?.quick ? ' (быстрая отметка, без подходов)' : ''}{log?.feeling ? `, самочувствие: ${FEELING_LABELS[log.feeling]}` : ''}. Подходы и веса можно поправить ниже.
        </Note>
      )}
      {status === 'skipped' && <Note kind="plain">Тренировка отмечена как пропущенная. Отметьте подходы — и она снова станет активной.</Note>}

      <div className="card flat" style={{ margin: '12px 0' }}>
        <div className="row between">
          <span><b className="num">{setsDone}</b> из <span className="num">{setsTotal}</span> подходов отмечено</span>
          <span className="muted small">Отдых {restRange[0]}–{restRange[1]} сек{tpl.durationMin ? `, всего ${tpl.durationMin[0]}–${tpl.durationMin[1]} мин` : ''}</span>
        </div>
        <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${setsTotal ? (setsDone / setsTotal) * 100 : 0}%`, background: 'var(--iron)' }} /></div>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        {tpl.items.map((it, idx) => (
          <ExerciseBlock key={idx} it={it} idx={idx} log={log} open={open === idx} onToggleOpen={() => setOpen(open === idx ? null : idx)}
            onSet={(si) => toggleSet(idx, si)} ensure={ensure} />
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 18 }}>
        <button className="btn iron big" onClick={() => setFinishing(true)}><PiCheckBold /> {status === 'done' ? 'Изменить итог' : 'Завершить тренировку'}</button>
      </div>
      <div className="workout-pad" />
      <RestTimerDock restRange={restRange} />
      <FinishSheet open={finishing} onClose={() => setFinishing(false)} task={task} tpl={tpl} />
      <TaskMenu task={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function ExerciseBlock({ it, idx, log, open, onToggleOpen, onSet, ensure }: {
  it: TemplateItem; idx: number; log?: TrainingLog; open: boolean; onToggleOpen: () => void; onSet: (si: number) => void; ensure: () => TrainingLog | null;
}) {
  const ex = EXERCISES[it.exerciseId];
  const el = log?.exercises.find((e) => e.index === idx);
  const sets = el?.sets ?? Array.from({ length: it.sets }, () => false);
  const done = sets.length > 0 && sets.every(Boolean);
  const isBell = ex?.equipment.includes('Гиря');
  const isTime = ex?.kind === 'time';
  const isCardio = ex?.kind === 'cardio';
  const wt = weightText(it);
  const setLabel = (i: number) => {
    if (it.minutes != null) return Array.isArray(it.minutes) ? `${it.minutes[0]}–${it.minutes[1]} мин` : `${it.minutes} мин`;
    if (it.seconds) return `${it.seconds} с`;
    return `${it.reps ?? ''}`;
  };
  return (
    <div className="card ex-card">
      <button className="ex-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className={`ex-num${done ? ' done' : ''}`}>{done ? <PiCheckBold /> : idx + 1}</span>
        <span className="grow">
          <span className="ex-name" style={{ display: 'block' }}>{exerciseName(it.exerciseId)}</span>
          <span className="ex-presc">{prescription(it)}{wt ? `, ориентир ${wt}` : ''}{it.note ? ` · ${it.note}` : ''}</span>
        </span>
        <span className="muted small">{open ? 'Скрыть' : 'Техника'}</span>
        {open ? <PiCaretUp /> : <PiCaretDown />}
      </button>
      <div className="ex-body">
        <div className="sets" role="group" aria-label={`Подходы: ${exerciseName(it.exerciseId)}`}>
          {sets.map((on, si) => (
            <button key={si} className={`set-btn${on ? ' on' : ''}`} onClick={() => onSet(si)} aria-pressed={on} aria-label={`Подход ${si + 1}${on ? ', выполнен' : ''}`}>
              {on ? <PiCheckBold /> : setLabel(si)}
              <small>{sets.length > 1 ? `подход ${si + 1}` : isCardio ? 'готово' : 'подход'}{it.perSide && !isCardio ? `, на ${it.perSide}` : ''}</small>
            </button>
          ))}
          {isTime && it.seconds && (
            <button className="btn small" onClick={() => {
              const next = sets.findIndex((x) => !x);
              if (next < 0) return;
              const started = ensure();
              if (!started) return;
              startTimer(it.seconds! * 1000, 'hold', `Удержание, подход ${next + 1}`, () => {
                const l = getData().trainingLogs[started.id];
                if (!l) return;
                const cur = l.exercises.find((e) => e.index === idx)!.sets.slice();
                cur[next] = true;
                A.updateExerciseLog(l.id, idx, { sets: cur });
              });
            }}><PiTimer /> Засечь {it.seconds} с</button>
          )}
        </div>
        {it.exerciseId === 'stepper_cardio' && (
          <div className="row">
            <span className="field-label">Минуты степпера</span>
            <div className="chips">
              {[10, 15, 20, 25].map((m) => (
                <button key={m} className={`chip${el?.minutes === m ? ' iron' : ''}`} aria-pressed={el?.minutes === m} onClick={() => {
                  const l = ensure();
                  if (l) A.updateExerciseLog(l.id, idx, { minutes: el?.minutes === m ? null : m, sets: [true] });
                }}>{m}</button>
              ))}
            </div>
          </div>
        )}
        {isBell && (
          <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <span className="field-label">Фактический вес гири (необязательно)</span>
              <NumberStepper label="Вес гири" value={el?.weightKg ?? null} step={2} min={0} max={24} unit="кг" onChange={(v) => {
                const l = ensure();
                if (l) A.updateExerciseLog(l.id, idx, { weightKg: v });
              }} />
            </div>
          </div>
        )}
        {!isCardio && (
          <div className="field" style={{ margin: 0 }}>
            <span className="field-label">Как далось (необязательно)</span>
            <div className="seg" role="group" aria-label="Сложность">
              {(['easy', 'ok', 'hard'] as Difficulty[]).map((d) => (
                <button key={d} type="button" aria-pressed={el?.difficulty === d} onClick={() => {
                  const l = ensure();
                  if (l) A.updateExerciseLog(l.id, idx, { difficulty: el?.difficulty === d ? null : d });
                }}>{DIFFICULTY_LABELS[d]}</button>
              ))}
            </div>
          </div>
        )}
        {open && ex && <ExerciseTechnique ex={ex} />}
        {!open && ex && <a className="btn ghost small" style={{ justifySelf: 'start', paddingLeft: 0 }} href={href(`/exercise/${ex.id}`)}>Подробно о технике</a>}
      </div>
    </div>
  );
}

function RestTimerDock({ restRange }: { restRange: [number, number] }) {
  const t = useTimer();
  const data = useApp();
  const presets = Array.from(new Set([restRange[0], Math.round((restRange[0] + restRange[1]) / 2 / 5) * 5, restRange[1]]));
  const rem = remainingMs(t);
  const frac = t.duration ? 1 - rem / t.duration : 0;
  const durSec = Math.round(t.duration / 1000);
  return (
    <div className="timer-dock no-print">
      <div className={`timer${t.status === 'finished' ? ' done' : ''}`} role="timer" aria-live="off">
        <div style={{ minWidth: 92 }}>
          <div className="t-time">{t.status === 'finished' ? '0:00' : fmtClock(rem)}</div>
          <div className="t-label">{t.status === 'finished' ? (t.mode === 'hold' ? 'Удержание готово' : 'Отдых окончен') : t.status === 'idle' ? 'Таймер отдыха' : t.label}</div>
          {(t.status === 'running' || t.status === 'paused') && <div className="timer-progress"><i style={{ width: `${frac * 100}%` }} /></div>}
        </div>
        <div className="grow">
          {t.status === 'idle' || t.status === 'finished' ? (
            <div className="presets" role="group" aria-label="Длительность отдыха">
              {presets.map((p) => (
                <button key={p} aria-pressed={durSec === p} onClick={() => { setDuration(p * 1000); if (p !== data.settings.restDefaultSec) A.updateSettings({ restDefaultSec: p }); }}>{p}</button>
              ))}
            </div>
          ) : null}
        </div>
        {(t.status === 'idle' || t.status === 'finished') && (
          <button className="btn primary" onClick={() => startTimer(t.duration || data.settings.restDefaultSec * 1000, 'rest', 'Отдых')}><PiPlay /> Начать</button>
        )}
        {t.status === 'running' && <button className="btn" onClick={pauseTimer}><PiPause /> Пауза</button>}
        {t.status === 'paused' && <button className="btn primary" onClick={resumeTimer}><PiPlay /> Дальше</button>}
        {(t.status === 'running' || t.status === 'paused') && <button className="btn" onClick={stopTimer}><PiStop /> Завершить</button>}
      </div>
    </div>
  );
}

function FinishSheet({ open, onClose, task, tpl }: { open: boolean; onClose: () => void; task: DayTask; tpl: WorkoutTemplate }) {
  const data = useApp();
  const today = useToday();
  const log = data.trainingLogs[task.id];
  const [feeling, setFeeling] = useState<Feeling | null>(log?.feeling ?? null);
  const [note, setNote] = useState(log?.note ?? '');
  const [minutes, setMinutes] = useState<number | null>(log?.stepperMinutes ?? null);
  useEffect(() => { if (open) { setFeeling(log?.feeling ?? null); setNote(log?.note ?? ''); setMinutes(log?.stepperMinutes ?? log?.exercises.find((e) => e.exerciseId === 'stepper_cardio')?.minutes ?? null); } }, [open]);
  if (!open) return null;
  const setsTotal = tpl.items.reduce((s, it) => s + it.sets, 0);
  const setsDone = log ? log.exercises.reduce((s, e) => s + e.sets.filter(Boolean).length, 0) : 0;
  const exDone = log ? log.exercises.filter((e) => e.sets.length && e.sets.every(Boolean)).length : 0;
  const save = () => {
    stopTimer();
    const l = getData().trainingLogs[task.id] ?? A.ensureTrainingLog(task, today);
    if (!l) return;
    if (setsDone === 0) A.quickDoneTraining(task, today);
    A.finishTraining(l.id, feeling, note, tpl.id === 'stepper' ? minutes : null);
    toast(`${tpl.name}: готово`);
    onClose();
    go('/today');
  };
  return (
    <Sheet open onClose={onClose} title="Готово">
      <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 14 }}>
        <div className="kpi"><span className="k-label">Упражнений полностью</span><span className="k-value">{exDone} из {tpl.items.length}</span></div>
        <div className="kpi"><span className="k-label">Подходов отмечено</span><span className="k-value">{setsDone} из {setsTotal}</span></div>
      </div>
      {setsDone === 0 && <Note kind="plain">Подходы не отмечены — тренировка сохранится как выполненная без подробностей. Для разбора в ChatGPT полезнее отмечать подходы.</Note>}
      {tpl.id === 'stepper' && (
        <div className="field" style={{ marginTop: 12 }}>
          <span className="field-label">Сколько минут на степпере</span>
          <NumberStepper label="Минуты" value={minutes} step={5} min={0} max={120} unit="мин" onChange={setMinutes} />
        </div>
      )}
      <div className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Самочувствие</span>
        <Seg<Feeling | ''> full value={feeling ?? ''} label="Самочувствие" onChange={(v) => setFeeling((v || null) as Feeling | null)}
          options={[{ value: 'great', label: FEELING_LABELS.great }, { value: 'ok', label: FEELING_LABELS.ok }, { value: 'hard', label: FEELING_LABELS.hard }]} />
      </div>
      <label className="field">
        <span>Заметка (необязательно)</span>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: тянуло поясницу на тяге — снизил вес" />
      </label>
      <button className="btn iron big block" onClick={save}>Сохранить</button>
    </Sheet>
  );
}
