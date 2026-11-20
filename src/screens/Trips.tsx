// Командировки: список, «Новая командировка» с предпросмотром изменений, карточки питания в поездке.
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import type { MealSlot, Trip } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, fmtDayMonth, fmtLong, fmtShort, isISODate, isoWeekday, weekdayShort, type ISODate } from '../lib/dates';
import { today as todayFn, useToday } from '../lib/clock';
import { fmtRub, nowStamp, parseNum, uid } from '../lib/util';
import { href } from '../app/router';
import { previewChange, tripOps, type PlanDiff } from '../domain/planDiff';
import { statusOf, type DayTask } from '../domain/tasks';
import {
  TRIP_PRINCIPLES, lastSunday, monthKey, relaxDateOfMonth, tripDates, tripList, tripMeal, tripOn, tripVariant, validateTrip,
} from '../domain/trips';
import { PRODUCTS } from '../domain/catalog';
import { buyText } from '../domain/plan';
import { CheckButton, Disclosure, Empty, Note, PageHead, Sheet, toast } from '../ui/kit';
import { PiCheck, PiCheckBold, PiPlus, PiSuitcase, PiTrash, PiWarning, PiPencilSimple } from '../ui/icons';

// ------------------------------------------------------------------ приём пищи в командировке

export function TripMealCard({ date, slot, task, onDone }: { date: ISODate; slot: MealSlot; task: DayTask | null; onDone?: () => void }) {
  const data = useApp();
  const trip = tripOn(tripList(data), date);
  const rec = task ? data.taskStatus[task.id] : undefined;
  const [variant, setVariant] = useState<string | null>(rec?.variantId ?? null);
  const [other, setOther] = useState(rec?.choice === 'other');
  const [comment, setComment] = useState(rec?.comment ?? '');
  if (!trip) return null;
  const m = tripMeal(trip, slot);
  const chosen = rec?.status === 'skipped' ? 'skipped' : rec?.choice ?? null;
  const save = (choice: 'suggested' | 'other' | 'skipped' | null) => {
    if (!task) return;
    A.setTripMeal(task, choice, choice === 'suggested' ? variant ?? m.variants[0].id : null, choice === 'other' ? comment : null).then(() => onDone?.());
  };
  return (
    <div className="card meal-card">
      <div className="meal-head">
        <b>{MEAL_LABELS[slot]}</b>
        <span className="small muted">{m.place}</span>
        <span className="grow" />
        {chosen && <span className={`chip ${chosen === 'skipped' ? '' : 'accent'}`}>{chosen === 'suggested' ? `съел: ${tripVariant(trip, slot, rec?.variantId)?.title ?? 'вариант'}` : chosen === 'other' ? 'другое подходящее блюдо' : 'пропущен'}</span>}
      </div>
      <div className="meal-dish">{m.title}</div>
      <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label={`${MEAL_LABELS[slot]}: варианты`}>
        {m.variants.map((v, i) => (
          <label key={v.id} className={`trip-variant${(variant ?? (chosen === 'suggested' ? rec?.variantId : null)) === v.id ? ' on' : ''}`}>
            <input type="radio" name={`v-${date}-${slot}`} checked={variant === v.id} onChange={() => { setVariant(v.id); setOther(false); }} />
            <span className="grow">
              <b>Вариант {i + 1}. {v.title}</b> <span className="small muted">ориентир {v.kcal} ккал, без взвешивания</span>
              <span className="small" style={{ display: 'block' }}>{v.items.map((it) => `${it.name} — ${it.amount}`).join('; ')}</span>
            </span>
          </label>
        ))}
      </div>
      {m.alternatives && <p className="small muted">{m.alternatives}</p>}
      {other && (
        <label className="field" style={{ margin: '8px 0 0' }}>
          <span>Что выбрали (необязательно)</span>
          <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="например, суп и курица с овощами" />
        </label>
      )}
      {task && (
        <div className="btn-row">
          <button className="btn primary small" onClick={() => save('suggested')}><PiCheck /> Съел предложенный вариант</button>
          {other
            ? <button className="btn small" onClick={() => save('other')}><PiCheck /> Сохранить: другое блюдо</button>
            : <button className="btn small" onClick={() => setOther(true)}>Выбрал другое подходящее блюдо</button>}
          <button className="btn small" onClick={() => save('skipped')}>Пропустил приём пищи</button>
          {chosen && <button className="btn ghost small" onClick={() => save(null)}>Снять отметку</button>}
        </div>
      )}
    </div>
  );
}

