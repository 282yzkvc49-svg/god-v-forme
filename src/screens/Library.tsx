// Версия 2.0: библиотека рецептов — поиск, категории, фильтры, избранное, оценки, «больше не предлагать».
// Работает офлайн: рецепты встроены в приложение. «Проверено» — только у рецептов, прошедших автоматическую проверку.
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as W from '../state/weeklyActions';
import { href } from '../app/router';
import { PRODUCTS } from '../domain/catalog';
import { CUISINES, KIND_LABEL, PROTEINS, type LibKind, type LibRecipe } from '../domain/recipeCheck';
import { LIBRARY, REPORT_DATE, ingrName, libNutrition, reportFor, verifyState } from '../domain/recipeLib';
import { prefsOf } from '../domain/weekly';
import { fmtShort } from '../lib/dates';
import { Empty, Note, NumberStepper, PageHead, Seg, Switch, toast } from '../ui/kit';
import { PiMagnifyingGlass, PiStar, PiStarFill, PiProhibit, PiShieldCheck, PiWarning, PiSnowflake } from '../ui/icons';

const TARGET = { breakfast: 100, snack: 50, main: 150 } as const;
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

function fmtAmt(pid: string, q: number): string {
  const p = PRODUCTS[pid];
  if (!p) return String(q);
  if (p.unit === 'pcs') return `${Math.round(q * 10) / 10} шт.`;
  const v = q >= 20 ? Math.round(q) : Math.round(q * 10) / 10;
  return `${String(v).replace('.', ',')} ${p.unit === 'ml' ? 'мл' : 'г'}`;
}

function VerifyChip({ r }: { r: LibRecipe }) {
  const v = verifyState(r);
  return v === 'verified' ? <span className="chip ok"><PiShieldCheck /> проверено</span> : v === 'failed' ? <span className="chip warn"><PiWarning /> есть ошибки</span> : <span className="chip warn">не проверено</span>;
}

