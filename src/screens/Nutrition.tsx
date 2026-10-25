import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { go, href, useRoute } from '../app/router';
import { addDays, fmtDayMonth, fmtLong, fmtShort, isISODate, isWeekend, type ISODate } from '../lib/dates';
import { PROFILE, STORAGE_GUIDE } from '../lib/seed';
import { planDay, planRange, statusOf, tasksForDate } from '../domain/tasks';
import { allRecipes, recipeById, resolveMeal, RECIPE_TYPE_LABELS } from '../domain/meals';
import { parseIngredientLine, scaleRecipe, stepChips } from '../domain/scale';
import { MEAL_LABELS, MEAL_SLOTS, type MealSlot, type Recipe, type RecipeType } from '../state/types';
import { CheckButton, Disclosure, Empty, Note, PageHead, Seg, toast } from '../ui/kit';
import { MealParts, NoPlanCard, RelaxCard } from './shared';
import { PiBookOpen, PiCaretLeft, PiCaretRight, PiCheck, PiMagnifyingGlass, PiSnowflake, PiThermometer, PiClock, PiTrash, PiPackage } from '../ui/icons';

const BOX_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'snack'];

export function NutritionScreen() {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const range = planRange(data);
  const q = route.query.get('d');
  const date: ISODate = isISODate(q) ? q! : range && today < range.from ? range.from : today;
  const p = planDay(data, date);
  const tasks = tasksForDate(data, date).filter((t) => t.kind === 'meal');
  const tomorrow = addDays(date, 1);
  const tp = planDay(data, tomorrow);
  const boxNeeded = !!tp?.meals && !tp.relax && !isWeekend(tomorrow) && !p?.relax;
  const setDate = (d: ISODate) => go('/nutrition', { d }, true);

  return (
    <div className="page">
      <PageHead title="Питание" sub={fmtLong(date)} right={
        <>
          <button className="icon-btn" onClick={() => setDate(addDays(date, -1))} aria-label="Предыдущий день"><PiCaretLeft /></button>
          {date !== today && <button className="btn small" onClick={() => setDate(today)}>Сегодня</button>}
          <button className="icon-btn" onClick={() => setDate(addDays(date, 1))} aria-label="Следующий день"><PiCaretRight /></button>
          <a className="btn small soft" href={href('/recipes')}><PiBookOpen /> Все рецепты</a>
        </>
      } />
      {range && today < range.from && date === range.from && !q && <Note kind="info">План питания начинается {fmtDayMonth(range.from)} — показан первый день.</Note>}
      <div className="cols" style={{ marginTop: 12 }}>
        <div className="stack">
          {p?.relax && <RelaxCard date={date} />}
          {!p && <NoPlanCard date={date} />}
          {p && !p.relax && isWeekend(date) && <Note kind="plain">{PROFILE.weekend_note}</Note>}
          {tasks.map((t) => {
            const parts = resolveMeal(data, t.slot!, t.dish!);
            const st = statusOf(data, t);
            return (
              <div className="card meal-card" key={t.id}>
                <div className="meal-head">
                  <CheckButton state={st === 'done' ? 'on' : st === 'skipped' ? 'skip' : 'off'} label={`${MEAL_LABELS[t.slot!]}: ${st === 'done' ? 'снять отметку' : 'съел'}`}
                    onClick={() => A.setTaskStatus(t, st === 'done' ? 'planned' : 'done')} />
                  <div className="grow">
                    <div style={{ fontWeight: 700, fontSize: 17 }}>{MEAL_LABELS[t.slot!]} <span className="time small">{t.time ?? 'по голоду'}</span></div>
                    {st === 'done' && <span className="status-tag done">съедено</span>}
                    {st === 'skipped' && <span className="status-tag">пропущено или заменено</span>}
                  </div>
                  {st !== 'skipped' && st !== 'done' && <button className="btn small ghost" onClick={() => A.setTaskStatus(t, 'skipped')}>Пропустил</button>}
                  {st === 'skipped' && <button className="btn small ghost" onClick={() => A.setTaskStatus(t, 'planned')}>Вернуть</button>}
                </div>
                <div className="meal-dish">{t.dish}</div>
                <MealParts parts={parts} date={date} />
                {t.slot === 'lunch' && !isWeekend(date) && <span className="hint">Контейнер на работу: горячее и гарнир — в один, свежие овощи — в отдельный.</span>}
              </div>
            );
          })}
          {p && !p.relax && (
            <p className="hint">«Съел» — отметка выполнения плана, а не подсчёт калорий. Пустая отметка не считается пропуском.</p>
          )}
        </div>
        <div className="stack sticky-col">
          {boxNeeded && (
            <div className="card">
              <div className="card-head"><h3>Контейнеры на завтра</h3><span className="chip accent"><PiPackage /> {fmtShort(tomorrow)}</span></div>
              <p className="muted small mt0">Подготовить сегодня вечером, взять завтра на работу.</p>
              <div className="list">
                {BOX_SLOTS.map((s) => {
                  const id = `box:${date}:${s}`;
                  const on = !!data.checks[id];
                  const dish = tp!.meals![s];
                  return (
                    <div className="li" key={s}>
                      <CheckButton small state={on ? 'on' : 'off'} label={`${MEAL_LABELS[s]} упакован`} onClick={() => A.setCheck(id, !on)} />
                      <div className="grow">
                        <div style={{ fontWeight: 600 }}>{MEAL_LABELS[s]} <span className="muted small">{data.settings.mealTimes[s]}</span></div>
                        <div className="small muted">{dish}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="card">
            <h3>Напитки и исключения</h3>
            <p className="small mt0">{PROFILE.drinks}</p>
            <p className="small muted">{PROFILE.exclusions} {PROFILE.kitchen}</p>
            <Disclosure summary="Справка о калорийности">
              <p className="small mt0">{PROFILE.kcal_note} Калории и БЖУ в приложении не ведутся; по блюдам цифры не выводятся, чтобы не создавать ложной точности.</p>
            </Disclosure>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ все рецепты

export function RecipesScreen() {
  const data = useApp();
  const [qText, setQ] = useState('');
  const [type, setType] = useState<RecipeType | 'all'>('all');
  const list = allRecipes(data);
  const filtered = list.filter((r) => (type === 'all' || r.type === type) && (!qText.trim() || r.title.toLowerCase().includes(qText.trim().toLowerCase()) || r.ingredients_text.toLowerCase().includes(qText.trim().toLowerCase())));
  const types = (['main', 'side', 'breakfast', 'snack', 'other'] as RecipeType[]).filter((t) => list.some((r) => r.type === t));
  return (
    <div className="page">
      <PageHead title="Рецепты" sub={`${list.length} рецептов: ${list.filter((r) => !r.user).length} из исходного набора${list.some((r) => r.user) ? `, ${list.filter((r) => r.user).length} добавлено вами` : ''}`} backTo="/nutrition" />
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="grow" style={{ position: 'relative', minWidth: 220 }}>
          <span className="sr-only">Поиск рецепта</span>
          <input className="input" type="search" placeholder="Поиск по названию или продукту" value={qText} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 40 }} />
          <PiMagnifyingGlass style={{ position: 'absolute', left: 12, top: 13, width: 20, height: 20, color: 'var(--ink-3)' }} />
        </label>
        <Seg value={type} onChange={setType} label="Тип" options={[{ value: 'all' as const, label: 'Все' }, ...types.map((t) => ({ value: t, label: RECIPE_TYPE_LABELS[t] }))]} />
      </div>
      {filtered.length === 0 && <Empty title="Ничего не найдено">Попробуйте другое слово.</Empty>}
      {types.filter((t) => type === 'all' || t === type).map((t) => {
        const rs = filtered.filter((r) => r.type === t);
        if (!rs.length) return null;
        return (
          <div key={t}>
            <h2 className="section-title">{RECIPE_TYPE_LABELS[t]}</h2>
            <div className="card tight">
              <div className="list">
                {rs.map((r) => (
                  <a key={r.id} className="li" href={href(`/recipe/${r.id}`)} style={{ padding: '10px 6px' }}>
                    <span className="grow">
                      <span style={{ display: 'block', fontWeight: 600 }}>{r.title}</span>
                      <span className="small muted">{r.yield_text}{r.steps.some((s) => /аэрогрил/i.test(s.text)) ? ', аэрогриль' : r.steps.some((s) => /гриль/i.test(s.text)) ? ', гриль' : ''}</span>
                    </span>
                    {r.user && <span className="chip">мой</span>}
                    <PiCaretRight />
                  </a>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ рецепт

function prepNote(r: Recipe): string {
  if (r.type === 'breakfast' || r.type === 'snack') return 'Подготовить сегодня, взять завтра: соберите вечером в контейнер и уберите в холодильник; хрустящее (гранолу, хлебцы) — отдельно.';
  if (r.type === 'side') return 'Подготовить сегодня, взять завтра: сварите партией в день готовки, быстро остудите и разложите по контейнерам вместе с основным блюдом.';
  return 'Подготовить сегодня, взять завтра: готовьте партией в день готовки, остудите, разложите по порциям; на работу — в отдельном контейнере от свежих овощей.';
}

export function RecipePage({ id }: { id: string }) {
  const data = useApp();
  const route = useRoute();
  const r = recipeById(data, id);
  const [servings, setServings] = useState<number>(r?.servings && r.servings <= 4 ? r.servings : 1);
  const usage = useMemo(() => {
    if (!r) return [] as { date: ISODate; slot: MealSlot }[];
    const out: { date: ISODate; slot: MealSlot }[] = [];
    for (const d of Object.values(data.planDays).sort((a, b) => (a.date < b.date ? -1 : 1))) {
      if (!d.meals) continue;
      for (const s of MEAL_SLOTS) if (resolveMeal(data, s, d.meals[s]).some((p) => p.recipe?.id === r.id && p.status === 'recipe')) out.push({ date: d.date, slot: s });
    }
    return out;
  }, [data, r]);
  if (!r) return <div className="page"><PageHead title="Рецепт не найден" backTo="/recipes" /></div>;
  const scaled = scaleRecipe(r, servings);
  const storage = STORAGE_GUIDE.filter((s) => r.storage_ids.includes(s.id));
  const anyChecked = r.steps.some((_, i) => data.checks[`recipe:${r.id}:${i}`]);
  return (
    <div className="page">
      <PageHead title={r.title} sub={`${r.type_label}. Выход: ${r.yield_text}`} backTo={route.query.get('d') ? '/nutrition' : '/recipes'} />
      <div className="cols">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Ингредиенты</h2>
              <Seg value={servings} onChange={setServings} label="Порции" options={[1, 2, 3, 4].map((n) => ({ value: n, label: `${n} порц.` }))} />
            </div>
            {!scaled.canScale && <Note kind="plain">{scaled.reason ?? 'Пересчёт недоступен.'} Показан исходный текст.</Note>}
            {scaled.canScale && servings !== r.servings && <p className="hint mt0">Пересчитано с {r.servings} на {servings}. Количества без цифр в источнике («лук», «чеснок») остаются по вкусу.</p>}
            <ul className="ing-list">
              {scaled.items.map((it, i) => (
                <li key={i}>
                  <span className={`ing-dot${it.textOnly ? ' text' : ''}`} />
                  <span className="grow">{it.text}{it.scaled && <span className="orig"> (в рецепте: {it.original})</span>}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Пошагово</h2>
              {anyChecked && <button className="btn small ghost" onClick={() => A.resetChecks(`recipe:${r.id}:`)}>Сбросить отметки</button>}
            </div>
            <ol className="steps-list">
              {r.steps.map((s, i) => {
                const cid = `recipe:${r.id}:${i}`;
                const on = !!data.checks[cid];
                const chips = stepChips(s.text);
                return (
                  <li key={i} className={`step-item${on ? ' on' : ''}`}>
                    <CheckButton small state={on ? 'on' : 'off'} label={`Шаг ${i + 1} ${on ? 'выполнен' : ''}`} onClick={() => A.setCheck(cid, !on)} />
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}><span className="step-no">{i + 1}</span><span className="step-text">{s.text}</span></div>
                      {(chips.temps.length > 0 || chips.times.length > 0) && (
                        <div className="chips" style={{ marginTop: 6 }}>
                          {chips.temps.map((t, k) => <span key={`t${k}`} className="chip amber"><PiThermometer /> {t}</span>)}
                          {chips.times.map((t, k) => <span key={`m${k}`} className="chip"><PiClock /> {t}</span>)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <Disclosure summary="Текст рецепта из источника">
              <p className="small mt0">{r.method_text}</p>
              <p className="hint">Ингредиенты: {r.ingredients_text}. Источник: {r.source}.</p>
            </Disclosure>
          </div>
        </div>
        <div className="stack sticky-col">
          <Note kind="ok" icon={<PiCheck />}>{prepNote(r)}</Note>
          <div className="card">
            <h3>Хранение</h3>
            <ul className="tech-list small">
              {storage.map((s) => <li key={s.id}>{s.text}</li>)}
              {(r.type === 'main' || r.type === 'side') && <li>Горячее и салат храните раздельно: салат не разогревают.</li>}
            </ul>
            {(r.type === 'main' || r.type === 'side') && <p className="hint"><PiSnowflake style={{ display: 'inline', verticalAlign: '-3px' }} /> Что не съедите за 3–4 дня — заморозьте порциями; размораживайте в холодильнике.</p>}
          </div>
          <div className="card">
            <h3>Где в меню</h3>
            {usage.length === 0 ? <p className="muted small mt0">В загруженном плане это блюдо напрямую не встречается{r.type === 'side' ? ' (гарниры входят в обеды и ужины)' : ''}.</p> : (
              <div className="chips">
                {usage.slice(0, 24).map((u) => <a key={u.date + u.slot} className="chip" href={href('/nutrition', { d: u.date })}>{fmtShort(u.date)} {MEAL_LABELS[u.slot].toLowerCase()}</a>)}
              </div>
            )}
          </div>
          {r.user && (
            <button className="btn danger" onClick={() => { if (confirm('Удалить этот рецепт? Связи с блюдами тоже удалятся.')) { A.deleteUserRecipe(r.id); go('/recipes'); } }}><PiTrash /> Удалить мой рецепт</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ «Нужно уточнить рецепт»

export function RecipeNeeded() {
  const data = useApp();
  const route = useRoute();
  const key = route.query.get('k') ?? '';
  const text = route.query.get('t') ?? '';
  const sim = recipeById(data, route.query.get('sim'));
  const [title, setTitle] = useState(text.replace(/^./, (c) => c.toUpperCase()));
  const [type, setType] = useState<RecipeType>('other');
  const [yieldText, setYield] = useState('1 порция');
  const [servings, setServings] = useState('1');
  const [ings, setIngs] = useState('');
  const [steps, setSteps] = useState('');
  const [linkTo, setLinkTo] = useState('');
  const save = async () => {
    const lines = ings.split('\n').map((s) => s.trim()).filter(Boolean);
    const stepLines = steps.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!title.trim() || !lines.length || !stepLines.length) { toast('Заполните название, ингредиенты и шаги'); return; }
    const n = Number(servings);
    const id = await A.saveUserRecipe({
      title: title.trim(), type, type_label: RECIPE_TYPE_LABELS[type] ?? 'Мой рецепт', yield_text: yieldText.trim() || `${n} порц.`,
      servings: Number.isInteger(n) && n > 0 ? n : null, scalable: Number.isInteger(n) && n > 0,
      ingredients_text: lines.join('; '), ingredients: lines.map(parseIngredientLine), method_text: stepLines.join('; '),
      steps: stepLines.map((t) => ({ text: t, temperature_c: null, minutes: null })), storage_ids: ['cool_fast', 'freeze'],
    }, key || null);
    toast('Рецепт сохранён');
    go(`/recipe/${id}`, undefined, true);
  };
  return (
    <div className="page narrow">
      <PageHead title="Нужно уточнить рецепт" sub={text} backTo="/nutrition" />
      <Note kind="warn">В исходных файлах нет точного рецепта для «{text}». Приложение не придумывает рецепт само — добавьте свой или свяжите блюдо с существующим рецептом.</Note>
      {sim && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Похожий рецепт для ориентира</h3>
          <div className="row between">
            <a className="btn soft" href={href(`/recipe/${sim.id}`)}><PiBookOpen /> {sim.title}</a>
            <button className="btn" onClick={() => { A.linkMealToRecipe(key, sim.id); toast('Блюдо связано с рецептом'); go('/nutrition'); }}>Это тот же рецепт</button>
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Связать с другим рецептом</h3>
        <div className="row nowrap">
          <select className="input grow" value={linkTo} onChange={(e) => setLinkTo(e.target.value)} aria-label="Рецепт">
            <option value="">Выберите рецепт…</option>
            {allRecipes(data).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
          <button className="btn" disabled={!linkTo} onClick={() => { A.linkMealToRecipe(key, linkTo); toast('Блюдо связано с рецептом'); go('/nutrition'); }}>Связать</button>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Добавить свой рецепт</h3>
        <label className="field"><span>Название</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row nowrap">
          <label className="field grow"><span>Тип</span>
            <select className="input" value={type} onChange={(e) => setType(e.target.value as RecipeType)}>
              {(['breakfast', 'snack', 'main', 'side', 'other'] as RecipeType[]).map((t) => <option key={t} value={t}>{RECIPE_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="field" style={{ width: 120 }}><span>Порций</span><input className="input" inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value)} /></label>
        </div>
        <label className="field"><span>Выход (как в источнике)</span><input className="input" value={yieldText} onChange={(e) => setYield(e.target.value)} /></label>
        <label className="field"><span>Ингредиенты — по одному в строке</span><textarea className="input" rows={5} value={ings} onChange={(e) => setIngs(e.target.value)} placeholder={'200 г творога\n1 банан\nкорица по вкусу'} /></label>
        <label className="field"><span>Шаги — по одному в строке</span><textarea className="input" rows={4} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'Смешать творог с бананом\nПосыпать корицей'} /></label>
        <p className="hint">Строки вида «200 г творога» будут пересчитываться по порциям; остальное останется текстом.</p>
        <button className="btn primary" onClick={save}>Сохранить рецепт</button>
      </div>
    </div>
  );
}
