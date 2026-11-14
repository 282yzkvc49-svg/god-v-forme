// «Проверить на av.ru»: открыть товар, выбрать свой адрес доставки, отметить, есть ли товар в корзине.
// Недоступный товар блокируется в закупке, пока не подтверждена замена (из каталога меню или своя карточка av.ru).
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useRoute, href } from '../app/router';
import { fmtShort, fmtDayMonth } from '../lib/dates';
import { fmtRub, parseNum } from '../lib/util';
import { BASE_PRODUCTS, PRODUCTS, TEMPLATE, fmtAmount } from '../domain/catalog';
import { menuUpdatePending } from '../domain/plan';
import {
  AV_HOME, AV_STATE_LABEL, alternativesFor, avRec, avState, basketState, makeSub, menuProductIds, orderProductIds, previewSub, recipesWith,
  type AvState,
} from '../domain/avCheck';
import { Note, PageHead, Seg, Sheet, toast } from '../ui/kit';
import { PiCheckBold, PiWarning, PiX } from '../ui/icons';

const CHIP: Record<AvState, string> = { unchecked: 'outline', available: 'accent', unavailable: 'warn', replaced: 'sea' };

export function AvStateChip({ productId }: { productId: string }) {
  const data = useApp();
  if (!BASE_PRODUCTS[productId]?.url) return null;
  const st = avState(data, productId);
  return <span className={`chip ${CHIP[st]}`} style={{ fontSize: 12 }}>{AV_STATE_LABEL[st]}</span>;
}

/** Итог проверки корзины: «Корзина проверена» — только если адрес выбран и все товары есть или заменены. */
export function BasketSummary({ ids, compact }: { ids: string[]; compact?: boolean }) {
  const data = useApp();
  const st = basketState(data, ids);
  if (st.verified) return <Note kind="ok">Корзина проверена: адрес доставки выбран, все {st.total} товаров есть в корзине или заменены по подтверждению.</Note>;
  return (
    <Note kind={st.unavailable.length ? 'warn' : 'plain'}>
      <p className="mt0"><b>Корзина ещё не проверена.</b> Карточка товара на av.ru не гарантирует доставку по вашему адресу.</p>
      <p className="small" style={{ marginBottom: st.unavailable.length ? 6 : 0 }}>
        {st.address ? 'Адрес доставки выбран. ' : 'Адрес доставки на av.ru ещё не подтверждён. '}
        Есть в корзине: {st.available.length}, заменено: {st.replaced.length}, не проверено: {st.unchecked.length}, недоступно: {st.unavailable.length} из {st.total}.
      </p>
      {st.unavailable.length > 0 && (
        <p className="small mt0" style={{ marginBottom: 0 }}><PiWarning style={{ display: 'inline', verticalAlign: '-2px' }} /> Недоступны без замены (в закупке заблокированы): {st.unavailable.map((id) => PRODUCTS[id].name).join('; ')}. Выберите замену — затем проверьте корзину заново.</p>
      )}
      {!compact && null}
    </Note>
  );
}

export function AvCheckScreen() {
  const data = useApp();
  const route = useRoute();
  const shops = useMemo(() => Object.values(data.shoppingEvents).filter((e) => e.kind === 'main' || e.kind === 'topup').filter((e) => !data.settings.plan || e.instanceId === data.settings.plan.instanceId).sort((a, b) => a.date.localeCompare(b.date)), [data.shoppingEvents, data.settings.plan]);
  const [scope, setScope] = useState<string>(route.query.get('shop') ?? 'all');
  const [replace, setReplace] = useState<string | null>(null);
  const ev = shops.find((e) => e.id === scope) ?? null;
  const ids = ev ? orderProductIds(ev) : menuProductIds();
  const cats = TEMPLATE.categories.filter((c) => ids.some((id) => BASE_PRODUCTS[id]?.category === c));
  const pending = menuUpdatePending(data);
  return (
    <div className="page narrow">
      <PageHead title="Проверка товаров на av.ru" sub="Наличие и доставка по вашему адресу" backTo={ev ? `/shop/${ev.id}` : '/shopping'} />
      {pending && <Note kind="warn">Сначала примените новое меню — проверка относится к товарам нового меню. <a href={href('/menu-update')}>Посмотреть</a></Note>}
      <div className="card">
        <h3 className="mt0">1. Выберите свой адрес доставки на av.ru</h3>
        <p className="small mt0">Откройте av.ru, войдите в свой аккаунт и укажите адрес доставки. Только после этого сайт показывает, что действительно можно привезти. Публичная кнопка «Добавить в корзину» ещё не гарантия доставки.</p>
        <div className="btn-row">
          <a className="btn" href={AV_HOME} target="_blank" rel="noopener noreferrer">Открыть av.ru ↗</a>
          <label className="row nowrap" style={{ gap: 8 }}>
            <input type="checkbox" checked={!!data.settings.avAddressConfirmedAt} onChange={(e) => A.updateSettings({ avAddressConfirmedAt: e.target.checked ? new Date().toISOString() : null })} />
            Адрес доставки выбран{data.settings.avAddressConfirmedAt ? ` (${fmtShort(data.settings.avAddressConfirmedAt.slice(0, 10))})` : ''}
          </label>
        </div>
      </div>
      <div className="card">
        <h3 className="mt0">2. Отметьте каждый товар</h3>
        <p className="small mt0">«Открыть на av.ru» → добавьте в корзину. Добавился — «Есть в корзине». Сайт предлагает «Заменить» или товара нет — «Недоступен» и выберите замену: из каталога меню или свою карточку av.ru.</p>
        <Seg label="Какие товары" value={scope} onChange={setScope} options={[{ value: 'all', label: `Все (${menuProductIds().length})` }, ...shops.map((e) => ({ value: e.id, label: `${e.kind === 'main' ? 'Закупка' : 'Докупка'} ${fmtShort(e.date)}` }))]} />
        <div style={{ marginTop: 12 }}><BasketSummary ids={ids} /></div>
        {cats.map((c) => (
          <div key={c} className="shop-cat">
            <h3>{c}</h3>
            {ids.filter((id) => BASE_PRODUCTS[id].category === c).map((id) => <AvRow key={id} id={id} onReplace={() => setReplace(id)} />)}
          </div>
        ))}
        {ev && <button className="btn ghost small" onClick={() => { A.resetAvChecks(ids); toast('Проверка сброшена — замены остались'); }}>Проверить заново (сбросить отметки этой закупки)</button>}
      </div>
      {replace && <ReplaceSheet productId={replace} onClose={() => setReplace(null)} />}
    </div>
  );
}

