import { useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { PLAN_START } from '../lib/seed';
import { fmtDayMonth, isISODate } from '../lib/dates';
import { isStandalone } from '../lib/files';
import { Note, Sheet } from '../ui/kit';
import { PiLock, PiShareNetwork } from '../ui/icons';

/** Первый запуск: что умеет приложение и когда начинать силовые. */
export function Onboarding() {
  const data = useApp();
  const [later, setLater] = useState(false);
  const [date, setDate] = useState('');
  const finish = () => {
    A.updateSettings({ onboarded: true, trainingStartDate: later && isISODate(date) ? date : null });
  };
  return (
    <Sheet open onClose={() => A.updateSettings({ onboarded: true })} title="Мой год в форме" label="Первый запуск">
      <p className="mt0">План на 30 дней с {fmtDayMonth(PLAN_START)}: меню, рецепты, закупки, готовка, тренировки с гирей и степпером. Отмечайте выполнение, раз в неделю записывайте вес и делайте фото, раз в месяц выгружайте отчёт для разбора в ChatGPT.</p>
      <Note kind="ok" icon={<PiLock />}>Данные хранятся только на этом устройстве. Регулярно сохраняйте резервную копию в «Файлы».</Note>
      {!isStandalone() && (
        <div style={{ marginTop: 10 }}><Note kind="info" icon={<PiShareNetwork />}>Добавьте приложение на экран «Домой» (Safari → «Поделиться» → «На экран „Домой“») и ведите записи уже в нём: данные вкладки Safari хранятся отдельно.</Note></div>
      )}
      <h3 style={{ marginTop: 16 }}>Когда начать силовые</h3>
      <div className="menu-list" style={{ marginTop: 12 }}>
        <button aria-pressed={!later} onClick={() => setLater(false)} style={!later ? { outline: '2px solid var(--accent)' } : undefined}>Начать по плану, с {fmtDayMonth(PLAN_START)}</button>
        <button aria-pressed={later} onClick={() => setLater(true)} style={later ? { outline: '2px solid var(--accent)' } : undefined}>Перенести начало силовых</button>
      </div>
      {later && (
        <label className="field" style={{ marginTop: 10 }}>
          <span>Силовые — с даты</span>
          <input className="input" type="date" value={date} min={PLAN_START} onChange={(e) => setDate(e.target.value)} />
          <span className="hint">До этой даты силовые будут помечены «отложено» и не попадут в пропуски. Дату можно поменять в настройках.</span>
        </label>
      )}
      <button className="btn primary big block" style={{ marginTop: 14 }} onClick={finish} disabled={later && !isISODate(date)}>Понятно, начать</button>
      <p className="hint center">{data.settings.goals.startWeightKg} → {data.settings.goals.targetWeightKg} кг примерно за год, без жёстких диет.</p>
    </Sheet>
  );
}