export function LibraryScreen() {
  const data = useApp();
  const prefs = prefsOf(data);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | LibKind>('all');
  const [cuisine, setCuisine] = useState('');
  const [protein, setProtein] = useState('');
  const [equip, setEquip] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [freezeOnly, setFreezeOnly] = useState(false);
  const [workOnly, setWorkOnly] = useState(false);
  const [hidden, setHidden] = useState(false);
  const counts = useMemo(() => {
    const c = { breakfast: 0, snack: 0, main: 0, verified: 0 };
    for (const r of LIBRARY) { c[r.kind]++; if (verifyState(r) === 'verified') c.verified++; }
    return c;
  }, []);
  const list = LIBRARY.filter((r) => {
    if (kind !== 'all' && r.kind !== kind) return false;
    if (!!prefs[r.id]?.hidden !== hidden) return false;
    if (favOnly && !prefs[r.id]?.fav) return false;
    if (cuisine && r.cuisine !== cuisine) return false;
    if (protein && r.protein !== protein) return false;
    if (equip && !r.equipment.includes(equip as never)) return false;
    if (freezeOnly && !r.storage.freeze) return false;
    if (workOnly && !r.tags.includes('на работу')) return false;
    if (q.trim()) {
      const t = norm(q.trim());
      const hay = norm(`${r.title} ${r.cuisine} ${r.protein} ${r.tags.join(' ')} ${r.ingredients.map((i) => ingrName(i.p)).join(' ')}`);
      if (!t.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const usedCuisines = CUISINES.filter((c) => LIBRARY.some((r) => r.cuisine === c));
  const usedProteins = PROTEINS.filter((p) => LIBRARY.some((r) => r.protein === p));
  return (
    <div className="page">
      <PageHead title="Библиотека рецептов" sub={`Сейчас ${LIBRARY.length} из 300: завтраки ${counts.breakfast} из ${TARGET.breakfast}, перекусы ${counts.snack} из ${TARGET.snack}, основные ${counts.main} из ${TARGET.main}. Прошли автоматическую проверку: ${counts.verified}${REPORT_DATE ? ` (отчёт ${fmtShort(REPORT_DATE.slice(0, 10))})` : ''}.`} />
      <Note>Библиотека пополняется партиями после согласования. Ккал и БЖУ посчитаны по ингредиентам; у новых ингредиентов — справочные данные, их наличие и цена на av.ru не подтверждены.</Note>
      <div className="card tight">
        <label className="field" style={{ marginTop: 0 }}>
          <span><PiMagnifyingGlass /> Поиск: название, продукт, кухня</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="например, минтай или гречка" />
        </label>
        <Seg value={kind} onChange={setKind} label="Категория" options={[{ value: 'all', label: 'Все' }, { value: 'breakfast', label: 'Завтраки' }, { value: 'snack', label: 'Перекусы' }, { value: 'main', label: 'Основные' }]} />
        <div className="filters">
          <label className="field"><span>Кухня</span><select className="input" value={cuisine} onChange={(e) => setCuisine(e.target.value)}><option value="">любая</option>{usedCuisines.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="field"><span>Белок</span><select className="input" value={protein} onChange={(e) => setProtein(e.target.value)}><option value="">любой</option>{usedProteins.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="field"><span>Техника</span><select className="input" value={equip} onChange={(e) => setEquip(e.target.value)}><option value="">любая</option>{['аэрогриль', 'электрогриль', 'плита', 'без нагрева'].map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>
        <div className="filters">
          <Switch checked={favOnly} onChange={setFavOnly} label="Только избранное" />
          <Switch checked={freezeOnly} onChange={setFreezeOnly} label="Можно заморозить" />
          <Switch checked={workOnly} onChange={setWorkOnly} label="На работу" />
          <Switch checked={hidden} onChange={setHidden} label="Скрытые («больше не предлагать»)" />
        </div>
      </div>
      <p className="small muted">Найдено: {list.length}</p>
      <div className="lib-grid">
        {list.map((r) => {
          const n = libNutrition(r);
          const pr = prefs[r.id];
          return (
            <a key={r.id} className="card tight lib-card" href={href(`/lib/${r.id}`)}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
                <b style={{ minWidth: 0 }}>{r.title}</b>
                {pr?.fav ? <PiStarFill aria-label="в избранном" style={{ flex: 'none', color: '#d97706' }} /> : null}
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>{KIND_LABEL[r.kind]} · {r.cuisine} · {r.protein} · {r.equipment.join(' + ')} · {r.time.active} мин активно{r.storage.freeze ? ' · ' : ''}{r.storage.freeze ? <PiSnowflake aria-label="морозится" /> : null}</div>
              <div className="small" style={{ marginTop: 4 }}>{n.kcal} ккал · Б {Math.round(n.p)} г на порцию{r.servings > 1 ? ` · партия ${r.servings} порц.` : ''}{pr?.rating ? ` · оценка ${pr.rating}/5` : ''}</div>
              <div style={{ marginTop: 6 }}><VerifyChip r={r} /></div>
            </a>
          );
        })}
      </div>
      {!list.length && <div className="card"><Empty title="Ничего не найдено" /></div>}
    </div>
  );
}

export function LibRecipePage({ id }: { id: string }) {
  const data = useApp();
  const r = LIBRARY.find((x) => x.id === id);
  const [servings, setServings] = useState(r?.servings ?? 1);
  if (!r) return <div className="page"><PageHead title="Рецепт" backTo="/library" /><div className="card"><Empty title="Рецепт не найден" /></div></div>;
  const pr = prefsOf(data)[r.id];
  const n = libNutrition(r);
  const k = servings / r.servings;
  const rep = reportFor(r.id);
  const v = verifyState(r);
  const st = r.storage;
  return (
    <div className="page">
      <PageHead title={r.title} sub={`${KIND_LABEL[r.kind]} · ${r.cuisine} · ${r.protein}${r.base ? ` · ${r.base}` : ''}`} backTo="/library" />
      <div className="grid2">
        <div>
          <div className="card tight">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <VerifyChip r={r} />
              {r.tags.map((t) => <span key={t} className="chip">{t}</span>)}
            </div>
            <p style={{ marginBottom: 4 }}><b>{n.kcal} ккал</b> · белки {n.p} г · жиры {n.f} г · углеводы {n.c} г — на порцию.</p>
            <p className="small muted mt0">Посчитано по ингредиентам каталога{n.complete ? '' : ' — не по всем: калорийность требует уточнения'}.</p>
            {v !== 'verified' && rep?.errors?.length ? <Note kind="warn">{rep.errors.join('; ')}</Note> : null}
            {rep?.warnings?.length ? <p className="small muted" style={{ marginBottom: 0 }}>Замечания проверки: {rep.warnings.join('; ')}.</p> : null}
          </div>
          <div className="card tight">
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h3 className="mt0" style={{ marginBottom: 0 }}>Ингредиенты</h3>
              <NumberStepper value={servings} onChange={(v) => setServings(v ?? r.servings)} min={1} max={12} label="Порций" unit="порц." />
            </div>
            <p className="small muted">Мясо и рыба — сырые, крупы — сухие, овощи — очищенные, консервы — без жидкости.</p>
            <ul className="ing-list" style={{ paddingLeft: 18 }}>
              {r.ingredients.map((i) => {
                const p = PRODUCTS[i.p];
                return <li key={i.p}><span className="grow">{ingrName(i.p)} — <b>{fmtAmt(i.p, i.q * k)}</b>{i.note ? <span className="muted"> ({i.note})</span> : null}{p?.av === 'unverified' ? <span className="chip warn" style={{ marginLeft: 4 }}>av.ru не подтверждено</span> : null}</span></li>;
              })}
            </ul>
          </div>
        </div>
        <div>
          <div className="card tight">
            <h3 className="mt0">Приготовление</h3>
            <p className="small mt0">Техника: {r.equipment.join(', ')}{r.utensils?.length ? `; посуда: ${r.utensils.join(', ')}` : ''}. Время: {r.time.active} мин активно, {r.time.total >= 240 ? 'настаивается ночь' : `${r.time.total} мин всего`}.</p>
            <ol style={{ paddingLeft: 20 }}>
              {r.steps.map((s, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {s.eq ? <span className="chip">{s.eq}{s.temp ? `, ${s.temp}` : ''}{s.min && s.min !== '—' ? `, ${s.min} мин` : ''}</span> : null} {s.t}
                </li>
              ))}
            </ol>
            <p className="small" style={{ marginBottom: 0 }}>
              <b>Хранение:</b> {st.fridge_days === 0 ? 'есть сразу' : `холодильник до ${st.fridge_days} сут.`}{st.freeze ? `, морозилка до ${st.freeze_months} мес.` : ', не замораживать'}.
              {st.thaw ? ` Разморозка: ${st.thaw.toLowerCase()}.` : ''}{st.reheat ? ` Разогрев: ${st.reheat[0].toLowerCase()}${st.reheat.slice(1)}.` : ''}{st.note ? ` ${st.note}.` : ''}
            </p>
          </div>
          <div className="card tight">
            <h3 className="mt0">Ваша оценка</h3>
            <div className="btn-row">
              <button className={`btn small${pr?.fav ? ' primary' : ''}`} onClick={() => W.setRecipePref(r.id, { fav: !pr?.fav }).then(() => toast(pr?.fav ? 'Убрано из избранного' : 'В избранном: планировщик будет предлагать чаще'))}>{pr?.fav ? <PiStarFill /> : <PiStar />} Избранное</button>
              {[1, 2, 3, 4, 5].map((x) => (
                <button key={x} className={`btn small${pr?.rating === x ? ' primary' : ''}`} aria-label={`Оценка ${x}`} onClick={() => W.setRecipePref(r.id, { rating: pr?.rating === x ? null : x })}>{x}</button>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className={`btn small ghost${pr?.hidden ? ' active' : ''}`} onClick={() => W.setRecipePref(r.id, { hidden: !pr?.hidden }).then(() => toast(pr?.hidden ? 'Снова предлагается' : 'Больше не предлагается в новых неделях'))}><PiProhibit /> {pr?.hidden ? 'Снова предлагать' : 'Больше не предлагать'}</button>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>Избранное и высокая оценка — блюдо предлагается чаще, но не чаще раза в 3–4 недели; оценка 1–2 и «больше не предлагать» — не предлагается. Уже утверждённые недели не меняются.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
