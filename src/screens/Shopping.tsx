import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { go, href, useRoute } from '../app/router';
import { StockView } from './Stock';
import { CookStockCheck } from './CookCheck';
import { inventoryOn } from '../domain/stock';
import { correctionPending } from '../domain/correction';
import { fmtDayMonth, fmtLong, fmtShort, weekdayShort, type ISODate } from '../lib/dates';
import { fmtNum, fmtRub, parseNum } from '../lib/util';
import { PROFILE, SHOPPING_META, STORAGE_GUIDE } from '../lib/seed';
import { statusOf, taskById } from '../domain/tasks';
import { recipeById } from '../domain/meals';
import { DISHES, PRODUCTS, TEMPLATE, cookedWeight, dishAmount, fmtAmount, ingredientLines } from '../domain/catalog';
import { BUDGET_RUB, buyText, needText, planEnd, portionsLeft } from '../domain/plan';
import { MEAL_LABELS, type CookingEvent, type ShopLine, type ShoppingEvent } from '../state/types';
import { CheckButton, Disclosure, Empty, Note, PageHead, Seg, toast } from '../ui/kit';
import { copyText, saveFile, shareText } from '../lib/files';
import { buildShoppingExport, shoppingExportFileName } from '../domain/shopExport';
import { PiBookOpen, PiCheck, PiCookingPot, PiCopy, PiDownloadSimple, PiPrinter, PiShareNetwork, PiShoppingCart, PiSnowflake, PiPackage, PiListChecks, PiHouse } from '../ui/icons';
import { containersFor } from './planViews';
import { AvLink } from '../ui/AvLink';
import { AvStateChip, BasketSummary } from './AvCheck';
import { isBlocked, orderProductIds } from '../domain/avCheck';
import { weekOfEvent } from '../domain/weekly';
import { WeekPage } from './Week';

type Data = ReturnType<typeof useApp>;

function lineCost(data: Data, e: ShoppingEvent, l: ShopLine): number {
  return data.shoppingChecks[`${e.id}:${l.productId}`]?.atHome ? 0 : l.cost;
}

function shopTotals(data: Data, e: ShoppingEvent) {
  let bought = 0, actual = 0, actualCount = 0, est = 0, atHome = 0;
  const ids = e.lines ? e.lines.map((l) => l.productId) : e.items.map((i) => i.itemId);
  for (const id of ids) {
    const c = data.shoppingChecks[`${e.id}:${id}`];
    if (c?.bought) bought++;
    if (c?.atHome) atHome++;
    if (c?.actualPrice != null) { actual += c.actualPrice; actualCount++; }
  }
  if (e.lines) for (const l of e.lines) est += lineCost(data, e, l);
  else for (const it of e.items) est += it.priceEstimate ?? 0;
  return { bought, atHome, total: ids.length, actual, actualCount, est };
}

function effDate(data: Data, taskId: string, date: ISODate): ISODate {
  return data.taskMoves[taskId]?.toDate ?? date;
}

function mainDishes(e: CookingEvent): string {
  if (!e.items?.length) return e.dishes.map((x) => x.text).join(', ');
  return e.items.filter((i) => DISHES[i.dishId]?.unit === 'portion').map((i) => `${DISHES[i.dishId].short} ×${i.qty}`).join(', ');
}

