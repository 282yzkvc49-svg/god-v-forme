// «Мои запасы»: что реально есть дома. Купленное, использованное, списанное, остаток, место, срок,
// ближайшие рецепты; готовая еда; ручная проверка и исправление остатков.
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { href } from '../app/router';
import { fmtShort, type ISODate } from '../lib/dates';
import { parseNum } from '../lib/util';
import { PRODUCTS, fmtAmount } from '../domain/catalog';
import { daysLeft, readyFood, stockSummary, untilLabel, upcomingUses, type ReadyPortion, type StockSummary } from '../domain/stock';
import { correctionPending } from '../domain/correction';
import { MEAL_LABELS, type StockPlace, type StockRec } from '../state/types';
import { Disclosure, Empty, Note, Seg, Sheet, toast } from '../ui/kit';
import { PiCheck, PiPencilSimple, PiSnowflake, PiTrash, PiWarning } from '../ui/icons';

const PLACE: Record<StockPlace, string> = { fridge: 'Холодильник', freezer: 'Морозилка', pantry: 'Шкаф' };
const name = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const amt = (pid: string, q: number) => (PRODUCTS[pid] ? fmtAmount(Math.max(0, Math.round(q)), PRODUCTS[pid].unit) : String(Math.round(q)));

function untilText(s: StockSummary, rec: StockRec, today: ISODate): string {
  if (!s.until || s.remaining <= 0.5) return '—';
  const d = daysLeft(s.until, today)!;
  const mark = rec.expiresOn ? '' : '≈';
  if (d < 0) return `${mark}до ${fmtShort(s.until)} — срок прошёл?`;
  const lbl = untilLabel(s.until, today);
  return `${lbl === 'долгий срок' ? '' : mark}${lbl}${d <= 2 ? ` (${d === 0 ? 'сегодня' : `${d} дн.`})` : ''}`;
}

