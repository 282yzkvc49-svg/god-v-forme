// Корректировка по фактическим покупкам (22.11): 1) проверить запасы, 2) посмотреть, что изменится,
// 3) подтвердить — резервная копия и изменения; после — отчёт.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { href } from '../app/router';
import { fmtLong, fmtShort, localDate, weekdayShort, type ISODate } from '../lib/dates';
import { fmtRub, nowStamp, parseNum } from '../lib/util';
import { PRODUCTS, fmtAmount } from '../domain/catalog';
import { ASK_AT_HOME, CONFIRMED_PURCHASES, NOT_BOUGHT, buildCorrection, correctionApplied, emptyInput, initialStock, type CorrectionInput } from '../domain/correction';
import { stockSummary, untilLabel } from '../domain/stock';
import { MEAL_LABELS, type CorrectionReport } from '../state/types';
import { Disclosure, Note, PageHead, toast } from '../ui/kit';
import { PiCheckBold, PiCookingPot, PiShoppingCart, PiWarning } from '../ui/icons';

const name = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const amt = (pid: string, q: number) => (PRODUCTS[pid] ? fmtAmount(Math.max(0, Math.round(q)), PRODUCTS[pid].unit) : String(Math.round(q)));
const unit = (pid: string) => (PRODUCTS[pid]?.unit === 'pcs' ? 'шт.' : PRODUCTS[pid]?.unit === 'ml' ? 'мл' : 'г');

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
            <p className="mt0"><b>{weekdayShort(e.date)}, {fmtShort(e.date)} — небольшая закупка{e.date === '2026-11-24' ? ' к 27–28.11 (до командировки)' : ''}</b>, ≈{fmtRub(e.cost)}</p>
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
  const base = useMemo(() => initialStock(data, now, { ...emptyInput() }, today).stock, [data.planDays, data.cookingEvents, data.taskStatus, today]);
  const cur = useMemo(() => initialStock(data, now, input, today).stock, [base, input]);
  const confirmed = new Set(CONFIRMED_PURCHASES.map((c) => c.productId));
  const rows = Object.values(base).filter((r) => r.moves.some((m) => m.kind === 'purchase')).sort((a, b) => (confirmed.has(a.productId) === confirmed.has(b.productId) ? name(a.productId).localeCompare(name(b.productId), 'ru') : confirmed.has(a.productId) ? -1 : 1));
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
      <h3 className="mt0">1. Проверьте запасы на {fmtShort('2026-11-22')}</h3>
      <p className="small mt0">Куплено — по фото чеков (фрукты и клубника — по плану первой закупки: на фото не видно). Использовано — оценка по выполненной готовке 15.11 и съеденным приёмам пищи (21.11 — только завтрак). Если знаете точный остаток — впишите; срок с упаковки — укажите. Пустое поле — оставить оценку.</p>
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
      <label className="row between small" style={{ gap: 8 }}>
        <span>Фактически потрачено на первую закупку, ₽ (если знаете)</span>
        <input className="input" style={{ width: 110 }} inputMode="decimal" defaultValue={input.spent != null ? String(input.spent) : ''} onBlur={(e) => { const v = parseNum(e.target.value); setInput((x) => ({ ...x, spent: v != null && v > 0 ? v : null })); }} />
      </label>
    </div>
  );
}

export function CorrectionScreen() {
  const data = useApp();
  const today = useToday();
  const applied = correctionApplied(data);
  const last = Object.values(data.backups ?? {}).filter((b) => b.correctionReport).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const [input, setInput] = useState<CorrectionInput>(emptyInput());
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useMemo(() => nowStamp(), []);
  useEffect(() => { if (applied) A.markCorrectionReportSeen(); }, [applied]);
  const preview = useMemo(() => (!applied && data.settings.plan ? buildCorrection(data, today, now, input) : null), [applied, input, data.planDays, data.cookingEvents, data.shoppingEvents, data.taskStatus, today]);

  if (applied && last?.correctionReport) {
    const r = last.correctionReport;
    return (
      <div className="page">
        <PageHead title="Корректировка по факту применена" sub={`${fmtLong(localDate(new Date(r.appliedAt)))}: меню, порции, готовки и закупки с 21.11 по 15.12`} backTo="/shopping" />
        <Note kind="ok">
          <p className="mt0">Резервная копия перед изменениями — {fmtLong(localDate(new Date(last.createdAt)))}, {new Date(last.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. Вес, фото, тренировки, отметки питания и прошедшие закупки не менялись.</p>
          <p style={{ marginBottom: 0 }}>Дальше: «Приготовлено» у готовки и «Съедено» у приёма пищи списывают продукты из запасов. <a href={href('/shopping', { tab: 'stock' })}>Мои запасы</a></p>
        </Note>
        <ReportBody r={r} />
      </div>
    );
  }
  if (!preview) return <div className="page"><PageHead title="Корректировка по факту" backTo="/shopping" /><Note>Нет плана питания.</Note></div>;
  const r = preview.report;
  return (
    <div className="page">
      <PageHead title="Корректировка по фактическим покупкам" sub="21.11–15.12: меню, остатки, порции, готовки и закупки" backTo="/shopping" />
      <Note kind="plain">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Готовки до 20.11 выполнены. 21.11 — съеден только завтрак, готовки и закупки не было, готовой еды к 22.11 не осталось.</li>
          <li>22.11 — завтрак и перекус по меню, обед отменён, на ужин — индейка с булгуром и овощами (3 порции: ужин 22.11, обеды 23 и 24.11).</li>
          <li>23.11 — готовка: куриное филе с рисом и брокколи (2 порции: ужины 23 и 24.11). Завтраки и перекусы 23–24.11 — из оставшихся фруктов, творога, йогурта и овсянки.</li>
          <li>25–26.11 — командировка, 27–28.11 — меню после возвращения, 29.11 — релакс; дальше — меню «Азбуки вкуса» с пересчётом закупок по остаткам.</li>
        </ul>
      </Note>
      <StockInputs data={data} input={input} setInput={setInput} />
      <h2 className="section-title">2. Что изменится</h2>
      <ReportBody r={r} preview />
      <div className="card">
        <h3 className="mt0">3. Подтверждение</h3>
        <p className="small mt0">Перед изменениями сохраняется резервная копия всех данных. Прогресс, вес, фото, выполненные тренировки, отметки питания и фактические покупки не удаляются.</p>
        <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Проверил запасы и изменения</label>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={!ack || busy} onClick={() => { setBusy(true); A.applyCorrection(input).then(() => toast('Корректировка применена')).finally(() => setBusy(false)); }}><PiCheckBold /> Создать резервную копию и применить</button>
        </div>
      </div>
    </div>
  );
}

export type { ISODate };