function AvRow({ id, onReplace }: { id: string; onReplace: () => void }) {
  const data = useApp();
  const st = avState(data, id);
  const base = BASE_PRODUCTS[id];
  const r = avRec(data, id);
  return (
    <div className={`shop-item${st === 'unavailable' ? ' blocked' : ''}`} style={{ gridTemplateColumns: '1fr' }}>
      <div style={{ minWidth: 0 }}>
        <div className="name">{base.name}</div>
        <div className="small muted">{base.pack.label}{base.pack_price != null ? ` · ≈${fmtRub(base.pack_price)} (цена на ${fmtShort(base.checked_date ?? '2026-11-14')})` : ''}</div>
        {r?.sub && <div className="small" style={{ color: 'var(--sea)' }}>Замена: {r.sub.name} — {fmtAmount(r.sub.packSize, base.unit)}, ≈{fmtRub(r.sub.packPrice)}{r.sub.qtyFactor !== 1 ? `, граммовка ×${String(r.sub.qtyFactor).replace('.', ',')}` : ''} · <a href={r.sub.url} target="_blank" rel="noopener noreferrer">av.ru ↗</a></div>}
        <div className="btn-row" style={{ marginTop: 6 }}>
          <a className="btn small" href={base.url} target="_blank" rel="noopener noreferrer">Открыть на av.ru ↗</a>
          <span className={`chip ${CHIP[st]}`}>{AV_STATE_LABEL[st]}{r?.checkedAt && st !== 'unchecked' ? `, ${fmtShort(r.checkedAt.slice(0, 10))}` : ''}</span>
        </div>
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className={`btn small${st === 'available' ? ' primary' : ''}`} aria-pressed={st === 'available'} onClick={() => A.setAvStatus(id, st === 'available' ? null : 'available')}><PiCheckBold /> Есть в корзине</button>
          <button className={`btn small${st === 'unavailable' || st === 'replaced' ? ' danger' : ''}`} aria-pressed={st === 'unavailable'} onClick={() => { if (st !== 'unavailable' && st !== 'replaced') A.setAvStatus(id, 'unavailable'); onReplace(); }}><PiX /> Недоступен</button>
          {(st === 'unavailable' || st === 'replaced') && <button className="btn small" onClick={onReplace}>{st === 'replaced' ? 'Изменить замену' : 'Выбрать замену'}</button>}
        </div>
      </div>
    </div>
  );
}