export function StockView() {
  const data = useApp();
  const today = useToday();
  const [edit, setEdit] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'confirm' | 'zero'>('all');
  const recs = Object.values(data.stock ?? {});
  const rows = useMemo(() => recs.map((r) => ({ rec: r, s: stockSummary(r, today) })).sort((a, b) => name(a.rec.productId).localeCompare(name(b.rec.productId), 'ru')), [data.stock, today]);
  const ready = useMemo(() => readyFood(data, today), [data.cookingEvents, data.taskStatus, data.readyFood, data.stock, today]);
  if (!data.settings.inventory) {
    return (
      <div className="card">
        <Empty title="Учёт запасов ещё не включён" actions={correctionPending(data, today) ? <a className="btn primary" href={href('/correction')}>Корректировка по фактическим покупкам</a> : null}>
          Учёт запасов включается корректировкой по фактическим покупкам: в неё вносятся купленные продукты по чекам, а дальше «Приготовлено» и «Съедено» списывают их по факту.
        </Empty>
      </div>
    );
  }
  const shown = rows.filter(({ s }) => (filter === 'confirm' ? s.needsConfirm && (s.remaining > 0.5 || s.bought > 0) : filter === 'zero' ? s.remaining <= 0.5 : s.remaining > 0.5 || s.needsConfirm));
  const toConfirm = rows.filter(({ s }) => s.needsConfirm && (s.remaining > 0.5 || s.bought > 0)).length;
  const expired = rows.filter(({ s }) => s.expired).length;
  return (
    <div className="stack">
      <Note kind="plain">
        <p className="mt0">Остаток = куплено − использовано − списано ± исправления. Продукты списываются только по факту: «Приготовлено» у готовки и «Съедено» у приёма пищи. С учётом этих остатков пересчитываются закупки.</p>
        <p style={{ marginBottom: 0 }}>Сроки со знаком «≈» — оценка по общему сроку хранения; точную дату с упаковки можно указать.</p>
      </Note>
      {(toConfirm > 0 || expired > 0) && (
        <Note kind="warn" icon={<PiWarning />}>
          {toConfirm > 0 && <p className="mt0">Требуют подтверждения: {toConfirm} — остатки расчётные (по чекам и плану). Проверьте и поправьте количество.</p>}
          {expired > 0 && <p style={{ marginBottom: 0 }}>По оценке срок прошёл: {rows.filter(({ s }) => s.expired).map(({ rec }) => name(rec.productId).toLowerCase()).join(', ')}. Проверьте дату на упаковке или спишите.</p>}
        </Note>
      )}
      <Seg value={filter} onChange={setFilter} label="Показать" options={[{ value: 'all', label: 'Есть дома' }, { value: 'confirm', label: `Проверить (${toConfirm})` }, { value: 'zero', label: 'Нет / закончилось' }]} />
      {(['fridge', 'freezer', 'pantry'] as StockPlace[]).map((place) => {
        const list = shown.filter(({ rec }) => rec.location === place);
        if (!list.length) return null;
        return (
          <div className="card tight" key={place}>
            <h3 className="mt0">{PLACE[place]}</h3>
            <div className="stock-table" role="table" aria-label={PLACE[place]}>
              <div className="stock-row head" role="row"><span role="columnheader">Продукт</span><span role="columnheader">Куплено</span><span role="columnheader">Использовано</span><span role="columnheader">Остаток</span><span role="columnheader">Срок</span></div>
              {list.map(({ rec, s }) => {
                const pid = rec.productId;
                const uses = upcomingUses(data, pid, today, 2);
                return (
                  <button type="button" className={`stock-row${s.expired ? ' expired' : ''}`} role="row" key={pid} onClick={() => setEdit(pid)}>
                    <span role="cell" className="stock-name">{name(pid)}
                      {s.needsConfirm && <span className="chip warn">требует подтверждения</span>}
                      {uses.length > 0 && <span className="muted small" style={{ display: 'block' }}>{uses.join(' · ')}</span>}
                    </span>
                    <span role="cell" className="num">{s.bought ? amt(pid, s.bought) : '—'}</span>
                    <span role="cell" className="num">{s.used || s.writtenOff ? `${amt(pid, s.used)}${s.writtenOff ? `, списано ${amt(pid, s.writtenOff)}` : ''}` : '—'}</span>
                    <span role="cell" className="num"><b>{amt(pid, s.remaining)}</b></span>
                    <span role="cell" className="small">{untilText(s, rec, today)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {!shown.length && <div className="card"><Empty title="Здесь пусто" /></div>}
      <ReadyFoodCard list={ready} today={today} />
      {edit && <StockSheet pid={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ReadyFoodCard({ list, today }: { list: ReadyPortion[]; today: ISODate }) {
  return (
    <div className="card">
      <h3 className="mt0">Готовая еда</h3>
      {!list.length ? <p className="muted small mt0">Приготовленных порций сейчас нет. Порции появляются после «Приготовлено» у готовки.</p> : (
        <div className="list">
          {list.map((p) => {
            const late = p.safeUntil < today;
            return (
              <div className="li" key={p.id} style={{ alignItems: 'flex-start' }}>
                <span className="grow small">
                  <b>{p.title}</b>
                  <span className="muted" style={{ display: 'block' }}>
                    приготовлено {fmtShort(p.cookedOn)} · {p.storage === 'freeze' ? 'морозилка' : 'холодильник'} · {late ? 'срок прошёл — не есть' : `безопасно до ${fmtShort(p.safeUntil)}`}
                    {p.state === 'left' ? ` · не съедено ${fmtShort(p.date)} (${MEAL_LABELS[p.slot].toLowerCase()})` : p.state === 'planned' ? ` · по плану ${fmtShort(p.date)}, ${MEAL_LABELS[p.slot].toLowerCase()}` : ''}
                  </span>
                </span>
                {p.state !== 'planned' && (
                  <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
                    {!late && <button className="btn small" onClick={() => A.readyFoodAction(p, 'eaten').then(() => toast('Отмечено: съедено'))}><PiCheck /> Съел</button>}
                    {!late && p.storage !== 'freeze' && <button className="btn small" onClick={() => A.readyFoodAction(p, 'frozen').then(() => toast('Порция в морозилке'))}><PiSnowflake /> Заморозить</button>}
                    <button className="btn small ghost" onClick={() => A.readyFoodAction(p, 'writeoff').then(() => toast('Порция списана'))}><PiTrash /> Списать</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="hint" style={{ marginBottom: 0 }}>Если приём пищи пропущен, порция остаётся здесь: её можно съесть позже в пределах срока, заморозить или списать. Старую еду на новые даты без проверки срока не переносите.</p>
    </div>
  );
}

function StockSheet({ pid, onClose }: { pid: string; onClose: () => void }) {
  const data = useApp();
  const today = useToday();
  const rec = data.stock[pid];
  const s = rec ? stockSummary(rec, today) : null;
  const p = PRODUCTS[pid];
  const [qty, setQty] = useState(s ? String(Math.round(s.remaining)) : '0');
  const [exp, setExp] = useState(rec?.expiresOn ?? '');
  if (!p) return null;
  const unit = p.unit === 'pcs' ? 'шт.' : p.unit === 'ml' ? 'мл' : 'г';
  const done = (msg: string) => (conf: string[]) => { toast(conf.length ? `${msg}. Не изменено отмеченное: ${conf.length}` : `${msg}; закупки пересчитаны`); onClose(); };
  return (
    <Sheet open onClose={onClose} title={name(pid)}>
      <p className="muted mt0">{p.name}</p>
      {s && (
        <ul className="small" style={{ paddingLeft: 18 }}>
          <li>Куплено: {amt(pid, s.bought)}; использовано: {amt(pid, s.used)}{s.writtenOff ? `; списано: ${amt(pid, s.writtenOff)}` : ''}{s.adjusted ? `; исправлено: ${s.adjusted > 0 ? '+' : ''}${amt(pid, s.adjusted)}` : ''}.</li>
          <li>Остаток: <b>{amt(pid, s.remaining)}</b> {s.needsConfirm ? '— расчётный, требует подтверждения' : '— проверен'}.</li>
          <li>Срок: {untilText(s, rec!, today)}.</li>
        </ul>
      )}
      {rec && rec.moves.length > 0 && (
        <Disclosure summary="Движения">
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {[...rec.moves].sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).map((m) => (
              <li key={m.id}>{fmtShort(m.date)}: {m.kind === 'purchase' ? 'куплено' : m.kind === 'use' ? 'использовано' : m.kind === 'writeoff' ? 'списано' : 'исправлено'} {amt(pid, Math.abs(m.qty))}{m.kind === 'adjust' && m.qty < 0 ? ' (−)' : ''}{m.note ? ` — ${m.note}` : ''}{m.confirmed ? '' : ' (оценка)'}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        <span>Сколько сейчас есть, {unit}</span>
        <input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <div className="btn-row">
        <button className="btn primary" onClick={() => { const v = parseNum(qty); if (v == null || v < 0) { toast('Укажите количество'); return; } A.setStockRemaining(pid, v).then(done('Остаток сохранён')); }}><PiPencilSimple /> Сохранить остаток</button>
        {s?.needsConfirm && <button className="btn" onClick={() => A.confirmStock(pid).then(() => { toast('Остаток подтверждён'); onClose(); })}><PiCheck /> Всё верно</button>}
      </div>
      <label className="field" style={{ marginTop: 10 }}>
        <span>Годен до (с упаковки)</span>
        <input className="input" type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
      </label>
      <div className="btn-row">
        <button className="btn" onClick={() => A.updateStock(pid, { expiresOn: exp || null }).then(done('Срок сохранён'))}>Сохранить срок</button>
        <Seg value={rec?.location ?? 'fridge'} onChange={(v) => A.updateStock(pid, { location: v }).then(done(`Место: ${PLACE[v].toLowerCase()}`))} label="Где хранится" options={(['fridge', 'freezer', 'pantry'] as StockPlace[]).map((x) => ({ value: x, label: PLACE[x] }))} />
      </div>
      {s && s.remaining > 0.5 && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={() => { if (confirm(`Списать ${amt(pid, s.remaining)} (испорчено)?`)) A.writeOffStock(pid, s.remaining).then(done('Списано')); }}><PiTrash /> Испорчено — списать всё</button>
        </div>
      )}
    </Sheet>
  );
}
