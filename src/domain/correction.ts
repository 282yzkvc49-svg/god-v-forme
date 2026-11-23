// Корректировка по факту (22.11.2026): фактические покупки по фото чеков, что съедено и приготовлено,
// новые блюда из уже купленного на 22–24.11, пересчёт меню, порций, готовок и закупок до 15.12.
// Сначала — проверка запасов (оценка «требует подтверждения», пользователь может поправить),
// затем предпросмотр, и только по подтверждению — резервная копия и изменения.
//
// Редакция 2 (22.11, вечер): ужин 22.11 — нут с булгуром и овощами (1 порция), обеды 23–24.11 — индейка
// с гречкой и морковью (2 порции, готовка 22.11), ужины 23–24.11 — курица с рисом и брокколи (2 порции,
// готовка 23.11); завтраки и перекусы — из текущего меню, если продукты есть. На устройствах, где первая
// редакция (индейка с булгуром на 3 порции) уже применена, запасы не пересоздаются — меняется только меню.
import type { Op } from '../state/idb';
import type { AppData, BackupRec, CookingEvent, CorrectionCheck, CorrectionMenuRow, CorrectionReport, MealCard, MealSlot, PlanDay, PlanOverrides, PlanSettings, ShoppingEvent, SlotOverride, StockMove, StockPlace, StockRec } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { applyOps, dataToStores } from '../state/model';
import { addDays, diffDays, fmtShort, type ISODate } from '../lib/dates';
import { DISHES, PRODUCTS, dishProducts, fmtAmount } from './catalog';
import { BUDGET_RUB, buildInstance, buyText, gross, planContext, replanOps } from './plan';
import { consumeOps, cookProducts, emptyStock, mealProducts, mealStockOps, stockLots, stockSummary } from './stock';

/** Запасы и отметки по факту (первая редакция). */
export const CORR_ID = 'fact-2026-11-22';
/** Меню 22–24.11, вторая редакция. */
export const CORR_REV = 'menu-2026-11-22-r2';
export const CORR_SINCE: ISODate = '2026-11-22';
export const CORR_LAST_DAY: ISODate = '2026-11-24';
const DONE_COOKS_BEFORE: ISODate = '2026-11-21';
const DAYS_22_24: ISODate[] = ['2026-11-22', '2026-11-23', '2026-11-24'];

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

/** Готовка 22.11: нут с булгуром (1 порция) и индейка с гречкой (2 порции). */
export const COOK_22 = 'x2211b';
/** Готовка 23.11: курица с рисом и брокколи (2 порции); id — как в первой редакции (то же блюдо и порции). */
export const COOK_CHICKEN = 'x2311';
/** Готовка первой редакции: индейка с булгуром на 3 порции — заменена. */
export const COOK_R1 = 'x2211';

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
/** Как продукт называется в согласованном меню и в разговоре. */
const PLAIN: Record<string, string> = {
  chickpeas: 'нут', bulgur: 'булгур', carrot: 'морковь', pepper: 'красный перец', onion: 'лук', turkey: 'филе индейки', buckwheat: 'гречка',
  chicken: 'куриное филе', rice: 'рис басмати', broccoli: 'брокколи замороженная', beans: 'фасоль красная', curd: 'творог', bread: 'хлеб цельнозерновой',
  egg: 'яйца', avocado: 'авокадо', tomato: 'помидоры', cherry: 'вишня замороженная', banana: 'бананы', kiwi: 'киви', pear: 'груши', apple: 'яблоки',
  yogurt: 'йогурт', oats: 'овсяные хлопья', almonds: 'миндаль', walnuts: 'грецкие орехи', strawberry: 'клубника замороженная', orange: 'апельсины',
};
export const plainName = (pid: string) => PLAIN[pid] ?? short(pid).toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
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
  applyInput(out, input, now, () => mid(now, ++n), today);
  return { stock: out, estimatedFrom };
}

/** Поправки пользователя на шаге проверки: срок с упаковки, остаток вручную, испорчено. */
function applyInput(out: Record<string, StockRec>, input: CorrectionInput, now: string, nextId: () => string, today: ISODate) {
  const date = today > CORR_SINCE ? today : CORR_SINCE;
  for (const [pid, d] of Object.entries(input.expiry)) if (out[pid]) out[pid] = { ...out[pid], expiresOn: d || null, updatedAt: now };
  for (const [pid, qty] of Object.entries(input.remaining)) {
    if (!PRODUCTS[pid] || !(qty >= 0)) continue;
    const rec = out[pid] ?? emptyStock(pid, now, FROZEN_RAW.includes(pid) ? 'freezer' : undefined);
    const have = stockLots(rec).reduce((s, l) => s + l.qty, 0);
    const delta = Math.round((qty - have) * 10) / 10;
    out[pid] = {
      ...rec, confirmedAt: now, updatedAt: now,
      moves: Math.abs(delta) > 0.05 ? [...rec.moves, { id: nextId(), date, kind: 'adjust', qty: delta, source: 'manual', note: 'Остаток проверен вручную', confirmed: true, at: now }] : rec.moves,
    };
  }
  for (const pid of input.spoiled) {
    const rec = out[pid];
    if (!rec) continue;
    const have = stockLots(rec).reduce((s, l) => s + l.qty, 0);
    if (have > 0.05) out[pid] = { ...rec, confirmedAt: now, updatedAt: now, moves: [...rec.moves, { id: nextId(), date, kind: 'writeoff', qty: Math.round(have * 10) / 10, source: 'manual', note: 'Испорчено — списано', confirmed: true, at: now }] };
  }
}

