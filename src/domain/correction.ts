// Корректировка по факту (22.11.2026): фактические покупки по фото чеков, что съедено и приготовлено,
// новые блюда из уже купленного на 22–24.11, пересчёт меню, порций, готовок и закупок до 15.12.
// Сначала — проверка запасов (оценка «требует подтверждения», пользователь может поправить),
// затем предпросмотр, и только по подтверждению — резервная копия и изменения.
import type { Op } from '../state/idb';
import type { AppData, BackupRec, CookingEvent, CorrectionReport, MealSlot, PlanOverrides, PlanSettings, ShoppingEvent, SlotOverride, StockMove, StockPlace, StockRec } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { applyOps, dataToStores } from '../state/model';
import { addDays, diffDays, fmtShort, type ISODate } from '../lib/dates';
import { DISHES, PRODUCTS, dishProducts, fmtAmount } from './catalog';
import { BUDGET_RUB, buyText, gross, replanOps } from './plan';
import { consumeOps, cookProducts, emptyStock, mealProducts, mealStockOps, stockLots, stockSummary } from './stock';

export const CORR_ID = 'fact-2026-11-22';
export const CORR_SINCE: ISODate = '2026-11-22';
export const CORR_LAST_DAY: ISODate = '2026-11-24';
const DONE_COOKS_BEFORE: ISODate = '2026-11-21';

/** Подтверждено фото чеков первой закупки (15.11). */
export const CONFIRMED_PURCHASES: { productId: string; qty: number; note: string | null }[] = [
  { productId: 'chicken', qty: 878, note: 'Филе «Петелинка»' },
  { productId: 'turkey', qty: 894, note: 'Филе индейки' },
  { productId: 'rice', qty: 500, note: 'Рис басмати' },
  { productId: 'buckwheat', qty: 900, note: null },
  { productId: 'bulgur', qty: 500, note: null },
  { productId: 'oats', qty: 500, note: 'Хлопья овсяные Quaker' },
  { productId: 'pepper', qty: 374, note: 'Красный перец' },
  { productId: 'carrot', qty: 1846, note: null },
  { productId: 'onion', qty: 524, note: null },
  { productId: 'broccoli', qty: 800, note: 'Замороженная' },
  { productId: 'yogurt', qty: 1750, note: 'TEOS 2%, 7 × 250 г' },
  { productId: 'curd', qty: 1180, note: '«Рузское молоко» 5%, 5 × 200 г, и «Савушкин хуторок» 180 г' },
  { productId: 'almonds', qty: 120, note: null },
  { productId: 'walnuts', qty: 200, note: null },
  { productId: 'tomato', qty: 500, note: null },
  { productId: 'tomatopuree', qty: 400, note: 'Томаты Mutti' },
  { productId: 'beans', qty: 400, note: 'Красная фасоль Casa Rinaldi' },
  { productId: 'chickpeas', qty: 400, note: 'Нут Casa Rinaldi' },
];
/** Куплены, но количество на фото не подтверждено — по плану первой закупки, требуют подтверждения. */
export const ESTIMATED_CATEGORIES = ['Фрукты'];
export const ESTIMATED_EXTRA = ['strawberry'];
/** Не подтверждены чеками: учитываются, только если пользователь укажет количество. */
export const ASK_AT_HOME = ['pollock', 'egg', 'potato', 'oliveoil'];
/** В первой закупке не куплены. */
export const NOT_BOUGHT = ['beef_mince', 'turkey_mince', 'trout'];
/** Сырое мясо и рыба хранятся в морозилке. */
const FROZEN_RAW = ['chicken', 'turkey', 'beef_mince', 'turkey_mince', 'trout', 'pollock'];
/** Не мешают выбору блюда: соль и специи, масло — если есть дома. */
const OPTIONAL = new Set(['salt', 'paprika', 'cinnamon', 'curry', 'oliveoil', 'garlic']);

export const COOK_TURKEY = 'x2211';
export const COOK_CHICKEN = 'x2311';

