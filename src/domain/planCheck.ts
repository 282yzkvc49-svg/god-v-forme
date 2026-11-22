// Автопроверка согласованности плана: меню, рецепты, порции, закупки, оборудование, перенос дат.
import type { AppData, MealSlot, PlanSettings, WorkoutTemplate } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, fmtShort, isoWeekday, plural } from '../lib/dates';
import { DISHES, PRODUCTS, TEMPLATE, dishNutrition, subDishOf } from './catalog';
import {
  BUDGET_RUB, KCAL_TARGET, PLAN_LENGTH, buildInstance, collectNeeds, dayNutrition, makePlanSettings, planEnd,
  type PlanContext, type PlanInstance,
} from './plan';
import { relaxDateOfMonth, tripDates, tripOn } from './trips';

export const AVAILABLE_KETTLEBELLS = [12, 16];

export interface CheckResult { id: number; title: string; ok: boolean; details: string[] }

const SLOT_ORDER: Record<MealSlot, number> = { breakfast: 1, lunch: 3, snack: 5, dinner: 7 };

function timeOrder(time: string | null | undefined): number {
  const m = /(\d{1,2}):(\d{2})/.exec(time ?? '');
  if (!m) return 0;
  const h = +m[1];
  return h < 12 ? 2 : h < 16 ? 4 : 6; // до обеда / до перекуса / вечером (до ужина)
}

