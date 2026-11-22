// Учёт запасов: остаток = купленное + поступления − использованное − списанное ± исправления.
// Продукты списываются только по факту: «Приготовлено» (готовка) и «Съедено» (свежие блюда), — не по плану.
// Расчётные движения (оценка по чекам и плану) помечены confirmed: false — «Требует подтверждения».
import type { Op } from '../state/idb';
import type { AppData, CookingEvent, MealSlot, ReadyFoodRec, StockMove, StockPlace, StockRec } from '../state/types';
import { MEAL_LABELS } from '../state/types';
import { addDays, diffDays, fmtShort, type ISODate } from '../lib/dates';
import { DISHES, PRODUCTS, dishProducts, roundBatch, type Product } from './catalog';

export interface StockLot { qty: number; date: ISODate; until: ISODate; frozen: boolean }

const EPS = 0.01;

/** Масса покупки с учётом несъедобной части (как в закупках). */
function gross(productId: string, net: number): number {
  const p = PRODUCTS[productId];
  return !p || p.unit === 'pcs' || p.edible_ratio >= 1 ? net : net / p.edible_ratio;
}

export function defaultPlace(p: Product): StockPlace {
  return p.storage === 'freezer' ? 'freezer' : p.storage === 'pantry' ? 'pantry' : 'fridge';
}

/** До какой даты годна партия: с упаковки (если указан); замороженное мясо и птица — 90 дней; иначе — общий срок хранения. */
export function lotUntil(rec: StockRec, date: ISODate): ISODate {
  if (rec.expiresOn) return rec.expiresOn;
  const p = PRODUCTS[rec.productId];
  if (!p) return addDays(date, 3);
  if (rec.location === 'freezer' && p.storage === 'fridge' && p.freezable) return addDays(date, 90);
  return addDays(date, p.shelf_days);
}

const sortMoves = (a: StockMove, b: StockMove) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at);

/** Партии на складе (FIFO: расход — из самой старой). */
export function stockLots(rec: StockRec): StockLot[] {
  const lots: StockLot[] = [];
  const frozen = rec.location === 'freezer';
  for (const m of [...rec.moves].sort(sortMoves)) {
    if (m.kind === 'purchase' || (m.kind === 'adjust' && m.qty > 0)) { lots.push({ qty: Math.abs(m.qty), date: m.date, until: lotUntil(rec, m.date), frozen }); continue; }
    let q = Math.abs(m.qty);
    for (const l of lots) { if (q <= EPS) break; const t = Math.min(l.qty, q); l.qty -= t; q -= t; }
  }
  return lots.filter((l) => l.qty > EPS);
}

export interface StockSummary {
  productId: string;
  bought: number;
  used: number;
  writtenOff: number;
  adjusted: number;
  remaining: number;
  location: StockPlace;
  until: ISODate | null;
  expired: boolean;
  /** Остаток расчётный (есть оценки) и пользователь его ещё не подтвердил. */
  needsConfirm: boolean;
}

export function stockSummary(rec: StockRec, today: ISODate): StockSummary {
  const sum = (k: StockMove['kind']) => rec.moves.filter((m) => m.kind === k).reduce((s, m) => s + m.qty, 0);
  const bought = sum('purchase'), used = sum('use'), writtenOff = sum('writeoff'), adjusted = sum('adjust');
  const lots = stockLots(rec);
  const remaining = Math.max(0, lots.reduce((s, l) => s + l.qty, 0));
  const until = lots.length ? lots.map((l) => l.until).sort()[0] : null;
  const estimated = rec.moves.some((m) => !m.confirmed && m.kind !== 'use');
  const estUse = rec.moves.some((m) => !m.confirmed && m.kind === 'use');
  return {
    productId: rec.productId, bought, used, writtenOff, adjusted, remaining: Math.round(remaining * 10) / 10, location: rec.location,
    until, expired: !!until && until < today && remaining > EPS, needsConfirm: !rec.confirmedAt && (estimated || (estUse && remaining > EPS)),
  };
}

/** Остаток на сегодня по каждому продукту — для пересчёта закупок (только годные партии). */
export function stockContext(data: AppData): Map<string, StockLot[]> {
  const out = new Map<string, StockLot[]>();
  for (const rec of Object.values(data.stock ?? {})) {
    const lots = stockLots(rec);
    if (lots.length) out.set(rec.productId, lots);
  }
  return out;
}

export function stockRemaining(data: AppData, productId: string): number {
  const rec = data.stock?.[productId];
  return rec ? stockLots(rec).reduce((s, l) => s + l.qty, 0) : 0;
}

export function emptyStock(productId: string, now: string, location?: StockPlace): StockRec {
  const p = PRODUCTS[productId];
  return { productId, location: location ?? (p ? defaultPlace(p) : 'fridge'), moves: [], confirmedAt: null, expiresOn: null, note: null, updatedAt: now };
}