/**
 * Запасы, с которыми считается корректировка: если учёт уже ведётся (первая редакция применена) — текущие
 * «Мои запасы» со всеми отметками; иначе — по фото чеков и оценке расхода. Поправки пользователя — поверх.
 */
export function baseStock(data: AppData, now: string, input: CorrectionInput, today: ISODate = CORR_SINCE): { stock: Record<string, StockRec>; estimatedFrom: string[]; ledger: boolean } {
  if (!data.settings.inventory) return { ...initialStock(data, now, input, today), ledger: false };
  const out: Record<string, StockRec> = JSON.parse(JSON.stringify(data.stock ?? {}));
  for (const pid of [...ASK_AT_HOME, ...NOT_BOUGHT]) if (!out[pid] && PRODUCTS[pid]) out[pid] = emptyStock(pid, now, FROZEN_RAW.includes(pid) ? 'freezer' : undefined);
  let n = 0;
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14);
  applyInput(out, input, now, () => `mv-${stamp}-r${++n}`, today);
  const estimatedFrom = Object.values(out).filter((r) => !r.confirmedAt && r.moves.some((m) => m.kind === 'purchase' && !m.confirmed)).map((r) => r.productId);
  return { stock: out, estimatedFrom, ledger: true };
}

// ------------------------------------------------------------------ подбор завтраков и перекусов из запасов

type SimLot = { qty: number; until: ISODate };

function simStock(stock: Record<string, StockRec>): Map<string, SimLot[]> {
  return new Map(Object.values(stock).map((r) => [r.productId, stockLots(r).map((l) => ({ qty: l.qty, until: l.until }))]));
}

