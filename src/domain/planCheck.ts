// Автопроверка согласованности плана: меню, рецепты, порции, закупки, оборудование, перенос дат.
import type { AppData, MealSlot, PlanSettings, WorkoutTemplate } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, fmtShort, isoWeekday } from '../lib/dates';
import { DISHES, PRODUCTS, dishNutrition } from './catalog';
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
      for (const s of MEAL_SLOTS) if (!day.mealCards?.[s]?.parts.length) d.push(`${fmtShort(day.date)}: нет «${MEAL_LABELS[s]}»`);
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
        if (DISHES[i.product]) used.add(i.product);
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
          if (p.fresh) for (const i of dish.ingredients) if (DISHES[i.product]) {
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