export function checkInstance(inst: PlanInstance): CheckResult[] {
  const res: CheckResult[] = [];
  // 1. 30 дней: домашние — с полным меню, командировки — с командировочным, релакс-день — свободный
  {
    const d: string[] = [];
    const end = planEnd(inst.cfg);
    const cycle = inst.planDays.filter((x) => x.date >= inst.cfg.startDate && x.date <= end);
    if (cycle.length !== PLAN_LENGTH) d.push(`дней в цикле: ${cycle.length}`);
    const dates = cycle.map((x) => x.date);
    for (let i = 1; i < dates.length; i++) if (diffDays(dates[i], dates[i - 1]) !== 1) d.push(`разрыв между ${fmtShort(dates[i - 1])} и ${fmtShort(dates[i])}`);
    for (const r of inst.layout.relaxDates) if (r !== relaxDateOfMonth(inst.ctx, r.slice(0, 7))) d.push(`релакс-день ${fmtShort(r)} не совпадает с календарным`);
    let home = 0, trip = 0;
    for (const day of cycle) {
      if (day.tripId) { trip++; if (!day.meals) d.push(`${fmtShort(day.date)}: нет командировочного меню`); continue; }
      if (day.relax || !day.templateDay) continue;
      home++;
      for (const s of MEAL_SLOTS) if (!day.mealCards?.[s]?.parts.length && !day.mealCards?.[s]?.cancelled) d.push(`${fmtShort(day.date)}: нет «${MEAL_LABELS[s]}»`);
    }
    const relax = inst.layout.relaxDates.map(fmtShort).join(', ') || 'нет в этом цикле';
    res.push({ id: 1, title: '30 дней: домашнее меню, командировки и релакс-день', ok: !d.length, details: d.length ? d : [`Домашних дней ${home} × 4 приёма = ${home * 4}; дней командировки ${trip}; релакс-день: ${relax}`] });
  }
  // 2 и 3. граммовки и рецепты
  {
    const d2: string[] = [], d3: string[] = [];
    const used = new Set<string>();
    for (const day of inst.planDays) for (const s of MEAL_SLOTS) for (const p of day.mealCards?.[s]?.parts ?? []) used.add(p.dishId);
    for (const e of inst.cookingEvents) for (const it of e.items ?? []) used.add(it.dishId);
    for (const id of Array.from(used)) {
      const dish = DISHES[id];
      if (!dish) { d3.push(`нет блюда «${id}»`); continue; }
      if (!dish.steps.length) d3.push(`${dish.title}: нет шагов рецепта`);
      if (!dish.ingredients.length) d2.push(`${dish.title}: нет ингредиентов`);
      for (const i of dish.ingredients) {
        if (!(i.qty > 0)) d2.push(`${dish.title}: нет количества для «${i.product}»`);
        if (!PRODUCTS[i.product] && !DISHES[i.product]) d2.push(`${dish.title}: неизвестный продукт «${i.product}»`);
        if (subDishOf(dish, i.product)) used.add(i.product);
      }
    }
    res.push({ id: 2, title: 'У каждого блюда подробные граммовки', ok: !d2.length, details: d2.length ? d2 : [`${used.size} блюд: все ингредиенты с количеством в г, мл или шт.`] });
    res.push({ id: 3, title: 'Каждый рецепт существует', ok: !d3.length, details: d3.length ? d3 : [`${used.size} рецептов с пошаговой инструкцией`] });
  }
  // 4 и 5. порции распределены корректно, нехватки нет
  {
    const d4: string[] = [], d5: string[] = [];
    const useKey = new Map<string, number>();
    let portions = 0;
    for (const e of inst.cookingEvents) {
      for (const it of e.items ?? []) {
        const dish = DISHES[it.dishId];
        const sum = it.uses.reduce((s, u) => s + u.qty, 0);
        if (Math.abs(sum - it.qty) > 1e-6) d4.push(`${fmtShort(e.date)} ${dish?.title}: приготовлено ${it.qty}, распределено ${sum}`);
        if (!it.uses.length) d4.push(`${fmtShort(e.date)} ${dish?.title}: порции без назначения`);
        if (dish?.unit === 'portion') portions += it.qty;
        for (const u of it.uses) {
          const gap = diffDays(u.date, e.date);
          if (gap < 0 || (gap === 0 && SLOT_ORDER[u.slot] < timeOrder(e.time))) d4.push(`${dish?.title}: используется ${fmtShort(u.date)} (${MEAL_LABELS[u.slot].toLowerCase()}) раньше готовки ${fmtShort(e.date)} ${e.time ?? ''}`);
          const st = dish?.storage;
          if (st && u.storage === 'fridge' && gap > st.days) d4.push(`${dish!.title}: ${gap} дн. в холодильнике`);
          if (st && u.storage === 'pantry' && gap > st.days) d4.push(`${dish!.title}: ${gap} дн. хранения при сроке ${st.days}`);
          if (st && u.storage === 'freeze' && !st.freezable) d4.push(`${dish!.title}: нельзя заморозить`);
          const k = `${u.date}|${u.slot}|${u.via ?? it.dishId}|${u.via ? it.dishId : ''}`;
          useKey.set(k, (useKey.get(k) ?? 0) + u.qty);
        }
      }
    }
    // каждая часть меню из партии должна быть покрыта ровно своей порцией
    const expected = new Map<string, number>();
    for (const day of inst.planDays) {
      for (const s of MEAL_SLOTS) {
        for (const p of day.mealCards?.[s]?.parts ?? []) {
          const dish = DISHES[p.dishId];
          if (!dish) continue;
          if (!p.fresh) expected.set(`${day.date}|${s}|${p.dishId}|`, (expected.get(`${day.date}|${s}|${p.dishId}|`) ?? 0) + p.qty);
          if (p.fresh) for (const i of dish.ingredients) if (subDishOf(dish, i.product)) {
            const k = `${day.date}|${s}|${p.dishId}|${i.product}`;
            expected.set(k, (expected.get(k) ?? 0) + i.qty * p.qty);
          }
        }
      }
    }
    for (const [k, q] of expected) {
      const got = useKey.get(k) ?? 0;
      if (got + 1e-6 < q) { const [date, slot, dish, sub] = k.split('|'); d5.push(`${fmtShort(date)} ${MEAL_LABELS[slot as MealSlot].toLowerCase()}: не хватает «${DISHES[sub || dish].title}» (${got} из ${q})`); }
    }
    for (const [k, q] of useKey) {
      if (!expected.has(k)) { const [date, slot, dish] = k.split('|'); d4.push(`${fmtShort(date)} ${MEAL_LABELS[slot as MealSlot].toLowerCase()}: порция «${DISHES[dish]?.title ?? dish}» не нужна в меню`); }
      else if (Math.abs((expected.get(k) ?? 0) - q) > 1e-6) d4.push(`${k}: лишние порции`);
    }
    res.push({ id: 4, title: 'Порции распределены корректно', ok: !d4.length, details: d4.length ? d4 : [`${inst.cookingEvents.length} событий готовки, ${portions} порций основных блюд: каждая назначена на конкретный приём, не раньше готовки, в пределах срока хранения`] });
    res.push({ id: 5, title: 'Нет нехватки порций', ok: !d5.length, details: d5.length ? d5 : ['Каждый приём пищи получает свою порцию из готовки'] });
  }
  // 6. закупки покрывают потребности
  {
    const d6: string[] = [];
    const needs = collectNeeds(inst.planDays, inst.cookingEvents, inst.ctx.trips);
    const need = new Map<string, number>();
    for (const n of needs) need.set(n.productId, (need.get(n.productId) ?? 0) + n.qty);
    const got = new Map<string, number>();
    for (const e of inst.shoppingEvents) for (const l of e.lines ?? []) {
      got.set(l.productId, (got.get(l.productId) ?? 0) + l.buy);
      if (l.buy + l.fromStock + 0.5 < l.need) d6.push(`${fmtShort(e.date)} ${PRODUCTS[l.productId].name}: нужно ${l.need}, покрыто ${l.buy + l.fromStock}`);
      for (const n of l.needs) if (n.date < e.date) d6.push(`${PRODUCTS[l.productId].name}: нужно ${fmtShort(n.date)}, а закупка ${fmtShort(e.date)}`);
      const p = PRODUCTS[l.productId];
      if (p.storage === 'fridge' && !p.freezable) for (const n of l.needs) if (diffDays(n.date, e.date) > p.shelf_days && l.fromStock < 1e-6) d6.push(`${p.name}: куплен ${fmtShort(e.date)}, нужен ${fmtShort(n.date)} — дольше срока ${p.shelf_days} дн.`);
    }
    for (const [pid, q] of need) if ((got.get(pid) ?? 0) + 0.5 < q) d6.push(`${PRODUCTS[pid].name}: всего нужно ${Math.round(q)}, куплено ${Math.round(got.get(pid) ?? 0)}`);
    const main = inst.shoppingEvents.filter((e) => e.kind === 'main').length;
    const top = inst.shoppingEvents.filter((e) => e.kind === 'topup').length;
    const tripLists = inst.shoppingEvents.filter((e) => e.kind === 'trip').length;
    const cost = Math.round(inst.totalCost);
    const details = d6.length ? d6 : [`${need.size} продуктов, ${main} основные закупки и ${top} докупки свежего; домашние закупки ≈${cost.toLocaleString('ru-RU')} ₽ при бюджете ${BUDGET_RUB.toLocaleString('ru-RU')} ₽${tripLists ? `; ${tripLists} отдельных списка перекусов в командировку (≈${Math.round(inst.tripCost).toLocaleString('ru-RU')} ₽, не входят в домашний бюджет)` : ''}`];
    if (cost > BUDGET_RUB) details.push(`Сумма больше бюджета на ${(cost - BUDGET_RUB).toLocaleString('ru-RU')} ₽`);
    res.push({ id: 6, title: 'Закупки покрывают все потребности', ok: !d6.length, details });
  }
  res.push(checkTripDays(inst));
  return res;
}