export function ShoppingHub() {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const tab = route.query.get('tab') === 'stock' ? 'stock' : 'shop';
  const cfg = data.settings.plan;
  const shops = useMemo(() => Object.values(data.shoppingEvents).sort((a, b) => (a.date < b.date ? -1 : 1)), [data.shoppingEvents]);
  const cooks = useMemo(() => Object.values(data.cookingEvents).filter((e) => e.eventType === 'meal_prep').sort((a, b) => (a.date + (a.time ?? '') < b.date + (b.time ?? '') ? -1 : 1)), [data.cookingEvents]);
  const nextShop = shops.find((e) => effDate(data, `shop:${e.id}`, e.date) >= today && statusOf(data, taskById(data, `shop:${e.id}`)!) !== 'done');
  const nextCook = cooks.find((e) => effDate(data, `cook:${e.id}`, e.date) >= today && statusOf(data, taskById(data, `cook:${e.id}`)!) !== 'done');
  const current = shops.filter((e) => (!cfg || e.instanceId === cfg.instanceId || !e.instanceId) && e.kind !== 'trip');
  const tripShops = shops.filter((e) => e.kind === 'trip');
  const homeShops = current;
  // закупки прежних планов (до перехода на текущее меню) — история, отдельно от текущих
  const oldShops = shops.filter((e) => e.kind !== 'trip' && !current.includes(e));
  const modelTotal = current.reduce((s, e) => s + shopTotals(data, e).est, 0);
  const tripTotal = tripShops.reduce((s, e) => s + shopTotals(data, e).est, 0);
  const actualTotal = current.reduce((s, e) => s + shopTotals(data, e).actual, 0);
  const exportJson = async () => {
    const json = buildShoppingExport(data, today, __APP_VERSION__, new Date().toISOString());
    const r = await saveFile(JSON.stringify(json, null, 2), shoppingExportFileName(today), 'application/json');
    if (r !== 'cancelled') toast(`Сохранено: ${json.totals.items} позиций из ${json.totals.purchases} закупок`);
  };
  return (
    <div className="page">
      <PageHead title="Закупки и готовка" sub={`${PROFILE.shopping_text} ${PROFILE.cooking_days_text}`} right={
        <Seg value={tab} onChange={(v) => go('/shopping', v === 'stock' ? { tab: 'stock' } : {}, true)} label="Раздел" options={[{ value: 'shop', label: 'Закупки' }, { value: 'stock', label: 'Мои запасы' }]} />
      } />
      {correctionPending(data, today) && (
        <Note kind="warn"><p className="mt0">Новое меню и готовка на 22–24.11 ещё не применены: проверьте запасы и посмотрите предварительный просмотр меню.</p><a className="btn small primary" href={href('/correction')}>Посмотреть и применить</a></Note>
      )}
      {tab === 'stock' ? <StockView /> : <>
      {data.settings.inventory && !correctionPending(data, today) && <p className="small mt0">Закупки пересчитаны по фактическим остаткам. <a href={href('/correction')}>Отчёт о корректировке</a></p>}
      {cfg && (
        <div className="card flat" style={{ marginBottom: 12 }}>
          <div className="card-head"><h3 className="mt0">Товары av.ru: проверка по вашему адресу</h3><a className="btn small primary" href={href('/av-check')}>Проверить на av.ru</a></div>
          <BasketSummary ids={Array.from(new Set(current.filter((e) => e.date >= today).flatMap((e) => orderProductIds(e))))} compact />
        </div>
      )}
      {shops.length > 0 && (
        <div className="card flat" style={{ marginBottom: 12 }}>
          <div className="card-head"><h3 className="mt0">Все товары одним файлом</h3><button className="btn small" onClick={exportJson}><PiDownloadSimple /> Экспорт всех товаров в JSON</button></div>
          <p className="small muted" style={{ margin: 0 }}>Все закупки текущего меню — основные, докупки и перекусы в поездки ({homeShops.length + tripShops.length}){oldShops.length ? `, и отдельно закупки прежнего плана (${oldShops.length})` : ''}; каждая позиция отдельно: название, количество и единицы, упаковки и фасовка, дата и название закупки, ссылка на товар av.ru, плановая стоимость, ID продукта. Для сверки с каталогом «Азбуки вкуса», например в ChatGPT.</p>
        </div>
      )}
      {cfg && <p className="muted mt0">План питания: {fmtDayMonth(cfg.startDate)} — {fmtDayMonth(planEnd(cfg))}. <a href={href('/settings', { s: 'plan' })}>Изменить дату старта</a></p>}
      <div className="cols even">
        <div className="stack">
          {nextShop ? <ShopSummaryCard e={nextShop} highlight /> : <div className="card"><Empty title="Ближайших закупок нет">Закупки появятся, когда вы выберете дату старта или загрузите план на следующий месяц.</Empty></div>}
          <h2 className="section-title">Домашние закупки</h2>
          {homeShops.map((e) => <ShopSummaryCard key={e.id} e={e} />)}
          {tripShops.length > 0 && <h2 className="section-title">Перекусы в командировки</h2>}
          {tripShops.map((e) => <ShopSummaryCard key={e.id} e={e} />)}
          {oldShops.length > 0 && (
            <Disclosure summary={<span>Закупки прежнего плана — история ({oldShops.length})</span>}>
              <div className="stack">{oldShops.map((e) => <ShopSummaryCard key={e.id} e={e} />)}</div>
            </Disclosure>
          )}
          <div className="card flat">
            <div className="row between"><span>Ориентир по домашним закупкам цикла</span><b className="num">{fmtRub(modelTotal)}</b></div>
            {tripShops.length > 0 && <div className="row between small"><span>Перекусы в командировки (отдельно, не входят в бюджет)</span><span className="num">{fmtRub(tripTotal)}</span></div>}
            <div className="row between"><span>Бюджет</span><b className="num">{fmtRub(BUDGET_RUB)}</b></div>
            {modelTotal > BUDGET_RUB && <Note kind="warn">Ориентир больше бюджета на {fmtRub(modelTotal - BUDGET_RUB)}. Можно заменить часть форели минтаем — он заметно дешевле.</Note>}
            {actualTotal > 0 && <div className="row between"><span>Введено фактических цен</span><b className="num">{fmtRub(actualTotal)}</b></div>}
            <p className="hint" style={{ marginBottom: 0 }}>{SHOPPING_META.price_warning} Позиции «есть дома» в сумму не входят. Остатки круп, масла, орехов и специй перейдут на следующий месяц.</p>
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
                    <span className="num" style={{ width: 84, fontWeight: 650 }}>{weekdayShort(d)}, {fmtShort(d)}<span className="muted small" style={{ display: 'block', fontWeight: 400 }}>{e.time}</span></span>
                    <span className="grow small">{e.kind === 'quick' ? 'Быстрая: ' : ''}{mainDishes(e)}<span className="muted" style={{ display: 'block' }}>{e.forDaysText}{d !== e.date ? `, перенесено с ${fmtShort(e.date)}` : ''}</span></span>
                    {st === 'done' && <span className="chip amber"><PiCheck /> готово</span>}
                    {st === 'skipped' && <span className="chip muted">отменена</span>}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      </>}
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
        {st === 'done' ? <span className="chip sea"><PiCheck /> выполнено</span> : <span className="chip">{fmtLong(d)}{e.time ? `, ${e.time}` : ''}</span>}
      </div>
      <div className="row between small">
        <span>Куплено {t.bought}{t.atHome ? ` (+${t.atHome} есть дома)` : ''} из {t.total}{e.forDatesText ? `, на ${e.forDatesText}` : ''}</span>
        <span className="num">ориентир {fmtRub(t.est)}</span>
      </div>
      <div className="budget-bar"><i style={{ width: `${((t.bought + t.atHome) / Math.max(1, t.total)) * 100}%` }} /></div>
      {e.kind === 'topup' && <p className="small muted" style={{ marginBottom: 0 }}>Небольшая докупка: эти продукты не хранятся до следующей основной закупки.</p>}
      {e.kind === 'trip' && <p className="small muted" style={{ marginBottom: 0 }}>Купить в супермаркете на месте; без готовки. Не входит в домашний бюджет.</p>}
    </a>
  );
}