export interface CorrectionInput {
  /** Срок годности с упаковки. */
  expiry: Record<string, ISODate | null>;
  /** Испорчено — списать остаток. */
  spoiled: string[];
  /** Остаток вручную (подтверждён пользователем). */
  remaining: Record<string, number>;
  /** Фактически потрачено на первую закупку, ₽ (если известно). */
  spent: number | null;
}

export const emptyInput = (): CorrectionInput => ({ expiry: {}, spoiled: [], remaining: {}, spent: null });

const short = (pid: string) => (PRODUCTS[pid]?.name ?? pid).split(/[,«(]/)[0].trim();
const mid = (now: string, n: number) => `mv-${now.replace(/[^0-9]/g, '').slice(0, 14)}-c${n}`;
const status = (data: AppData, id: string) => data.taskStatus[id]?.status ?? null;
const mark = (taskId: string, date: ISODate, kind: string, st: 'done' | 'skipped', now: string): Op => ({ store: 'taskStatus', put: { taskId, date, kind, status: st, updatedAt: now } });

/** Текущий план и его первая основная закупка. */
function planParts(data: AppData) {
  const inst = data.settings.plan?.instanceId ?? '';
  return {
    m1: data.shoppingEvents[`shop-${inst}-m1`] as ShoppingEvent | undefined,
    cookId: (x: string) => `cook-${inst}-${x}`,
    inst,
  };
}

/** Запасы на 22.11 по фото чеков и оценке расхода с 15.11 (что приготовлено и съедено по плану). */
export function initialStock(data: AppData, now: string, input: CorrectionInput, today: ISODate = CORR_SINCE): { stock: Record<string, StockRec>; estimatedFrom: string[] } {
  const { m1, inst } = planParts(data);
  const recs: Record<string, StockRec> = {};
  let n = 0;
  const add = (pid: string, qty: number, confirmed: boolean, note: string | null, place?: StockPlace) => {
    if (!PRODUCTS[pid] || !(qty > 0)) return;
    const rec = recs[pid] ?? emptyStock(pid, now, place ?? (FROZEN_RAW.includes(pid) ? 'freezer' : undefined));
    rec.moves = [...rec.moves, { id: mid(now, ++n), date: '2026-11-15', kind: 'purchase', qty, source: confirmed ? 'receipt-photo' : 'estimate:plan-m1', note, confirmed, at: now }];
    recs[pid] = rec;
  };
  for (const c of CONFIRMED_PURCHASES) add(c.productId, c.qty, true, c.note);
  const estimatedFrom: string[] = [];
  for (const l of m1?.lines ?? []) {
    const p = PRODUCTS[l.productId];
    if (!p || recs[l.productId] || !(l.buy > 0)) continue;
    if (ESTIMATED_CATEGORIES.includes(p.category) || ESTIMATED_EXTRA.includes(l.productId)) {
      add(l.productId, l.buy, false, 'Куплено, количество на фото не видно — по плану первой закупки');
      estimatedFrom.push(l.productId);
    }
  }
  for (const pid of [...ASK_AT_HOME, ...NOT_BOUGHT]) if (!recs[pid]) recs[pid] = emptyStock(pid, now, FROZEN_RAW.includes(pid) ? 'freezer' : undefined);
  // расход до 22.11 — оценка: готовка 15.11 и свежие блюда съеденных приёмов пищи (21.11 — только завтрак)
  let d: AppData = { ...data, stock: recs, settings: { ...data.settings, inventory: { since: '2026-11-15', createdAt: now } } };
  const est = (source: string, items: Map<string, number>, date: ISODate, note: string) => {
    const r = consumeOps(d, source, items, date, now, note);
    d = applyOps(d, r.ops.map((o) => ('put' in o ? { ...o, put: { ...o.put, moves: o.put.moves.map((m: StockMove) => (m.source === source ? { ...m, confirmed: false } : m)) } } : o)));
  };
  for (const e of Object.values(data.cookingEvents).sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.instanceId !== inst || e.date >= DONE_COOKS_BEFORE || status(data, `cook:${e.id}`) === 'skipped') continue;
    est(`estimate:cook:${e.id}`, cookProducts(e), e.date, `Готовка ${fmtShort(e.date)} (выполнена) — оценка по рецептам`);
  }
  for (const day of Object.values(data.planDays).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!day.mealCards || day.instanceId !== inst || day.date >= CORR_SINCE) continue;
    for (const s of MEAL_SLOTS) {
      const st = status(data, `meal:${day.date}:${s}`);
      const eaten = day.date === '2026-11-21' ? s === 'breakfast' && st !== 'skipped' : st !== 'skipped';
      if (!eaten) continue;
      est(`estimate:meal:${day.date}:${s}`, mealProducts(data, day.date, s), day.date, `${MEAL_LABELS[s]} ${fmtShort(day.date)} — оценка по рецепту`);
    }
  }
  // с 22.11 — уже отмеченное «съедено» списывается по факту
  for (let date = CORR_SINCE; date <= today; date = addDays(date, 1)) {
    for (const s of MEAL_SLOTS) if (status(data, `meal:${date}:${s}`) === 'done') d = applyOps(d, mealStockOps(d, date, s, 'done', now));
  }
  const out = d.stock;
  // поправки пользователя на шаге проверки
  for (const [pid, date] of Object.entries(input.expiry)) if (out[pid]) out[pid] = { ...out[pid], expiresOn: date || null };
  for (const [pid, qty] of Object.entries(input.remaining)) {
    if (!PRODUCTS[pid] || !(qty >= 0)) continue;
    const rec = out[pid] ?? emptyStock(pid, now, FROZEN_RAW.includes(pid) ? 'freezer' : undefined);
    const have = stockLots(rec).reduce((s, l) => s + l.qty, 0);
    const delta = Math.round((qty - have) * 10) / 10;
    out[pid] = {
      ...rec, confirmedAt: now, updatedAt: now,
      moves: Math.abs(delta) > 0.05 ? [...rec.moves, { id: mid(now, ++n), date: CORR_SINCE, kind: 'adjust', qty: delta, source: 'manual', note: 'Остаток проверен вручную', confirmed: true, at: now }] : rec.moves,
    };
  }
  for (const pid of input.spoiled) {
    const rec = out[pid];
    if (!rec) continue;
    const have = stockLots(rec).reduce((s, l) => s + l.qty, 0);
    if (have > 0.05) out[pid] = { ...rec, confirmedAt: now, updatedAt: now, moves: [...rec.moves, { id: mid(now, ++n), date: CORR_SINCE, kind: 'writeoff', qty: Math.round(have * 10) / 10, source: 'manual', note: 'Испорчено — списано', confirmed: true, at: now }] };
  }
  return { stock: out, estimatedFrom };
}