export function ReplaceSheet({ productId, onClose }: { productId: string; onClose: () => void }) {
  const data = useApp();
  const base = BASE_PRODUCTS[productId];
  const r = avRec(data, productId);
  const alts = alternativesFor(data, productId);
  const [pick, setPick] = useState<string | null>(r?.sub?.catalogId ?? null);
  const [own, setOwn] = useState(!r?.sub?.catalogId && !!r?.sub);
  const [url, setUrl] = useState(r?.sub && !r.sub.catalogId ? r.sub.url : '');
  const [name, setName] = useState(r?.sub && !r.sub.catalogId ? r.sub.name : '');
  const [pack, setPack] = useState(r?.sub && !r.sub.catalogId ? String(r.sub.packSize) : '');
  const [price, setPrice] = useState(r?.sub && !r.sub.catalogId ? String(r.sub.packPrice) : '');
  const [kcal, setKcal] = useState(''), [p, setP] = useState(''), [f, setF] = useState(''), [c, setC] = useState('');
  const [confirm, setConfirm] = useState(false);
  const nutrGiven = [kcal, p, f, c].every((x) => x.trim() !== '');
  const res = useMemo(() => {
    if (!own && !pick) return null;
    return makeSub(productId, own
      ? { name, url, packSize: parseNum(pack) ?? 0, packPrice: parseNum(price) ?? 0, nutr: nutrGiven ? { kcal: parseNum(kcal) ?? 0, p: parseNum(p) ?? 0, f: parseNum(f) ?? 0, c: parseNum(c) ?? 0 } : null }
      : { catalogId: pick, name: '', url: '', packSize: 0, packPrice: 0 }, new Date().toISOString());
  }, [own, pick, name, url, pack, price, kcal, p, f, c]);
  const preview = res?.sub ? previewSub(productId, res.sub) : null;
  const recipes = recipesWith(productId);
  const save = () => {
    if (!res?.sub || !confirm) return;
    A.setAvSub(productId, res.sub).then(() => { toast('Замена подтверждена — рецепты и закупки пересчитаны'); onClose(); });
  };
  return (
    <Sheet open onClose={onClose} title={`Замена: ${base.name}`}>
      <p className="small mt0">Товар недоступен по вашему адресу. Выберите замену, которую вы проверили в своей корзине на av.ru. Приложение не подбирает и не придумывает товары само.</p>
      <p className="small muted">Где используется: {recipes.length} рецепт(ов) — {recipes.join(', ')}. Граммовка пересчитается так, чтобы сохранить {['Мясо и птица', 'Рыба и морепродукты', 'Яйца', 'Молочные продукты'].includes(base.category) ? 'белок' : 'калорийность'}; закупки, упаковки, цены и калорийность — по новому товару.</p>
      {alts.length > 0 && (
        <>
          <h4>Из проверенного каталога меню</h4>
          <div className="list">
            {alts.map((a) => (
              <label key={a.id} className="li" style={{ alignItems: 'flex-start', gap: 10 }}>
                <input type="radio" name="alt" checked={!own && pick === a.id} onChange={() => { setOwn(false); setPick(a.id); }} />
                <span className="grow"><b>{a.name}</b><span className="small muted" style={{ display: 'block' }}>{a.pack.label}, ≈{fmtRub(a.pack_price ?? 0)} · {AV_STATE_LABEL[avState(data, a.id)]} · <a href={a.url} target="_blank" rel="noopener noreferrer">av.ru ↗</a></span></span>
              </label>
            ))}
          </div>
        </>
      )}
      <h4>Свой товар av.ru</h4>
      <label className="li" style={{ gap: 10 }}><input type="radio" name="alt" checked={own} onChange={() => { setOwn(true); setPick(null); }} /> Указать карточку товара, который есть в моей корзине</label>
      {own && (
        <div className="stack" style={{ gap: 8 }}>
          <label className="field" style={{ margin: 0 }}><span>Ссылка на карточку (https://av.ru/i/…)</span><input className="input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://av.ru/i/123456" /></label>
          <label className="field" style={{ margin: 0 }}><span>Название как на av.ru</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="row" style={{ gap: 8 }}>
            <label className="field grow" style={{ margin: 0 }}><span>Фасовка, {base.unit === 'pcs' ? 'шт.' : base.unit === 'ml' ? 'мл' : 'г'}</span><input className="input" inputMode="decimal" value={pack} onChange={(e) => setPack(e.target.value)} /></label>
            <label className="field grow" style={{ margin: 0 }}><span>Цена упаковки, ₽</span><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          </div>
          <p className="small muted mt0">Пищевая ценность на 100 г по этикетке (необязательно; без неё — как у исходного товара, граммовка не меняется):</p>
          <div className="row" style={{ gap: 6 }}>
            {[['ккал', kcal, setKcal], ['Б', p, setP], ['Ж', f, setF], ['У', c, setC]].map(([l, v, set]) => (
              <label key={l as string} className="field grow" style={{ margin: 0 }}><span>{l as string}</span><input className="input" inputMode="decimal" value={v as string} onChange={(e) => (set as (x: string) => void)(e.target.value)} /></label>
            ))}
          </div>
        </div>
      )}
      {res && res.errors.length > 0 && <Note kind="warn">{res.errors.join(' ')}</Note>}
      {preview && res?.sub && (
        <Note kind="info">Будет: {preview.name}, {preview.pack.label}, ≈{fmtRub(res.sub.packPrice)}. Граммовка в рецептах ×{String(res.sub.qtyFactor).replace('.', ',')}{res.sub.qtyFactor === 1 ? ' (без изменений)' : ''}.</Note>
      )}
      <label className="row nowrap" style={{ gap: 8, marginTop: 8 }}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Я проверил: этот товар есть в моей корзине по моему адресу</label>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!res?.sub || !confirm} onClick={save}><PiCheckBold /> Подтвердить замену</button>
        {r?.sub && <button className="btn" onClick={() => A.setAvSub(productId, null).then(() => { toast('Замена отменена'); onClose(); })}>Отменить замену</button>}
        <button className="btn ghost" onClick={onClose}>Закрыть</button>
      </div>
      <p className="hint">Проверено {fmtDayMonth(new Date().toISOString().slice(0, 10))}: товар отмечается как подтверждённый вами. Перед следующей закупкой корзину стоит проверить заново.</p>
    </Sheet>
  );
}
