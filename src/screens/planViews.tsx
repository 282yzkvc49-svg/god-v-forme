// Подробные карточки плана: приём пищи с граммовками, день целиком, готовка, закупка, разморозка,
// выбор даты старта и проверка согласованности плана.
import { useMemo, useState } from 'react';
import { useApp, getData } from '../state/store';
import * as A from '../state/actions';
import type { CookingEvent, MealCard, MealSlot, PlanSettings, ShoppingEvent } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import {
  DISHES, PRODUCTS, TEMPLATE, cookedWeight, dishAmount, dishNutrition, ingredientLines, kcalText,
} from '../domain/catalog';
import {
  BASE_START, BUDGET_RUB, PLAN_LENGTH, buildInstance, buyText, cardNutrition, dayNutrition,
  makePlanSettings, planContext, planEnd, planPosition, portionsLeft,
} from '../domain/plan';
import { checkActiveData, checkEquipment, checkInstance, checkSeedPlan, checkShift, checkUserData, kcalSummary } from '../domain/planCheck';
import { planDay, statusOf, tasksForDate, thawList, type DayTask } from '../domain/tasks';
import { templateFor, prescription, weightText, exerciseName } from '../domain/templates';
import { TEMPLATE_IDS } from '../state/types';
import { addDays, fmtDayMonth, fmtLong, fmtShort, isWeekend, isoWeekday, weekdayShort, type ISODate } from '../lib/dates';
import { fmtRub } from '../lib/util';
import { today as todayFn } from '../lib/clock';
import { href } from '../app/router';
import { CheckButton, Disclosure, Note, Sheet, toast } from '../ui/kit';
import { TripDayCard } from './Trips';
import { NOV_2026_START } from '../state/model';
import { KettlebellIcon, PiBookOpen, PiCheck, PiCheckBold, PiCookingPot, PiShoppingCart, PiSnowflake, PiWarning } from '../ui/icons';

// ------------------------------------------------------------------ приём пищи

function partSource(date: ISODate, slot: MealSlot, p: MealCard['parts'][number], cook: CookingEvent | undefined): string {
  const d = DISHES[p.dishId];
  if (!p.fresh && cook) {
    const st = p.storage === 'freeze'
      ? `из морозилки — разморозить в холодильнике ${p.thawOn ? `вечером ${fmtShort(p.thawOn)}` : 'накануне'}`
      : p.storage === 'pantry' ? 'хранится в закрытой банке' : 'хранится в холодильнике';
    return `Порция из готовки ${fmtShort(cook.date)}, ${st}.`;
  }
  if (d?.method === 'без готовки') return slot === 'dinner' || isWeekend(date) ? 'Собрать перед едой.' : 'Собрать вечером накануне в контейнер.';
  return slot === 'dinner' || isWeekend(date) ? 'Приготовить к этому приёму пищи.' : 'Приготовить вечером накануне и убрать в контейнер.';
}