let seq = 0;
const moveId = (now: string) => `mv-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${(++seq).toString(36)}`;

/** Списать продукты (готовка, приём пищи) — не больше остатка; чего нет — дефицит, а не минус. */
export function consumeOps(data: AppData, source: string, items: Map<string, number>, date: ISODate, now: string, note: string | null): { ops: Op[]; deficits: { productId: string; need: number; have: number }[] } {
  const ops: Op[] = [];
  const deficits: { productId: string; need: number; have: number }[] = [];
  const recs = new Map<string, StockRec>();
  // прежние движения этого источника убираются (повторная отметка не списывает дважды)
  for (const rec of Object.values(data.stock ?? {})) if (rec.moves.some((m) => m.source === source)) recs.set(rec.productId, { ...rec, moves: rec.moves.filter((m) => m.source !== source) });
  for (const [pid, q] of items) {
    if (!(q > EPS)) continue;
    const rec = recs.get(pid) ?? data.stock?.[pid];
    if (!rec) { deficits.push({ productId: pid, need: q, have: 0 }); continue; }
    const have = stockLots(rec).reduce((s, l) => s + l.qty, 0);
    const take = Math.min(have, q);
    if (q - take > 1) deficits.push({ productId: pid, need: q, have });
    if (take <= EPS) { recs.set(pid, rec); continue; }
    recs.set(pid, { ...rec, moves: [...rec.moves, { id: moveId(now), date, kind: 'use', qty: Math.round(take * 10) / 10, source, note, confirmed: true, at: now }], updatedAt: now });
  }
  for (const rec of recs.values()) ops.push({ store: 'stock', put: rec });
  return { ops, deficits };
}

/** Убрать движения источника (отметку сняли). */
export function releaseOps(data: AppData, source: string, now: string): Op[] {
  return Object.values(data.stock ?? {}).filter((r) => r.moves.some((m) => m.source === source)).map((r) => ({ store: 'stock', put: { ...r, moves: r.moves.filter((m) => m.source !== source), updatedAt: now } }));
}

export function inventoryOn(data: AppData, date: ISODate): boolean {
  const inv = data.settings.inventory;
  return !!inv && date >= inv.since;
}

/** Продукты партии (с заменами из проверки перед готовкой). */
export function cookProducts(e: CookingEvent, replace: Record<string, string> = {}): Map<string, number> {
  const tot = new Map<string, number>();
  for (const it of e.items ?? []) for (const [k, v] of dishProducts(it.dishId, it.qty, false)) tot.set(k, (tot.get(k) ?? 0) + v);
  const out = new Map<string, number>();
  for (const [k, v] of tot) {
    const pid = replace[k] ?? k;
    const p = PRODUCTS[pid];
    if (!p) continue;
    out.set(pid, (out.get(pid) ?? 0) + gross(pid, roundBatch(p, v)));
  }
  return out;
}

/** Свежие продукты приёма пищи (без порций из готовки). */
export function mealProducts(data: AppData, date: ISODate, slot: MealSlot): Map<string, number> {
  const out = new Map<string, number>();
  const card = data.planDays[date]?.mealCards?.[slot];
  if (!card || card.cancelled) return out;
  for (const part of card.parts) {
    if (part.cookEventId || !part.fresh) continue;
    for (const [k, v] of dishProducts(part.dishId, part.qty, false)) if (PRODUCTS[k]) out.set(k, (out.get(k) ?? 0) + gross(k, v));
  }
  return out;
}

/** Отметка приёма пищи: «Съедено» списывает свежие продукты блюда; другие отметки — возвращают. */
export function mealStockOps(data: AppData, date: ISODate, slot: MealSlot, status: string | null, now: string): Op[] {
  if (!inventoryOn(data, date)) return [];
  const source = `meal:${date}:${slot}`;
  if (status !== 'done') return releaseOps(data, source, now);
  return consumeOps(data, source, mealProducts(data, date, slot), date, now, `${MEAL_LABELS[slot]} ${fmtShort(date)}`).ops;
}

/** Готовка: «Приготовлено» списывает продукты партии; «Отменена» или снятая отметка — продукты остаются на складе. */
export function cookStockOps(data: AppData, e: CookingEvent, done: boolean, now: string, replace: Record<string, string> = {}): { ops: Op[]; deficits: { productId: string; need: number; have: number }[] } {
  if (!inventoryOn(data, e.date)) return { ops: [], deficits: [] };
  const source = `cook:${e.id}`;
  if (!done) return { ops: releaseOps(data, source, now), deficits: [] };
  return consumeOps(data, source, cookProducts(e, replace), e.date, now, `${e.title} ${fmtShort(e.date)}`);
}