// ------------------------------------------------------------------ подбор завтраков и перекусов из запасов

type SimLot = { qty: number; until: ISODate };

function simStock(stock: Record<string, StockRec>): Map<string, SimLot[]> {
  return new Map(Object.values(stock).map((r) => [r.productId, stockLots(r).map((l) => ({ qty: l.qty, until: l.until }))]));
}

function canTake(sim: Map<string, SimLot[]>, items: Map<string, number>, date: ISODate): boolean {
  for (const [pid, q] of items) {
    if (OPTIONAL.has(pid)) continue;
    const have = (sim.get(pid) ?? []).filter((l) => l.until >= date).reduce((s, l) => s + l.qty, 0);
    if (have + 0.5 < q) return false;
  }
  return true;
}

function take(sim: Map<string, SimLot[]>, items: Map<string, number>, date: ISODate) {
  for (const [pid, q0] of items) {
    let q = q0;
    for (const l of (sim.get(pid) ?? []).filter((x) => x.until >= date).sort((a, b) => a.until.localeCompare(b.until))) {
      const t = Math.min(l.qty, q); l.qty -= t; q -= t;
      if (q <= 0.01) break;
    }
  }
}

function dishItems(dishId: string, qty = 1): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of dishProducts(dishId, qty, false)) if (PRODUCTS[k]) out.set(k, gross(k, v));
  return out;
}

