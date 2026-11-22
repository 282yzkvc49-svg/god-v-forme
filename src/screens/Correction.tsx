// Корректировка по фактическим покупкам и меню 22–24.11: 1) проверить запасы, 2) предварительный просмотр
// меню 22, 23 и 24.11 и что ещё изменится, 3) подтвердить — резервная копия и перезапись плана; после — отчёт.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { href } from '../app/router';
import { fmtLong, fmtShort, localDate, weekdayShort, type ISODate } from '../lib/dates';
import { fmtRub, nowStamp, parseNum } from '../lib/util';
import { PRODUCTS, fmtAmount } from '../domain/catalog';
import { ASK_AT_HOME, CONFIRMED_PURCHASES, NOT_BOUGHT, baseStock, buildCorrection, correctionApplied, emptyInput, firstRevisionApplied, menuMissing, revisionBlocked, type CorrectionInput } from '../domain/correction';
import { stockSummary, untilLabel } from '../domain/stock';
import { MEAL_LABELS, type CorrectionMenuRow, type CorrectionReport } from '../state/types';
import { Disclosure, Note, PageHead, toast } from '../ui/kit';
import { PiCheckBold, PiCookingPot, PiShoppingCart, PiWarning } from '../ui/icons';

const name = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const amt = (pid: string, q: number) => (PRODUCTS[pid] ? fmtAmount(Math.max(0, Math.round(q)), PRODUCTS[pid].unit) : String(Math.round(q)));
const unit = (pid: string) => (PRODUCTS[pid]?.unit === 'pcs' ? 'шт.' : PRODUCTS[pid]?.unit === 'ml' ? 'мл' : 'г');

const SOURCE: Record<CorrectionMenuRow['source'], { label: string; cls: string }> = {
  kept: { label: 'из меню', cls: '' },
  new: { label: 'новое', cls: 'accent' },
  swap: { label: 'замена', cls: 'amber' },
  cancel: { label: 'пропущен', cls: 'outline' },
  marked: { label: 'отмечено', cls: 'sea' },
};