// ------------------------------------------------------------------ готовая еда

export interface ReadyPortion {
  id: string;
  cookId: string;
  dishId: string;
  title: string;
  cookedOn: ISODate;
  /** Плановый приём пищи для этой порции. */
  date: ISODate;
  slot: MealSlot;
  storage: 'fridge' | 'freeze';
  /** До какого дня безопасно съесть. */
  safeUntil: ISODate;
  state: 'planned' | 'left' | 'frozen';
}

/**
 * Готовая еда: порции приготовленных партий, которые ещё не съедены. «Осталась» — приём пищи пропущен
 * (можно съесть позже в пределах срока, заморозить или списать).
 */
export function readyFood(data: AppData, today: ISODate): ReadyPortion[] {
  const out: ReadyPortion[] = [];
  const st = (id: string) => data.taskStatus[id]?.status;
  for (const e of Object.values(data.cookingEvents)) {
    if (st(`cook:${e.id}`) !== 'done' || !inventoryOn(data, e.date)) continue;
    for (const it of e.items ?? []) {
      const dish = DISHES[it.dishId];
      if (!dish) continue;
      for (const u of it.uses) {
        if (u.via) continue;
        const id = `${e.id}|${it.dishId}|${u.date}|${u.slot}`;
        const rec: ReadyFoodRec | undefined = data.readyFood?.[id];
        if (rec && rec.status !== 'frozen') continue; // съедено вне плана или списано
        const meal = st(`meal:${u.date}:${u.slot}`);
        if (meal === 'done') continue;
        const frozen = rec?.status === 'frozen' || u.storage === 'freeze';
        const safeUntil = frozen ? addDays(e.date, 30) : addDays(e.date, dish.storage.days);
        const left = meal === 'skipped' || (u.date < today && !meal);
        if (!left && u.date < today) continue;
        out.push({ id, cookId: e.id, dishId: it.dishId, title: dish.title, cookedOn: e.date, date: u.date, slot: u.slot, storage: frozen ? 'freeze' : 'fridge', safeUntil, state: rec?.status === 'frozen' ? 'frozen' : left ? 'left' : 'planned' });
      }
    }
  }
  return out.sort((a, b) => a.safeUntil.localeCompare(b.safeUntil) || a.date.localeCompare(b.date));
}

export function readyFoodOps(p: ReadyPortion, status: ReadyFoodRec['status'], now: string): Op[] {
  return [{ store: 'readyFood', put: { id: p.id, cookId: p.cookId, dishId: p.dishId, date: p.date, slot: p.slot, status, at: now } satisfies ReadyFoodRec }];
}

/** Ближайшие приёмы пищи и готовки по плану, где нужен продукт (с сегодняшнего дня). */
export function upcomingUses(data: AppData, productId: string, today: ISODate, limit = 3): string[] {
  const out: { date: ISODate; text: string }[] = [];
  for (const e of Object.values(data.cookingEvents)) {
    if (e.date < today || data.taskStatus[`cook:${e.id}`]?.status === 'done' || data.taskStatus[`cook:${e.id}`]?.status === 'skipped') continue;
    if (cookProducts(e).has(productId)) out.push({ date: e.date, text: `${fmtShort(e.date)} готовка: ${(e.items ?? []).filter((i) => dishProducts(i.dishId, 1, false).has(productId)).map((i) => DISHES[i.dishId]?.short).join(', ')}` });
  }
  for (const d of Object.values(data.planDays)) {
    if (d.date < today || !d.mealCards) continue;
    for (const s of ['breakfast', 'snack', 'lunch', 'dinner'] as MealSlot[]) {
      if (data.taskStatus[`meal:${d.date}:${s}`]?.status === 'done' || data.taskStatus[`meal:${d.date}:${s}`]?.status === 'skipped') continue;
      if (mealProducts(data, d.date, s).has(productId)) out.push({ date: d.date, text: `${fmtShort(d.date)} ${MEAL_LABELS[s].toLowerCase()}: ${DISHES[d.mealCards[s].parts[0]?.dishId]?.short ?? d.mealCards[s].title}` });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit).map((x) => x.text);
}

export function daysLeft(until: ISODate | null, today: ISODate): number | null {
  return until ? diffDays(until, today) : null;
}

/** Подпись срока: дальние сроки (круп, консервов, заморозки) — без ложной «даты в этом месяце». */
export function untilLabel(until: ISODate | null, today: ISODate): string {
  if (!until) return '—';
  const d = diffDays(until, today);
  if (d > 120) return 'долгий срок';
  if (d > 45) return `до ${until.slice(8, 10)}.${until.slice(5, 7)}.${until.slice(0, 4)}`;
  return `до ${fmtShort(until)}`;
}