/** Чем раньше заканчивается срок продуктов блюда, тем выше оценка; повтор блюда — штраф. */
function score(sim: Map<string, SimLot[]>, dishId: string, date: ISODate, used: Set<string>, original: string): number {
  let s = dishId === original ? 3 : 0;
  for (const [pid, q] of dishItems(dishId)) {
    if (OPTIONAL.has(pid)) continue;
    const lots = (sim.get(pid) ?? []).filter((l) => l.until >= date && l.qty > 0.5);
    if (!lots.length) continue;
    const days = Math.max(1, diffDays(lots.map((l) => l.until).sort()[0], date) + 1);
    s += Math.min(q, 200) / 50 / days;
  }
  if (used.has(dishId)) s -= 10;
  return s;
}

const BREAKFASTS = () => Object.values(DISHES).filter((d) => d.category === 'breakfast' && !d.archived && !d.extra).map((d) => d.id);
const SNACKS = () => Object.values(DISHES).filter((d) => d.category === 'snack' && !d.archived && !d.extra).map((d) => d.id);

export interface Pick { date: ISODate; slot: MealSlot; original: string; dishId: string; feasible: boolean }

/**
 * Завтраки и перекусы 23–24.11 — из оставшихся фруктов, творога, йогурта и овсянки: сначала то, у чего раньше
 * заканчивается срок; если исходное блюдо можно собрать из запасов — оно остаётся.
 */
export function pickFromStock(data: AppData, stock: Record<string, StockRec>): Pick[] {
  const sim = simStock(stock);
  const cards = (date: ISODate) => data.planDays[date]?.mealCards;
  // сначала — то, что уже решено: новые партии и завтрак с перекусом 22.11 из меню
  take(sim, dishItems('X01', 3), '2026-11-22');
  take(sim, dishItems('X02', 2), '2026-11-23');
  for (const s of ['breakfast', 'snack'] as MealSlot[]) {
    const c = cards('2026-11-22')?.[s];
    if (c) for (const p of c.parts) if (p.fresh) take(sim, dishItems(p.dishId, p.qty), '2026-11-22');
  }
  const used = new Set<string>();
  for (const date of ['2026-11-21', '2026-11-22']) for (const s of ['breakfast', 'snack'] as MealSlot[]) { const id = cards(date)?.[s]?.parts[0]?.dishId; if (id) used.add(id); }
  const out: Pick[] = [];
  for (const date of ['2026-11-23', '2026-11-24']) {
    for (const slot of ['breakfast', 'snack'] as MealSlot[]) {
      const original = cards(date)?.[slot]?.parts[0]?.dishId ?? '';
      const pool = slot === 'breakfast' ? BREAKFASTS() : SNACKS();
      const feasible = pool.filter((id) => canTake(sim, dishItems(id), date));
      const best = feasible.sort((a, b) => score(sim, b, date, used, original) - score(sim, a, date, used, original))[0];
      const dishId = best ?? original;
      if (best) take(sim, dishItems(best), date);
      used.add(dishId);
      out.push({ date, slot, original, dishId, feasible: !!best });
    }
  }
  return out;
}

// ------------------------------------------------------------------ корректировка целиком

export interface Correction {
  ops: Op[];
  after: AppData;
  report: CorrectionReport;
  stock: Record<string, StockRec>;
  picks: Pick[];
}

const SLOT_TEXT = (d: AppData, date: ISODate, slot: MealSlot): string => d.planDays[date]?.mealCards?.[slot]?.title ?? d.planDays[date]?.meals?.[slot] ?? '—';

export function correctionApplied(data: AppData): boolean {
  return !!data.settings.corrections?.[CORR_ID];
}

/** Корректировка нужна: план со стартом 16.11, ещё не применена и дни 22–24.11 впереди. */
export function correctionPending(data: AppData, today: ISODate): boolean {
  const cfg = data.settings.plan;
  return !!cfg && cfg.startDate === '2026-11-16' && !correctionApplied(data) && today >= '2026-11-21' && today <= CORR_LAST_DAY;
}

