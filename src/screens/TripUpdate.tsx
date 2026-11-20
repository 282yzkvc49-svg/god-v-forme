// Перенос командировки: отчёт о том, что пересчитано (дни, готовка, закупки, тренировки), или — если перенос
// задевает уже отмеченное — предпросмотр и подтверждение.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { nowStamp, fmtRub } from '../lib/util';
import { addDays, fmtDayMonth, fmtLong, fmtShort, localDate, weekdayShort, type ISODate } from '../lib/dates';
import { planTripMove } from '../domain/tripMove';
import { scheduledTraining } from '../domain/tasks';
import type { AppData, TripMoveReport } from '../state/types';
import { href } from '../app/router';
import { Note, PageHead, toast } from '../ui/kit';
import { PiCheckBold, PiCookingPot, PiShoppingCart, PiSuitcase, PiWarning } from '../ui/icons';

/** «25–26 ноября», «30 ноября – 2 декабря». */
function range(from: ISODate, to: ISODate): string {
  return from.slice(0, 7) === to.slice(0, 7) ? `${+from.slice(8)}–${fmtDayMonth(to)}` : `${fmtDayMonth(from)} – ${fmtDayMonth(to)}`;
}

function ReportBody({ r, data }: { r: TripMoveReport; data: AppData }) {
  const label = (d: ISODate) => scheduledTraining(data, d)?.label ?? '—';
  const around = [addDays(r.after.to, 1), addDays(r.after.to, 2), addDays(r.after.to, 3)];
  return (
    <>
      <div className="card">
        <h3 className="mt0"><PiSuitcase style={{ display: 'inline', verticalAlign: '-3px' }} /> Дни</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {r.days.map((x) => <li key={x.date}><b>{weekdayShort(x.date)}, {fmtShort(x.date)}</b>: {x.before} → <b>{x.after}</b></li>)}
        </ul>
        <div className="btn-row" style={{ marginTop: 8 }}>
          {Array.from(new Set([r.before.from, r.after.to, addDays(r.after.to, 1)])).filter((d) => r.days.some((x) => x.date === d)).map((d) => <a key={d} className="btn small" href={href(`/day/${d}`)}>Открыть {fmtShort(d)}</a>)}
        </div>
      </div>
      <div className="card">
        <h3 className="mt0">Тренировки</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {r.trainings.map((t) => <li key={t.date}>{weekdayShort(t.date)}, {fmtShort(t.date)}: {t.before} → <b>{t.after}</b></li>)}
          {around.filter((d) => !r.trainings.some((t) => t.date === d)).map((d) => <li key={d}>{weekdayShort(d)}, {fmtShort(d)}: {label(d)} — без изменений</li>)}
        </ul>
        <p className="small muted" style={{ marginBottom: 0 }}>В командировке — плановый отдых, прогулка по желанию. Пропущенные силовые не переносятся и не удваиваются.</p>
      </div>
      <div className="card">
        <h3 className="mt0"><PiCookingPot style={{ display: 'inline', verticalAlign: '-3px' }} /> Готовка</h3>
        {r.cooks.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.cooks.map((c, i) => <li key={i}><b>{c.title}</b>: {c.text}</li>)}</ul> : <p className="small mt0">Без изменений.</p>}
        <p className="small muted" style={{ marginBottom: 0 }}>Готовая еда не ждёт в холодильнике всю поездку: порции на дни после командировки — в морозилку ({r.frozenBefore} → {r.frozenAfter}).</p>
      </div>
      <div className="card">
        <h3 className="mt0"><PiShoppingCart style={{ display: 'inline', verticalAlign: '-3px' }} /> Закупки</h3>
        {r.shops.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.shops.map((c, i) => <li key={i}><b>{c.title}</b>: {c.text}</li>)}</ul> : <p className="small mt0">Без изменений.</p>}
        <p className="small" style={{ marginBottom: 0 }}>Домашние закупки ≈{fmtRub(r.costBefore)} → ≈{fmtRub(r.costAfter)}; цены ориентировочные. Прошедшие закупки не менялись: что уже куплено, учтено как запас.</p>
        <div className="btn-row" style={{ marginTop: 8 }}><a className="btn small" href={href('/shopping')}>Открыть закупки</a></div>
      </div>
    </>
  );
}