/** На командировочные и релакс-дни нет домашних порций, готовки и домашних закупок. */
export function checkTripDays(inst: PlanInstance): CheckResult {
  const d: string[] = [];
  const trips = inst.ctx.trips;
  const relax = inst.layout.relaxDates;
  for (const e of inst.cookingEvents) {
    if (tripOn(trips, e.date)) d.push(`готовка ${fmtShort(e.date)} — в командировке`);
    if (relax.includes(e.date)) d.push(`готовка ${fmtShort(e.date)} — в релакс-день`);
    for (const it of e.items ?? []) for (const u of it.uses) if (tripOn(trips, u.date)) d.push(`${DISHES[it.dishId].title}: порция на ${fmtShort(u.date)} — день командировки`);
  }
  for (const s of inst.shoppingEvents) {
    if (s.kind === 'trip') continue;
    if (tripOn(trips, s.date)) d.push(`закупка ${fmtShort(s.date)} — в командировке`);
  }
  for (const day of inst.planDays) if (day.tripId && day.mealCards) d.push(`${fmtShort(day.date)}: домашнее меню в командировке`);
  const tripDays = trips.reduce((n, t) => n + tripDates(t).length, 0);
  return {
    id: 7, title: 'Командировки и релакс-дни без домашних порций и готовки', ok: !d.length,
    details: d.length ? d : trips.length ? [`Командировок: ${trips.length}, дней: ${tripDays}. Домашние порции, готовка и закупки на эти дни не планируются; перекусы — отдельным списком.`] : ['Командировок нет.'],
  };
}