export function buildCorrection(data: AppData, today: ISODate, now: string, input: CorrectionInput, appVersion = 'test'): Correction {
  const cfg0 = data.settings.plan as PlanSettings;
  const { cookId } = planParts(data);
  const conflicts: string[] = [];
  const marks: string[] = [];
  const ops: Op[] = [];
  // 1. отметки по факту — только там, где ещё ничего не отмечено
  const setMark = (taskId: string, date: ISODate, kind: string, st: 'done' | 'skipped', text: string) => {
    const cur = status(data, taskId);
    if (cur === st) return;
    if (cur && cur !== 'planned') { conflicts.push(`${text}: уже отмечено «${cur === 'done' ? 'выполнено' : 'пропущено'}» — не меняется`); return; }
    ops.push(mark(taskId, date, kind, st, now));
    marks.push(text);
  };
  for (const e of Object.values(data.cookingEvents)) if (e.instanceId === cfg0.instanceId && e.date < DONE_COOKS_BEFORE && e.source === 'seed') setMark(`cook:${e.id}`, e.date, 'cooking', 'done', `${fmtShort(e.date)} готовка — приготовлено`);
  const m1 = data.shoppingEvents[`shop-${cfg0.instanceId}-m1`];
  if (m1) setMark(`shop:${m1.id}`, m1.date, 'shopping', 'done', `${fmtShort(m1.date)} первая закупка — сделана (состав — по фото чеков)`);
  setMark('meal:2026-11-21:breakfast', '2026-11-21', 'meal', 'done', '21.11 завтрак — съеден');
  for (const s of ['lunch', 'snack', 'dinner'] as MealSlot[]) setMark(`meal:2026-11-21:${s}`, '2026-11-21', 'meal', 'skipped', `21.11 ${MEAL_LABELS[s].toLowerCase()} — пропущен`);
  for (const e of Object.values(data.cookingEvents)) if (e.instanceId === cfg0.instanceId && e.date === '2026-11-21') setMark(`cook:${e.id}`, e.date, 'cooking', 'skipped', '21.11 готовка — отменена (продукты остаются на складе)');
  for (const e of Object.values(data.shoppingEvents)) if (e.instanceId === cfg0.instanceId && e.kind !== 'trip' && e.date >= '2026-11-16' && e.date < today) setMark(`shop:${e.id}`, e.date, 'shopping', 'skipped', `${fmtShort(e.date)} ${e.title.toLowerCase()} — не было`);
  setMark('meal:2026-11-22:lunch', '2026-11-22', 'meal', 'skipped', '22.11 обед — отменён');

  // 2. запасы
  const { stock, estimatedFrom } = initialStock(data, now, input, today);

  // 3. новые блюда и порции 22–24.11, завтраки и перекусы 23–24.11 — из запасов
  const picks = pickFromStock(data, stock);
  const turkeyCook = cookId(COOK_TURKEY), chickenCook = cookId(COOK_CHICKEN);
  const days: PlanOverrides['days'] = {
    '2026-11-22': { lunch: { kind: 'cancel', label: 'Обед отменён (по факту)' }, dinner: { kind: 'cook', cookId: turkeyCook, dishId: 'X01', note: 'Новое блюдо из купленного: партия на 3 порции' } },
    '2026-11-23': { lunch: { kind: 'cook', cookId: turkeyCook, dishId: 'X01' }, dinner: { kind: 'cook', cookId: chickenCook, dishId: 'X02', note: 'Партия на 2 порции' } },
    '2026-11-24': { lunch: { kind: 'cook', cookId: turkeyCook, dishId: 'X01' }, dinner: { kind: 'cook', cookId: chickenCook, dishId: 'X02' } },
  };
  for (const p of picks) {
    if (p.dishId === p.original) continue;
    days[p.date] = { ...days[p.date], [p.slot]: { kind: 'dish', dishId: p.dishId, note: `Из того, что есть дома (вместо «${DISHES[p.original]?.short ?? p.original}»)` } satisfies SlotOverride };
  }
  // приёмы, уже отмеченные пользователем, не меняются
  for (const [date, slots] of Object.entries(days)) {
    for (const s of Object.keys(slots) as MealSlot[]) {
      const st = status(data, `meal:${date}:${s}`);
      const o = slots[s]!;
      if (st === 'done' || (st === 'skipped' && o.kind !== 'cancel')) { conflicts.push(`${fmtShort(date)} ${MEAL_LABELS[s].toLowerCase()}: уже отмечен — не меняется`); delete slots[s]; }
    }
  }
  const cooks: PlanOverrides['cooks'] = [
    {
      id: turkeyCook, date: '2026-11-22', time: '19:30', title: 'Готовка: индейка с булгуром и овощами',
      note: 'Перед готовкой — «Проверить продукты»: индейка 540 г, булгур 225 г, морковь 300 г, перец 240 г, лук 90 г, масло — до 24 мл, если есть. Одна порция — на ужин, две — в холодильник на обеды 23 и 24.11.',
      items: [{ dishId: 'X01', uses: [{ date: '2026-11-22', slot: 'dinner' }, { date: '2026-11-23', slot: 'lunch' }, { date: '2026-11-24', slot: 'lunch' }] }],
    },
    {
      id: chickenCook, date: '2026-11-23', time: '19:00', title: 'Готовка: куриное филе с рисом и брокколи',
      note: 'Перед готовкой — «Проверить продукты»: курица 360 г, рис 140 г, брокколи 320 г, масло — до 20 мл, если есть. Курицу достать из морозилки утром или накануне вечером. Одна порция — на ужин, вторая — в холодильник на ужин 24.11.',
      items: [{ dishId: 'X02', uses: [{ date: '2026-11-23', slot: 'dinner' }, { date: '2026-11-24', slot: 'dinner' }] }],
    },
  ];
  for (const c of cooks) c.items.forEach((it) => { it.uses = it.uses.filter((u) => (days[u.date]?.[u.slot] as SlotOverride | undefined)?.kind === 'cook'); });
  const cfg: PlanSettings = { ...cfg0, overrides: { sourceId: CORR_ID, days, cooks: cooks.filter((c) => c.items.some((i) => i.uses.length)) } };

  // 4. настройки и запасы, затем пересчёт с сегодняшнего дня (прошедшее не меняется)
  const settings = {
    ...data.settings, plan: cfg,
    inventory: { since: CORR_SINCE, createdAt: now },
    budgetSpent: input.spent != null ? { amount: input.spent, note: 'Первая закупка 15.11, по чекам', at: now } : data.settings.budgetSpent ?? null,
    corrections: { ...(data.settings.corrections ?? {}), [CORR_ID]: now },
  };
  ops.push({ store: 'settings', put: settings });
  for (const rec of Object.values(stock)) ops.push({ store: 'stock', put: rec });
  let after = applyOps(data, ops);
  // дни и готовки — с 22.11 (даже если применяют позже), закупки — с сегодняшнего дня
  const rp = replanOps(after, cfg, today, { keepPast: true, overwriteMarked: true, now, from: CORR_SINCE });
  ops.push(...rp.ops);
  after = applyOps(after, rp.ops);

  // 5. отчёт
  const dishes: CorrectionReport['dishes'] = [];
  for (const date of ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-27', '2026-11-28']) {
    for (const s of MEAL_SLOTS) {
      const b = SLOT_TEXT(data, date, s), a = SLOT_TEXT(after, date, s);
      const st = status(after, `meal:${date}:${s}`);
      const aa = date < today ? `${a}${st === 'skipped' ? ' — пропущен' : st === 'done' ? ' — съеден' : ''}` : a;
      if (aa !== b) dishes.push({ date, slot: s, before: b, after: aa });
    }
  }
  const portions: string[] = [];
  const cook = (id: string) => after.cookingEvents[id] as CookingEvent | undefined;
  for (const e of Object.values(data.cookingEvents).filter((x) => x.instanceId === cfg0.instanceId && x.date === '2026-11-21')) {
    portions.push(`21.11 «${e.title}» отменена: ${(e.items ?? []).map((i) => `${DISHES[i.dishId]?.short} × ${i.qty}`).join(', ')} — не приготовлено, продукты (каких хватало) остаются на складе`);
  }
  for (const c of cfg.overrides!.cooks) {
    const e = cook(c.id);
    if (e) portions.push(`${fmtShort(e.date)} ${e.time} — новая готовка: ${(e.items ?? []).map((i) => `${DISHES[i.dishId].title}, ${i.qty} порц. (${i.uses.map((u) => `${fmtShort(u.date)} ${MEAL_LABELS[u.slot].toLowerCase()}`).join(', ')})`).join('; ')}`);
  }
  for (const id of Object.keys(data.cookingEvents)) {
    const b = data.cookingEvents[id], a = after.cookingEvents[id];
    if (!b || !a || b.date < today || (b.date === a.date && b.time === a.time && JSON.stringify(b.items) === JSON.stringify(a.items))) continue;
    portions.push(`Готовка ${fmtShort(b.date)} ${b.time ?? ''} → ${fmtShort(a.date)} ${a.time ?? ''}: ${(a.items ?? []).map((i) => `${DISHES[i.dishId]?.short} × ${i.qty}`).join(', ')}${(b.items ?? []).reduce((s, i) => s + i.qty, 0) !== (a.items ?? []).reduce((s, i) => s + i.qty, 0) ? ` (было ${(b.items ?? []).reduce((s, i) => s + i.qty, 0)} порц., стало ${(a.items ?? []).reduce((s, i) => s + i.qty, 0)})` : ''}`);
  }
  for (const id of Object.keys(data.cookingEvents)) {
    const b = data.cookingEvents[id];
    if (b.date >= today && b.instanceId === cfg0.instanceId && !after.cookingEvents[id]) portions.push(`Готовка ${fmtShort(b.date)} ${b.time ?? ''} больше не нужна: её порции заменены`);
  }
  const sums = Object.values(after.stock).map((r) => ({ ...stockSummary(r, today), name: short(r.productId), unit: (PRODUCTS[r.productId]?.unit ?? 'g') as 'g' | 'ml' | 'pcs' }));
  const stockRows = sums.filter((s) => s.remaining > 0.5 || s.bought > 0).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const needConfirm = stockRows.filter((s) => s.needsConfirm).map((s) => s.name);
  const shops = Object.values(after.shoppingEvents).filter((e) => e.instanceId === cfg0.instanceId && e.kind !== 'trip' && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const cost = (e: ShoppingEvent) => Math.round((e.lines ?? []).reduce((s, l) => s + l.cost, 0));
  const m2 = shops.find((e) => e.kind === 'main') ?? null;
  const extra = shops.filter((e) => e.kind === 'topup' && (!m2 || e.date < m2.date)).map((e) => ({
    id: e.id, date: e.date, title: e.title,
    lines: (e.lines ?? []).filter((l) => l.buy > 0).map((l) => ({ name: short(l.productId), text: buyText(l), cost: Math.round(l.cost) })), cost: cost(e),
  }));
  const fq = (pid: string, q: number) => (PRODUCTS[pid] ? fmtAmount(Math.round(q), PRODUCTS[pid].unit) : String(Math.round(q)));
  const main = m2 ? {
    id: m2.id, date: m2.date, cost: cost(m2),
    lines: (m2.lines ?? []).filter((l) => l.buy > 0).map((l) => ({ name: short(l.productId), need: fq(l.productId, l.need), fromStock: l.fromStock > 0.5 ? fq(l.productId, l.fromStock) : '—', buy: buyText(l), cost: Math.round(l.cost) })),
    covered: (m2.lines ?? []).filter((l) => !(l.buy > 0) && l.fromStock > 0.5).map((l) => `${short(l.productId)} (${fq(l.productId, l.fromStock)})`),
  } : null;
  const later = shops.filter((e) => e.kind === 'topup' && m2 && e.date > m2.date).map((e) => ({ date: e.date, title: e.title, cost: cost(e) }));
  const spentEstimate = Math.round(Object.values(stock).flatMap((r) => r.moves.filter((m) => m.kind === 'purchase').map((m) => m.qty * (PRODUCTS[r.productId]?.price ?? 0) / (PRODUCTS[r.productId]?.unit === 'pcs' ? 1 : 1000))).reduce((s, x) => s + x, 0));
  const spent = input.spent ?? data.settings.budgetSpent?.amount ?? spentEstimate;
  const planned = shops.reduce((s, e) => s + cost(e), 0);
  const notes: string[] = [
    'Продукты списываются только по факту: «Приготовлено» у готовки и «Съедено» у приёма пищи. Запланированное не списывается.',
    'Остатки первой закупки — расчётные (по фото чеков минус приготовленное и съеденное по плану): проверьте их в «Закупки» → «Мои запасы».',
    `Фрукты и клубника — по плану первой закупки (${estimatedFrom.map(short).join(', ') || '—'}): на фото количество не видно, подтвердите.`,
    'Минтай, яйца, картофель и оливковое масло не учтены как имеющиеся: если они есть дома — укажите количество в «Моих запасах».',
    'Говяжий фарш, фарш индейки и форель не куплены: блюда с ними с 30.11 остаются, если войдут во вторую закупку.',
  ];
  if (m2 && m2.date !== '2026-11-30') notes.push(`Вторая основная закупка — ${fmtShort(m2.date)}, а не 30.11: готовка 30.11 в 07:00 (обед в этот день — из неё), продукты к ней нужны накануне. В релакс-день достаточно оформить заказ с доставкой.`);
  const defMap = new Map<string, { pid: string; qty: number; labels: Set<string> }>();
  for (const x of rp.instance.deficits) {
    const k = x.productId;
    const cur = defMap.get(k) ?? { pid: k, qty: 0, labels: new Set<string>() };
    cur.qty += x.qty; cur.labels.add(x.label);
    defMap.set(k, cur);
  }
  const deficits = Array.from(defMap.values()).map((x) => `${short(x.pid)}: не хватает ≈${qtyText(x.pid, x.qty)} (${Array.from(x.labels).join(', ')}) — проверьте перед готовкой; при нехватке «Проверить продукты» предложит замену`);
  const report: CorrectionReport = {
    id: CORR_ID, appliedAt: now, today, marks, dishes, portions, stock: stockRows, needConfirm, extra, main, later, deficits,
    budget: { total: BUDGET_RUB, spent, spentActual: input.spent != null || !!data.settings.budgetSpent, planned, left: BUDGET_RUB - spent - planned },
    notes, conflicts: [...conflicts, ...(rp.conflicts ?? [])],
  };
  // 6. резервная копия — первой операцией
  const backup: BackupRec = {
    id: `fact-${now.replace(/[^0-9]/g, '').slice(0, 14)}`, createdAt: now, appVersion,
    reason: 'Перед корректировкой по фактическим покупкам (22.11)', fromMenu: cfg0.menuId ?? null, toMenu: cfg0.menuId ?? null,
    stores: dataToStores(data), report: null, tripReport: null, correctionReport: report,
  };
  const all: Op[] = [{ store: 'backups', put: backup }, ...ops, { store: 'settings', put: { ...after.settings, correctionReportUnseen: backup.id } }];
  return { ops: all, after: applyOps(after, [{ store: 'backups', put: backup }, { store: 'settings', put: { ...after.settings, correctionReportUnseen: backup.id } }]), report, stock, picks };
}

/** Короткая подпись количества продукта. */
export function qtyText(pid: string, q: number): string {
  return PRODUCTS[pid] ? fmtAmount(Math.round(q), PRODUCTS[pid].unit) : String(Math.round(q));
}
