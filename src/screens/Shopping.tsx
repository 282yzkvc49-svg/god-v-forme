import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { href } from '../app/router';
import { fmtDayMonth, fmtLong, fmtShort, weekdayShort, type ISODate } from '../lib/dates';
import { fmtNum, fmtRub, parseNum } from '../lib/util';
import { PROFILE, SHOPPING_META, STORAGE_GUIDE } from '../lib/seed';
import { statusOf, taskById } from '../domain/tasks';
import { recipeById } from '../domain/meals';
import { MEAL_LABELS, type CookingEvent, type ShoppingEvent } from '../state/types';
import { CheckButton, Empty, Note, PageHead, toast } from '../ui/kit';
import { copyText, shareText } from '../lib/files';
import { PiBookOpen, PiCheck, PiCookingPot, PiCopy, PiPrinter, PiShareNetwork, PiShoppingCart, PiSnowflake, PiPackage, PiListChecks } from '../ui/icons';

function shopTotals(data: ReturnType<typeof useApp>, e: ShoppingEvent) {
  let bought = 0, actual = 0, actualCount = 0, est = 0;
  for (const it of e.items) {
    const c = data.shoppingChecks[`${e.id}:${it.itemId}`];
    if (c?.bought) bought++;
    if (c?.actualPrice != null) { actual += c.actualPrice; actualCount++; }
    est += it.priceEstimate ?? 0;
  }
  return { bought, total: e.items.length, actual, actualCount, est };
}

function effDate(data: ReturnType<typeof useApp>, taskId: string, date: ISODate): ISODate {
  return data.taskMoves[taskId]?.toDate ?? date;
}

export function ShoppingHub() {
  const data = useApp();
  const today = useToday();
  const shops = useMemo(() => Object.values(data.shoppingEvents).sort((a, b) => (a.date < b.date ? -1 : 1)), [data.shoppingEvents]);
  const cooks = useMemo(() => Object.values(data.cookingEvents).filter((e) => e.eventType === 'meal_prep').sort((a, b) => (a.date < b.date ? -1 : 1)), [data.cookingEvents]);
  const nextShop = shops.find((e) => effDate(data, `shop:${e.id}`, e.date) >= today && statusOf(data, taskById(data, `shop:${e.id}`)!) !== 'done');
  const nextCook = cooks.find((e) => effDate(data, `cook:${e.id}`, e.date) >= today && statusOf(data, taskById(data, `cook:${e.id}`)!) !== 'done');
  const modelTotal = shops.reduce((s, e) => s + e.items.reduce((x, it) => x + (it.priceEstimate ?? 0), 0), 0);
  const actualTotal = shops.reduce((s, e) => s + shopTotals(data, e).actual, 0);
  return (
    <div className="page">
      <PageHead title="Закупки и готовка" sub={`${PROFILE.shopping_text} ${PROFILE.cooking_days_text}`} />
      <div className="cols even">
        <div className="stack">
          {nextShop ? <ShopSummaryCard e={nextShop} highlight /> : <div className="card"><Empty title="Ближайших закупок нет">Новые закупки появятся после импорта плана на следующий месяц.</Empty></div>}
          <h2 className="section-title">Все закупки</h2>
          {shops.map((e) => <ShopSummaryCard key={e.id} e={e} />)}
          <div className="card flat">
            <div className="row between"><span>Модельный бюджет всех закупок</span><b className="num">{fmtRub(modelTotal)}</b></div>
            <div className="row between"><span>Лимит</span><b className="num">{fmtRub(PROFILE.budget_limit_rub)}</b></div>
            {actualTotal > 0 && <div className="row between"><span>Введено фактических цен</span><b className="num">{fmtRub(actualTotal)}</b></div>}
            <p className="hint" style={{ marginBottom: 0 }}>{SHOPPING_META.price_warning}</p>
          </div>
        </div>
        <div className="stack">
          {nextCook ? <CookSummaryCard e={nextCook} highlight /> : <div className="card"><Empty title="Ближайшей готовки нет" /></div>}
          <h2 className="section-title">Календарь готовки</h2>
          <div className="card tight">
            <div className="list">
              {cooks.map((e) => {
                const t = taskById(data, `cook:${e.id}`);
                const st = t ? statusOf(data, t) : 'planned';
                const d = effDate(data, `cook:${e.id}`, e.date);
                return (
                  <a key={e.id} className="li" href={href(`/cook/${e.id}`)} style={{ padding: '10px 6px' }}>
                    <span className="num" style={{ width: 70, fontWeight: 650 }}>{weekdayShort(d)}, {fmtShort(d)}</span>
                    <span className="grow small">{e.dishes.map((x) => x.text).join(', ')}<span className="muted" style={{ display: 'block' }}>{e.forDaysText}{d !== e.date ? `, перенесено с ${fmtShort(e.date)}` : ''}</span></span>
                    {st === 'done' && <span className="chip amber"><PiCheck /> готово</span>}
                  </a>
                );
              })}
            </div>
          </div>
          {Object.values(data.cookingEvents).some((e) => e.eventType === 'relax_day' && e.date === '2026-11-29') && (
            <Note kind="plain">29.11 — релакс-день, плановой готовки нет: заготовки на 30.11–01.12 делаются в субботу 28.11.</Note>
          )}
        </div>
      </div>
    </div>
  );
}

