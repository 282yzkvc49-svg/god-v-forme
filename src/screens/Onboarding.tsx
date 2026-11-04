import { useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { addDays, fmtDayMonth, isISODate, isoWeekday } from '../lib/dates';
import { today as todayFn } from '../lib/clock';
import { isStandalone } from '../lib/files';
import { Note, Sheet } from '../ui/kit';
import { PiLock, PiShareNetwork } from '../ui/icons';
import { PlanStartForm } from './planViews';
import { go } from '../app/router';
import type { PlanSettings } from '../state/types';

/** Первый запуск: дата старта питания, затем — начало тренировок (своё расписание). */
export function Onboarding() {
  const data = useApp();
  const [step, setStep] = useState<1 | 2>(data.settings.plan?.confirmed ? 2 : 1);
  const [plan, setPlan] = useState<PlanSettings | null>(data.settings.plan);
  const today = todayFn();
  const nextMonday = addDays(today, (8 - isoWeekday(today)) % 7 || 7);
  const [trainFrom, setTrainFrom] = useState<string>(isoWeekday(today) === 1 ? today : nextMonday);
  const finish = () => {
    A.updateSettings({
      onboarded: true,
      training: { ...data.settings.training, startDate: isISODate(trainFrom) ? trainFrom : today },
    });
  };
  return (
    <Sheet open onClose={() => (plan ? finish() : undefined)} title="Мой год в форме" label="Первый запуск">
      {step === 1 ? (
        <>
          <p className="mt0">Меню на 30 дней с граммовками, рецепты, закупки, готовка, тренировки с гирями 12 и 16 кг и степпером. Отмечайте выполнение, раз в неделю записывайте вес и делайте фото, раз в месяц выгружайте отчёт для разбора в ChatGPT.</p>
          <Note kind="ok" icon={<PiLock />}>Данные хранятся только на этом устройстве. Регулярно сохраняйте резервную копию в «Файлы».</Note>
          {!isStandalone() && (
            <div style={{ marginTop: 10 }}><Note kind="info" icon={<PiShareNetwork />}>Добавьте приложение на экран «Домой» (Safari → «Поделиться» → «На экран „Домой“») и ведите записи уже в нём: данные вкладки Safari хранятся отдельно.</Note></div>
          )}
          <h3 style={{ marginTop: 16 }}>Когда начинаем программу питания?</h3>
          <p className="small muted mt0">Можно выбрать любую дату. Меню, закупки, готовка, контейнеры и релакс-день встанут на свои места; первая закупка и готовка — накануне старта.</p>
          <PlanStartForm firstRun submitLabel="Дальше" onDone={(cfg) => { setPlan(cfg); setStep(2); }} />
          <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { A.updateSettings({ onboarded: true }); go('/analysis', { tab: 'backup' }); }}>У меня есть резервная копия — восстановить</button>
        </>
      ) : (
        <>
          <p className="mt0">План питания: с {plan ? fmtDayMonth(plan.startDate) : '—'}.</p>
          <h3>Когда начать тренировки?</h3>
          <p className="small muted mt0">У тренировок своё расписание, оно не зависит от даты старта питания: силовые — пн, ср, пт (А и Б по очереди), степпер — вт и сб, в остальные дни — восстановление. Гири: 12 и 16 кг.</p>
          <label className="field">
            <span>Первый день тренировок</span>
            <input className="input" type="date" value={trainFrom} onChange={(e) => setTrainFrom(e.target.value)} />
          </label>
          <div className="chips" style={{ marginBottom: 12 }}>
            <button className="chip" onClick={() => setTrainFrom(today)}>Сегодня</button>
            <button className="chip" onClick={() => setTrainFrom(nextMonday)}>С понедельника</button>
            {plan && <button className="chip" onClick={() => setTrainFrom(plan.startDate)}>Вместе с питанием</button>}
          </div>
          <button className="btn primary big block" onClick={finish} disabled={!isISODate(trainFrom)}>Начать</button>
          <p className="hint center">{data.settings.goals.startWeightKg} → {data.settings.goals.targetWeightKg} кг примерно за год, без жёстких диет.</p>
        </>
      )}
    </Sheet>
  );
}