/** Меню 22, 23 и 24.11 целиком: что в каждом приёме и откуда. */
export function MenuPreview({ r }: { r: CorrectionReport }) {
  if (!r.menu?.length) return null;
  const dates = Array.from(new Set(r.menu.map((m) => m.date)));
  return (
    <div className="card" data-testid="menu-preview">
      <h3 className="mt0">Меню на 22, 23 и 24 ноября</h3>
      {dates.map((d) => (
        <div key={d} style={{ marginBottom: 10 }}>
          <h4 className="mt0" style={{ marginBottom: 4 }}><a href={href(`/day/${d}`)}>{weekdayShort(d)}, {fmtShort(d)}</a></h4>
          <div className="table-wrap">
            <table className="table small">
              <tbody>
                {r.menu!.filter((m) => m.date === d).map((m) => (
                  <tr key={m.slot}>
                    <td style={{ width: 84 }}>{MEAL_LABELS[m.slot]}</td>
                    <td><b>{m.title}</b><span className="muted" style={{ display: 'block' }}>{m.note}</span></td>
                    <td style={{ width: 96 }}><span className={`chip ${SOURCE[m.source].cls}`}>{SOURCE[m.source].label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="hint" style={{ marginBottom: 0 }}>Завтрак, перекус и ужин 22.11 не отмечаются выполненными автоматически — отметьте сами, когда поедите. Тренировки не меняются.</p>
    </div>
  );
}

/** Остатки к новым блюдам: хватает / по расчёту / не хватает — с заменой. */
export function StockCheck({ r }: { r: CorrectionReport }) {
  if (!r.checks?.length) return null;
  const short = r.checks.filter((c) => c.state === 'short');
  return (
    <div className="card" data-testid="stock-check">
      <h3 className="mt0">Хватит ли продуктов на новые блюда</h3>
      <div className="table-wrap">
        <table className="table small">
          <thead><tr><th>Продукт</th><th>Нужно</th><th>Есть по учёту</th><th>Итог</th></tr></thead>
          <tbody>{r.checks.map((c) => (
            <tr key={c.productId} className={c.state === 'short' ? 'warn-row' : ''}>
              <td>{c.name}</td><td>{c.need}</td><td className="num">{c.haveText}</td>
              <td className={c.state === 'short' ? 'danger-text' : 'muted'}>{c.state !== 'short' ? <span style={{ whiteSpace: 'nowrap' }}><PiCheckBold style={{ display: 'inline', verticalAlign: '-2px' }} /> {c.text}</span> : c.text}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {r.checks.some((c) => c.state === 'confirm') && <p className="small mt0">* Остаток расчётный (по чекам минус приготовленное и съеденное) — проверьте дома.</p>}
      <p className="small" style={{ marginBottom: 0 }}>
        {r.noPurchaseUntil ? <><b>На 22–24.11 закупка не нужна</b> — всё из запасов. </> : short.length ? <><b>Не хватает: {short.map((c) => c.name.toLowerCase()).join(', ')}</b> — в закупку автоматически не добавлено, см. замену. </> : null}
        Остатки не списываются заранее: только когда вы отметите «Приготовлено». Перед готовкой — «Проверить продукты»: там можно отметить, чего нет, и выбрать замену.
      </p>
    </div>
  );
}

function ReportBody({ r, preview }: { r: CorrectionReport; preview?: boolean }) {
  return (
    <>
      {r.conflicts.length > 0 && <Note kind="warn" icon={<PiWarning />}><p className="mt0"><b>Уже отмечено вами — не меняется:</b></p><ul style={{ margin: 0, paddingLeft: 18 }}>{r.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></Note>}
      <div className="card">
        <h3 className="mt0">Отметки по факту</h3>
        {r.marks.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.marks.map((m, i) => <li key={i}>{m}</li>)}</ul> : <p className="small mt0">Всё уже отмечено.</p>}
        <p className="hint" style={{ marginBottom: 0 }}>Будущие приёмы пищи не отмечаются выполненными автоматически.</p>
      </div>
      <div className="card">
        <h3 className="mt0">Какие блюда изменены</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {r.dishes.map((d, i) => <li key={i}><b>{weekdayShort(d.date)}, {fmtShort(d.date)}, {MEAL_LABELS[d.slot].toLowerCase()}</b>: {d.before} → <b>{d.after}</b></li>)}
        </ul>
        <div className="btn-row" style={{ marginTop: 8 }}>{['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-27'].map((d) => <a key={d} className="btn small" href={href(`/day/${d}`)}>{fmtShort(d)}</a>)}</div>
      </div>
      <div className="card">
        <h3 className="mt0"><PiCookingPot style={{ display: 'inline', verticalAlign: '-3px' }} /> Готовки и порции</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.portions.map((p, i) => <li key={i}>{p}</li>)}</ul>
        <p className="small" style={{ marginBottom: 0 }}>25–26.11 — командировка: завтрак в гостинице, остальное вне дома, без домашней готовки и тренировок. 29.11 — релакс-день.</p>
      </div>
      {r.deficits.length > 0 && (
        <Note kind="warn" icon={<PiWarning />}><p className="mt0"><b>По учёту может не хватить</b> (докупать не нужно — проверьте дома):</p><ul style={{ margin: 0, paddingLeft: 18 }}>{r.deficits.map((x, i) => <li key={i}>{x}</li>)}</ul></Note>
      )}
      <div className="card">
        <h3 className="mt0"><PiShoppingCart style={{ display: 'inline', verticalAlign: '-3px' }} /> Что докупить</h3>
        {r.extra.map((e) => (
          <div key={e.id} style={{ marginBottom: 10 }}>
            <p className="mt0"><b>{weekdayShort(e.date)}, {fmtShort(e.date)} — небольшая закупка{e.date === '2026-11-24' ? ' к 27–28.11 (до командировки; к меню 22–24.11 не относится)' : ''}</b>, ≈{fmtRub(e.cost)}</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{e.lines.map((l, i) => <li key={i}>{l.name} — {l.text}, ≈{fmtRub(l.cost)}</li>)}</ul>
          </div>
        ))}
        {r.main && (
          <Disclosure defaultOpen={!preview} summary={<span><b>{weekdayShort(r.main.date)}, {fmtShort(r.main.date)} — вторая основная закупка</b>, ≈{fmtRub(r.main.cost)} ({r.main.lines.length} позиций)</span>}>
            <div className="table-wrap">
              <table className="table small">
                <thead><tr><th>Продукт</th><th>Нужно</th><th>Из запасов</th><th>Купить</th><th className="num">₽</th></tr></thead>
                <tbody>{r.main.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.need}</td><td>{l.fromStock}</td><td>{l.buy}</td><td className="num">{Math.round(l.cost)}</td></tr>)}</tbody>
              </table>
            </div>
            {r.main.covered.length > 0 && <p className="small">Хватит запасов, покупать не нужно: {r.main.covered.join(', ')}.</p>}
          </Disclosure>
        )}
        {r.later.length > 0 && <p className="small">Позже — докупки свежего: {r.later.map((x) => `${fmtShort(x.date)} ≈${fmtRub(x.cost)}`).join(', ')}.</p>}
        <div className="row between" style={{ marginTop: 6 }}><span>Бюджет на месяц</span><b className="num">{fmtRub(r.budget.total)}</b></div>
        <div className="row between"><span>Уже потрачено {r.budget.spentActual ? '(по чекам)' : '(оценка по ценам каталога)'}</span><span className="num">{fmtRub(r.budget.spent)}</span></div>
        <div className="row between"><span>Предстоящие закупки</span><span className="num">{fmtRub(r.budget.planned)}</span></div>
        <div className="row between"><span>Остаток бюджета</span><b className="num">{fmtRub(r.budget.left)}</b></div>
        <p className="hint" style={{ marginBottom: 0 }}>Цены — ориентир по каталогу av.ru, не собранная корзина: наличие и доставку по адресу подтверждайте в корзине («Проверить на av.ru»).</p>
      </div>
      <div className="card">
        <h3 className="mt0">Какие продукты остались</h3>
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th>Продукт</th><th>Куплено</th><th>Использовано</th><th>Остаток</th><th>Срок</th></tr></thead>
            <tbody>{r.stock.filter((s) => s.remaining > 0.5).map((s) => <tr key={s.productId}><td>{s.name}{s.needsConfirm ? ' *' : ''}</td><td>{amt(s.productId, s.bought)}</td><td>{amt(s.productId, s.used + s.writtenOff)}</td><td><b>{amt(s.productId, s.remaining)}</b></td><td>{s.until ? (s.expired ? `прошёл? ${fmtShort(s.until)}` : untilLabel(s.until, r.today)) : '—'}</td></tr>)}</tbody>
          </table>
        </div>
        {r.needConfirm.length > 0 && <p className="small" style={{ marginBottom: 0 }}>* Требуют подтверждения (расчётные остатки): {r.needConfirm.join(', ')}.</p>}
      </div>
      <div className="card">
        <h3 className="mt0">Важно</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </div>
    </>
  );
}

function StockInputs({ data, input, setInput }: { data: ReturnType<typeof useApp>; input: CorrectionInput; setInput: (f: (x: CorrectionInput) => CorrectionInput) => void }) {
  const today = useToday();
  const now = useMemo(() => nowStamp(), []);
  const b0 = useMemo(() => baseStock(data, now, { ...emptyInput() }, today), [data.planDays, data.cookingEvents, data.taskStatus, data.stock, today]);
  const base = b0.stock;
  const ledger = b0.ledger;
  const cur = useMemo(() => baseStock(data, now, input, today).stock, [base, input]);
  const missing = useMemo(() => menuMissing(data, now, today), [base]);
  const confirmed = new Set(CONFIRMED_PURCHASES.map((c) => c.productId));
  const rows = Object.values(base).filter((r) => r.moves.some((m) => m.kind === 'purchase')).sort((a, b) => (confirmed.has(a.productId) === confirmed.has(b.productId) ? name(a.productId).localeCompare(name(b.productId), 'ru') : confirmed.has(a.productId) ? -1 : 1));
  const inTable = new Set([...rows.map((r) => r.productId), ...ASK_AT_HOME]);
  const askMore = missing.filter((m) => !inTable.has(m.pid) && PRODUCTS[m.pid]);
  const row = (pid: string) => {
    const s0 = stockSummary(base[pid], today);
    const s = stockSummary(cur[pid], today);
    const perishable = PRODUCTS[pid]?.storage === 'fridge' && cur[pid].location !== 'freezer';
    const spoiled = input.spoiled.includes(pid);
    return (
      <tr key={pid} className={s.expired && !spoiled ? 'warn-row' : ''}>
        <td>{name(pid)}{!confirmed.has(pid) && <span className="chip warn" style={{ marginLeft: 4 }}>по плану</span>}<span className="muted" style={{ display: 'block' }}>куплено {amt(pid, s0.bought)}, использовано ≈{amt(pid, s0.used)}</span></td>
        <td><input className="input" style={{ width: 86 }} inputMode="decimal" aria-label={`${name(pid)}: остаток, ${unit(pid)}`} placeholder={String(Math.round(s0.remaining))}
          defaultValue={input.remaining[pid] != null ? String(input.remaining[pid]) : ''}
          onBlur={(e) => { const v = parseNum(e.target.value); setInput((x) => { const remaining = { ...x.remaining }; if (v == null) delete remaining[pid]; else remaining[pid] = v; return { ...x, remaining }; }); }} /> <span className="muted">{unit(pid)}</span></td>
        <td>{perishable ? (
          <>
            <input className="input" type="date" style={{ width: 140 }} aria-label={`${name(pid)}: годен до`} defaultValue={input.expiry[pid] ?? ''} onChange={(e) => setInput((x) => ({ ...x, expiry: { ...x.expiry, [pid]: e.target.value || null } }))} />
            <span className={`small ${s.expired ? 'danger-text' : 'muted'}`} style={{ display: 'block' }}>{input.expiry[pid] ? 'с упаковки' : s.until ? `оценка: до ${fmtShort(s.until)}${s.expired ? ' — прошёл?' : ''}` : ''}</span>
          </>
        ) : <span className="muted small">{s.until ? untilLabel(s.until, today) : '—'}</span>}</td>
        <td><label className="row nowrap small" style={{ gap: 4 }}><input type="checkbox" checked={spoiled} onChange={(e) => setInput((x) => ({ ...x, spoiled: e.target.checked ? [...x.spoiled, pid] : x.spoiled.filter((y) => y !== pid) }))} /> испорчено</label></td>
      </tr>
    );
  };
  return (
    <div className="card">
      <h3 className="mt0">1. Проверьте запасы на {fmtShort(today > '2026-11-22' ? today : '2026-11-22')}</h3>
      {ledger
        ? <p className="small mt0">Остатки — из «Моих запасов», с вашими отметками. Если знаете точный остаток — впишите; срок с упаковки — укажите. Пустое поле — оставить как есть.</p>
        : <p className="small mt0">Куплено — по фото чеков (фрукты и клубника — по плану первой закупки: на фото не видно). Использовано — оценка по выполненной готовке 15.11 и съеденным приёмам пищи (21.11 — только завтрак). Если знаете точный остаток — впишите; срок с упаковки — укажите. Пустое поле — оставить оценку.</p>}
      {missing.length > 0 && (
        <Note kind="plain">
          <p className="mt0">Для завтраков и перекусов меню 23–24.11 по учёту нет: <b>{missing.map((m) => m.text).join(', ')}</b>. Если это есть дома и годно — укажите остаток{missing.some((m) => inTable.has(m.pid)) ? ' (и срок) в таблице' : ''}{askMore.length ? ' или ниже' : ''}, и блюдо меню останется. Иначе — замена из того, что есть.</p>
          {askMore.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {askMore.map(({ pid }) => (
                <label key={pid} className="row between small" style={{ gap: 8 }}>
                  <span>{name(pid)}</span>
                  <span><input className="input" style={{ width: 86 }} inputMode="decimal" placeholder="0" aria-label={`${name(pid)}: есть дома, ${unit(pid)}`}
                    defaultValue={input.remaining[pid] != null ? String(input.remaining[pid]) : ''}
                    onBlur={(e) => { const v = parseNum(e.target.value); setInput((x) => { const remaining = { ...x.remaining }; if (v == null || v === 0) delete remaining[pid]; else remaining[pid] = v; return { ...x, remaining }; }); }} /> <span className="muted">{unit(pid)}</span></span>
                </label>
              ))}
            </div>
          )}
        </Note>
      )}
      <div className="table-wrap">
        <table className="table small">
          <thead><tr><th>Продукт</th><th>Остаток сейчас</th><th>Годен до</th><th /></tr></thead>
          <tbody>{rows.map((r) => row(r.productId))}</tbody>
        </table>
      </div>
      <h4>Есть дома, но не на чеках?</h4>
      <p className="small mt0">Учитываются, только если вы укажете количество; иначе — попадут в закупки.</p>
      <div className="stack" style={{ gap: 6 }}>
        {ASK_AT_HOME.map((pid) => (
          <label key={pid} className="row between small" style={{ gap: 8 }}>
            <span>{name(pid)}</span>
            <span><input className="input" style={{ width: 86 }} inputMode="decimal" placeholder="0" aria-label={`${name(pid)}: есть дома, ${unit(pid)}`}
              defaultValue={input.remaining[pid] != null ? String(input.remaining[pid]) : ''}
              onBlur={(e) => { const v = parseNum(e.target.value); setInput((x) => { const remaining = { ...x.remaining }; if (v == null || v === 0) delete remaining[pid]; else remaining[pid] = v; return { ...x, remaining }; }); }} /> <span className="muted">{unit(pid)}</span></span>
          </label>
        ))}
      </div>
      <p className="small">Не куплены и не считаются имеющимися: {NOT_BOUGHT.map(name).join(', ')}.</p>
      {!data.settings.budgetSpent && (
        <label className="row between small" style={{ gap: 8 }}>
          <span>Фактически потрачено на первую закупку, ₽ (если знаете)</span>
          <input className="input" style={{ width: 110 }} inputMode="decimal" defaultValue={input.spent != null ? String(input.spent) : ''} onBlur={(e) => { const v = parseNum(e.target.value); setInput((x) => ({ ...x, spent: v != null && v > 0 ? v : null })); }} />
        </label>
      )}
    </div>
  );
}

export function CorrectionScreen() {
  const data = useApp();
  const today = useToday();
  const applied = correctionApplied(data);
  const blocked = revisionBlocked(data);
  const revision = firstRevisionApplied(data);
  const last = Object.values(data.backups ?? {}).filter((b) => b.correctionReport).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const [input, setInput] = useState<CorrectionInput>(emptyInput());
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useMemo(() => nowStamp(), []);
  useEffect(() => { if (applied) A.markCorrectionReportSeen(); }, [applied]);
  const preview = useMemo(() => (!applied && !blocked && data.settings.plan ? buildCorrection(data, today, now, input) : null), [applied, blocked, input, data.planDays, data.cookingEvents, data.shoppingEvents, data.taskStatus, data.stock, today]);

  if ((applied || blocked) && last?.correctionReport) {
    const r = last.correctionReport;
    return (
      <div className="page">
        <PageHead title={applied ? 'Меню 22–24.11 и запасы обновлены' : 'Корректировка по факту применена'} sub={`${fmtLong(localDate(new Date(r.appliedAt)))}: меню, порции, готовки и закупки с 21.11 по 15.12`} backTo="/shopping" />
        {blocked && <Note kind="warn" icon={<PiWarning />}><p className="mt0"><b>Новое меню 22–24.11 (нут с булгуром, индейка с гречкой, курица с рисом) не применено.</b></p><p style={{ marginBottom: 0 }}>{blocked}</p></Note>}
        <Note kind="ok">
          <p className="mt0">Резервная копия перед изменениями — {fmtLong(localDate(new Date(last.createdAt)))}, {new Date(last.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. Вес, фото, тренировки, отметки питания и прошедшие закупки не менялись.</p>
          <p style={{ marginBottom: 0 }}>Дальше: «Приготовлено» у готовки и «Съедено» у приёма пищи списывают продукты из запасов. <a href={href('/shopping', { tab: 'stock' })}>Мои запасы</a></p>
        </Note>
        <MenuPreview r={r} />
        <StockCheck r={r} />
        <ReportBody r={r} />
      </div>
    );
  }
  if (!preview) return <div className="page"><PageHead title="Корректировка по факту" backTo="/shopping" /><Note>{blocked ?? 'Нет плана питания.'}</Note></div>;
  const r = preview.report;
  return (
    <div className="page">
      <PageHead title={revision ? 'Новое меню на 22–24 ноября' : 'Корректировка по фактическим покупкам'} sub={revision ? 'Предварительный просмотр: применится только после подтверждения' : '21.11–15.12: меню, остатки, порции, готовки и закупки'} backTo="/shopping" />
      <Note kind="plain">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>21.11 — съеден только завтрак; обед, перекус и ужин пропущены, готовки не было, готовых блюд не осталось.</li>
          <li>22.11 — завтрак и перекус по меню, обед пропущен, на ужин — <b>нут с булгуром и овощами</b> (1 порция). Готовка 22.11: нут с булгуром и <b>индейка с гречкой и морковью</b> на 2 порции — обеды 23 и 24.11 в 12:00.</li>
          <li>23.11 — готовка: <b>курица с рисом и брокколи</b> на 2 порции — ужины 23 и 24.11. 24.11 — без новой готовки. Завтраки и перекусы 23–24.11 — из меню, если продукты есть.</li>
          <li>25–26.11 — командировка, 27–28.11 — домашнее меню из оставшихся продуктов, 29.11 — релакс; с 30.11 — программа дальше, закупки пересчитаны по остаткам.</li>
          {revision && <li>Заменяет первую редакцию корректировки (индейка с булгуром на 3 порции). Запасы и отметки не пересоздаются.</li>}
        </ul>
      </Note>
      <StockInputs data={data} input={input} setInput={setInput} />
      <h2 className="section-title">2. Предварительный просмотр</h2>
      <MenuPreview r={r} />
      <StockCheck r={r} />
      <ReportBody r={r} preview />
      <div className="card">
        <h3 className="mt0">3. Подтверждение</h3>
        <p className="small mt0">Перед изменениями сохраняется резервная копия всех данных. Затем существующий план 22–24.11 перезаписывается этим меню; прогресс, вес, фото, тренировки, отметки питания и фактические покупки не удаляются.</p>
        <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Проверил меню 22–24.11 и запасы</label>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={!ack || busy} onClick={() => { setBusy(true); A.applyCorrection(input).then(() => toast('Меню 22–24.11 обновлено')).finally(() => setBusy(false)); }}><PiCheckBold /> Создать резервную копию и применить</button>
        </div>
      </div>
    </div>
  );
}

export type { ISODate };
