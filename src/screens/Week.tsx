// Версия 2.0: «Неделя» — меню недели, общая готовка, проверка запасов и закупка.
// Закупка появляется только после подтверждения фактических запасов.
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as W from '../state/weeklyActions';
import { useToday } from '../lib/clock';
import { href, useRoute } from '../app/router';
import { fmtLong, fmtShort, weekdayShort, type ISODate } from '../lib/dates';
import { fmtRub, parseNum } from '../lib/util';
import { MEAL_LABELS, MEAL_SLOTS, type MealSlot } from '../state/types';
import { PRODUCTS, buyInfo, subCandidates } from '../domain/catalog';
import { BUDGET_RUB } from '../domain/plan';
import {
  LIB, WEEKDAY_NAMES, alternatives, cookEventId, cookSchedule, cookTiming, fmtQty, shopEventId, weekDates, weekDayNutrition, weekFrom,
  weekList, weekPurchase, weekStockRows, weekTo, weeklyOf, type WeekPlan,
} from '../domain/weekly';
import { tripList } from '../domain/trips';
import { ingrName } from '../domain/recipeLib';
import { Disclosure, Empty, Note, PageHead, Seg, toast } from '../ui/kit';
import { PiCheck, PiCookingPot, PiShoppingCart, PiSnowflake, PiArrowsClockwise, PiPackage, PiListChecks, PiX, PiWarning } from '../ui/icons';

type Data = ReturnType<typeof useApp>;
const STATUS = { draft: 'черновик', approved: 'утверждено' } as const;

function monthSpend(data: Data, month: string): { planned: number; actual: number } {
  let planned = 0, actual = 0;
  for (const w of weekList(weeklyOf(data))) {
    if (!w.shopDate?.startsWith(month)) continue;
    const p = weekPurchase(data, w);
    for (const l of p.lines) {
      const c = data.shoppingChecks[`${shopEventId(w)}:${l.productId}`];
      planned += c?.absent ? 0 : l.cost;
      if (c?.actualPrice != null) actual += c.actualPrice;
    }
  }
  return { planned, actual };
}