export function MealCardView({ date, slot, card, task, showCheck = true }: {
  date: ISODate; slot: MealSlot; card: MealCard; task?: DayTask | null; showCheck?: boolean;
}) {
  const data = useApp();
  const n = cardNutrition(card);
  const kt = kcalText(n);
  const raw = task ? statusOf(data, task) : 'planned';
  const time = isWeekend(date) ? 'по голоду' : data.settings.mealTimes[slot];
  return (
    <div className="card meal-card">
      <div className="meal-head">
        {showCheck && task && (
          <CheckButton state={raw === 'done' ? 'on' : raw === 'skipped' ? 'skip' : 'off'} label={`${MEAL_LABELS[slot]}: ${raw === 'done' ? 'снять отметку' : 'съел'}`}
            onClick={() => A.setTaskStatus(task, raw === 'done' ? 'planned' : 'done')} />
        )}
        <b>{MEAL_LABELS[slot]}</b>
        <span className="time small">{time}</span>
        <span className="grow" />
        <span className={`chip ${kt.verified ? 'accent' : 'warn'}`} title={kt.detail ?? ''}>{kt.main}</span>
      </div>
      <div className="meal-dish">{card.title}</div>
      <div className="stack" style={{ gap: 12 }}>
        {card.parts.map((p, i) => {
          const d = DISHES[p.dishId];
          if (!d) return <Note key={i} kind="warn">Нет блюда «{p.dishId}»</Note>;
          const cook = p.cookEventId ? data.cookingEvents[p.cookEventId] : undefined;
          const cw = cookedWeight(p.dishId, p.qty);
          const lines = ingredientLines(p.dishId, p.qty);
          return (
            <div key={i} className="meal-part">
              <div className="row between" style={{ alignItems: 'baseline' }}>
                <span style={{ fontWeight: 650 }}>{d.title}</span>
                <span className="small muted">{dishAmount(p.dishId, p.qty)}{cw ? ` · ≈${cw} г готового` : ''}</span>
              </div>
              <div className="small muted">{partSource(date, slot, p, cook)}</div>
              <ul className="ing-list compact">
                {lines.map((l, j) => (
                  <li key={j}><span className={`ing-dot${l.dishId ? ' text' : ''}`} /><span className="grow">{l.name}</span><span className="num small">{l.amount}</span></li>
                ))}
                {d.spices.map((s, j) => <li key={`s${j}`}><span className="ing-dot text" /><span className="grow small muted">{s}</span></li>)}
              </ul>
              {d.kind === 'batch' && !p.fresh && d.unit === 'portion' && <p className="hint mt0">Ингредиенты — на эту порцию, масса мяса и рыбы до приготовления.</p>}
              <div className="row" style={{ gap: 8 }}>
                {(p.fresh || d.kind === 'fresh') && (
                  <Disclosure summary="Как приготовить">
                    <ol className="tech-list small">{d.steps.map((s, j) => <li key={j}>{s.text}{s.temperature_c ? ` ${s.temperature_c} °C` : ''}{s.minutes && !/мин|ч$/.test(s.text + s.minutes) ? `, ${s.minutes} мин` : s.minutes && /ч$/.test(s.minutes) ? `, ${s.minutes}` : ''}</li>)}</ol>
                  </Disclosure>
                )}
                <a className="btn ghost small" href={href(`/recipe/${d.id}`, { d: date })}><PiBookOpen /> Рецепт</a>
              </div>
            </div>
          );
        })}
      </div>
      {kt.detail && <p className="hint mt0">{kt.detail}</p>}
      {task && showCheck && (
        <div className="btn-row">
          {raw !== 'done'
            ? <button className="btn primary small" onClick={() => A.setTaskStatus(task, 'done')}><PiCheck /> Съел</button>
            : <button className="btn small" onClick={() => A.setTaskStatus(task, 'planned')}>Снять отметку</button>}
          {raw !== 'skipped' && <button className="btn small" onClick={() => A.setTaskStatus(task, 'skipped')}>Пропустил или заменил</button>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ день: питание, тренировка, готовка, закупка

export function DayPlanSections({ date }: { date: ISODate }) {
  const data = useApp();
  const p = planDay(data, date);
  const tasks = useMemo(() => tasksForDate(data, date), [data, date]);
  const meals = tasks.filter((t) => t.kind === 'meal');
  const training = tasks.find((t) => t.kind === 'training' && t.templateId && t.templateId !== 'recovery');
  const cooks = tasks.filter((t) => t.kind === 'cooking').map((t) => data.cookingEvents[t.eventId!]).filter(Boolean);
  const shops = tasks.filter((t) => t.kind === 'shopping').map((t) => data.shoppingEvents[t.eventId!]).filter(Boolean);
  const dn = p ? dayNutrition(p) : null;
  const pos = planPosition(data.settings.plan, date);
  if (p?.tripId) {
    return (
      <div className="stack">
        <TripDayCard date={date} tasks={tasks} />
        {shops.map((e) => <ShopInline key={e.id} e={e} />)}
      </div>
    );
  }
  return (
    <div className="stack">
      {p?.mealCards && (
        <>
          <div className="row between" style={{ marginTop: 4 }}>
            <h2 className="section-title mt0">Питание{pos ? `, день ${pos} из ${PLAN_LENGTH}` : ''}</h2>
            {dn && <span className={`chip ${dn.labelProducts.length ? 'warn' : 'accent'}`}>{dn.labelProducts.length ? `≈${Math.round(dn.kcal / 10) * 10} ккал, требует уточнения` : `≈${Math.round(dn.kcal / 10) * 10} ккал за день`}</span>}
          </div>
          {MEAL_SLOTS.map((s) => <MealCardView key={s} date={date} slot={s} card={p.mealCards![s]} task={meals.find((t) => t.slot === s) ?? null} />)}
        </>
      )}
      {training && <TrainingInline task={training} />}
      {cooks.map((e) => <CookInline key={e.id} e={e} />)}
      {shops.map((e) => <ShopInline key={e.id} e={e} />)}
    </div>
  );
}

function TrainingInline({ task }: { task: DayTask }) {
  const data = useApp();
  const log = data.trainingLogs[task.id];
  const tpl = log?.templateSnapshot ?? templateFor(data, task.templateId!, task.originDate);
  if (!tpl) return null;
  const toggle = (idx: number, si: number) => {
    const l = getData().trainingLogs[task.id] ?? A.ensureTrainingLog(task, todayFn() < task.date ? task.date : todayFn());
    if (!l) return;
    const ex = l.exercises.find((e) => e.index === idx);
    if (!ex) return;
    const sets = ex.sets.slice();
    sets[si] = !sets[si];
    A.updateExerciseLog(l.id, idx, { sets });
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3><KettlebellIcon /> {tpl.name}</h3>
        <a className="btn iron small" href={href(`/workout/${encodeURIComponent(task.id)}`, { d: task.date })}>Открыть тренировку</a>
      </div>
      <div className="list">
        {tpl.items.map((it, idx) => {
          const el = log?.exercises.find((e) => e.index === idx);
          const sets = el?.sets ?? Array.from({ length: it.sets }, () => false);
          return (
            <div className="li" key={idx}>
              <div className="grow">
                <a href={href(`/exercise/${it.exerciseId}`)} style={{ fontWeight: 600 }}>{exerciseName(el?.variantId ?? it.exerciseId)}</a>
                <div className="small muted">{prescription(it)}{weightText(it) ? ` · ${weightText(it)}` : ''}{el?.weightKg ? ` · записано ${el.weightKg} кг` : ''}</div>
              </div>
              <div className="row nowrap" style={{ gap: 6 }}>
                {sets.map((on, si) => (
                  <CheckButton key={si} small state={on ? 'on' : 'off'} label={`${exerciseName(it.exerciseId)}, подход ${si + 1}`} onClick={() => toggle(idx, si)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Сколько контейнеров собрать из готовки: по порциям блюд и гарниров на каждый приём. */
export function containersFor(e: CookingEvent): { date: ISODate; slot: MealSlot; items: string[] }[] {
  const map = new Map<string, { date: ISODate; slot: MealSlot; items: string[] }>();
  for (const it of e.items ?? []) {
    for (const u of it.uses) {
      if (u.storage === 'pantry') continue;
      const k = `${u.date}|${u.slot}`;
      const rec = map.get(k) ?? { date: u.date, slot: u.slot, items: [] };
      const d = DISHES[it.dishId];
      rec.items.push(`${d.short} — ${dishAmount(it.dishId, u.qty)}${u.storage === 'freeze' ? ' (в морозилку)' : ''}`);
      map.set(k, rec);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot));
}

export function CookInline({ e }: { e: CookingEvent }) {
  const data = useApp();
  const boxes = containersFor(e);
  return (
    <div className="card">
      <div className="card-head">
        <h3><PiCookingPot /> {e.title}{e.time ? `, ${e.time}` : ''}</h3>
        <a className="btn small" href={href(`/cook/${e.id}`)}>Рецепты и шаги</a>
      </div>
      {e.timeNote && <p className="hint mt0">{e.timeNote}</p>}
      <div className="list">
        {(e.items ?? []).map((it) => {
          const d = DISHES[it.dishId];
          const left = portionsLeft(data, e, it);
          return (
            <div className="li" key={it.dishId}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{d.title} — {dishAmount(it.dishId, it.qty)}</div>
                <div className="small muted">{it.uses.map((u) => `${fmtShort(u.date)} ${MEAL_LABELS[u.slot].toLowerCase()}${u.storage === 'freeze' ? ' (заморозить)' : ''}`).join(', ')}</div>
              </div>
              {d.unit === 'portion' && <span className="chip">{left.left} из {left.total} осталось</span>}
            </div>
          );
        })}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Контейнеров: {boxes.length} (по одному на приём пищи; овощи и салат — отдельно от горячего).</p>
    </div>
  );
}

function ShopInline({ e }: { e: ShoppingEvent }) {
  const data = useApp();
  const lines = e.lines ?? [];
  const done = lines.filter((l) => data.shoppingChecks[`${e.id}:${l.productId}`]?.bought || data.shoppingChecks[`${e.id}:${l.productId}`]?.atHome).length;
  return (
    <div className="card">
      <div className="card-head">
        <h3><PiShoppingCart /> {e.title}{e.time ? `, ${e.time}` : ''}</h3>
        <a className="btn small" href={href(`/shop/${e.id}`)}>Весь список</a>
      </div>
      <p className="small muted mt0">Куплено или есть дома: {done} из {lines.length}. Продукты на {e.forDatesText}.</p>
      <div className="list">
        {lines.slice(0, 8).map((l) => {
          const c = data.shoppingChecks[`${e.id}:${l.productId}`];
          return (
            <div className="li" key={l.productId}>
              <CheckButton small state={c?.bought || c?.atHome ? 'on' : 'off'} label={`${PRODUCTS[l.productId].name}: куплено`} onClick={() => A.setBought(e.id, l.productId, !c?.bought)} />
              <span className="grow small">{PRODUCTS[l.productId].name}</span>
              <span className="small num">{c?.atHome ? 'есть дома' : buyText(l)}</span>
            </div>
          );
        })}
      </div>
      {lines.length > 8 && <a className="btn ghost small" href={href(`/shop/${e.id}`)}>Ещё {lines.length - 8} позиций</a>}
    </div>
  );
}

// ------------------------------------------------------------------ разморозка

export function ThawSheet({ task, onClose }: { task: DayTask | null; onClose: () => void }) {
  const data = useApp();
  if (!task) return null;
  const items = thawList(data, task.originDate);
  const raw = statusOf(data, task);
  return (
    <Sheet open onClose={onClose} title="Разморозка на завтра">
      <p className="muted mt0">Вечером {fmtDayMonth(task.originDate)} переложите из морозилки в холодильник (не на стол):</p>
      <ul className="ing-list">{items.map((t, i) => <li key={i}><PiSnowflake /> <span className="grow">{t}</span></li>)}</ul>
      <Note kind="plain">Рыбу и мясо размораживайте в холодильнике, в контейнере или на тарелке. Готовые порции разогревайте до горячего.</Note>
      <div className="btn-row" style={{ marginTop: 14 }}>
        {raw !== 'done'
          ? <button className="btn primary" onClick={() => { A.setTaskStatus(task, 'done'); onClose(); }}><PiCheck /> Переложил</button>
          : <button className="btn" onClick={() => { A.setTaskStatus(task, 'planned'); onClose(); }}>Снять отметку</button>}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ дата старта и релакс-день

export function PlanStartForm({ initialDate, onDone, submitLabel = 'Начать', firstRun }: {
  initialDate?: ISODate; onDone?: (cfg: PlanSettings) => void; submitLabel?: string; firstRun?: boolean;
}) {
  const data = useApp();
  const today = todayFn();
  const cur = data.settings.plan;
  const [date, setDate] = useState<ISODate>(initialDate ?? cur?.startDate ?? (today < NOV_2026_START ? NOV_2026_START : addDays(today, 1)));
  const [ack, setAck] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const cfg = valid ? makePlanSettings(date, new Date().toISOString()) : null;
  const inst = useMemo(() => (cfg ? buildInstance(cfg, planContext(data, today)) : null), [date, today, data.trips, data.settings.relaxOverrides]);
  const preview = useMemo(() => (cfg ? A.previewPlan(cfg) : null), [date, data]);
  const same = !!cur && cur.startDate === date && cur.confirmed && cur.menuId === TEMPLATE.id;
  const conflicts = !!preview && (preview.mealMarks > 0 || preview.eventMarks.length > 0);
  const firstShop = inst?.shoppingEvents.find((e) => e.kind === 'main');
  const firstCook = inst?.cookingEvents[0];
  const secondShop = inst?.shoppingEvents.find((e) => e.kind === 'main' && e !== firstShop);
  const trips = inst ? inst.ctx.trips.filter((t) => t.to >= date && t.from <= planEnd(cfg!)) : [];
  const submit = () => {
    if (!cfg) return;
    if (conflicts && !ack) return;
    A.applyPlan(cfg).then(() => {
      toast(`План питания: старт ${fmtDayMonth(cfg.startDate)}`);
      onDone?.(cfg);
    });
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <label className="field" style={{ margin: 0 }}>
        <span>Когда начинаем программу питания? (день 1)</span>
        <input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setAck(false); }} />
      </label>
      <div className="chips">
        {[0, 1, 2].map((n) => <button key={n} className={`chip${date === addDays(today, n) ? ' accent' : ''}`} onClick={() => setDate(addDays(today, n))}>{n === 0 ? 'Сегодня' : n === 1 ? 'Завтра' : 'Послезавтра'}</button>)}
        {(() => { const mon = addDays(today, (8 - isoWeekday(today)) % 7 || 7); return <button className={`chip${date === mon ? ' accent' : ''}`} onClick={() => setDate(mon)}>С понедельника {fmtShort(mon)}</button>; })()}
      </div>
      {inst && (
        <div className="card flat">
          <table className="table small">
            <tbody>
              <tr><td>Первый цикл</td><td>{fmtDayMonth(date)} — {fmtDayMonth(planEnd(cfg!))} (30 дней; дальше — следующий месяц)</td></tr>
              {firstShop && <tr><td>Первая закупка</td><td>{fmtLong(firstShop.date)}, {firstShop.time}</td></tr>}
              {firstCook && <tr><td>Первая готовка</td><td>{fmtLong(firstCook.date)}, {firstCook.time}</td></tr>}
              {secondShop && <tr><td>Вторая закупка</td><td>{fmtLong(secondShop.date)}, {secondShop.time}</td></tr>}
              <tr><td>Релакс-день</td><td>{inst.layout.relaxDates.length ? inst.layout.relaxDates.map((d) => fmtLong(d)).join(', ') : 'в этом цикле нет'} — один в календарный месяц, не сдвигается при смене даты старта</td></tr>
              {trips.map((t) => <tr key={t.id}><td>Командировка</td><td>{t.city}: {fmtShort(t.from)}–{fmtShort(t.to)} — командировочное меню, без готовки и тренировок</td></tr>)}
              <tr><td>Домашние закупки</td><td>≈{fmtRub(inst.totalCost)} (бюджет {fmtRub(BUDGET_RUB)}, цены ориентировочные){inst.tripCost ? `; перекусы в поездки — отдельно, ≈${fmtRub(inst.tripCost)}` : ''}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      {firstCook && firstCook.timeNote && <Note kind="warn">{firstCook.timeNote}</Note>}
      {valid && date < today && <Note kind="warn">Дата старта в прошлом: дни до сегодняшнего будут считаться прошедшими.</Note>}
      {!firstRun && preview && preview.importedKept > 0 && <Note kind="plain">{preview.importedKept} дн. изменены импортом от ChatGPT — они останутся как есть.</Note>}
      {!firstRun && conflicts && (
        <Note kind="warn">
          <p>На сегодня и будущие дни уже есть отметки прежнего плана: {preview!.mealMarks ? `приёмов пищи — в ${preview!.mealMarks} дн.` : ''}{preview!.eventMarks.length ? ` ${preview!.eventMarks.join(', ')}` : ''}.</p>
          <p>Отметки не удаляются: отметки приёмов пищи останутся на своих датах, отметки прежних готовок и закупок сохранятся в истории.</p>
          <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Понятно, сменить план</label>
        </Note>
      )}
      {!firstRun && cur && <p className="hint mt0">Командировки и релакс-дни остаются на своих датах. Прошедшие дни остаются историей. Тренировки, вес, фото и отметки не удаляются и не переносятся — расписание тренировок своё.</p>}
      <button className="btn primary big" disabled={!valid || (conflicts && !ack) || same} onClick={submit}><PiCheckBold /> {same ? 'Уже выбрано' : submitLabel}</button>
    </div>
  );
}

export function PlanStartSheet({ open, onClose, initialDate }: { open: boolean; onClose: () => void; initialDate?: ISODate }) {
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title="Дата старта программы">
      <PlanStartForm initialDate={initialDate} onDone={onClose} submitLabel="Применить" />
    </Sheet>
  );
}

// ------------------------------------------------------------------ проверка плана

export function PlanCheckCard() {
  const data = useApp();
  const cfg = data.settings.plan ?? makePlanSettings(BASE_START, '');
  const result = useMemo(() => {
    const ctx = { ...planContext(data, null) };
    const inst = buildInstance(cfg, ctx);
    const tpls = TEMPLATE_IDS.map((id) => templateFor(data, id, todayFn())).filter(Boolean) as any[];
    return { checks: [...checkInstance(inst), checkEquipment(tpls), checkShift(cfg, ctx), ...checkSeedPlan(inst), checkActiveData(data, todayFn()), ...checkUserData(data)], kcal: kcalSummary(inst), inst };
  }, [cfg.startDate, data.trips, data.settings.relaxOverrides, data.templateVersions]);
  const failed = result.checks.filter((c) => !c.ok).length;
  return (
    <div className="card">
      <div className="card-head"><h3>Проверка плана</h3><span className={`chip ${failed ? 'warn' : 'accent'}`}>{failed ? `замечаний: ${failed}` : 'всё сходится'}</span></div>
      <p className="small muted mt0">Калорийность по дням: {result.kcal.min}–{result.kcal.max} ккал, в среднем {result.kcal.avg} (справочные данные; дней с продуктами «по этикетке»: {result.kcal.unverifiedDays}).</p>
      <div className="list">
        {result.checks.map((c) => (
          <div className="li" key={c.id} style={{ alignItems: 'flex-start' }}>
            <span style={{ color: c.ok ? 'var(--accent)' : 'var(--warn)', marginTop: 2 }}>{c.ok ? <PiCheckBold /> : <PiWarning />}</span>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{c.id}. {c.title}</div>
              {c.details.slice(0, 6).map((d, i) => <div key={i} className="small muted">{d}</div>)}
            </div>
          </div>
        ))}
      </div>
      {result.inst.issues.filter((i) => i.level !== 'info').map((i, k) => <Note key={k} kind="warn">{i.text}</Note>)}
    </div>
  );
}

export function dishKcalLine(dishId: string, qty: number): string {
  const kt = kcalText(dishNutrition(dishId, qty));
  return kt.verified ? kt.main : `${kt.main}`;
}