function CookSummaryCard({ e, highlight }: { e: CookingEvent; highlight?: boolean }) {
  const data = useApp();
  const d = effDate(data, `cook:${e.id}`, e.date);
  return (
    <a className="card" href={href(`/cook/${e.id}`)} style={{ display: 'block', color: 'inherit', textDecoration: 'none', borderLeft: highlight ? '5px solid var(--amber)' : undefined }}>
      <div className="card-head">
        <h3><PiCookingPot style={{ display: 'inline', verticalAlign: '-4px', color: 'var(--amber)' }} /> {e.title}</h3>
        <span className="chip">{fmtLong(d)}{e.time ? `, ${e.time}` : ''}</span>
      </div>
      <p className="mt0" style={{ marginBottom: 4 }}>{mainDishes(e)}</p>
      <p className="small muted mt0" style={{ marginBottom: 0 }}>{e.forDaysText}. {e.storage}</p>
    </a>
  );
}

// ------------------------------------------------------------------ список закупки

function listText(e: ShoppingEvent, data: Data): string {
  const out = [`${e.title} (${fmtDayMonth(e.date)}${e.time ? `, ${e.time}` : ''})`];
  if (e.lines) {
    let cat = '';
    for (const l of e.lines) {
      const p = PRODUCTS[l.productId];
      if (p.category !== cat) { cat = p.category; out.push('', `${cat}:`); }
      const c = data.shoppingChecks[`${e.id}:${l.productId}`];
      const by = l.needs.length ? l.needs.reduce((m, n) => (n.date < m ? n.date : m), l.needs[0].date) : null;
      out.push(`${c?.bought ? '☑' : '☐'} ${p.name} — ${c?.atHome ? 'есть дома' : buyText(l)}${by ? `, к ${fmtShort(by)}` : ''}${l.notes.length ? ` (${l.notes.join(' ')})` : ''}`);
    }
    return out.join('\n');
  }
  for (const it of e.items) {
    const b = data.shoppingChecks[`${e.id}:${it.itemId}`]?.bought;
    out.push(`${b ? '☑' : '☐'} ${it.name} — ${fmtNum(it.qty, 2)} ${it.unit}${it.note ? ` (${it.note})` : ''}`);
  }
  return out.join('\n');
}