export function TripDayCard({ date, tasks }: { date: ISODate; tasks: DayTask[] }) {
  const data = useApp();
  const trip = tripOn(tripList(data), date);
  if (!trip) return null;
  const n = diffDays(date, trip.from) + 1;
  const total = diffDays(trip.to, trip.from) + 1;
  return (
    <div className="stack">
      <div className="card" style={{ borderLeft: '5px solid var(--sea)' }}>
        <div className="card-head">
          <h3><PiSuitcase style={{ display: 'inline', verticalAlign: '-4px' }} /> Командировка: {trip.city}</h3>
          <span className="chip sea">день {n} из {total}</span>
        </div>
        <p className="mt0 small">{trip.hotelBreakfast ? 'Гостиница, завтрак включён. ' : ''}Домашнего меню и готовки нет; тренировки — плановый отдых, прогулка 20–40 минут по желанию.</p>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{TRIP_PRINCIPLES.map((p, i) => <li key={i}>{p}</li>)}</ul>
      </div>
      {MEAL_SLOTS.map((s) => <TripMealCard key={s} date={date} slot={s} task={tasks.find((t) => t.kind === 'meal' && t.slot === s) ?? null} />)}
    </div>
  );
}

// ------------------------------------------------------------------ список командировок

export function TripsScreen() {
  const data = useApp();
  const today = useToday();
  const trips = tripList(data);
  const [edit, setEdit] = useState<Trip | 'new' | null>(null);
  const upcoming = trips.filter((t) => t.to >= today);
  const past = trips.filter((t) => t.to < today).reverse();
  return (
    <div className="page">
      <PageHead title="Командировки" sub="В поездке — командировочное питание и плановый отдых вместо тренировок; меню, готовка и закупки дома пересчитываются" backTo="/settings" right={
        <button className="btn primary small" onClick={() => setEdit('new')}><PiPlus /> Новая командировка</button>
      } />
      {Object.values(data.backups ?? {}).some((b) => b.tripReport) && <p className="small"><a href={href('/trip-update')}>Отчёт о последнем переносе командировки</a></p>}
      {!trips.length && <div className="card"><Empty title="Командировок нет">Добавьте поездку — приложение покажет, что изменится в меню, готовке, закупках и тренировках, и применит изменения только после подтверждения.</Empty></div>}
      {upcoming.length > 0 && <h2 className="section-title">Предстоящие</h2>}
      {upcoming.map((t) => <TripRow key={t.id} t={t} onEdit={() => setEdit(t)} />)}
      {past.length > 0 && <h2 className="section-title">Прошедшие</h2>}
      {past.map((t) => <TripRow key={t.id} t={t} onEdit={() => setEdit(t)} />)}
      {edit && <TripEditor trip={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TripRow({ t, onEdit }: { t: Trip; onEdit: () => void }) {
  const data = useApp();
  const shop = data.shoppingEvents[`shop-trip-${t.id}`];
  const days = tripDates(t);
  let suggested = 0, other = 0, skipped = 0;
  for (const d of days) for (const s of MEAL_SLOTS) {
    const r = data.taskStatus[`meal:${d}:${s}`];
    if (r?.status === 'skipped') skipped++;
    else if (r?.choice === 'other') other++;
    else if (r?.status === 'done') suggested++;
  }
  const [exp, setExp] = useState(t.foodExpensesRub != null ? String(t.foodExpensesRub) : '');
  return (
    <div className="card">
      <div className="card-head">
        <h3><PiSuitcase style={{ display: 'inline', verticalAlign: '-4px' }} /> {t.city}</h3>
        <span className="chip sea">{fmtDayMonth(t.from)} — {fmtDayMonth(t.to)}, {days.length} дн.</span>
      </div>
      <p className="small mt0">{t.hotelBreakfast ? 'Завтрак в гостинице' : 'Без завтрака в гостинице'} · {t.fridge ? 'есть холодильник' : 'без холодильника'} · {t.canTrain ? 'можно тренироваться' : 'без тренировок'}{t.trainNextDay ? ' · на следующий день — тренировка по самочувствию' : ''}{t.comment ? ` · ${t.comment}` : ''}</p>
      <p className="small muted mt0">Приёмы пищи: по варианту {suggested}, другое блюдо {other}, пропущено {skipped} из {days.length * 4}.</p>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <a className="btn small" href={href(`/day/${t.from}`)}>Открыть первый день</a>
        {shop && <a className="btn small" href={href(`/shop/${shop.id}`)}>Перекусы: список</a>}
        <button className="btn ghost small" onClick={onEdit}><PiPencilSimple /> Изменить</button>
        <label className="field" style={{ margin: 0 }}>
          <span className="small">Расходы на еду в поездке, ₽ (необязательно)</span>
          <input className="input price-input" inputMode="decimal" value={exp} onChange={(e) => setExp(e.target.value)} onBlur={() => A.setTripExpenses(t.id, parseNum(exp))} />
        </label>
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>Командировочные расходы не входят в домашний бюджет на продукты.</p>
    </div>
  );
}

// ------------------------------------------------------------------ новая командировка / изменение

export function TripEditor({ trip, onClose, initialFrom }: { trip: Trip | null; onClose: () => void; initialFrom?: ISODate }) {
  const data = useApp();
  const today = todayFn();
  const [city, setCity] = useState(trip?.city ?? '');
  const [from, setFrom] = useState<ISODate>(trip?.from ?? initialFrom ?? addDays(today, 7));
  const [to, setTo] = useState<ISODate>(trip?.to ?? addDays(initialFrom ?? addDays(today, 7), 2));
  const [hotelBreakfast, setHotelBreakfast] = useState(trip?.hotelBreakfast ?? true);
  const [fridge, setFridge] = useState(trip?.fridge ?? false);
  const [canTrain, setCanTrain] = useState(trip?.canTrain ?? false);
  const [trainNextDay, setTrainNextDay] = useState(trip?.trainNextDay ?? false);
  const [comment, setComment] = useState(trip?.comment ?? '');
  const [step, setStep] = useState<'form' | 'preview'>('form');
  const [relaxChoice, setRelaxChoice] = useState<'move' | 'keep'>('move');
  const [relaxTo, setRelaxTo] = useState<ISODate | null>(null);
  const [ack, setAck] = useState(false);
  const errors = validateTrip({ id: trip?.id, city, from, to }, tripList(data));
  const draft: Trip = {
    id: trip?.id ?? uid('trip'), city: city.trim(), from, to, hotelBreakfast, fridge, canTrain, trainNextDay, comment: comment.trim() || null,
    foodExpensesRub: trip?.foodExpensesRub ?? null, createdAt: trip?.createdAt ?? nowStamp(), updatedAt: nowStamp(),
  };
  const focus = useMemo(() => (errors.length ? [] : tripDates(draft)), [from, to, errors.length]);
  // релакс-день попадает в поездку → предложить перенос
  const relaxHits = focus.filter((d) => relaxDateOfMonth(data.settings, monthKey(d)) === d);
  const relaxOptions = (ym: string) => {
    const out: ISODate[] = [];
    const last = lastSunday(ym);
    for (let d = `${ym}-01`; monthKey(d) === ym; d = addDays(d, 1)) if (!focus.includes(d) && !tripOn(tripList(data).filter((t) => t.id !== draft.id), d) && d >= today && isoWeekday(d) >= 6) out.push(d);
    return out.sort((a, b) => Math.abs(diffDays(a, last)) - Math.abs(diffDays(b, last)));
  };
  const relaxOps = () => {
    if (!relaxHits.length || relaxChoice === 'keep') return [];
    const ym = monthKey(relaxHits[0]);
    const target = relaxTo ?? relaxOptions(ym)[0];
    if (!target) return [];
    return [{ store: 'settings', put: { ...data.settings, relaxOverrides: { ...data.settings.relaxOverrides, [ym]: target } } }];
  };
  const diff: PlanDiff | null = useMemo(() => {
    if (step !== 'preview' || errors.length) return null;
    return previewChange(data, [...tripOps(draft, trip?.id ?? null), ...relaxOps()], today, focus);
  }, [step, city, from, to, hotelBreakfast, fridge, canTrain, trainNextDay, comment, relaxChoice, relaxTo, data]);
  const needAck = !!diff && (diff.conflicts.markedDays.length > 0 || diff.conflicts.trainingLogs.length > 0 || diff.conflicts.doneEvents.length > 0);
  const apply = () => {
    if (!diff) return;
    A.applyOps(diff.ops).then(() => { toast(trip ? 'Командировка изменена, план пересчитан' : 'Командировка добавлена, план пересчитан'); onClose(); });
  };
  const remove = () => {
    if (!trip) return;
    const d = previewChange(data, tripOps(null, trip.id), today, tripDates(trip));
    const marked = d.conflicts.markedDays.length + d.conflicts.trainingLogs.length;
    if (!confirm(`Удалить командировку «${trip.city}»? Дни ${fmtShort(trip.from)}–${fmtShort(trip.to)} снова станут домашними: меню, готовка и закупки пересчитаются.${marked ? ' Отметки этих дней сохранятся в истории.' : ''}`)) return;
    A.applyOps(d.ops).then(() => { toast('Командировка удалена, план пересчитан'); onClose(); });
  };
  return (
    <Sheet open onClose={onClose} title={trip ? `Командировка: ${trip.city}` : 'Новая командировка'} wide>
      {step === 'form' ? (
        <div className="stack" style={{ gap: 10 }}>
          <label className="field" style={{ margin: 0 }}><span>Город</span><input className="input" value={city} onChange={(e) => setCity(e.target.value)} placeholder="например, Казань" /></label>
          <div className="row" style={{ gap: 10 }}>
            <label className="field grow" style={{ margin: 0 }}><span>Дата начала</span><input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (isISODate(e.target.value) && to < e.target.value) setTo(e.target.value); }} /></label>
            <label className="field grow" style={{ margin: 0 }}><span>Дата окончания (включительно)</span><input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={hotelBreakfast} onChange={(e) => setHotelBreakfast(e.target.checked)} /> Завтрак включён в гостинице</label>
          <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={fridge} onChange={(e) => setFridge(e.target.checked)} /> В номере есть холодильник</label>
          <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={canTrain} onChange={(e) => setCanTrain(e.target.checked)} /> Можно тренироваться (комплекс с собственным весом по желанию)</label>
          <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={trainNextDay} onChange={(e) => setTrainNextDay(e.target.checked)} /> На следующий день после возвращения — тренировка по схеме, по самочувствию (вместо восстановления)</label>
          <label className="field" style={{ margin: 0 }}><span>Комментарий</span><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          {errors.map((e, i) => <Note key={i} kind="warn">{e}</Note>)}
          <div className="btn-row">
            <button className="btn primary" disabled={!!errors.length} onClick={() => setStep('preview')}>Показать изменения</button>
            {trip && <button className="btn ghost" onClick={remove}><PiTrash /> Удалить командировку</button>}
          </div>
        </div>
      ) : diff ? (
        <div className="stack" style={{ gap: 10 }}>
          <p className="mt0"><b>{draft.city}</b>: {fmtLong(from)} — {fmtLong(to)}, {focus.length} дн. Изменения применятся только после подтверждения.</p>
          <div className="card flat">
            <h4 className="mt0">Меню</h4>
            <p className="small mt0">Домашних приёмов пищи станет {diff.homeMealsAfter} (было {diff.homeMealsBefore}). В поездке вместо домашнего меню: завтраки {diff.replacedMeals.breakfast}, обеды {diff.replacedMeals.lunch}, перекусы {diff.replacedMeals.snack}, ужины {diff.replacedMeals.dinner} — {hotelBreakfast ? 'завтрак в гостинице' : 'завтрак из супермаркета или кафе'}, обед и ужин в кафе или доставкой, перекус из супермаркета.</p>
            <h4>Готовка</h4>
            {diff.cookChanges.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{diff.cookChanges.map((c, i) => <li key={i}><b>{c.title}</b>: {c.text}</li>)}</ul> : <p className="small mt0">Без изменений.</p>}
            <p className="small">Порций в морозилку: {diff.frozenBefore} → {diff.frozenAfter}. Готовая еда не ждёт в холодильнике всю поездку.</p>
            <h4>Закупки</h4>
            <p className="small mt0">Домашние закупки ≈{fmtRub(diff.costBefore)} → ≈{fmtRub(diff.costAfter)}. Перекусы в поездку — отдельный небольшой список (≈{fmtRub(diff.tripCostAfter)} за все поездки, не входит в домашний бюджет). Цены ориентировочные.</p>
            <h4>Тренировки</h4>
            {diff.trainings.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{diff.trainings.map((t) => <li key={t.date}>{weekdayShort(t.date)}, {fmtShort(t.date)}: {t.before} → <b>{t.after}</b></li>)}</ul> : <p className="small mt0">Без изменений.</p>}
            <p className="small">Пропущенные из-за поездки тренировки не переносятся и не удваиваются; в статистике — «Плановый отдых / Командировка».</p>
          </div>
          {relaxHits.length > 0 && (
            <Note kind="warn">
              <p><b>Релакс-день {fmtDayMonth(relaxHits[0])} попадает на командировку.</b> Как поступить?</p>
              <label className="row nowrap" style={{ gap: 8 }}><input type="radio" checked={relaxChoice === 'move'} onChange={() => setRelaxChoice('move')} /> Перенести релакс-день на
                <select className="input" style={{ width: 'auto' }} value={relaxTo ?? relaxOptions(monthKey(relaxHits[0]))[0] ?? ''} onChange={(e) => { setRelaxTo(e.target.value); setRelaxChoice('move'); }}>
                  {relaxOptions(monthKey(relaxHits[0])).map((d) => <option key={d} value={d}>{weekdayShort(d)}, {fmtShort(d)}</option>)}
                </select>
              </label>
              <label className="row nowrap" style={{ gap: 8 }}><input type="radio" checked={relaxChoice === 'keep'} onChange={() => setRelaxChoice('keep')} /> Оставить: релакс-день совпадёт с поездкой</label>
            </Note>
          )}
          {needAck && (
            <Note kind="warn">
              <p><b>На эти даты уже есть отметки:</b> {[
                diff.conflicts.markedDays.length ? `приёмы пищи — ${diff.conflicts.markedDays.map(fmtShort).join(', ')}` : '',
                diff.conflicts.trainingLogs.length ? `тренировки — ${diff.conflicts.trainingLogs.map(fmtShort).join(', ')}` : '',
                ...diff.conflicts.doneEvents,
              ].filter(Boolean).join('; ')}.</p>
              <p>Ничего не удаляется: отметки сохранятся в истории. Если поездка на самом деле короче — вернитесь и поправьте даты.</p>
              <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Понятно, сохранить отметки и применить</label>
            </Note>
          )}
          <div className="btn-row">
            <button className="btn primary" disabled={needAck && !ack} onClick={apply}><PiCheckBold /> Применить</button>
            <button className="btn" onClick={() => setStep('form')}>Изменить данные</button>
            <button className="btn ghost" onClick={onClose}>Отмена</button>
          </div>
        </div>
      ) : <Note kind="warn"><PiWarning /> Не удалось построить предпросмотр.</Note>}
    </Sheet>
  );
}

// ------------------------------------------------------------------ релакс-день месяца

export function RelaxEditor({ months }: { months: string[] }) {
  const data = useApp();
  const today = useToday();
  const [pending, setPending] = useState<{ ym: string; date: ISODate } | null>(null);
  const diff = useMemo(() => {
    if (!pending) return null;
    const ops = [{ store: 'settings', put: { ...data.settings, relaxOverrides: { ...data.settings.relaxOverrides, [pending.ym]: pending.date } } }];
    return previewChange(data, ops, today, [pending.date, relaxDateOfMonth(data.settings, pending.ym)].sort());
  }, [pending, data]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {months.map((ym) => {
        const cur = relaxDateOfMonth(data.settings, ym);
        const isDefault = cur === lastSunday(ym);
        return (
          <label key={ym} className="field" style={{ margin: 0 }}>
            <span>{new Date(`${ym}-15T12:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}: {weekdayShort(cur)}, {fmtShort(cur)}{isDefault ? ' (последнее воскресенье)' : ''}</span>
            <input className="input" type="date" value={pending?.ym === ym ? pending.date : cur} min={`${ym}-01`} max={`${ym}-${String(new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate()).padStart(2, '0')}`}
              onChange={(e) => { if (isISODate(e.target.value) && monthKey(e.target.value) === ym && e.target.value !== cur) setPending({ ym, date: e.target.value }); }} />
          </label>
        );
      })}
      {pending && diff && (
        <Note kind="plain">
          <p>Релакс-день {new Date(`${pending.ym}-15T12:00`).toLocaleDateString('ru-RU', { month: 'long' })} → {fmtLong(pending.date)}.{tripOn(tripList(data), pending.date) ? ' Это день командировки.' : ''}</p>
          {diff.cookChanges.length > 0 && <p className="small">Готовка: {diff.cookChanges.map((c) => `${c.title}: ${c.text}`).join('; ')}.</p>}
          {diff.conflicts.markedDays.length > 0 && <p className="small">На {diff.conflicts.markedDays.map(fmtShort).join(', ')} уже есть отметки — они сохранятся.</p>}
          <div className="btn-row">
            <button className="btn primary small" onClick={() => A.applyOps(diff.ops).then(() => { toast('Релакс-день изменён, план пересчитан'); setPending(null); })}>Применить</button>
            <button className="btn small" onClick={() => setPending(null)}>Отмена</button>
          </div>
        </Note>
      )}
      <p className="hint mt0">Один релакс-день в каждом календарном месяце, по умолчанию — последнее воскресенье. При смене даты старта он не сдвигается. Любимая еда без обязательного меню; алкоголь исключён. Это часть плана, а не нарушение.</p>
    </div>
  );
}

export function TripShopNote({ tripId }: { tripId: string }) {
  const data = useApp();
  const e = data.shoppingEvents[`shop-trip-${tripId}`];
  if (!e?.lines?.length) return null;
  return (
    <Disclosure summary={<span className="small">Перекусы на поездку: {e.lines.length} поз.</span>}>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {e.lines.map((l) => <li key={l.productId}>{PRODUCTS[l.productId].name} — {buyText(l)}, к {fmtShort(l.needs[0]?.date ?? e.date)}</li>)}
      </ul>
    </Disclosure>
  );
}

export { CheckButton, statusOf };
