// Перед готовкой: проверить продукты по запасам. Нехватка — показать дефицит; испорчено или нет — предложить
// замену из того, что есть (тот же вид продукта). «Приготовлено» списывает продукты, «Отменена» — оставляет.
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { PRODUCTS, fmtAmount } from '../domain/catalog';
import { cookProducts, stockLots, stockSummary } from '../domain/stock';
import type { CookingEvent } from '../state/types';
import { Note, toast } from '../ui/kit';
import { PiCheckBold, PiWarning } from '../ui/icons';

const OPTIONAL = new Set(['salt', 'paprika', 'cinnamon', 'curry', 'oliveoil', 'garlic']);
const name = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const amt = (pid: string, q: number) => (PRODUCTS[pid] ? fmtAmount(Math.max(0, Math.round(q)), PRODUCTS[pid].unit) : String(Math.round(q)));
const KIND = (pid: string) => {
  const c = PRODUCTS[pid]?.category ?? '';
  return c.startsWith('Овощи') ? 'Овощи' : c;
};

export function CookStockCheck({ e }: { e: CookingEvent }) {
  const data = useApp();
  const today = useToday();
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const [replace, setReplace] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const need = useMemo(() => cookProducts(e), [e]);
  const usable = (pid: string) => {
    const rec = data.stock?.[pid];
    return rec ? stockLots(rec).filter((l) => l.until >= today).reduce((s, l) => s + l.qty, 0) : 0;
  };
  const rows = Array.from(need, ([pid, q]) => {
    const have = usable(pid);
    const rec = data.stock?.[pid];
    const expired = rec ? stockSummary(rec, today).expired : false;
    const short = have + 1 < q;
    const alts = Object.values(data.stock ?? {}).filter((r) => r.productId !== pid && KIND(r.productId) === KIND(pid) && usable(r.productId) + 1 >= q).map((r) => r.productId);
    return { pid, q, have, expired, short, optional: OPTIONAL.has(pid), alts };
  });
  const problems = rows.filter((r) => !r.optional && (r.short || missing[r.pid]) && !replace[r.pid]);
  return (
    <div className="card">
      <h3 className="mt0">Перед готовкой — проверьте продукты</h3>
      <p className="small mt0">По учёту запасов. «Приготовлено» спишет эти продукты; если готовка не состоится — «Готовка отменена», продукты останутся.</p>
      <div className="table-wrap">
        <table className="table small">
          <thead><tr><th>Продукт</th><th>Нужно</th><th>Есть по учёту</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pid} className={!r.optional && (r.short || missing[r.pid]) && !replace[r.pid] ? 'warn-row' : ''}>
                <td>{name(r.pid)}{r.optional ? <span className="muted"> — по желанию</span> : null}{r.expired ? <span className="danger-text" style={{ display: 'block' }}>срок по оценке прошёл — проверьте</span> : null}</td>
                <td>{amt(r.pid, r.q)}</td>
                <td>{amt(r.pid, r.have)}{!r.optional && r.short ? <span className="danger-text" style={{ display: 'block' }}>не хватает ≈{amt(r.pid, r.q - r.have)}</span> : null}</td>
                <td>
                  {!r.optional && (
                    <label className="row nowrap small" style={{ gap: 4 }}><input type="checkbox" checked={!!missing[r.pid]} onChange={(ev) => setMissing((m) => ({ ...m, [r.pid]: ev.target.checked }))} /> нет или испорчено</label>
                  )}
                  {!r.optional && (missing[r.pid] || r.short) && (
                    r.alts.length
                      ? <select className="input" style={{ marginTop: 4 }} aria-label={`Замена: ${name(r.pid)}`} value={replace[r.pid] ?? ''} onChange={(ev) => setReplace((x) => { const n = { ...x }; if (ev.target.value) n[r.pid] = ev.target.value; else delete n[r.pid]; return n; })}>
                          <option value="">Заменить на…</option>
                          {r.alts.map((a) => <option key={a} value={a}>{name(a)} (есть {amt(a, usable(a))})</option>)}
                        </select>
                      : <span className="muted small" style={{ display: 'block' }}>замены в запасах нет</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {problems.length > 0 && <Note kind="warn" icon={<PiWarning />}>Не хватает: {problems.map((r) => name(r.pid).toLowerCase()).join(', ')}. Можно приготовить из того, что есть (меньше этого продукта), выбрать замену или отменить готовку — минуса в запасах не будет.</Note>}
      <label className="row nowrap" style={{ gap: 8, marginTop: 8 }}><input type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} /> Проверил продукты{Object.keys(replace).length ? ' (с заменами)' : ''}</label>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!ack} onClick={() => A.markCooked(e, replace).then((def) => toast(def.length ? `Приготовлено. Не хватило: ${def.map((d) => name(d.productId).toLowerCase()).join(', ')}` : 'Приготовлено: продукты списаны из запасов'))}><PiCheckBold /> Приготовлено</button>
        <button className="btn ghost" onClick={() => { if (confirm('Отменить готовку? Продукты останутся в запасах, порции из неё не появятся.')) A.cancelCook(e).then(() => toast('Готовка отменена')); }}>Готовка отменена</button>
      </div>
    </div>
  );
}