export function ShopPage({ id }: { id: string }) {
  const data = useApp();
  const e = data.shoppingEvents[id];
  const [editPrices, setEditPrices] = useState(false);
  if (!e) return <div className="page"><PageHead title="Закупка не найдена" backTo="/shopping" /></div>;
  // версия 2.0: закупка недели — в разделе «Неделя» (считается после проверки запасов)
  const wk = e.instanceId === 'weekly' ? weekOfEvent(data, e.id) : null;
  if (wk) return <WeekPage id={wk.id} initialTab="buy" />;
  const task = taskById(data, `shop:${e.id}`);
  const st = task ? statusOf(data, task) : 'planned';
  const t = shopTotals(data, e);
  const d = effDate(data, `shop:${e.id}`, e.date);
  const ids = e.lines ? e.lines.map((l) => l.productId) : e.items.map((i) => i.itemId);
  const markAll = () => {
    const left = ids.filter((pid) => !data.shoppingChecks[`${e.id}:${pid}`]?.bought && !data.shoppingChecks[`${e.id}:${pid}`]?.atHome && !isBlocked(data, pid));
    if (!left.length) return;
    if (!confirm(`Отметить купленными ещё ${left.length} позиций? Отметки можно будет снять по одной или все сразу.`)) return;
    A.setAllBought(e.id, left, true);
  };
  const clearAll = () => {
    if (!confirm('Снять отметки «Куплено» со всех позиций? Введённые цены и «есть дома» сохранятся.')) return;
    A.setAllBought(e.id, ids.filter((pid) => !data.shoppingChecks[`${e.id}:${pid}`]?.atHome), false);
  };
  const cats = e.lines ? Array.from(new Set(e.lines.map((l) => PRODUCTS[l.productId].category))) : Array.from(new Set(e.items.map((i) => i.category)));
  return (
    <div className="page">
      <PageHead title={e.title} sub={`${fmtLong(d)}${e.time ? `, ${e.time}` : ''}${e.forDatesText ? `, продукты на ${e.forDatesText}` : ''}`} backTo="/shopping" right={
        <>
          <button className="btn small" onClick={() => window.print()}><PiPrinter /> Печать</button>
          <button className="btn small" onClick={async () => { (await copyText(listText(e, data))) ? toast('Список скопирован') : toast('Не удалось скопировать'); }}><PiCopy /> Скопировать</button>
          <button className="btn small" onClick={() => shareText(listText(e, data), e.title)}><PiShareNetwork /> Поделиться</button>
        </>
      } />
      <div className="print-only"><h2>{e.title}, {fmtLong(d)}</h2></div>
      {e.kind === 'trip' && <Note kind="info">Перекусы в командировку: купить в обычном супермаркете на месте, готовить не нужно. Варианты чередуются по дням — можно взять любой доступный. Сумма не входит в домашний бюджет на продукты.</Note>}
      {e.kind === 'topup' && <Note kind="info">Небольшая докупка свежего: молочные продукты, грибы, огурцы, помидоры, бананы и т. п. не хранятся до следующей основной закупки — их лучше купить ближе к дате. Фрукты и овощи — поштучно, в ближайшем магазине или заказом на av.ru; часть можно заменить замороженными.</Note>}
      {e.kind !== 'trip' && e.lines?.some((l) => PRODUCTS[l.productId]?.url) && (
        <div className="no-print">
          <BasketSummary ids={orderProductIds(e)} />
          <div className="btn-row" style={{ marginBottom: 12 }}>
            <a className="btn primary" href={href('/av-check', { shop: e.id })}>Проверить на av.ru</a>
            <span className="small muted">Цены — ориентир на 14.11.2026, не собранная корзина.</span>
          </div>
        </div>
      )}
      {e.lines && <p className="hint">Количество посчитано из меню и готовок этого периода; учтены остатки прошлых закупок и несъедобная часть (кожура, сердцевина). Отметьте «есть дома», если продукт уже есть — он не войдёт в сумму.</p>}
      <div className="cols">
        <div className="card">
          {cats.map((c) => (
            <div className="shop-cat" key={c}>
              <h3>{c}</h3>
              {e.lines
                ? e.lines.filter((l) => PRODUCTS[l.productId].category === c).map((l) => <ShopLineRow key={l.productId} e={e} l={l} editPrices={editPrices} />)
                : e.items.filter((i) => i.category === c).map((it) => {
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
                        {(editPrices || chk?.actualPrice != null) && <PriceInput value={chk?.actualPrice ?? null} onChange={(v) => A.setActualPrice(e.id, it.itemId, v)} label={`Фактическая цена: ${it.name}`} />}
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
            <div className="row between"><span>Куплено</span><b className="num">{t.bought} из {t.total - t.atHome}</b></div>
            {t.atHome > 0 && <div className="row between small"><span>Есть дома</span><span className="num">{t.atHome}</span></div>}
            <div className="budget-bar"><i style={{ width: `${((t.bought + t.atHome) / Math.max(1, t.total)) * 100}%` }} /></div>
            <div className="row between"><span>Ориентир по списку</span><b className="num">{fmtRub(t.est)}</b></div>
            <div className="row between"><span>Фактически ({t.actualCount} поз.)</span><b className="num">{t.actualCount ? fmtRub(t.actual) : '—'}</b></div>
            <div className="row between muted small"><span>Бюджет на месяц</span><span className="num">{fmtRub(BUDGET_RUB)}</span></div>
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
            <p className="hint" style={{ marginBottom: 0 }}>«Закупка выполнена» и отметки по товарам независимы.</p>
          </div>
          <Note kind="warn">{SHOPPING_META.price_warning}</Note>
        </div>
      </div>
    </div>
  );
}

function ShopLineRow({ e, l, editPrices }: { e: ShoppingEvent; l: ShopLine; editPrices: boolean }) {
  const data = useApp();
  const p = PRODUCTS[l.productId];
  const chk = data.shoppingChecks[`${e.id}:${l.productId}`];
  const bought = !!chk?.bought;
  const atHome = !!chk?.atHome;
  const blocked = e.kind !== 'trip' && isBlocked(data, l.productId) && !bought;
  return (
    <div className={`shop-item${bought || atHome ? ' bought' : ''}${blocked ? ' blocked' : ''}`}>
      <CheckButton small state={bought ? 'on' : 'off'} label={`${p.name}: ${bought ? 'снять отметку' : blocked ? 'заблокировано до замены' : 'куплено'}`} onClick={() => { if (blocked) { toast('Товар недоступен по вашему адресу — сначала подтвердите замену'); return; } A.setBought(e.id, l.productId, !bought); }} />
      <div style={{ minWidth: 0 }}>
        <div className="name">{p.name}</div>
        {p.substituteFor && <div className="small" style={{ color: 'var(--sea)' }}>замена вместо «{p.substituteFor}»</div>}
        <AvLink productId={l.productId} />
        {e.kind !== 'trip' && <div style={{ marginTop: 2 }}><AvStateChip productId={l.productId} />{blocked && <a className="small" style={{ marginLeft: 8 }} href={href('/av-check', { shop: e.id })}>выбрать замену</a>}</div>}
        <div className="small muted">
          Нужно {needText(l)}{l.needs.length ? ` к ${fmtShort(l.needs.reduce((m, n) => (n.date < m ? n.date : m), l.needs[0].date))}` : ''}{l.fromStock > 0 ? `, из остатков ${fmtAmount(l.fromStock, p.unit)}` : ''}{l.leftover > 0 && l.buy > 0 ? `, останется ${fmtAmount(l.leftover, p.unit)}` : ''}. Ориентир {fmtRub(atHome ? 0 : l.cost)}.
        </div>
        {l.notes.map((n, i) => <div key={i} className="small" style={{ color: 'var(--sea)' }}><PiSnowflake style={{ display: 'inline', verticalAlign: '-2px' }} /> {n}</div>)}
        <Disclosure summary={<span className="small">На что</span>}>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            {l.needs.map((n, i) => <li key={i}>{n.label}: {fmtAmount(n.qty, p.unit)}</li>)}
          </ul>
        </Disclosure>
      </div>
      <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
        <span className="qty">{atHome ? 'есть дома' : buyText(l)}</span>
        <button className={`chip${atHome ? ' accent' : ''}`} aria-pressed={atHome} onClick={() => A.setAtHome(e.id, l.productId, !atHome)}><PiHouse /> есть дома</button>
        {(editPrices || chk?.actualPrice != null) && <PriceInput value={chk?.actualPrice ?? null} onChange={(v) => A.setActualPrice(e.id, l.productId, v)} label={`Фактическая цена: ${p.name}`} />}
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
  { key: 'portion', label: 'Остудить (не дольше 30 минут) и разложить порции по контейнерам' },
  { key: 'freeze', label: 'Порции с пометкой «заморозить» — сразу в морозилку, подписать дату' },
  { key: 'box', label: 'Подготовить завтрашние контейнеры на работу' },
];

export function CookPage({ id }: { id: string }) {
  const data = useApp();
  const e = data.cookingEvents[id];
  if (!e) return <div className="page"><PageHead title="Готовка не найдена" backTo="/shopping" /></div>;
  const task = taskById(data, `cook:${e.id}`);
  const st = task ? statusOf(data, task) : 'planned';
  const d = effDate(data, `cook:${e.id}`, e.date);
  const boxes = containersFor(e);
  return (
    <div className="page">
      <PageHead title={`${e.title}, ${fmtDayMonth(d)}`} sub={`${weekdayShort(d)}${e.time ? `, ${e.time}` : ''}. Блюда ${e.forDaysText}${d !== e.date ? `. Перенесено с ${fmtDayMonth(e.date)}` : ''}`} backTo="/shopping" right={
        task && (st === 'done' || st === 'skipped'
          ? <button className="btn small" onClick={() => A.setTaskStatus(task, 'planned')}>{st === 'skipped' ? 'Вернуть готовку' : 'Снять отметку'}</button>
          : inventoryOn(data, e.date) ? null
          : <button className="btn small primary" onClick={() => { A.setTaskStatus(task, 'done'); toast('Готовка отмечена'); }}><PiCheck /> Готовка выполнена</button>)
      } />
      {e.instanceId === 'weekly' && weekOfEvent(data, e.id) && <Note>Порядок общей готовки, загрузка аэрогриля и плиты и хранение порций — <a href={href(`/week/${weekOfEvent(data, e.id)!.id}`, { tab: 'cook' })}>в разделе «Неделя»</a>.</Note>}
      {st === 'skipped' && <Note kind="plain">Готовка отменена — продукты остались в запасах.</Note>}
      {task && st === 'planned' && inventoryOn(data, e.date) && <CookStockCheck e={e} />}
      {e.timeNote && <Note kind="info">{e.timeNote}</Note>}
      {!!e.thawProducts?.length && (
        <Note kind="plain"><p><b>Накануне вечером</b> переложить из морозилки в холодильник:</p><p>{e.thawProducts.map((t) => `${PRODUCTS[t.productId].name} — ${fmtAmount(t.qty, PRODUCTS[t.productId].unit)}`).join('; ')}.</p></Note>
      )}
      <div className="cols">
        <div className="stack">
          {e.items?.length ? e.items.map((it) => <CookItemCard key={it.dishId} e={e} dishId={it.dishId} />) : <LegacyCook e={e} />}
        </div>
        <div className="stack sticky-col">
          {e.items?.length ? (
            <div className="card">
              <h3><PiPackage style={{ display: 'inline', verticalAlign: '-4px' }} /> Контейнеры: {boxes.length}</h3>
              <div className="list">
                {boxes.map((b) => (
                  <div className="li" key={b.date + b.slot} style={{ alignItems: 'flex-start' }}>
                    <span className="num" style={{ width: 92, fontWeight: 650 }}>{weekdayShort(b.date)}, {fmtShort(b.date)}<span className="small muted" style={{ display: 'block', fontWeight: 400 }}>{MEAL_LABELS[b.slot].toLowerCase()}</span></span>
                    <span className="grow small">{b.items.join('; ')}</span>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginBottom: 0 }}>Овощи и салаты — в отдельный контейнер, без разогрева. Гранола хранится в закрытой банке.</p>
            </div>
          ) : null}
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
          {e.forDates[0] && <a className="btn soft" href={href('/nutrition', { d: e.forDates[0] })}><PiPackage /> Меню этих дней</a>}
        </div>
      </div>
    </div>
  );
}

function CookItemCard({ e, dishId }: { e: CookingEvent; dishId: string }) {
  const data = useApp();
  const it = e.items!.find((x) => x.dishId === dishId)!;
  const d = DISHES[dishId];
  const cid = `cook:${e.id}:dish:${dishId}`;
  const on = !!data.checks[cid];
  const left = portionsLeft(data, e, it);
  const total = cookedWeight(dishId, it.qty);
  const per = d.unit === 'portion' ? cookedWeight(dishId, 1) : null;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="row nowrap" style={{ gap: 10 }}>
          <CheckButton small state={on ? 'on' : 'off'} label={`${d.title}: ${on ? 'снять отметку' : 'готово'}`} onClick={() => A.setCheck(cid, !on)} />
          {d.title}
        </h3>
        <span className="chip amber">{dishAmount(dishId, it.qty)}</span>
      </div>
      <p className="small muted mt0">
        {d.method[0].toUpperCase() + d.method.slice(1)}. {per ? `Готовая порция ≈${per} г. ` : ''}{total ? `Всего ≈${total} г готового.` : ''}
        {d.unit === 'portion' ? ` Осталось порций: ${left.left} из ${left.total}.` : ''}
      </p>
      <h4 className="mt0" style={{ marginBottom: 4 }}>Продукты на всю партию</h4>
      <ul className="ing-list compact">
        {ingredientLines(dishId, it.qty, true).map((l, j) => <li key={j}><span className="ing-dot" /><span className="grow ing-main"><span>{l.name}{l.note ? <span className="orig"> — {l.note}</span> : null}</span>{l.productId && <AvLink productId={l.productId} qty={l.qty} />}</span><span className="num small">{l.amount}</span></li>)}
        {d.spices.map((s, j) => <li key={`s${j}`}><span className="ing-dot text" /><span className="grow small muted">{s}</span></li>)}
      </ul>
      <h4 style={{ marginBottom: 4 }}>Как готовить</h4>
      <ol className="tech-list small">{d.steps.map((s, j) => <li key={j}>{s.text}{s.temperature_c && !s.text.includes(`${s.temperature_c} °C`) ? ` ${s.temperature_c} °C` : ''}{s.minutes && !/мин|ч$/.test(s.text + s.minutes) ? `, ${s.minutes} мин` : s.minutes && /ч$/.test(s.minutes) ? `, ${s.minutes}` : ''}</li>)}</ol>
      <h4 style={{ marginBottom: 4 }}>Куда идут порции</h4>
      <div className="list">
        {it.uses.map((u, j) => {
          const eaten = data.taskStatus[`meal:${u.date}:${u.slot}`]?.status === 'done';
          return (
            <a className="li" key={j} href={href(`/day/${u.date}`)} style={{ minHeight: 40 }}>
              <span className="num" style={{ width: 92 }}>{weekdayShort(u.date)}, {fmtShort(u.date)}</span>
              <span className="grow small">{MEAL_LABELS[u.slot]}{u.via ? ` (${DISHES[u.via]?.short.toLowerCase()})` : ''} — {dishAmount(dishId, u.qty)}</span>
              <span className={`chip ${u.storage === 'freeze' ? 'sea' : ''}`}>{u.storage === 'freeze' ? `морозилка, разморозить ${u.thawOn ? fmtShort(u.thawOn) : 'накануне'}` : u.storage === 'pantry' ? 'банка' : 'холодильник'}</span>
              {eaten && <span className="chip accent"><PiCheck /> съедено</span>}
            </a>
          );
        })}
      </div>
      <a className="btn ghost small" href={href(`/recipe/${dishId}`)}><PiBookOpen /> Карточка рецепта</a>
    </div>
  );
}

function LegacyCook({ e }: { e: CookingEvent }) {
  const data = useApp();
  const recipes = Array.from(new Set(e.dishes.flatMap((x) => x.recipeIds))).map((rid) => recipeById(data, rid)).filter(Boolean) as NonNullable<ReturnType<typeof recipeById>>[];
  return (
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
              </div>
              <div className="chips">
                {dish.recipeIds.map((rid) => { const r = recipeById(data, rid); return r ? <a key={rid} className="chip accent" href={href(`/recipe/${rid}`)}><PiBookOpen /> {r.title}</a> : null; })}
              </div>
            </div>
          );
        })}
      </div>
      {recipes.map((r) => <p key={r.id} className="small"><b>{r.title}</b> ({r.yield_text}): {r.ingredients_text}</p>)}
      <p className="hint">Это готовка из импортированного плана: количества — как в плане.</p>
    </div>
  );
}

export const _categories = TEMPLATE.categories;