function ShopSummaryCard({ e, highlight }: { e: ShoppingEvent; highlight?: boolean }) {
  const data = useApp();
  const t = shopTotals(data, e);
  const task = taskById(data, `shop:${e.id}`);
  const st = task ? statusOf(data, task) : 'planned';
  const d = effDate(data, `shop:${e.id}`, e.date);
  return (
    <a className="card" href={href(`/shop/${e.id}`)} style={{ display: 'block', color: 'inherit', textDecoration: 'none', borderLeft: highlight ? '5px solid var(--sea)' : undefined }}>
      <div className="card-head">
        <h3><PiShoppingCart style={{ display: 'inline', verticalAlign: '-4px', color: 'var(--sea)' }} /> {e.title}</h3>
        {st === 'done' ? <span className="chip sea"><PiCheck /> выполнено</span> : <span className="chip">{fmtLong(d)}</span>}
      </div>
      <div className="row between small">
        <span>Куплено {t.bought} из {t.total}{e.forDatesText ? `, на ${e.forDatesText}` : ''}</span>
        <span className="num">ориентир {fmtRub(t.est)}</span>
      </div>
      <div className="budget-bar"><i style={{ width: `${(t.bought / Math.max(1, t.total)) * 100}%` }} /></div>
    </a>
  );
}

function CookSummaryCard({ e, highlight }: { e: CookingEvent; highlight?: boolean }) {
  const data = useApp();
  const d = effDate(data, `cook:${e.id}`, e.date);
  return (
    <a className="card" href={href(`/cook/${e.id}`)} style={{ display: 'block', color: 'inherit', textDecoration: 'none', borderLeft: highlight ? '5px solid var(--amber)' : undefined }}>
      <div className="card-head">
        <h3><PiCookingPot style={{ display: 'inline', verticalAlign: '-4px', color: 'var(--amber)' }} /> Готовка</h3>
        <span className="chip">{fmtLong(d)}</span>
      </div>
      <p className="mt0" style={{ marginBottom: 4 }}>{e.dishes.map((x) => x.text).join(', ')}</p>
      <p className="small muted mt0" style={{ marginBottom: 0 }}>{e.forDaysText}. {e.storage}</p>
    </a>
  );
}

// ------------------------------------------------------------------ список закупки

function listText(e: ShoppingEvent, data: ReturnType<typeof useApp>): string {
  const order = SHOPPING_META.categories_order;
  const cats = Array.from(new Set(e.items.map((i) => i.category))).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const lines = [`${e.title} (${fmtDayMonth(e.date)})`];
  for (const c of cats) {
    lines.push('', `${c}:`);
    for (const it of e.items.filter((i) => i.category === c)) {
      const b = data.shoppingChecks[`${e.id}:${it.itemId}`]?.bought;
      lines.push(`${b ? '☑' : '☐'} ${it.name} — ${fmtNum(it.qty, 2)} ${it.unit}${it.note ? ` (${it.note})` : ''}`);
    }
  }
  return lines.join('\n');
}