/** Каких продуктов блюда по учёту не хватает к дате (соль, специи и масло не мешают). */
function lacking(sim: Map<string, SimLot[]>, items: Map<string, number>, date: ISODate): string[] {
  const out: string[] = [];
  for (const [pid, q] of items) {
    if (OPTIONAL.has(pid)) continue;
    const have = (sim.get(pid) ?? []).filter((l) => l.until >= date).reduce((s, l) => s + l.qty, 0);
    if (have + 0.5 < q) out.push(pid);
  }
  return out;
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
function score(sim: Map<string, SimLot[]>, dishId: string, date: ISODate, used: Set<string>): number {
  let s = 0;
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

export interface Pick {
  date: ISODate;
  slot: MealSlot;
  /** Блюдо текущего меню (из комплекта). */
  original: string;
  dishId: string;
  /** Блюдо собирается из запасов. */
  feasible: boolean;
  /** Чего по учёту нет для блюда меню. */
  missing: string[];
  /** Приём уже отмечен — не меняется. */
  marked: boolean;
}

/** «творог (срок по оценке — до 22.11), хлеб цельнозерновой»: чего нет или что по оценке уже не годится к дате. */
export function missingText(stock: Record<string, StockRec>, p: Pick): string {
  return p.missing.map((pid) => {
    const lots = stock[pid] ? stockLots(stock[pid]) : [];
    const all = lots.reduce((s, l) => s + l.qty, 0);
    const last = lots.map((l) => l.until).sort().pop();
    return all > 0.5 && last && last < p.date ? `${plainName(pid)} (срок по оценке — до ${fmtShort(last)})` : plainName(pid);
  }).join(', ');
}

/** Чего по учёту нет для завтраков и перекусов меню 23–24.11 — спросить на шаге проверки запасов. */
export function menuMissing(data: AppData, now: string, today: ISODate): { pid: string; text: string }[] {
  const { stock } = baseStock(data, now, emptyInput(), today);
  const out = new Map<string, string>();
  for (const p of pickFromStock(data, stock)) for (const pid of p.missing) if (!out.has(pid)) out.set(pid, missingText(stock, { ...p, missing: [pid] }));
  return Array.from(out, ([pid, text]) => ({ pid, text }));
}

/** Новые блюда 22–24.11 и их порции: какие готовки, что в какой приём. */
export const NEW_MENU: { date: ISODate; slot: MealSlot; dishId: string; cook: 'c22' | 'c23'; portion: number; of: number }[] = [
  { date: '2026-11-22', slot: 'dinner', dishId: 'X03', cook: 'c22', portion: 1, of: 1 },
  { date: '2026-11-23', slot: 'lunch', dishId: 'X04', cook: 'c22', portion: 1, of: 2 },
  { date: '2026-11-23', slot: 'dinner', dishId: 'X02', cook: 'c23', portion: 1, of: 2 },
  { date: '2026-11-24', slot: 'lunch', dishId: 'X04', cook: 'c22', portion: 2, of: 2 },
  { date: '2026-11-24', slot: 'dinner', dishId: 'X02', cook: 'c23', portion: 2, of: 2 },
];

/**
 * Блюда меню из комплекта на 22–24.11 — без замен первой редакции (на устройствах, где она применена,
 * завтраки и перекусы 23–24.11 были подобраны по срокам; теперь они возвращаются к меню, если продукты есть).
 */
export function menuOriginals(data: AppData): Record<ISODate, Partial<Record<MealSlot, MealCard>>> {
  const cfg = data.settings.plan;
  const out: Record<ISODate, Partial<Record<MealSlot, MealCard>>> = {};
  let days: (PlanDay | undefined)[] = DAYS_22_24.map((d) => data.planDays[d]);
  if (cfg?.overrides) {
    const inst = buildInstance({ ...cfg, overrides: undefined }, planContext(data, null));
    days = DAYS_22_24.map((d) => inst.planDays.find((x) => x.date === d));
  }
  for (const d of days) if (d?.mealCards) out[d.date] = d.mealCards;
  return out;
}

/**
 * Завтраки и перекусы 23–24.11: блюдо меню остаётся, если его продукты есть в запасах и годны к дате.
 * Если чего-то нет — замена из того, что есть (сначала то, у чего раньше заканчивается срок), и список,
 * чего не хватило. Уже отмеченные приёмы не меняются.
 */
export function pickFromStock(data: AppData, stock: Record<string, StockRec>, originals = menuOriginals(data)): Pick[] {
  const sim = simStock(stock);
  const cards = (date: ISODate) => data.planDays[date]?.mealCards;
  const marked = (date: ISODate, s: MealSlot) => { const st = status(data, `meal:${date}:${s}`); return st === 'done' || st === 'skipped'; };
  // сначала — то, что уже решено: новые партии и завтрак с перекусом 22.11 из меню (съеденное уже списано)
  take(sim, dishItems('X03', 1), '2026-11-22');
  take(sim, dishItems('X04', 2), '2026-11-22');
  take(sim, dishItems('X02', 2), '2026-11-23');
  for (const s of ['breakfast', 'snack'] as MealSlot[]) {
    const c = cards('2026-11-22')?.[s];
    if (c && !marked('2026-11-22', s)) for (const p of c.parts) if (p.fresh) take(sim, dishItems(p.dishId, p.qty), '2026-11-22');
  }
  const used = new Set<string>();
  for (const date of ['2026-11-21', '2026-11-22']) for (const s of ['breakfast', 'snack'] as MealSlot[]) { const id = cards(date)?.[s]?.parts[0]?.dishId; if (id) used.add(id); }
  const out: Pick[] = [];
  for (const date of ['2026-11-23', '2026-11-24']) {
    for (const slot of ['breakfast', 'snack'] as MealSlot[]) {
      const cur = cards(date)?.[slot]?.parts[0]?.dishId ?? '';
      if (marked(date, slot)) { used.add(cur); out.push({ date, slot, original: cur, dishId: cur, feasible: true, missing: [], marked: true }); continue; }
      const original = originals[date]?.[slot]?.parts[0]?.dishId ?? cur;
      const missing = lacking(sim, dishItems(original), date);
      if (!missing.length) {
        take(sim, dishItems(original), date);
        used.add(original);
        out.push({ date, slot, original, dishId: original, feasible: true, missing, marked: false });
        continue;
      }
      const pool = slot === 'breakfast' ? BREAKFASTS() : SNACKS();
      const best = pool.filter((id) => id !== original && !lacking(sim, dishItems(id), date).length)
        .sort((a, b) => score(sim, b, date, used) - score(sim, a, date, used))[0];
      const dishId = best ?? original;
      if (best) take(sim, dishItems(best), date);
      used.add(dishId);
      out.push({ date, slot, original, dishId, feasible: !!best, missing, marked: false });
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

/** Вторая редакция (меню 22–24.11 с нутом, индейкой с гречкой и курицей) применена. */
export function correctionApplied(data: AppData): boolean {
  return !!data.settings.corrections?.[CORR_REV];
}

/** Первая редакция применена (учёт запасов ведётся), меню 22–24.11 ещё прежнее — нужно обновление. */
export function firstRevisionApplied(data: AppData): boolean {
  return !!data.settings.corrections?.[CORR_ID] && !correctionApplied(data);
}

/** Обновление первой редакции невозможно без потери отметок: индейка с булгуром уже приготовлена или съедена. */
export function revisionBlocked(data: AppData): string | null {
  if (!firstRevisionApplied(data)) return null;
  const { cookId } = planParts(data);
  if (status(data, `cook:${cookId(COOK_R1)}`) === 'done') return 'Готовка 22.11 «Индейка с булгуром и овощами» уже отмечена «Приготовлено»: меню 22–24.11 не заменяется, чтобы не потерять приготовленные порции. Если готовки не было — снимите отметку на странице готовки, и обновление станет доступно.';
  for (const [date, slot] of [['2026-11-22', 'dinner'], ['2026-11-23', 'lunch'], ['2026-11-24', 'lunch']] as [ISODate, MealSlot][]) {
    if (data.planDays[date]?.mealCards?.[slot]?.parts.some((p) => p.dishId === 'X01') && status(data, `meal:${date}:${slot}`) === 'done') {
      return `${fmtShort(date)}, ${MEAL_LABELS[slot].toLowerCase()}: «Индейка с булгуром и овощами» уже отмечена «Съедено» — меню 22–24.11 не заменяется. Если это не так — снимите отметку в дне.`;
    }
  }
  return null;
}

/** Корректировка нужна: план со стартом 16.11, меню 22–24.11 второй редакции ещё не применено и эти дни впереди. */
export function correctionPending(data: AppData, today: ISODate): boolean {
  const cfg = data.settings.plan;
  return !!cfg && cfg.startDate === '2026-11-16' && !correctionApplied(data) && today >= '2026-11-21' && today <= CORR_LAST_DAY && !revisionBlocked(data);
}

/** Продукты блюда на n порций: «нут 240 г без жидкости (1 банка 400 г), булгур 70 г, …». */
function gramsText(dishId: string, n: number): string {
  const out: string[] = [];
  for (const [pid, v] of dishProducts(dishId, n, false)) {
    const p = PRODUCTS[pid];
    if (!p) continue;
    if (/банка/.test(p.pack?.label ?? '')) {
      const cans = Math.round(gross(pid, v) / p.pack.size * 10) / 10;
      out.push(`${plainName(pid)} ${String(cans).replace('.', ',')} ${cans === 1 ? 'банка' : 'банки'} ${p.pack.size} г (≈${fmtAmount(Math.round(v), p.unit)} без жидкости)`);
    } else out.push(`${plainName(pid)} ${fmtAmount(Math.round(v), p.unit)}`);
  }
  return out.join(', ');
}

/** Что докупить нельзя придумать: замены одного вида из того, что есть. */
const SUBS: Record<string, string[]> = {
  turkey: ['chicken'], chicken: ['turkey'], bulgur: ['rice', 'buckwheat'], buckwheat: ['bulgur', 'rice'], rice: ['buckwheat', 'bulgur'],
  broccoli: ['carrot'], chickpeas: ['beans'], carrot: ['broccoli'], onion: [], pepper: ['carrot'],
};
const CHECK_ORDER = ['turkey', 'chicken', 'bulgur', 'buckwheat', 'rice', 'broccoli', 'chickpeas', 'carrot', 'onion', 'pepper'];

/** Проверка остатков к новым блюдам: хватает, хватает по расчёту (проверьте дома) или не хватает — с заменой. */
function stockChecks(stock: Record<string, StockRec>, cooks: PlanOverrides['cooks'], today: ISODate): CorrectionCheck[] {
  const needs = new Map<string, { net: number; gross: number; date: ISODate }>();
  for (const c of cooks) for (const it of c.items) {
    for (const [pid, v] of dishProducts(it.dishId, it.uses.length, false)) {
      if (!PRODUCTS[pid] || OPTIONAL.has(pid)) continue;
      const cur = needs.get(pid) ?? { net: 0, gross: 0, date: c.date };
      cur.net += v; cur.gross += gross(pid, v);
      if (c.date < cur.date) cur.date = c.date;
      needs.set(pid, cur);
    }
  }
  const have = (pid: string, date: ISODate) => (stock[pid] ? stockLots(stock[pid]).filter((l) => l.until >= date).reduce((s, l) => s + l.qty, 0) : 0);
  const spare = (pid: string) => have(pid, needs.get(pid)?.date ?? today) - (needs.get(pid)?.gross ?? 0);
  const ids = [...CHECK_ORDER.filter((p) => needs.has(p)), ...Array.from(needs.keys()).filter((p) => !CHECK_ORDER.includes(p))];
  return ids.map((pid): CorrectionCheck => {
    const nd = needs.get(pid)!;
    const p = PRODUCTS[pid];
    const h = have(pid, nd.date);
    const need = /банка/.test(p.pack?.label ?? '')
      ? `${String(Math.round(nd.gross / p.pack.size * 10) / 10).replace('.', ',')} банка ${p.pack.size} г (≈${fmtAmount(Math.round(nd.net), p.unit)} без жидкости)`
      : `${pid === 'pepper' ? 'до ' : ''}${fmtAmount(Math.round(nd.net), p.unit)}${nd.gross - nd.net > 3 ? ` (≈${fmtAmount(Math.round(nd.gross), p.unit)} до очистки)` : ''}`;
    const base = { productId: pid, name: cap(plainName(pid)), need, have: Math.round(h), haveText: h > 0.5 ? qtyText(pid, h) : 'нет' };
    if (h + 0.5 >= nd.gross) {
      const confirm = !!stock[pid] && stockSummary(stock[pid], today).needsConfirm;
      return { ...base, state: confirm ? 'confirm' : 'ok', text: confirm ? 'хватает*' : 'хватает' };
    }
    const deficit = nd.gross - h;
    if (pid === 'pepper') {
      const carrot = spare('carrot');
      return { ...base, state: 'short', text: `не хватает ≈${qtyText(pid, deficit)} — можно без перца: вместо него ещё ${qtyText('carrot', Math.min(80, nd.net))} моркови${carrot >= gross('carrot', Math.min(80, nd.net)) ? ' (моркови хватает)' : ' (моркови по учёту тоже мало — проверьте дома)'}` };
    }
    if (pid === 'onion') return { ...base, state: 'short', text: `не хватает ≈${qtyText(pid, deficit)} — можно готовить без лука или с меньшим количеством` };
    const sub = (SUBS[pid] ?? []).find((s) => spare(s) >= deficit);
    return {
      ...base, state: 'short',
      text: sub
        ? `не хватает ≈${qtyText(pid, deficit)} — замена: ${plainName(sub)} (свободно ≈${qtyText(sub, spare(sub))}); при готовке выберите её в «Проверить продукты»`
        : `не хватает ≈${qtyText(pid, deficit)} — замены в запасах нет: докупите вручную (автоматически в закупку не добавлено) или уменьшите порцию`,
    };
  });
}

export function buildCorrection(data: AppData, today: ISODate, now: string, input: CorrectionInput, appVersion = 'test'): Correction {
  const cfg0 = data.settings.plan as PlanSettings;
  const { cookId } = planParts(data);
  const revision = firstRevisionApplied(data);
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
  for (const e of Object.values(data.cookingEvents)) if (e.instanceId === cfg0.instanceId && e.date === '2026-11-21') setMark(`cook:${e.id}`, e.date, 'cooking', 'skipped', '21.11 готовка — не выполнялась (продукты остаются в запасах)');
  for (const e of Object.values(data.shoppingEvents)) if (e.instanceId === cfg0.instanceId && e.kind !== 'trip' && e.date >= '2026-11-16' && e.date < today) setMark(`shop:${e.id}`, e.date, 'shopping', 'skipped', `${fmtShort(e.date)} ${e.title.toLowerCase()} — не было`);
  setMark('meal:2026-11-22:lunch', '2026-11-22', 'meal', 'skipped', '22.11 обед — пропущен');

  // 2. запасы: учёт уже ведётся — текущие «Мои запасы», иначе — по чекам и оценке расхода
  const { stock, estimatedFrom, ledger } = baseStock(data, now, input, today);

  // 3. меню 22–24.11: новые блюда из двух готовок, завтраки и перекусы — из меню, если продукты есть
  const originals = menuOriginals(data);
  const picks = pickFromStock(data, stock, originals);
  const missText = (p: Pick) => missingText(stock, p);
  const cook22 = cookId(COOK_22), cook23 = cookId(COOK_CHICKEN);
  const cookIdOf = { c22: cook22, c23: cook23 };
  const days: PlanOverrides['days'] = { '2026-11-22': { lunch: { kind: 'cancel', label: 'Пропущен' } } };
  for (const m of NEW_MENU) {
    days[m.date] = { ...days[m.date], [m.slot]: { kind: 'cook', cookId: cookIdOf[m.cook], dishId: m.dishId, note: `${m.of === 1 ? '1 порция' : `Порция ${m.portion} из ${m.of}`} — готовка ${m.cook === 'c22' ? '22.11' : '23.11'}` } satisfies SlotOverride };
  }
  for (const p of picks) {
    if (p.marked) continue;
    days[p.date] = { ...days[p.date], [p.slot]: p.dishId === p.original
      // блюдо меню остаётся, но 22–24.11 всё — из запасов: без автоматической закупки
      ? { kind: 'dish', dishId: p.dishId } satisfies SlotOverride
      : { kind: 'dish', dishId: p.dishId, note: `Из того, что есть дома: для «${DISHES[p.original]?.short ?? p.original}» по учёту нет — ${missText(p)}` } satisfies SlotOverride };
  }
  for (const s of ['breakfast', 'snack'] as MealSlot[]) {
    const id = data.planDays['2026-11-22']?.mealCards?.[s]?.parts[0]?.dishId;
    if (id && !days['2026-11-22'][s] && !['done', 'skipped'].includes(status(data, `meal:2026-11-22:${s}`) ?? '')) days['2026-11-22'][s] = { kind: 'dish', dishId: id };
  }
  // приёмы, уже отмеченные пользователем, не меняются
  for (const [date, slots] of Object.entries(days)) {
    for (const s of Object.keys(slots) as MealSlot[]) {
      const st = status(data, `meal:${date}:${s}`);
      const o = slots[s]!;
      if (st === 'done' || (st === 'skipped' && o.kind !== 'cancel')) { conflicts.push(`${fmtShort(date)} ${MEAL_LABELS[s].toLowerCase()}: уже отмечен «${st === 'done' ? 'Съеден' : 'Пропущен'}» — не меняется`); delete slots[s]; }
    }
  }
  const uses = (c: 'c22' | 'c23', dishId: string) => NEW_MENU.filter((m) => m.cook === c && m.dishId === dishId && days[m.date]?.[m.slot]?.kind === 'cook').map((m) => ({ date: m.date, slot: m.slot }));
  const times = data.settings.mealTimes;
  const whereText = (us: { date: ISODate; slot: MealSlot }[]) => us.map((u) => `${MEAL_LABELS[u.slot].toLowerCase()} ${fmtShort(u.date)}${u.slot === 'lunch' && times?.lunch ? ` в ${times.lunch}` : ''}`).join(', ');
  const itemText = (dishId: string, us: { date: ISODate; slot: MealSlot }[]) => `${DISHES[dishId].title} — ${us.length} ${us.length === 1 ? 'порция' : 'порции'}: ${gramsText(dishId, us.length)} → ${whereText(us)}`;
  const c22 = [{ dishId: 'X03', uses: uses('c22', 'X03') }, { dishId: 'X04', uses: uses('c22', 'X04') }].filter((i) => i.uses.length);
  const c23 = [{ dishId: 'X02', uses: uses('c23', 'X02') }].filter((i) => i.uses.length);
  const cooks: PlanOverrides['cooks'] = [];
  if (c22.length) cooks.push({
    id: cook22, date: '2026-11-22', time: '19:30',
    title: c22.length === 2 ? 'Готовка: нут с булгуром и индейка с гречкой' : `Готовка: ${DISHES[c22[0].dishId].short.toLowerCase()}`,
    note: [
      ...c22.map((i) => `${itemText(i.dishId, i.uses)}.`),
      c22.some((i) => i.dishId === 'X03') ? 'Если красный перец испортился — не добавлять его, вместо него ещё 80 г моркови.' : '',
      c22.some((i) => i.dishId === 'X04') ? 'Индейку разморозить безопасно: в герметичном пакете в холодной воде, меняя воду каждые 30 минут, — и сразу готовить. Порции индейки — в два одинаковых контейнера и в холодильник.' : '',
      c23.length ? 'Переложить куриное филе (360 г) из морозилки в холодильник — к готовке 23.11.' : '',
    ].filter(Boolean).join(' '),
    items: c22,
  });
  if (c23.length) cooks.push({
    id: cook23, date: '2026-11-23', time: '19:00', title: 'Готовка: курица с рисом и брокколи',
    note: [
      `${itemText('X02', c23[0].uses)}.`,
      'Если курицу не переложили в холодильник с вечера 22.11 — разморозить в герметичном пакете в холодной воде, меняя воду каждые 30 минут, и сразу готовить.',
      'Курица — в аэрогриле при 180 °C примерно 15–20 минут, до 74 °C внутри.',
      c22.some((i) => i.dishId === 'X04' && i.uses.some((u) => u.date === '2026-11-24')) ? 'Подготовить контейнер с индейкой на обед 24.11.' : '',
    ].filter(Boolean).join(' '),
    items: c23,
  });
  const cfg: PlanSettings = { ...cfg0, overrides: { sourceId: CORR_REV, days, cooks } };

  // 4. настройки и запасы, затем пересчёт (прошедшее не меняется)
  const settings = {
    ...data.settings, plan: cfg,
    inventory: data.settings.inventory ?? { since: CORR_SINCE, createdAt: now },
    budgetSpent: input.spent != null ? { amount: input.spent, note: 'Первая закупка 15.11, по чекам', at: now } : data.settings.budgetSpent ?? null,
    corrections: { ...(data.settings.corrections ?? {}), [CORR_ID]: data.settings.corrections?.[CORR_ID] ?? now, [CORR_REV]: now },
  };
  ops.push({ store: 'settings', put: settings });
  for (const rec of Object.values(stock)) if (!ledger || JSON.stringify(rec) !== JSON.stringify(data.stock?.[rec.productId])) ops.push({ store: 'stock', put: rec });
  let after = applyOps(data, ops);
  // дни и готовки — с 22.11 (даже если применяют позже), закупки — с сегодняшнего дня
  const rp = replanOps(after, cfg, today, { keepPast: true, overwriteMarked: true, now, from: CORR_SINCE });
  ops.push(...rp.ops);
  after = applyOps(after, rp.ops);

  // 5. отчёт
  const dishes: CorrectionReport['dishes'] = [];
  for (const date of ['2026-11-21', ...DAYS_22_24, '2026-11-27', '2026-11-28']) {
    for (const s of MEAL_SLOTS) {
      const b = SLOT_TEXT(data, date, s), a = SLOT_TEXT(after, date, s);
      const st = status(after, `meal:${date}:${s}`);
      const aa = date < today || st === 'skipped' ? `${a}${st === 'skipped' && a !== 'Пропущен' ? ' — пропущен' : st === 'done' ? ' — съеден' : ''}` : a;
      if (aa !== b) dishes.push({ date, slot: s, before: b, after: aa });
    }
  }
  const menu: CorrectionMenuRow[] = [];
  for (const date of DAYS_22_24) {
    for (const s of MEAL_SLOTS) {
      const card = after.planDays[date]?.mealCards?.[s];
      const st = status(after, `meal:${date}:${s}`);
      const nm = NEW_MENU.find((m) => m.date === date && m.slot === s);
      const pk = picks.find((p) => p.date === date && p.slot === s);
      const title = card?.title ?? '—';
      let row: { source: CorrectionMenuRow['source']; note: string };
      if (card?.cancelled) row = { source: 'cancel', note: 'обед убран, отмечен «Пропущен»' };
      else if (st === 'done' || st === 'skipped') row = { source: 'marked', note: st === 'done' ? 'уже отмечен «Съеден» — не меняется' : 'отмечен «Пропущен» — не меняется' };
      else if (nm && card?.parts.some((p) => p.dishId === nm.dishId)) row = { source: 'new', note: `${nm.of === 1 ? '1 порция' : `порция ${nm.portion} из ${nm.of}`}, готовка ${nm.cook === 'c22' ? '22.11' : '23.11'}` };
      else if (pk && pk.dishId !== pk.original) row = { source: 'swap', note: `вместо «${DISHES[pk.original]?.short ?? pk.original}»: по учёту нет — ${missText(pk)}` };
      else if (pk && !pk.feasible) row = { source: 'kept', note: `из текущего меню; по учёту нет — ${missText(pk)}, замены из запасов тоже нет: проверьте дома` };
      else row = { source: 'kept', note: pk ? 'из текущего меню — продукты есть' : 'из текущего меню' };
      menu.push({ date, slot: s, title, ...row });
    }
  }
  const checks = stockChecks(stock, cooks, today);
  const portions: string[] = [];
  const cook = (id: string) => after.cookingEvents[id] as CookingEvent | undefined;
  for (const e of Object.values(data.cookingEvents).filter((x) => x.instanceId === cfg0.instanceId && x.date === '2026-11-21')) {
    portions.push(`21.11 «${e.title}» не выполнялась: ${(e.items ?? []).map((i) => `${DISHES[i.dishId]?.short} × ${i.qty}`).join(', ')} — не приготовлено, готовых порций после 21.11 нет; продукты (каких хватало) остаются в запасах`);
  }
  for (const c of cooks) {
    const e = cook(c.id);
    if (e) portions.push(`${fmtShort(e.date)} ${e.time} — готовка: ${(e.items ?? []).map((i) => `${DISHES[i.dishId].title}, ${i.qty} ${i.qty === 1 ? 'порция' : 'порции'} (${i.uses.map((u) => `${MEAL_LABELS[u.slot].toLowerCase()} ${fmtShort(u.date)}`).join(', ')})`).join('; ')}`);
  }
  if (cooks.length) portions.push('24.11 — новой готовки основных блюд нет: обед и ужин — из приготовленных порций');
  for (const id of Object.keys(data.cookingEvents)) {
    const b = data.cookingEvents[id], a = after.cookingEvents[id];
    if (!b || !a || b.date < today || cooks.some((c) => c.id === id) || (b.date === a.date && b.time === a.time && JSON.stringify(b.items) === JSON.stringify(a.items))) continue;
    portions.push(`Готовка ${fmtShort(b.date)} ${b.time ?? ''} → ${fmtShort(a.date)} ${a.time ?? ''}: ${(a.items ?? []).map((i) => `${DISHES[i.dishId]?.short} × ${i.qty}`).join(', ')}${(b.items ?? []).reduce((s, i) => s + i.qty, 0) !== (a.items ?? []).reduce((s, i) => s + i.qty, 0) ? ` (было ${(b.items ?? []).reduce((s, i) => s + i.qty, 0)} порц., стало ${(a.items ?? []).reduce((s, i) => s + i.qty, 0)})` : ''}`);
  }
  for (const id of Object.keys(data.cookingEvents)) {
    const b = data.cookingEvents[id];
    if (b.instanceId !== cfg0.instanceId || after.cookingEvents[id] || b.date < (b.blockId ? today : CORR_SINCE)) continue;
    portions.push(b.blockId ? `Готовка ${fmtShort(b.date)} ${b.time ?? ''} больше не нужна: её порции заменены` : `Готовка ${fmtShort(b.date)} «${(b.items ?? []).map((i) => `${DISHES[i.dishId]?.title} × ${i.qty}`).join(', ')}» первой редакции убрана — заменена новыми блюдами`);
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
  // закупка к 22–24.11 не нужна, если ни одна строка не покупается для этих дней
  const buyFor22 = shops.some((e) => e.date <= CORR_LAST_DAY && (e.lines ?? []).some((l) => l.buy > 0 && l.needs.some((n) => (n.use ?? n.date) <= CORR_LAST_DAY)));
  const short22 = checks.filter((c) => c.state === 'short' && c.productId !== 'pepper');
  const notes: string[] = [
    'Продукты списываются только по факту: «Приготовлено» у готовки и «Съедено» у приёма пищи. Запланированное не списывается.',
    ledger
      ? 'Остатки — из «Моих запасов» (с вашими отметками и поправками); первая закупка и прежние отметки не пересчитываются.'
      : 'Остатки первой закупки — расчётные (по фото чеков минус приготовленное и съеденное по плану): проверьте их в «Закупки» → «Мои запасы».',
    ...(estimatedFrom.length ? [`Фрукты и клубника — по плану первой закупки (${estimatedFrom.map(short).join(', ')}): на фото количество не видно, подтвердите.`] : []),
    'Минтай, яйца, картофель и оливковое масло не учтены как имеющиеся, пока вы не укажете количество в «Моих запасах».',
    'Говяжий фарш, фарш индейки и форель не куплены: блюда с ними с 30.11 остаются, если войдут во вторую закупку.',
    '25–26.11 — командировка в Санкт-Петербург: домашнее питание не нужно. 27–28.11 — домашнее меню из оставшихся продуктов. 29.11 — релакс-день без изменений. С 30.11 — программа дальше; вторая закупка пересчитана по остаткам и уточнится, когда вы подтвердите запасы.',
  ];
  if (revision) notes.unshift('Первая редакция корректировки (индейка с булгуром на 3 порции, подбор завтраков и перекусов по срокам) заменена этим меню. Запасы, отметки, вес, фото и тренировки не меняются.');
  if (m2 && m2.date !== '2026-11-30') notes.push(`Вторая основная закупка — ${fmtShort(m2.date)}, а не 30.11: готовка 30.11 в 07:00 (обед в этот день — из неё), продукты к ней нужны накануне. В релакс-день достаточно оформить заказ с доставкой.`);
  const defMap = new Map<string, { pid: string; qty: number; labels: Set<string> }>();
  for (const x of rp.instance.deficits) {
    const k = x.productId;
    const cur = defMap.get(k) ?? { pid: k, qty: 0, labels: new Set<string>() };
    cur.qty += x.qty; cur.labels.add(x.label);
    defMap.set(k, cur);
  }
  const deficits = Array.from(defMap.values()).map((x) => `${cap(plainName(x.pid))}: не хватает ≈${qtyText(x.pid, x.qty)} (${Array.from(x.labels).join(', ')}) — проверьте перед готовкой; при нехватке «Проверить продукты» предложит замену`);
  const report: CorrectionReport = {
    id: CORR_REV, rev: 2, revision, appliedAt: now, today, marks, dishes, portions, stock: stockRows, needConfirm, extra, main, later, deficits,
    budget: { total: BUDGET_RUB, spent, spentActual: input.spent != null || !!data.settings.budgetSpent, planned, left: BUDGET_RUB - spent - planned },
    notes, conflicts: [...conflicts, ...(rp.conflicts ?? [])], menu, checks,
    noPurchaseUntil: !buyFor22 && !short22.length ? CORR_LAST_DAY : null,
  };
  // 6. резервная копия — первой операцией
  const backup: BackupRec = {
    id: `fact-${now.replace(/[^0-9]/g, '').slice(0, 14)}`, createdAt: now, appVersion,
    reason: revision ? 'Перед обновлением меню 22–24.11 (вторая редакция корректировки)' : 'Перед корректировкой по фактическим покупкам и меню 22–24.11',
    fromMenu: cfg0.menuId ?? null, toMenu: cfg0.menuId ?? null,
    stores: dataToStores(data), report: null, tripReport: null, correctionReport: report,
  };
  const all: Op[] = [{ store: 'backups', put: backup }, ...ops, { store: 'settings', put: { ...after.settings, correctionReportUnseen: backup.id } }];
  return { ops: all, after: applyOps(after, [{ store: 'backups', put: backup }, { store: 'settings', put: { ...after.settings, correctionReportUnseen: backup.id } }]), report, stock, picks };
}

/** Короткая подпись количества продукта. */
export function qtyText(pid: string, q: number): string {
  return PRODUCTS[pid] ? fmtAmount(Math.round(q), PRODUCTS[pid].unit) : String(Math.round(q));
}