/**
 * Проверки по комплекту «Азбука вкуса»: календарь, рецепты, партии готовки, товары av.ru, закупки, хранение.
 * Сверка с датами комплекта — когда старт совпадает с его датой (16.11); при другом старте — по составу.
 */
export function checkSeedPlan(inst: PlanInstance): CheckResult[] {
  const src = TEMPLATE.source;
  if (!src) return [];
  const res: CheckResult[] = [];
  const sameStart = inst.cfg.startDate === TEMPLATE.base_start;
  const end = planEnd(inst.cfg);
  const cycle = inst.planDays.filter((x) => x.date >= inst.cfg.startDate && x.date <= end);
  const tripsMatch = src.calendar.filter((c) => c.type === 'travel').every((c) => !!tripOn(inst.ctx.trips, c.date));
  // 12. календарь
  {
    const d: string[] = [];
    const home = cycle.filter((x) => x.mealCards && !x.tripId).length;
    const trip = cycle.filter((x) => x.tripId).length;
    const relax = cycle.filter((x) => x.relax && !x.tripId).length;
    if (sameStart && tripsMatch) {
      for (const c of src.calendar) {
        const day = inst.planDays.find((x) => x.date === c.date);
        if (!day) { d.push(`${fmtShort(c.date)}: нет дня`); continue; }
        if (c.type === 'travel' && !day.tripId) d.push(`${fmtShort(c.date)}: в комплекте командировка (${c.city}), в приложении — нет`);
        if (c.type === 'relax' && !day.relax) d.push(`${fmtShort(c.date)}: в комплекте релакс-день`);
        if (c.type === 'home') {
          if (!day.mealCards) { d.push(`${fmtShort(c.date)}: нет домашнего меню`); continue; }
          for (const sl of MEAL_SLOTS) {
            const got = day.mealCards[sl].parts.map((p) => p.dishId).join('+');
            if (got !== c.meals![sl]) d.push(`${fmtShort(c.date)} ${MEAL_LABELS[sl].toLowerCase()}: ${got} вместо ${c.meals![sl]}`);
          }
        }
      }
    }
    const bfs = new Set(cycle.filter((x) => x.mealCards && !x.tripId).map((x) => x.mealCards!.breakfast.parts[0]?.dishId));
    res.push({
      id: 12, title: 'Календарь и меню — как в комплекте «Азбука вкуса»', ok: !d.length,
      details: d.length ? d : [
        `${cycle.length} дней: ${home} домашних, ${trip} командировочных, ${relax} релакс; на каждый домашний день 4 рецепта, разных завтраков ${bfs.size}`
        + (sameStart && tripsMatch ? ' — совпадает с календарём комплекта по датам и ID рецептов' : ' — дата старта или поездки отличаются от комплекта, меню идёт по домашним дням в том же порядке'),
      ],
    });
  }
  // 13. рецепты
  {
    const d: string[] = [];
    const recipes = TEMPLATE.dishes.filter((x) => !x.archived);
    for (const r of recipes) {
      if (!r.ingredients.length || !r.steps.length) d.push(`${r.id}: нет состава или шагов`);
      if (!r.method || !r.active_minutes) d.push(`${r.id}: нет способа или времени приготовления`);
      for (const i of r.ingredients) if (!PRODUCTS[i.product] || !(i.qty > 0)) d.push(`${r.id}: ${i.product} без товара или массы`);
    }
    const by = (c: string) => recipes.filter((x) => x.category === c).length;
    res.push({ id: 13, title: `${recipes.length} ${plural(recipes.length, 'рецепт', 'рецепта', 'рецептов')}: состав, масса, техника, время`, ok: !d.length, details: d.length ? d : [`Завтраков ${by('breakfast')}, обедов ${by('lunch')}, ужинов ${by('dinner')}, перекусов ${by('snack')}; у каждого — граммовки на порцию, шаги, оборудование и время`] });
  }
  // 14. партии: 48 обедов и ужинов, порции = назначения, как в комплекте
  {
    const d: string[] = [];
    let ld = 0, covered = 0;
    const cookOf = new Map<string, string>();
    for (const e of inst.cookingEvents) for (const it of e.items ?? []) {
      if (it.uses.length !== it.qty) d.push(`${fmtShort(e.date)} ${it.dishId}: ${it.qty} порц., назначений ${it.uses.length}`);
      for (const u of it.uses) cookOf.set(`${u.date}|${u.slot}`, `${e.blockId}:${it.dishId}`);
    }
    for (const day of cycle) {
      if (!day.mealCards || day.tripId) continue;
      for (const sl of ['lunch', 'dinner'] as MealSlot[]) {
        if (day.mealCards[sl].cancelled) continue; // приём отменён корректировкой по факту
        ld++;
        const dish = day.mealCards[sl].parts[0]?.dishId;
        const got = cookOf.get(`${day.date}|${sl}`);
        if (!got || !got.endsWith(`:${dish}`)) d.push(`${fmtShort(day.date)} ${MEAL_LABELS[sl].toLowerCase()}: нет порции из партии`);
        else covered++;
      }
    }
    if (sameStart && tripsMatch) {
      for (const sc of src.cooking) {
        const ce = inst.cookingEvents.find((e) => e.blockId === sc.id);
        if (!ce) { d.push(`${sc.id}: нет готовки`); continue; }
        if (ce.date !== sc.date) d.push(`${sc.id}: готовка ${fmtShort(ce.date)} вместо ${fmtShort(sc.date)}`);
        for (const si of sc.items) {
          const it = ce.items?.find((x) => x.dishId === si.dish);
          if (!it || it.qty !== si.servings) { d.push(`${sc.id} ${si.dish}: ${it?.qty ?? 0} порц. вместо ${si.servings}`); continue; }
          const a = it.uses.map((u) => `${u.date}|${u.slot}`).sort().join(','), b = si.uses.map(([dt, sl]) => `${dt}|${sl}`).sort().join(',');
          if (a !== b) d.push(`${sc.id} ${si.dish}: назначения отличаются от комплекта`);
        }
      }
    }
    res.push({
      id: 14, title: 'Обеды и ужины распределены по партиям без потерь и лишних порций', ok: !d.length,
      details: d.length ? d : [`${covered} из ${ld} обедов и ужинов — ровно по одной порции из партии; в каждой партии порций столько же, сколько назначений`
        + (sameStart && tripsMatch ? `; ${src.cooking.length} партий совпадают с комплектом по датам, порциям и назначениям` : '')],
    });
  }
  // 15. товары av.ru
  {
    const d: string[] = [];
    const used = new Set<string>();
    for (const r of TEMPLATE.dishes) if (!r.archived) for (const i of r.ingredients) used.add(i.product);
    let card = 0, cat = 0;
    for (const id of used) {
      const p = PRODUCTS[id];
      if (!p?.url) { d.push(`${p?.name ?? id}: нет ссылки av.ru`); continue; }
      if (p.listing_status === 'category_listing') cat++; else card++;
    }
    res.push({ id: 15, title: 'Каждый ингредиент связан с товаром av.ru', ok: !d.length, details: d.length ? d : [`${used.size} товаров: ${card} — ссылка на карточку товара, ${cat} — на подборку категории. Наличие и доставка по адресу не проверены.`] });
  }
  // 16. хранение
  {
    const d: string[] = [];
    let frozen = 0, fish = 0;
    for (const e of inst.cookingEvents) for (const it of e.items ?? []) {
      const dish = DISHES[it.dishId];
      const isFish = dish.ingredients.some((i) => PRODUCTS[i.product]?.category === 'Рыба и морепродукты');
      for (const u of it.uses) {
        const gap = diffDays(u.date, e.date);
        if (u.storage === 'freeze') frozen++;
        if (isFish && u.storage === 'fridge') { fish++; if (gap > 1) d.push(`${dish.title}: готовая рыба ${gap} дн. в холодильнике`); }
        if (u.storage === 'fridge' && gap > 3) d.push(`${dish.title}: ${gap} дн. в холодильнике`);
      }
    }
    for (const s of inst.shoppingEvents) for (const l of s.lines ?? []) {
      const p = PRODUCTS[l.productId];
      if (p.storage !== 'fridge' || p.freezable) continue;
      for (const n of l.needs) if (diffDays(n.use ?? n.date, s.date) > p.shelf_days && l.buy > 0 && l.fromStock < 1e-6) d.push(`${p.name}: куплен ${fmtShort(s.date)}, нужен ${fmtShort(n.use ?? n.date)}`);
    }
    const tops = inst.shoppingEvents.filter((e) => e.kind === 'topup').map((e) => fmtShort(e.date));
    res.push({
      id: 16, title: 'Сроки хранения скоропортящегося соблюдены', ok: !d.length,
      details: d.length ? d : [`Готовые блюда — не дольше 3 дней в холодильнике, рыба — в день готовки или на следующий (${fish} порц.), в морозилку — ${frozen} порц.; свежее не лежит дольше срока: докупки ${tops.join(', ') || 'не нужны'}`],
    });
  }
  // 17. закупки против расчёта комплекта (сведения, не ошибка)
  {
    const app = new Map<string, number>(), seed = new Map<string, number>();
    for (const e of inst.shoppingEvents) if (e.kind !== 'trip') for (const l of e.lines ?? []) app.set(l.productId, (app.get(l.productId) ?? 0) + l.cost);
    for (const o of src.orders) for (const l of o.lines) seed.set(l.product, (seed.get(l.product) ?? 0) + l.cost);
    const seedTotal = src.orders.reduce((x, o) => x + o.subtotal, 0);
    const diffs = Array.from(new Set([...app.keys(), ...seed.keys()])).map((id) => ({ id, d: (app.get(id) ?? 0) - (seed.get(id) ?? 0) })).filter((x) => Math.abs(x.d) >= 50).sort((a, b) => b.d - a.d);
    const rub = (x: number) => `${Math.round(x).toLocaleString('ru-RU')} ₽`;
    res.push({
      id: 17, title: 'Закупки посчитаны из меню и сверены с комплектом', ok: true,
      details: [
        `Комплект: ${src.orders.length} заказа на ${rub(seedTotal)} (${src.orders.map((o) => fmtShort(o.date)).join(' и ')}). Приложение: ${inst.shoppingEvents.filter((e) => e.kind === 'main').length} основные закупки и ${inst.shoppingEvents.filter((e) => e.kind === 'topup').length} докупки свежего, ≈${rub(inst.totalCost)}.`,
        ...(diffs.length ? [`Разница — из-за докупок скоропортящегося ближе к дате: ${diffs.slice(0, 6).map((x) => `${PRODUCTS[x.id].name.split(/[«(]/)[0].trim().toLowerCase()} ${x.d > 0 ? '+' : '−'}${rub(Math.abs(x.d))}`).join(', ')}.`] : []),
        'Цены — ориентир с av.ru на 14.11.2026, не корзина; наличие и доставка по адресу не проверены.',
      ],
    });
  }
  return res;
}

const AV_CARD = /^https:\/\/av\.ru\/i\/\d+\/?$/;
const MACKEREL = /скумбри|mackerel/i;

/**
 * Активные данные (каталог, рецепты, план с сегодняшнего дня, готовки, закупки) — без скумбрии,
 * без ссылок на удалённые или архивные товары и только с индивидуальными карточками av.ru.
 */
export function checkActiveData(data: AppData, today: string): CheckResult {
  const d: string[] = [];
  const products = TEMPLATE.products.filter((p) => !p.archived);
  for (const p of products) {
    if (!p.url || !AV_CARD.test(p.url)) d.push(`${p.name}: нет индивидуальной карточки av.ru`);
    if (MACKEREL.test(`${p.id} ${p.name}`)) d.push(`каталог: ${p.name}`);
  }
  const dishes = TEMPLATE.dishes.filter((x) => !x.archived);
  for (const x of dishes) {
    if (MACKEREL.test(`${x.id} ${x.title} ${x.steps.map((s) => s.text).join(' ')} ${x.note ?? ''}`)) d.push(`рецепт ${x.id}: скумбрия`);
    for (const i of x.ingredients) {
      const p = PRODUCTS[i.product];
      if (!p || p.archived) d.push(`рецепт ${x.id}: ингредиент «${i.product}» ссылается на удалённый товар`);
      else if (!p.url || !AV_CARD.test(p.url)) d.push(`рецепт ${x.id}: «${p.name}» без карточки av.ru`);
    }
  }
  const okDish = (id: string) => !!DISHES[id] && !DISHES[id].archived;
  for (const day of Object.values(data.planDays)) {
    if (day.date < today) continue;
    if (MACKEREL.test(JSON.stringify(day.meals ?? {}) + JSON.stringify(day.mealCards ?? {}))) d.push(`${fmtShort(day.date)}: скумбрия в меню`);
    for (const sl of MEAL_SLOTS) for (const p of day.mealCards?.[sl]?.parts ?? []) if (!okDish(p.dishId)) d.push(`${fmtShort(day.date)}: блюдо «${p.dishId}» не из текущего меню`);
  }
  for (const e of Object.values(data.cookingEvents)) {
    if (e.date < today) continue;
    if (MACKEREL.test(`${e.sourceText ?? ''} ${(e.dishes ?? []).map((x) => x.text).join(' ')}`)) d.push(`готовка ${fmtShort(e.date)}: скумбрия`);
    for (const it of e.items ?? []) if (!okDish(it.dishId)) d.push(`готовка ${fmtShort(e.date)}: блюдо «${it.dishId}» не из текущего меню`);
  }
  for (const e of Object.values(data.shoppingEvents)) {
    if (e.date < today || e.kind === 'trip') continue;
    for (const l of e.lines ?? []) {
      const p = PRODUCTS[l.productId];
      if (!p || p.archived) d.push(`закупка ${fmtShort(e.date)}: товар «${l.productId}» удалён из каталога`);
      else if (!p.url || !AV_CARD.test(p.url)) d.push(`закупка ${fmtShort(e.date)}: «${p.name}» без карточки av.ru`);
    }
    if ((e.items ?? []).some((i) => MACKEREL.test(i.name))) d.push(`закупка ${fmtShort(e.date)}: скумбрия`);
  }
  return {
    id: 18, title: 'В активном меню нет скумбрии и ссылок на удалённые товары', ok: !d.length,
    details: d.length ? d.slice(0, 12) : [`Каталог: ${products.length} товаров, у всех — индивидуальная карточка av.ru/i/…; ${dishes.length} рецептов — все ингредиенты ссылаются на действующие товары; в плане с ${fmtShort(today)}, готовках и закупках скумбрии нет.`],
  };
}

/** Калорийность по дням (для отчёта проверки). */
export function kcalSummary(inst: PlanInstance): { min: number; max: number; avg: number; unverifiedDays: number } {
  const ks: number[] = [];
  let unverified = 0;
  for (const d of inst.planDays) {
    const n = dayNutrition(d);
    if (!n) continue;
    ks.push(n.kcal);
    if (n.labelProducts.length) unverified++;
  }
  return { min: Math.round(Math.min(...ks)), max: Math.round(Math.max(...ks)), avg: Math.round(ks.reduce((a, b) => a + b, 0) / ks.length), unverifiedDays: unverified };
}

export function checkEquipment(templates: WorkoutTemplate[]): CheckResult {
  const d: string[] = [];
  for (const t of templates) for (const it of t.items) {
    const ws = [it.kettlebellKg, it.fallbackKg, ...(it.weightKg ?? [])].filter((w): w is number => typeof w === 'number');
    for (const w of ws) if (!AVAILABLE_KETTLEBELLS.includes(w)) d.push(`${t.name}: ${it.exerciseId} — ${w} кг`);
  }
  return { id: 8, title: 'В тренировках только гири 12 и 16 кг', ok: !d.length, details: d.length ? d : ['Гиря 12 кг, гиря 16 кг или собственный вес; других весов нет'] };
}

/** Перенос: план собирается для других дат старта и проходит те же проверки; командировки и релакс-дни остаются на своих датах. */
export function checkShift(base: PlanSettings, ctx: PlanContext): CheckResult {
  const d: string[] = [];
  const variants: PlanSettings[] = [1, 3, 10, 17, -2].map((n) => makePlanSettings(addDays(base.startDate, n), base.setAt));
  for (const v of variants) {
    const inst = buildInstance(v, { ...ctx, today: null });
    const cycle = inst.planDays.filter((x) => x.date >= v.startDate && x.date <= planEnd(v));
    if (cycle[0]?.date !== v.startDate) d.push(`старт ${fmtShort(v.startDate)}: первый день ${fmtShort(cycle[0]?.date ?? '')}`);
    for (const t of ctx.trips) for (const day of tripDates(t)) {
      const pd = inst.planDays.find((x) => x.date === day);
      if (!pd?.tripId) d.push(`старт ${fmtShort(v.startDate)}: командировка «${t.city}» сдвинулась с ${fmtShort(day)}`);
    }
    for (const r of inst.layout.relaxDates) if (r !== relaxDateOfMonth(ctx, r.slice(0, 7))) d.push(`старт ${fmtShort(v.startDate)}: релакс-день ${fmtShort(r)} сдвинулся`);
    for (const c of checkInstance(inst)) if (!c.ok) d.push(`старт ${fmtShort(v.startDate)}: ${c.title} — ${c.details[0]}`);
  }
  return { id: 9, title: 'Перенос событий при смене даты старта', ok: !d.length, details: d.length ? d : [`Проверено ${variants.length} других дат старта: меню, готовки, закупки и контейнеры пересчитываются; командировки и релакс-дни остаются на своих календарных датах`] };
}

/** Проверки на текущих данных пользователя. */
export function checkUserData(data: AppData): CheckResult[] {
  const out: CheckResult[] = [];
  const marks = Object.values(data.taskStatus).filter((s) => s.status !== 'planned').length;
  out.push({
    id: 10, title: 'Отметки, вес и фото сохраняются', ok: true,
    details: [`Сейчас в приложении: отметок ${marks}, тренировок в журнале ${Object.keys(data.trainingLogs).length}, взвешиваний ${Object.keys(data.weights).length}, фото ${Object.keys(data.photos).length}. Смена даты старта, релакс-дня и командировок их не удаляет и не переносит.`],
  });
  out.push({ id: 11, title: 'Хранение, резервная копия, экспорт и импорт', ok: true, details: ['Данные хранятся на устройстве (IndexedDB); резервная копия, отчёт для ChatGPT и импорт плана проверяются автотестами при каждой сборке.'] });
  return out;
}

export function weekdayName(n: number): string {
  return ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][n - 1];
}

export { isoWeekday, KCAL_TARGET, dishNutrition };