function WeekCard({ w, today }: { w: WeekPlan; today: ISODate }) {
  const data = useApp();
  const pur = weekPurchase(data, w);
  const frozen = w.cook.reduce((s, c) => s + c.uses.filter((u) => u.storage === 'freeze').length, 0);
  const past = weekTo(w) < today;
  return (
    <a className="card tight week-card" href={href(`/week/${w.id}`)} style={{ display: 'block', opacity: past ? 0.7 : 1 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <b>{fmtShort(weekFrom(w))}–{fmtShort(weekTo(w))}</b>
        <span className={`chip ${w.status === 'approved' ? 'ok' : 'warn'}`}>{STATUS[w.status]}</span>
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {w.cookDate ? `Готовка ${weekdayShort(w.cookDate).toLowerCase()} ${fmtShort(w.cookDate)}: ` : ''}
        {w.cook.map((c) => `${LIB[c.r]?.title ?? c.r} ×${c.servings}`).join('; ') || 'без готовки'}
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        {pur.ready ? <>Закупка: {fmtRub(pur.total)}{pur.unverified.length ? ` + ${pur.unverified.length} без цены` : ''}</> : w.status === 'draft' ? 'Закупка — после утверждения меню и проверки запасов' : 'Закупка — после проверки запасов'}
        {frozen ? ` · морозилка: ${frozen} пак.` : ''}
      </div>
    </a>
  );
}

export function WeekHub() {
  const data = useApp();
  const today = useToday();
  const ws = weeklyOf(data);
  const weeks = weekList(ws);
  const [showPast, setShowPast] = useState(false);
  if (!ws) return <div className="page"><PageHead title="Неделя" /><div className="card"><Empty title="Недельный цикл не включён">Он включается при обновлении данных до версии 2.0.</Empty></div></div>;
  const current = weeks.filter((w) => weekTo(w) >= today);
  const past = weeks.filter((w) => weekTo(w) < today);
  const month = today.slice(0, 7);
  const spend = monthSpend(data, month);
  const trips = tripList(data).filter((t) => t.to >= today);
  return (
    <div className="page">
      <PageHead title="Неделя: меню, готовка, закупка" sub={`Закупка и основная готовка — ${WEEKDAY_NAMES[ws.shopDay - 1]}, ${ws.cookTime}. Морозилка: ${ws.freezer.capacity == null ? 'место не указано' : `${ws.freezer.capacity} плоских пакетов`}.`} />
      {ws.reportUnseen && (
        <div className="card">
          <h3 className="mt0">Что изменилось в версии 2.0</h3>
          <ul className="small" style={{ paddingLeft: 18 }}>
            <li>Меню 25–30.11 предварительно утверждено: одна готовка 25.11 (3 блюда, 9 порций, 4 из них — в морозилку). Закупка появится после проверки запасов.</li>
            <li>Командировка 25–26.11 убрана; добавлены 1–2.12 и 15–22.12 — в эти дни нет домашней готовки, закупки скоропортящегося и обязательных тренировок.</li>
            <li>Релакс-дни: 29.11 и 27.12. Календарь теперь идёт дальше 30 дней.</li>
            <li>Следующие недели — черновики планировщика из библиотеки рецептов; утверждаете их вы, перед закупкой.</li>
            <li>Запасы: минтай ≈200 г и целая упаковка стручковой фасоли — по вашему сообщению; открытые неделю назад фасоль и томаты не используются; крупы, брокколи, вишня, йогурт, творог, масло — «уточнить».</li>
            <li>История (прошедшие дни, отметки, тренировки, вес, фото) не менялась. Резервная копия до изменений сохранена.</li>
          </ul>
          <button className="btn small" onClick={() => W.markWeeklyReportSeen()}><PiCheck /> Понятно</button>
        </div>
      )}
      <div className="grid2">
        <div>
          {current.map((w) => <WeekCard key={w.id} w={w} today={today} />)}
          {!current.length && <div className="card"><Empty title="Нет составленных недель" /></div>}
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => W.draftMissingWeeks().then(() => toast('Черновики составлены'))}><PiArrowsClockwise /> Составить черновики на следующие недели</button>
          </div>
          {past.length > 0 && (
            <Disclosure summary={`Прошедшие недели (${past.length})`} defaultOpen={showPast}>
              <div onClick={() => setShowPast(true)}>{past.map((w) => <WeekCard key={w.id} w={w} today={today} />)}</div>
            </Disclosure>
          )}
        </div>
        <div>
          <div className="card tight">
            <h3 className="mt0">Бюджет: {month === '2026-11' ? 'ноябрь' : month}</h3>
            <p className="small mt0">Запланировано на закупки недель: <b>{fmtRub(spend.planned)}</b> из {fmtRub(BUDGET_RUB)}{spend.actual ? `; фактически отмечено ${fmtRub(spend.actual)}` : ''}. Командировки — вне домашнего бюджета. Сумма считается только по подтверждённым закупкам; цены — ориентир av.ru, без проверки наличия.</p>
          </div>
          <div className="card tight">
            <h3 className="mt0">Командировки впереди</h3>
            {trips.length ? <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>{trips.map((t) => <li key={t.id}>{fmtShort(t.from)}–{fmtShort(t.to)}: {t.city}</li>)}</ul> : <p className="small muted mt0">Нет.</p>}
            <p className="small" style={{ marginBottom: 0 }}><a href={href('/trips')}>Изменить командировки</a> — меню и закупки пересчитаются.</p>
          </div>
          <div className="card tight">
            <h3 className="mt0">Как составляется меню</h3>
            <p className="small mt0">Сейчас — планировщик приложения: подбирает 2–3 проверенных рецепта библиотеки на неделю без повторов основных блюд за 4 недели, с разными видами белка и морской рыбой, учитывает избранное, оценки и «больше не предлагать». Новые рецепты он не придумывает. Новые недели можно составлять и в чате с Claude; генерация через API заложена на будущее и не подключена.</p>
            <a className="small" href={href('/library')}>Библиотека рецептов</a>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WeekPage({ id, initialTab }: { id: string; initialTab?: 'menu' | 'cook' | 'stock' | 'buy' }) {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const ws = weeklyOf(data);
  const w = ws?.weeks[id];
  const [tab, setTab] = useState<'menu' | 'cook' | 'stock' | 'buy'>((route.query.get('tab') as 'menu') || initialTab || 'menu');
  if (!ws || !w) return <div className="page"><PageHead title="Неделя" backTo="/week" /><div className="card"><Empty title="Неделя не найдена" /></div></div>;
  const pur = weekPurchase(data, w);
  return (
    <div className="page">
      <PageHead
        title={`${fmtShort(weekFrom(w))}–${fmtShort(weekTo(w))}`}
        sub={<>{w.title} · <span className={`chip ${w.status === 'approved' ? 'ok' : 'warn'}`}>{STATUS[w.status]}</span>{w.source === 'chat' ? ' · составлено в чате' : w.source === 'planner' ? ' · планировщик' : ''}</>}
        backTo="/week"
        right={w.status === 'draft' ? <button className="btn primary small" onClick={() => W.approveWeek(w.id).then(() => toast('Меню недели утверждено'))}><PiCheck /> Утвердить меню</button> : undefined}
      />
      {w.notes.map((n, i) => <Note key={i} kind={/не хватает|нужна короткая|вместо 2–3/i.test(n) ? 'warn' : 'info'}>{n}</Note>)}
      <Seg value={tab} onChange={setTab} label="Раздел" options={[
        { value: 'menu', label: 'Меню' }, { value: 'cook', label: 'Готовка' }, { value: 'stock', label: `Запасы${w.stockConfirmedAt ? ' ✓' : ''}` }, { value: 'buy', label: pur.ready ? 'Закупка ✓' : 'Закупка' },
      ]} />
      {tab === 'menu' && <MenuTab w={w} today={today} />}
      {tab === 'cook' && <CookTab w={w} />}
      {tab === 'stock' && <StockTab w={w} onDone={() => setTab('buy')} />}
      {tab === 'buy' && <BuyTab w={w} />}
    </div>
  );
}

function srcLabel(w: WeekPlan, date: ISODate, slot: MealSlot): string {
  const m = w.meals[date]?.[slot];
  if (!m) return '';
  if (m.src === 'stock') return 'из запасов';
  if (m.src === 'fresh') return 'свежее';
  const use = w.cook.find((c) => c.r === m.r)?.uses.find((u) => u.date === date && u.slot === slot);
  return use?.storage === 'freeze' ? `из морозилки — разморозить ${use.thawOn ? `${fmtShort(use.thawOn)} вечером` : 'накануне'}` : 'из готовки, холодильник';
}

function MenuTab({ w, today }: { w: WeekPlan; today: ISODate }) {
  const data = useApp();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="week-menu">
      {weekDates(w).map((date) => {
        const n = weekDayNutrition(w, date);
        const full = MEAL_SLOTS.every((s) => w.meals[date]?.[s]?.r);
        return (
          <div className="card tight" key={date} style={{ opacity: date < today ? 0.65 : 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <h3 className="mt0" style={{ marginBottom: 4 }}>{fmtLong(date)}</h3>
              {n && <span className="small muted">{full ? '' : 'без учёта приёмов «из остатков»: '}{n.kcal} ккал · Б {n.p} / Ж {n.f} / У {n.c} г</span>}
            </div>
            <div className="list">
              {MEAL_SLOTS.map((slot) => {
                const m = w.meals[date]?.[slot];
                if (!m) return null;
                const r = m.r ? LIB[m.r] : null;
                const key = `${date}|${slot}`;
                const alts = open === key && r ? alternatives(data, w, r.id) : [];
                return (
                  <div className="li" key={slot} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <span className="small muted" style={{ minWidth: 72 }}>{MEAL_LABELS[slot]}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      {r ? <a href={href(`/lib/${r.id}`)}>{r.title}</a> : <b>{m.title ?? 'Из того, что есть'}</b>}
                      <span className="small muted" style={{ display: 'block' }}>{srcLabel(w, date, slot)}{m.note ? ` · ${m.note}` : ''}</span>
                      {open === key && (
                        <span style={{ display: 'block', marginTop: 6 }}>
                          {alts.length ? alts.map((a) => (
                            <button key={a.id} className="btn small" style={{ margin: '0 6px 6px 0' }} onClick={() => W.replaceDish(w.id, r!.id, a.id, { date, slot }).then(() => { setOpen(null); toast(r!.kind === 'main' ? 'Блюдо заменено во всех порциях готовки' : 'Заменено'); })}>{a.title}</button>
                          )) : <span className="small muted">Подходящих замен в библиотеке пока нет.</span>}
                        </span>
                      )}
                    </span>
                    {r && date >= today && <button className="btn small ghost" onClick={() => setOpen(open === key ? null : key)}>{open === key ? <PiX /> : 'Заменить'}</button>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CookTab({ w }: { w: WeekPlan }) {
  const data = useApp();
  const ws = weeklyOf(data)!;
  if (!w.cook.length || !w.cookDate) return <div className="card"><Empty title="Готовки на этой неделе нет" /></div>;
  const t = cookTiming(w);
  const sch = cookSchedule(w);
  const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const frozen = w.cook.reduce((s, c) => s + c.uses.filter((u) => u.storage === 'freeze').length, 0) + w.cook.reduce((s, c) => s + Math.max(0, c.servings - c.uses.length), 0);
  const cap = ws.freezer.capacity;
  const cookStatus = data.taskStatus[`cook:${cookEventId(w)}`]?.status;
  return (
    <div className="grid2">
      <div>
        <div className="card tight">
          <h3 className="mt0"><PiCookingPot /> {fmtLong(w.cookDate)}, {w.cookTime ?? ws.cookTime}</h3>
          <p className="small mt0">{w.cook.map((c) => `${LIB[c.r]?.title ?? c.r} — ${c.servings} порц.`).join('; ')}.</p>
          <p className="small">Примерно <b>{Math.floor(t.total / 60) ? `${Math.floor(t.total / 60)} ч ` : ''}{t.total % 60} мин</b>, из них активно около {t.active} мин. Занятость техники: {Object.entries(t.byDevice).map(([k, v]) => `${k} ${v} мин`).join(', ')} — плита на двух конфорках, аэрогриль и электрогриль параллельно.</p>
          <p className="small" style={{ marginBottom: 0 }}>{cookStatus === 'done' ? 'Отмечено «Приготовлено».' : <a href={href(`/cook/${cookEventId(w)}`)}>Открыть готовку: «Приготовлено», порции и списание продуктов</a>}</p>
        </div>
        <div className="card tight">
          <h3 className="mt0">Порядок</h3>
          {sch.before.length > 0 && <Note>Накануне: {sch.before.join(' ')}</Note>}
          <ol className="small cook-plan" style={{ paddingLeft: 0, margin: 0, listStyle: 'none' }}>
            {sch.steps.map((s, i) => (
              <li key={i} style={{ marginBottom: 6, display: 'flex', gap: 8 }}>
                <span className="muted" style={{ flex: 'none', width: 74, fontVariantNumeric: 'tabular-nums' }}>{hm(s.start)}–{hm(s.end)}</span>
                <span className="grow" style={{ minWidth: 0 }}><span className="chip">{s.eq}</span> {s.text} <span className="muted">({s.recipe})</span></span>
              </li>
            ))}
          </ol>
          <p className="hint" style={{ marginBottom: 0 }}>Время от начала готовки. Пока варится или запекается, делается следующий шаг; плита — две конфорки, аэрогриль и электрогриль — по одной закладке.</p>
        </div>
      </div>
      <div>
        <div className="card tight">
          <h3 className="mt0"><PiSnowflake /> Хранение порций</h3>
          {cap == null ? <Note kind="warn">В морозилку — {frozen} плоских пакетов на 1 л. Свободное место не указано: <a href={href('/settings', { s: 'weekly' })}>укажите в настройках</a>, и планировщик будет его учитывать.</Note>
            : frozen > cap ? <Note kind="warn">В морозилку нужно {frozen} пакетов, а свободно {cap}. Замените одно блюдо на свежее или добавьте короткую готовку в середине недели.</Note>
            : <p className="small mt0">В морозилку — {frozen} из {cap} свободных пакетов.</p>}
          <div className="table-scroll">
            <table className="small" style={{ width: '100%' }}>
              <thead><tr><th>Порция</th><th>Когда</th><th>Где</th><th>Заранее</th></tr></thead>
              <tbody>
                {w.cook.flatMap((c) => c.uses.map((u, i) => (
                  <tr key={`${c.r}${i}`}>
                    <td>{LIB[c.r]?.title ?? c.r}, {i + 1}</td>
                    <td>{MEAL_LABELS[u.slot].toLowerCase()} {fmtShort(u.date)}</td>
                    <td>{u.storage === 'freeze' ? 'морозилка, плоский пакет' : u.date === w.cookDate ? 'сразу' : 'холодильник'}</td>
                    <td>{u.thawOn ? `${fmtShort(u.thawOn)} вечером переложить в холодильник` : '—'}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginBottom: 0 }}>Остудить не дольше 30 минут, белок и гарнир — в одном плоском контейнере или пакете толщиной 1,5–2 см, с датой. Разогревать до горячего пара по всей порции. Рыба — не дольше суток в холодильнике.</p>
        </div>
      </div>
    </div>
  );
}

function StockTab({ w, onDone }: { w: WeekPlan; onDone: () => void }) {
  const data = useApp();
  const today = useToday();
  const rows = useMemo(() => weekStockRows(data, w, today), [data, w, today]);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.productId, String(Math.round(r.usable))])));
  const [opened, setOpened] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.productId, data.stock[r.productId]?.openedOn ?? ''])));
  if (w.status === 'draft') return <Note kind="warn">Сначала утвердите меню недели — потом проверка запасов и закупка.</Note>;
  const save = () => {
    const amounts: Record<string, number> = {};
    const op: Record<string, string | null> = {};
    for (const r of rows) {
      const v = parseNum(vals[r.productId]);
      if (v == null || v < 0) { toast(`Укажите количество: ${ingrName(r.productId)}`); return; }
      amounts[r.productId] = v;
      if ((opened[r.productId] ?? '') !== (data.stock[r.productId]?.openedOn ?? '')) op[r.productId] = opened[r.productId] || null;
    }
    W.confirmWeekStock(w.id, amounts, op).then(() => { toast('Запасы подтверждены — закупка посчитана'); onDone(); });
  };
  return (
    <div className="card tight">
      <h3 className="mt0"><PiListChecks /> Что есть дома сейчас</h3>
      <p className="small mt0">Проверьте холодильник, морозилку и шкаф. Укажите фактическое количество (0 — нет или испортилось). Закупка посчитается только после подтверждения и купит только недостающее.{w.stockConfirmedAt ? ` Последнее подтверждение: ${fmtShort(w.stockConfirmedAt.slice(0, 10))}.` : ''}</p>
      <div className="table-scroll">
        <table className="small stock-confirm" style={{ width: '100%' }}>
          <thead><tr><th>Продукт</th><th>Нужно на неделю</th><th>По учёту</th><th>Есть дома</th><th>Вскрыто</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const p = PRODUCTS[r.productId];
              const u = p.unit === 'pcs' ? 'шт.' : p.unit === 'ml' ? 'мл' : 'г';
              return (
                <tr key={r.productId}>
                  <td>{ingrName(r.productId)}{p.av === 'unverified' ? <span className="chip warn" style={{ marginLeft: 4 }}>av.ru не подтверждено</span> : null}</td>
                  <td>{fmtQty(p, r.need)}</td>
                  <td>{data.stock[r.productId] ? fmtQty(p, r.have) : '—'}{r.have - r.usable > 0.5 ? <span className="muted">, из них {fmtQty(p, r.have - r.usable)} — срок вышел</span> : null}{data.stock[r.productId] && !data.stock[r.productId].confirmedAt ? ' (уточнить)' : ''}</td>
                  <td>
                    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <input className="input" style={{ width: 84 }} inputMode="decimal" aria-label={`${ingrName(r.productId)}: есть дома, ${u}`} value={vals[r.productId] ?? ''} onChange={(e) => setVals({ ...vals, [r.productId]: e.target.value })} />
                      <span className="muted">{u}</span>
                      <button className="btn small ghost" onClick={() => setVals({ ...vals, [r.productId]: '0' })} aria-label={`${ingrName(r.productId)}: нет дома`}>нет</button>
                    </span>
                  </td>
                  <td>{p.storage === 'freezer' || p.storage === 'pantry' && p.category !== 'Консервы и готовые продукты' ? <span className="muted">—</span> : <input className="input" type="date" style={{ width: 140 }} aria-label={`${ingrName(r.productId)}: дата вскрытия`} value={opened[r.productId] ?? ''} onChange={(e) => setOpened({ ...opened, [r.productId]: e.target.value })} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={save}><PiCheck /> Подтвердить запасы и посчитать закупку</button>
        {w.stockConfirmedAt && <button className="btn ghost" onClick={() => W.resetWeekStock(w.id)}>Сбросить подтверждение</button>}
      </div>
    </div>
  );
}

function BuyTab({ w }: { w: WeekPlan }) {
  const data = useApp();
  const pur = weekPurchase(data, w);
  const eventId = shopEventId(w);
  if (!pur.ready) return <Note kind="warn" icon={<PiWarning />}>{w.status === 'draft' ? 'Меню недели — черновик. Утвердите его, затем подтвердите запасы — после этого появится список закупки.' : 'Список закупки появится после подтверждения запасов (раздел «Запасы»). До этого окончательный заказ не составляется.'}</Note>;
  const month = (w.shopDate ?? weekFrom(w)).slice(0, 7);
  const spend = monthSpend(data, month);
  let left = 0;
  for (const l of pur.lines) if (!data.shoppingChecks[`${eventId}:${l.productId}`]?.bought && !data.shoppingChecks[`${eventId}:${l.productId}`]?.absent) left++;
  return (
    <div className="grid2">
      <div className="card tight">
        <h3 className="mt0"><PiShoppingCart /> Закупка {w.shopDate ? fmtShort(w.shopDate) : ''}: {fmtRub(pur.total)}</h3>
        <p className="small mt0">Только недостающее по подтверждённым запасам, упаковками целиком. У каждого товара — карточка av.ru, цена упаковки и дата проверки; наличие по адресу доставки av.ru показывает в корзине при заказе. Осталось отметить: {left}.</p>
        <div className="list">
          {pur.lines.map((l) => {
            const p = PRODUCTS[l.productId];
            const c = data.shoppingChecks[`${eventId}:${l.productId}`];
            const bi = buyInfo(l.productId);
            const rest = Math.max(0, l.need - l.fromStock);
            return (
              <div className="li" key={l.productId} style={{ alignItems: 'flex-start', flexWrap: 'wrap', opacity: c?.bought ? 0.6 : 1 }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b>{ingrName(l.productId)}</b> — {l.packs != null ? `${l.packs} × ${bi.packLabel || p.pack.label}` : fmtQty(p, l.buy)}{l.cost ? ` · ${fmtRub(l.cost)}` : ' · цена не подтверждена'}
                  <span className="small" style={{ display: 'block' }}>
                    {bi.url ? <a href={bi.url} target="_blank" rel="noopener">{bi.name}</a> : bi.name}
                    {bi.packPrice != null ? ` · ${fmtRub(bi.packPrice)} за упаковку` : ''}{bi.checkedAt ? ` · проверено ${fmtShort(bi.checkedAt)}` : ''}
                    {bi.label ? ` · на 100 г: ${Math.round(bi.label.kcal)} ккал, Б ${bi.label.p} / Ж ${bi.label.f} / У ${bi.label.c} (этикетка)` : ''}
                  </span>
                  <span className="small muted" style={{ display: 'block' }}>
                    нужно {fmtQty(p, l.need)}{l.fromStock ? `, дома ${fmtQty(p, l.fromStock)}` : ''}{l.notes.length ? ` · ${l.notes.join('; ')}` : ''}
                    {bi.status !== 'listed' ? ' · карточка av.ru не найдена' : ''}{bi.note ? ` · ${bi.note}` : ''}
                  </span>
                  {c?.absent && (
                    <span className="small" style={{ display: 'block' }}>
                      <span style={{ color: 'var(--warn, #b45309)' }}>Нет в магазине. Замена с пересчётом стоимости и КБЖУ:</span>
                      {subCandidates(l.productId).map((x) => {
                        const tb = buyInfo(x.to);
                        const tp = PRODUCTS[x.to];
                        const need = rest * x.ratio;
                        const packs = tb.packSize ? Math.ceil(need / tb.packSize - 1e-9) : null;
                        return (
                          <span key={x.to} className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                            <span className="grow">{ingrName(x.to)} — {fmtQty(tp, need)}{packs != null && tb.packPrice != null ? ` (${packs} × ${tb.packLabel}, ${fmtRub(packs * tb.packPrice)})` : ''} · на 100 г {Math.round(tp.nutr.kcal)} ккал, Б {tp.nutr.p}{x.note ? ` · ${x.note}` : ''}</span>
                            <button className="btn small" onClick={() => W.setWeekSub(w.id, l.productId, x.to).then(() => toast('Замена учтена: закупка и КБЖУ пересчитаны'))}>Заменить</button>
                          </span>
                        );
                      })}
                      {!subCandidates(l.productId).length && <span className="muted"> подходящей замены на av.ru нет — замените блюдо в меню.</span>}
                    </span>
                  )}
                </span>
                <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
                  <button className={`btn small${c?.bought ? ' primary' : ''}`} onClick={() => W.setWeekLine(w.id, l.productId, { bought: !c?.bought })}><PiCheck /> {c?.bought ? 'Куплено' : 'Купил'}</button>
                  <button className={`btn small ghost${c?.absent ? ' active' : ''}`} onClick={() => W.setWeekLine(w.id, l.productId, { absent: !c?.absent })}>Нет</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="card tight">
          <h3 className="mt0">Бюджет месяца</h3>
          <p className="small mt0">Закупки недель за месяц: {fmtRub(spend.planned)} из {fmtRub(BUDGET_RUB)}. «Куплено» добавляет продукт в «Мои запасы».</p>
        </div>
        {pur.leftovers.length > 0 && (
          <div className="card tight">
            <h3 className="mt0"><PiPackage /> Что останется</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>{pur.leftovers.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
        {pur.unverified.length > 0 && <Note kind="warn">Без подтверждённой карточки и цены av.ru: {pur.unverified.join(', ')}. Их стоимость в сумму не входит — проверьте при оформлении заказа.</Note>}
        {w.subs && Object.keys(w.subs).length > 0 && (
          <div className="card tight">
            <h3 className="mt0">Замены этой недели</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
              {Object.entries(w.subs).map(([from, to]) => (
                <li key={from}>{ingrName(from)} → {ingrName(to)} <button className="btn small ghost" onClick={() => W.setWeekSub(w.id, from, null)}>Отменить</button></li>
              ))}
            </ul>
          </div>
        )}
        {pur.deficits.length > 0 && <Note kind="warn">Не хватает к блюдам «из запасов» (не докупается): {pur.deficits.join('; ')}.</Note>}
        <p className="small"><a href={href('/shopping', { tab: 'stock' })}>Мои запасы</a> · <a href={href(`/week/${w.id}`, { tab: 'stock' })}>Проверить запасы заново</a></p>
      </div>
    </div>
  );
}

export function weekHrefForEvent(data: Data, eventId: string): string | null {
  for (const w of weekList(weeklyOf(data))) {
    if (shopEventId(w) === eventId) return href(`/week/${w.id}`, { tab: 'buy' });
    if (cookEventId(w) === eventId) return href(`/week/${w.id}`, { tab: 'cook' });
  }
  return null;
}
