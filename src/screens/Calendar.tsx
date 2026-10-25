import { useMemo, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { useToday } from '../lib/clock';
import { useRoute, go, href } from '../app/router';
import {
  addDays, addMonths, fmtDayMonth, fmtLong, fmtMonthYear, isISODate, monthGrid, parts, startOfWeek, WEEKDAYS_SHORT, weekdayShort, type ISODate,
} from '../lib/dates';
import { cookingEventsOn, dayProgress, planDay, shoppingEventsOn, tasksForDate } from '../domain/tasks';
import { TEMPLATE_NAMES } from '../domain/templates';
import type { AppData } from '../state/types';
import { DayDetail } from './shared';
import { PageHead, Seg, useMedia } from '../ui/kit';
import { KettlebellIcon, PiCaretLeft, PiCaretRight, PiCookingPot, PiPersonSimpleWalk, PiScales, PiShoppingCart, PiSun, PiForkKnife, PiCamera, StepperIcon } from '../ui/icons';

function DayIcons({ data, date }: { data: AppData; date: ISODate }) {
  const p = planDay(data, date);
  const tasks = tasksForDate(data, date);
  const train = tasks.find((t) => t.kind === 'training');
  const icons: ReactNode[] = [];
  if (p?.relax) icons.push(<span key="r" className="i-relax" title="Релакс-день"><PiSun /></span>);
  else if (p?.meals) icons.push(<span key="m" title="Меню"><PiForkKnife /></span>);
  if (train) {
    icons.push(
      <span key="t" className="i-train" title={train.title}>
        {train.templateId === 'stepper' ? <StepperIcon size={16} /> : train.templateId === 'recovery' ? <PiPersonSimpleWalk /> : <KettlebellIcon size={16} />}
      </span>,
    );
  }
  if (tasks.some((t) => t.kind === 'cooking')) icons.push(<span key="c" className="i-cook" title="Готовка"><PiCookingPot /></span>);
  if (tasks.some((t) => t.kind === 'shopping')) icons.push(<span key="s" className="i-shop" title="Закупка"><PiShoppingCart /></span>);
  if (tasks.some((t) => t.kind === 'weigh')) icons.push(<span key="w" className="i-weigh" title="Взвешивание"><PiScales /></span>);
  if (tasks.some((t) => t.kind === 'photo')) icons.push(<span key="p" className="i-weigh" title="Фото"><PiCamera /></span>);
  return <span className="cal-icons">{icons}</span>;
}

function dayLabel(data: AppData, date: ISODate): string {
  const p = planDay(data, date);
  const bits: string[] = [];
  if (p?.relax) bits.push('релакс-день');
  const tr = tasksForDate(data, date).find((t) => t.kind === 'training');
  if (tr) bits.push(tr.title);
  if (cookingEventsOn(data, date).some((e) => e.eventType === 'meal_prep')) bits.push('готовка');
  if (shoppingEventsOn(data, date).length) bits.push('закупка');
  const pr = dayProgress(data, date);
  if (pr.total) bits.push(`выполнено ${pr.done} из ${pr.total}`);
  if (!p) bits.push('плана нет');
  return `${fmtLong(date)}: ${bits.join(', ')}`;
}

export function CalendarScreen() {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const sel = isISODate(route.query.get('d')) ? route.query.get('d')! : today;
  const view = route.query.get('view') === 'week' ? 'week' : 'month';
  const anchor = isISODate(route.query.get('m')) ? route.query.get('m')! : sel;
  const set = (q: Record<string, string>) => go('/calendar', { d: sel, view, m: anchor, ...q }, true);
  const wide = useMedia('(min-width: 980px)');

  const selectDay = (d: ISODate) => {
    if (wide) set({ d, m: d });
    else go(`/day/${d}`);
  };

  return (
    <div className="page">
      <PageHead title="Календарь" sub="Нажмите на день, чтобы увидеть задачи" right={
        <Seg value={view} onChange={(v) => set({ view: v })} options={[{ value: 'month', label: 'Месяц' }, { value: 'week', label: 'Неделя' }]} label="Вид календаря" />
      } />
      <div className="cols">
        <div className="card">
          {view === 'month' ? <MonthView data={data} anchor={anchor} sel={sel} today={today} onSelect={selectDay} onNav={(m) => set({ m })} />
            : <WeekView data={data} anchor={anchor} today={today} sel={sel} onSelect={selectDay} onNav={(m) => set({ m })} />}
          <div className="legend">
            <span><KettlebellIcon size={15} /> силовая</span>
            <span><StepperIcon size={15} /> степпер</span>
            <span><PiCookingPot /> готовка</span>
            <span><PiShoppingCart /> закупка</span>
            <span><PiScales /> вес</span>
            <span><PiSun /> релакс</span>
          </div>
        </div>
        {wide && (
          <div className="sticky-col">
            <DayDetail date={sel} header={
              <div>
                <h2 className="section-title mt0" style={{ marginTop: 0 }}>{fmtLong(sel)}</h2>
                {sel !== today && <a className="btn ghost small" style={{ paddingLeft: 0 }} href={href('/calendar', { d: today, view, m: today })}>Вернуться к сегодня</a>}
              </div>
            } />
          </div>
        )}
      </div>
    </div>
  );
}

function MonthView({ data, anchor, sel, today, onSelect, onNav }: { data: AppData; anchor: ISODate; sel: ISODate; today: ISODate; onSelect: (d: ISODate) => void; onNav: (m: ISODate) => void }) {
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const m = parts(anchor).m;
  return (
    <>
      <div className="cal-head">
        <button className="icon-btn" onClick={() => onNav(addMonths(anchor, -1))} aria-label="Предыдущий месяц"><PiCaretLeft /></button>
        <div className="title center">{fmtMonthYear(anchor)}</div>
        <button className="icon-btn" onClick={() => onNav(addMonths(anchor, 1))} aria-label="Следующий месяц"><PiCaretRight /></button>
      </div>
      <div className="cal-grid" role="grid">
        {WEEKDAYS_SHORT.map((w) => <div key={w} className="cal-wd">{w}</div>)}
        {grid.flat().map((d) => {
          const p = planDay(data, d);
          const pr = dayProgress(data, d);
          const out = parts(d).m !== m;
          const cls = ['cal-day', out && 'out', !p && 'noplan', p?.relax && 'relax', d === today && 'today', d === sel && 'sel'].filter(Boolean).join(' ');
          return (
            <button key={d} className={cls} onClick={() => onSelect(d)} aria-label={dayLabel(data, d)} aria-current={d === today ? 'date' : undefined}>
              <span className="cal-num">{parts(d).d}</span>
              <DayIcons data={data} date={d} />
              {pr.total > 0 && pr.done > 0 && <span className="cal-bar"><i style={{ width: `${(pr.done / pr.total) * 100}%` }} /></span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

function WeekView({ data, anchor, today, sel, onSelect, onNav }: { data: AppData; anchor: ISODate; today: ISODate; sel: ISODate; onSelect: (d: ISODate) => void; onNav: (m: ISODate) => void }) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <>
      <div className="cal-head">
        <button className="icon-btn" onClick={() => onNav(addDays(start, -7))} aria-label="Предыдущая неделя"><PiCaretLeft /></button>
        <div className="title center" style={{ fontSize: 18 }}>{fmtDayMonth(days[0])} — {fmtDayMonth(days[6])}</div>
        <button className="icon-btn" onClick={() => onNav(addDays(start, 7))} aria-label="Следующая неделя"><PiCaretRight /></button>
      </div>
      <div className="week-list">
        {days.map((d) => {
          const p = planDay(data, d);
          const tasks = tasksForDate(data, d);
          const pr = dayProgress(data, d);
          const tr = tasks.find((t) => t.kind === 'training');
          return (
            <button key={d} className={`week-day${d === today ? ' today' : ''}${p?.relax ? ' relax' : ''}`} onClick={() => onSelect(d)} style={d === sel ? { outline: '2px solid var(--ink)' } : undefined}>
              <span className="wd">{parts(d).d}<small>{weekdayShort(d)}</small></span>
              <span style={{ display: 'grid', gap: 4 }}>
                {!p && <span className="muted small">План пока не добавлен</span>}
                {p?.relax && <span style={{ fontWeight: 650, color: 'var(--rose)' }}>Релакс-день</span>}
                {tr && <span style={{ fontWeight: 600 }}>{tr.templateId ? TEMPLATE_NAMES[tr.templateId] ?? tr.title : tr.title}{tr.time ? `, ${tr.time}` : ''}</span>}
                {p?.meals && <span className="small muted">Обед: {p.meals.lunch}</span>}
                <span className="chips">
                  {tasks.filter((t) => t.kind === 'cooking').map((t) => <span key={t.id} className="chip amber">Готовка</span>)}
                  {tasks.filter((t) => t.kind === 'shopping').map((t) => <span key={t.id} className="chip sea">Закупка</span>)}
                  {tasks.filter((t) => t.kind === 'weigh').map((t) => <span key={t.id} className="chip plum">Взвешивание</span>)}
                  {tasks.filter((t) => t.kind === 'photo').map((t) => <span key={t.id} className="chip plum">Фото</span>)}
                  {pr.total > 0 && <span className="chip">{pr.done}/{pr.total}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function DayPage({ date }: { date: string }) {
  const today = useToday();
  const d = isISODate(date) ? date : today;
  return (
    <div className="page narrow">
      <PageHead title={fmtLong(d)} backTo="/calendar" right={
        <>
          <a className="icon-btn" href={href(`/day/${addDays(d, -1)}`)} aria-label="Предыдущий день"><PiCaretLeft /></a>
          <a className="icon-btn" href={href(`/day/${addDays(d, 1)}`)} aria-label="Следующий день"><PiCaretRight /></a>
        </>
      } />
      <DayDetail date={d} />
    </div>
  );
}