export function ShopPage({ id }: { id: string }) {
  const data = useApp();
  const e = data.shoppingEvents[id];
  const [editPrices, setEditPrices] = useState(false);
  if (!e) return <div className="page"><PageHead title="Закупка не найдена" backTo="/shopping" /></div>;
  const task = taskById(data, `shop:${e.id}`);
  const st = task ? statusOf(data, task) : 'planned';
  const t = shopTotals(data, e);
  const order = SHOPPING_META.categories_order;
  const cats = Array.from(new Set(e.items.map((i) => i.category))).sort((a, b) => (order.indexOf(a) + 100) % 100 - (order.indexOf(b) + 100) % 100);
  const d = effDate(data, `shop:${e.id}`, e.date);
  const markAll = () => {
    const left = e.items.filter((it) => !data.shoppingChecks[`${e.id}:${it.itemId}`]?.bought).map((it) => it.itemId);
    if (!left.length) return;
    if (!confirm(`Отметить купленными ещё ${left.length} позиций? Отметки можно будет снять по одной или все сразу.`)) return;
    A.setAllBought(e.id, left, true);
  };
  const clearAll = () => {
    if (!confirm('Снять отметки «Куплено» со всех позиций? Введённые цены сохранятся.')) return;
    A.setAllBought(e.id, e.items.map((it) => it.itemId), false);
  };
  return (
    <div className="page">
      <PageHead title={e.title} sub={`${fmtLong(d)}${e.forDatesText ? `, продукты на ${e.forDatesText}` : ''}`} backTo="/shopping" right={
        <>
          <button className="btn small" onClick={() => window.print()}><PiPrinter /> Печать</button>
          <button className="btn small" onClick={async () => { (await copyText(listText(e, data))) ? toast('Список скопирован') : toast('Не удалось скопировать'); }}><PiCopy /> Скопировать</button>
          <button className="btn small" onClick={() => shareText(listText(e, data), e.title)}><PiShareNetwork /> Поделиться</button>
        </>
      } />
      <div className="print-only"><h2>{e.title}, {fmtLong(d)}</h2></div>
      <div className="cols">
        <div className="card">
          {cats.map((c) => (
            <div className="shop-cat" key={c}>
              <h3>{c}</h3>
              {e.items.filter((i) => i.category === c).map((it) => {
                const chk = data.shoppingChecks[`${e.id}:${it.itemId}`];
                const bought = !!chk?.bought;
                return (
                  <div key={it.itemId} className={`shop-item${bought ? ' bought' : ''}`}>
                    <CheckButton small state={bought ? 'on' : 'off'} label={`${it.name}: ${bought ? 'снять отметку' : 'куплено'}`} onClick={() => A.setBought(e.id, it.itemId, !bought)} />
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{it.name}</div>
                      <div className="small muted">{it.note}{it.priceEstimate != null ? `${it.note ? '. ' : ''}Ориентир ${fmtRub(it.priceEstimate)}` : ''}</div>
                    </div>
                    <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                      <span className="qty">{fmtNum(it.qty, 2)} {it.unit}</span>
                      {(editPrices || chk?.actualPrice != null) && (
                        <PriceInput value={chk?.actualPrice ?? null} onChange={(v) => A.setActualPrice(e.id, it.itemId, v)} label={`Фактическая цена: ${it.name}`} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="stack sticky-col no-print">
          <div className="card">
            <h3>Итог</h3>
            <div className="row between"><span>Куплено</span><b className="num">{t.bought} из {t.total}</b></div>
            <div className="budget-bar"><i style={{ width: `${(t.bought / Math.max(1, t.total)) * 100}%` }} /></div>
            <div className="row between"><span>Ориентир по списку</span><b className="num">{fmtRub(t.est)}</b></div>
            <div className="row between"><span>Фактически ({t.actualCount} поз.)</span><b className="num">{t.actualCount ? fmtRub(t.actual) : '—'}</b></div>
            <div className="row between muted small"><span>Лимит на месяц</span><span className="num">{fmtRub(PROFILE.budget_limit_rub)}</span></div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => setEditPrices(!editPrices)} aria-pressed={editPrices}>{editPrices ? 'Скрыть поля цен' : 'Вписать фактические цены'}</button>
            </div>
          </div>
          <div className="card">
            <div className="btn-row">
              {task && (st === 'done'
                ? <button className="btn" onClick={() => A.setTaskStatus(task, 'planned')}>Снять «Закупка выполнена»</button>
                : <button className="btn primary" onClick={() => { A.setTaskStatus(task, 'done'); toast('Закупка отмечена выполненной'); }}><PiCheck /> Закупка выполнена</button>)}
              <button className="btn" onClick={markAll}>Отметить всё купленным…</button>
              <button className="btn ghost" onClick={clearAll}>Снять все отметки</button>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>«Закупка выполнена» и отметки по товарам независимы: одна кнопка не отмечает все товары без подтверждения.</p>
          </div>
          <Note kind="warn">{SHOPPING_META.price_warning}</Note>
        </div>
      </div>
    </div>
  );
}

function PriceInput({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const [text, setText] = useState(value == null ? '' : String(value).replace('.', ','));
  return (
    <input className="input price-input" inputMode="decimal" placeholder="₽" aria-label={label} value={text}
      onChange={(ev) => setText(ev.target.value)} onBlur={() => onChange(parseNum(text))}
      onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} />
  );
}

// ------------------------------------------------------------------ готовка

const AFTER = [
  { key: 'portion', label: 'Разложить порции по контейнерам' },
  { key: 'freeze', label: 'Заморозить то, что не съесть за 3–4 дня' },
  { key: 'box', label: 'Подготовить завтрашний контейнер на работу' },
];

export function CookPage({ id }: { id: string }) {
  const data = useApp();
  const e = data.cookingEvents[id];
  if (!e) return <div className="page"><PageHead title="Готовка не найдена" backTo="/shopping" /></div>;
  const task = taskById(data, `cook:${e.id}`);
  const st = task ? statusOf(data, task) : 'planned';
  const d = effDate(data, `cook:${e.id}`, e.date);
  const recipes = Array.from(new Set(e.dishes.flatMap((x) => x.recipeIds))).map((rid) => recipeById(data, rid)).filter(Boolean) as NonNullable<ReturnType<typeof recipeById>>[];
  return (
    <div className="page">
      <PageHead title={`Готовка, ${fmtDayMonth(d)}`} sub={`${weekdayShort(d)}. ${e.forDaysText}${d !== e.date ? `. Перенесено с ${fmtDayMonth(e.date)}` : ''}`} backTo="/shopping" right={
        task && (st === 'done'
          ? <button className="btn small" onClick={() => A.setTaskStatus(task, 'planned')}>Снять отметку</button>
          : <button className="btn small primary" onClick={() => { A.setTaskStatus(task, 'done'); toast('Готовка отмечена'); }}><PiCheck /> Готовка выполнена</button>)
      } />
      <div className="cols">
        <div className="stack">
          <div className="card">
            <h2>Что готовить</h2>
            <div className="list">
              {e.dishes.map((dish, i) => {
                const cid = `cook:${e.id}:dish:${i}`;
                const on = !!data.checks[cid];
                return (
                  <div className="li" key={i}>
                    <CheckButton small state={on ? 'on' : 'off'} label={`${dish.text}: ${on ? 'снять отметку' : 'готово'}`} onClick={() => A.setCheck(cid, !on)} />
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{dish.text}</div>
                      {dish.comment && <div className="small muted">{dish.comment}</div>}
                      {dish.recipeIds.length === 0 && <div className="small muted">Овощи или гарнир без отдельного рецепта{/перлов/i.test(dish.text) ? ' — перловки нет в рецепте круп, время варки по упаковке' : ''}</div>}
                    </div>
                    <div className="chips">
                      {dish.recipeIds.map((rid) => { const r = recipeById(data, rid); return r ? <a key={rid} className="chip accent" href={href(`/recipe/${rid}`)}><PiBookOpen /> {r.title}</a> : null; })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card">
            <h2>Нужные продукты</h2>
            <p className="muted small mt0">Из рецептов, как в источнике. Количества на партию; гарниры и овощи — по меню дней.</p>
            {recipes.map((r) => (
              <div key={r.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 650 }}>{r.title} <span className="muted small">({r.yield_text})</span></div>
                <div className="small">{r.ingredients_text}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>На какие дни</h2>
            {e.forDates.length === 0 ? <p className="muted mt0">{e.forDaysText || 'Даты не указаны'}</p> : (
              <div className="list">
                {e.forDates.map((fd) => {
                  const p = data.planDays[fd];
                  return (
                    <a className="li" key={fd} href={href('/nutrition', { d: fd })}>
                      <span className="num" style={{ width: 70, fontWeight: 650 }}>{weekdayShort(fd)}, {fmtShort(fd)}</span>
                      <span className="grow small">
                        {p?.relax ? 'Релакс-день' : p?.meals ? <>{MEAL_LABELS.lunch}: {p.meals.lunch}<br />{MEAL_LABELS.dinner}: {p.meals.dinner}</> : 'План пока не добавлен'}
                      </span>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="stack sticky-col">
          <div className="card">
            <h3><PiListChecks style={{ display: 'inline', verticalAlign: '-4px' }} /> После готовки</h3>
            <div className="list">
              {AFTER.map((a) => {
                const cid = `cook:${e.id}:after:${a.key}`;
                const on = !!data.checks[cid];
                return (
                  <div className="li" key={a.key}>
                    <CheckButton small state={on ? 'on' : 'off'} label={a.label} onClick={() => A.setCheck(cid, !on)} />
                    <span className="grow">{a.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card">
            <h3><PiSnowflake style={{ display: 'inline', verticalAlign: '-4px' }} /> Хранение</h3>
            <p className="mt0"><b>{e.storage}</b></p>
            <ul className="tech-list small">
              {STORAGE_GUIDE.filter((s) => ['cool_fast', 'freeze', 'fish_thaw', 'veg_separate', 'reheat'].includes(s.id)).map((s) => <li key={s.id}>{s.text}</li>)}
            </ul>
          </div>
          <a className="btn soft" href={href('/nutrition', { d: e.forDates[0] })}><PiPackage /> Меню этих дней</a>
        </div>
      </div>
    </div>
  );
}