export function TripUpdateScreen() {
  const data = useApp();
  const today = useToday();
  const pending = data.settings.tripMovePending ?? null;
  const last = Object.values(data.backups ?? {}).filter((b) => b.tripReport).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const trip = pending ? data.trips[pending.tripId] ?? null : null;
  const mv = useMemo(() => (pending && trip ? planTripMove(data, trip, pending, today, nowStamp()) : null), [pending?.tripId, trip?.updatedAt, today]);
  const [ack, setAck] = useState(false);
  useEffect(() => { if (!pending) A.markTripReportSeen(); }, []);

  if (pending && mv) {
    const r = mv.report;
    return (
      <div className="page">
        <PageHead title={`Перенос командировки: ${r.city}`} sub={`${range(r.before.from, r.before.to)} → ${range(r.after.from, r.after.to)}`} backTo="/settings" />
        <Note kind="warn">
          <p className="mt0"><b>Нужно ваше подтверждение:</b> перенос затрагивает то, что уже отмечено — {mv.conflicts.join('; ')}.</p>
          <p style={{ marginBottom: 0 }}>Отметки не удаляются и остаются в истории. Ниже — что изменится; прошедшие дни и купленное не меняются.</p>
        </Note>
        <ReportBody r={r} data={mv.after} />
        <label className="row nowrap" style={{ gap: 8, margin: '10px 0' }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Понятно, сохранить отметки и перенести</label>
        <div className="btn-row">
          <button className="btn primary" disabled={!ack} onClick={() => A.confirmTripMove().then(() => toast('Командировка перенесена, план пересчитан'))}><PiCheckBold /> Перенести</button>
          <button className="btn ghost" onClick={() => { if (confirm('Оставить прежние даты командировки? Их можно поменять позже в «Командировках».')) A.dismissTripMove(); }}>Не переносить</button>
        </div>
      </div>
    );
  }
  if (!last?.tripReport) {
    return (
      <div className="page">
        <PageHead title="Перенос командировки" backTo="/settings" />
        <Note>Переносов командировок не было. Даты поездок меняются в «Настройки» → «Командировки».</Note>
      </div>
    );
  }
  const r = last.tripReport;
  return (
    <div className="page">
      <PageHead title={`Командировка перенесена: ${r.city}`} sub={`Теперь ${range(r.after.from, r.after.to)} (было ${range(r.before.from, r.before.to)})`} backTo="/settings" />
      <Note kind="ok">
        <p className="mt0">Пересчитано только затронутое — с {fmtShort(r.today)}: дни, готовка, закупки и тренировки ниже. Прошедшие дни, выполненные задачи и купленное не менялись.{r.confirmed.length ? ` С вашего подтверждения изменено отмеченное: ${r.confirmed.join('; ')}.` : ''}</p>
        <p style={{ marginBottom: 0 }}>Без изменений: старт программы 16.11, командировка в Екатеринбург 18–20.11, релакс-день 29.11, меню «Азбука вкуса», тренировки с гирями 12 и 16 кг, вес, фото и отметки. Резервная копия перед переносом — {fmtLong(localDate(new Date(last.createdAt)))}, {new Date(last.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.</p>
      </Note>
      <ReportBody r={r} data={data} />
      <p className="small muted"><PiWarning style={{ display: 'inline', verticalAlign: '-2px' }} /> Если даты снова поменяются — «Настройки» → «Командировки» → «Изменить»: приложение покажет изменения до применения.</p>
    </div>
  );
}
