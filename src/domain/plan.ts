// План питания на реальные даты: шаблон (дни 1–30 и день 0 «накануне») → дни, готовки и закупки.
// Всё считается от даты старта и номера релакс-дня; тренировки от этого не зависят.
import type { Op } from '../state/idb';
import type {
  AppData, CookingEvent, CookItem, CookUse, MealCard, MealCardPart, MealSlot, PlanDay, PlanSettings, ShopLine,
  ShoppingEvent, ShoppingItem, ShoppingNeed,
} from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { addDays, diffDays, fmtShort, isWeekend, type ISODate } from '../lib/dates';
import {
  DISHES, PRODUCTS, TEMPLATE, dishNutrition, dishProducts, roundBatch, sumNutrition, type DishNutrition, type TplBlock,
} from './catalog';

export const BASE_START: ISODate = TEMPLATE.base_start;
export const PLAN_LENGTH = TEMPLATE.length;
export const DEFAULT_RELAX = TEMPLATE.relax_day;
export const BUDGET_RUB = TEMPLATE.budget_rub;
export const KCAL_TARGET = TEMPLATE.kcal_target;
/** Вторая основная закупка — к первой основной готовке начиная с этого дня шаблона. */
export const SECOND_SHOP_DAY = 14;
export const DRINKS_TEXT = 'Вода, травяные чаи и морсы без сахара. Без кофе, энергетиков, сладких лимонадов и алкоголя.';

const MENU_DAYS: number[] = TEMPLATE.days.filter((d) => !d.relax).map((d) => d.day);

export function instanceIdFor(start: ISODate): string {
  return `p${start.replace(/-/g, '')}`;
}

export function makePlanSettings(startDate: ISODate, relaxDay: number, now: string, confirmed = true): PlanSettings {
  return { startDate, relaxDay, instanceId: instanceIdFor(startDate), confirmed, setAt: now };
}

/** Позиция дня в плане (1–30) для дня шаблона; 0 — «накануне старта». Релакс-день сдвигает меню после себя. */
export function positionOf(templateDay: number, relaxDay: number): number {
  if (templateDay <= 0) return templateDay;
  const k = MENU_DAYS.indexOf(templateDay) + 1;
  if (k <= 0) return relaxDay;
  return k < relaxDay ? k : k + 1;
}

/** Обратное: какой день шаблона стоит на позиции (null — релакс-день). */
export function templateDayAt(pos: number, relaxDay: number): number | null {
  if (pos === relaxDay) return null;
  const k = pos < relaxDay ? pos : pos - 1;
  return MENU_DAYS[k - 1] ?? null;
}

export function dateAt(cfg: PlanSettings, pos: number): ISODate {
  return addDays(cfg.startDate, pos - 1);
}

export function planEnd(cfg: PlanSettings): ISODate {
  return addDays(cfg.startDate, PLAN_LENGTH - 1);
}

export function relaxDate(cfg: PlanSettings): ISODate {
  return dateAt(cfg, cfg.relaxDay);
}

/** Номер дня плана для даты (1–30) или null. */
export function planPosition(cfg: PlanSettings | null, date: ISODate): number | null {
  if (!cfg) return null;
  const n = diffDays(date, cfg.startDate) + 1;
  return n >= 1 && n <= PLAN_LENGTH ? n : null;
}

// ------------------------------------------------------------------ экземпляр плана

export interface PlanIssue { level: 'info' | 'warn' | 'error'; text: string }

export interface PlanInstance {
  cfg: PlanSettings;
  planDays: PlanDay[];
  cookingEvents: CookingEvent[];
  shoppingEvents: ShoppingEvent[];
  issues: PlanIssue[];
  totalCost: number;
}

function cookId(cfg: PlanSettings, blockId: string) { return `cook-${cfg.instanceId}-${blockId}`; }

interface Scheduled { block: TplBlock; date: ISODate; time: string; note: string | null; pos: number }

function scheduleBlock(cfg: PlanSettings, b: TplBlock, today: ISODate | null): Scheduled {
  const pos = positionOf(b.day, cfg.relaxDay);
  let date = dateAt(cfg, pos);
  let time: string;
  let note: string | null = null;
  if (b.when === 'morning') {
    if (isWeekend(date)) time = '10:00';
    else {
      date = addDays(date, -1);
      time = '19:00';
      note = 'Блюда нужны уже к обеду, а в будний день утром готовить некогда, — готовка накануне вечером.';
    }
  } else time = b.kind === 'quick' ? '19:30' : isWeekend(date) ? '17:00' : '19:00';
  if (b.day === 0 && today && date < today && cfg.startDate >= today) {
    date = today;
    time = '10:00';
    note = 'План начинается сегодня — первую закупку и готовку нужно сделать сегодня до обеда.';
  }
  return { block: b, date, time, note, pos };
}

function storageFor(dishId: string, cookDate: ISODate, useDate: ISODate): CookUse['storage'] {
  const st = DISHES[dishId].storage;
  const gap = diffDays(useDate, cookDate);
  if (st.place === 'pantry') return 'pantry';
  return gap <= st.days ? 'fridge' : 'freeze';
}

function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

function rangeText(dates: ISODate[]): string {
  if (!dates.length) return '';
  const s = [...dates].sort();
  return s[0] === s[s.length - 1] ? fmtShort(s[0]) : `${fmtShort(s[0])}–${fmtShort(s[s.length - 1])}`;
}

export function buildInstance(cfg: PlanSettings, today: ISODate | null = null): PlanInstance {
  const issues: PlanIssue[] = [];
  // ---- дни
  const planDays: PlanDay[] = [];
  const cardsByDate = new Map<ISODate, Record<MealSlot, MealCard>>();
  for (let pos = 1; pos <= PLAN_LENGTH; pos++) {
    const date = dateAt(cfg, pos);
    const td = templateDayAt(pos, cfg.relaxDay);
    if (td == null) {
      planDays.push({
        date, source: 'seed', patchId: null, dayNumber: pos, relax: true, meals: null,
        relaxMealsText: { breakfast: 'Свободный выбор', lunch: 'Свободный выбор', snack: 'По желанию', dinner: 'Свободный выбор' },
        training: null, drinks: 'Свободное меню, но без алкоголя. Вода, чаи и морсы без сахара.', note: 'Релакс-день: меню свободное, алкоголь исключён.',
        kcalNote: null, instanceId: cfg.instanceId, templateDay: null, mealCards: null,
      });
      continue;
    }
    const tday = TEMPLATE.days.find((d) => d.day === td)!;
    const cards = {} as Record<MealSlot, MealCard>;
    for (const slot of MEAL_SLOTS) {
      const parts: MealCardPart[] = tday.meals![slot].parts.map((p) => ({ dishId: p.dish, qty: p.qty, fresh: p.fresh, cookEventId: null, storage: null, thawOn: null }));
      cards[slot] = { title: mealTitle(parts), parts };
    }
    cardsByDate.set(date, cards);
    planDays.push({
      date, source: 'seed', patchId: null, dayNumber: pos, relax: false,
      meals: Object.fromEntries(MEAL_SLOTS.map((s) => [s, cards[s].title])) as Record<MealSlot, string>,
      relaxMealsText: null, training: null, drinks: DRINKS_TEXT, note: null, kcalNote: null,
      instanceId: cfg.instanceId, templateDay: td, mealCards: cards,
    });
  }

  // ---- готовки
  const cookingEvents: CookingEvent[] = [];
  for (const b of TEMPLATE.blocks) {
    const sc = scheduleBlock(cfg, b, today);
    const id = cookId(cfg, b.id);
    const items: CookItem[] = [];
    const useDates: ISODate[] = [];
    let frozen = 0;
    for (const it of b.items) {
      const uses: CookUse[] = it.uses.map((u) => {
        const date = dateAt(cfg, positionOf(u.day, cfg.relaxDay));
        const storage = storageFor(it.dish, sc.date, date);
        if (storage === 'freeze') frozen++;
        if (storage === 'freeze' && !DISHES[it.dish].storage.freezable) issues.push({ level: 'error', text: `${DISHES[it.dish].title}: не хранится до ${fmtShort(date)}` });
        if (storage !== 'pantry') useDates.push(date);
        const card = cardsByDate.get(date)?.[u.slot];
        const part = card?.parts.find((p) => (u.via ? p.dishId === u.via : p.dishId === it.dish && !p.fresh));
        if (part && !u.via) { part.cookEventId = id; part.storage = storage; part.thawOn = storage === 'freeze' ? addDays(date, -1) : null; }
        return { date, slot: u.slot, qty: u.qty, via: u.via, storage, thawOn: storage === 'freeze' ? addDays(date, -1) : null };
      });
      items.push({ dishId: it.dish, qty: Math.round(uses.reduce((s, u) => s + u.qty, 0) * 1000) / 1000, uses });
    }
    const forDates = Array.from(new Set(useDates)).sort();
    cookingEvents.push({
      id, date: sc.date, eventType: 'meal_prep',
      title: b.kind === 'quick' ? 'Быстрая готовка перед ужином' : 'Основная готовка',
      sourceText: items.map((i) => DISHES[i.dishId].title).join('; '),
      forDaysText: `на ${rangeText(forDates)}`, forDates,
      storage: frozen ? 'Порции на ближайшие дни — в холодильник, остальное — сразу в морозилку (см. по каждому блюду).' : 'Остудить и убрать в холодильник; съесть в течение срока хранения.',
      dishes: items.map((i) => ({ text: DISHES[i.dishId].title, recipeIds: [i.dishId], comment: null })),
      source: 'seed', patchId: null, instanceId: cfg.instanceId, blockId: b.id, kind: b.kind, time: sc.time, timeNote: sc.note,
      items, thawProducts: [],
    });
  }
  cookingEvents.sort((a, b) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? '')));

  // ---- закупки
  const shopping = buildShopping(cfg, planDays, cookingEvents, today, issues);

  // разморозка сырых продуктов к готовке
  for (const ce of cookingEvents) {
    const thaw = new Map<string, number>();
    for (const n of shopping.thawNeeds.filter((x) => x.cookId === ce.id)) thaw.set(n.productId, (thaw.get(n.productId) ?? 0) + n.qty);
    ce.thawProducts = Array.from(thaw, ([productId, qty]) => ({ productId, qty: Math.round(qty) }));
  }
  for (const d of planDays) if (d.mealCards) for (const s of MEAL_SLOTS) d.meals![s] = d.mealCards[s].title;
  const totalCost = shopping.events.reduce((s, e) => s + (e.lines ?? []).reduce((x, l) => x + l.cost, 0), 0);
  if (totalCost > BUDGET_RUB) issues.push({ level: 'warn', text: `Ориентировочная сумма закупок ${Math.round(totalCost)} ₽ больше бюджета ${BUDGET_RUB} ₽. Можно заменить сёмгу на форель или хек и часть греческого йогурта — на кефир.` });
  return { cfg, planDays, cookingEvents, shoppingEvents: shopping.events, issues, totalCost };
}

export function mealTitle(parts: MealCardPart[]): string {
  return parts.map((p, i) => {
    const d = DISHES[p.dishId];
    const t = d ? d.short : p.dishId;
    return i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1);
  }).join(' + ');
}

// ------------------------------------------------------------------ закупки

interface Need { productId: string; qty: number; date: ISODate; label: string; cookId: string | null }

/** Масса покупки с учётом несъедобной части (кожура, сердцевина). */
function gross(productId: string, net: number): number {
  const p = PRODUCTS[productId];
  return p.unit === 'pcs' || p.edible_ratio >= 1 ? net : net / p.edible_ratio;
}

export function collectNeeds(planDays: PlanDay[], cookingEvents: CookingEvent[]): Need[] {
  const needs: Need[] = [];
  for (const ce of cookingEvents) {
    const tot = new Map<string, number>();
    for (const it of ce.items ?? []) for (const [k, v] of dishProducts(it.dishId, it.qty, false)) tot.set(k, (tot.get(k) ?? 0) + v);
    for (const [k, v] of tot) needs.push({ productId: k, qty: gross(k, roundBatch(PRODUCTS[k], v)), date: ce.date, label: `${ce.kind === 'quick' ? 'Быстрая готовка' : 'Готовка'} ${fmtShort(ce.date)}`, cookId: ce.id });
  }
  for (const d of planDays) {
    if (!d.mealCards) continue;
    for (const slot of MEAL_SLOTS) {
      for (const part of d.mealCards[slot].parts) {
        if (!part.fresh) continue;
        // завтрак, обед и перекус в будни собираются накануне вечером
        const date = slot === 'dinner' ? d.date : addDays(d.date, -1);
        for (const [k, v] of dishProducts(part.dishId, part.qty, false)) needs.push({ productId: k, qty: gross(k, v), date, label: `${MEAL_LABELS[slot]} ${fmtShort(d.date)}`, cookId: null });
      }
    }
  }
  return needs.filter((n) => n.qty > 0);
}

function packNoun(label: string): string {
  return /^1 /.test(label) ? 'шт.' : 'уп.';
}

function isByWeight(productId: string) {
  return /по весу/.test(PRODUCTS[productId].pack.label);
}

function shopTime(date: ISODate, kind: 'main' | 'topup'): string {
  if (kind === 'main') return isWeekend(date) ? '09:30' : '18:00';
  return isWeekend(date) ? '10:00' : '18:30';
}

interface ShopBuild { events: ShoppingEvent[]; thawNeeds: { cookId: string; productId: string; qty: number }[] }

function buildShopping(cfg: PlanSettings, planDays: PlanDay[], cooks: CookingEvent[], today: ISODate | null, issues: PlanIssue[]): ShopBuild {
  const needs = collectNeeds(planDays, cooks);
  const mainBlocks = cooks.filter((c) => c.kind === 'main');
  const m1Cook = cooks.find((c) => c.blockId === 'd0') ?? mainBlocks[0];
  const second = TEMPLATE.blocks.filter((b) => b.kind === 'main' && b.day >= SECOND_SHOP_DAY).sort((a, b) => a.day - b.day)[0];
  const m2Cook = cooks.find((c) => c.blockId === second?.id) ?? null;
  const mains = [
    { id: `shop-${cfg.instanceId}-m1`, date: m1Cook.date, title: 'Основная закупка 1' },
    ...(m2Cook ? [{ id: `shop-${cfg.instanceId}-m2`, date: m2Cook.date, title: 'Основная закупка 2' }] : []),
  ];
  for (const n of needs) if (n.date < mains[0].date) n.date = mains[0].date;

  // окно основной закупки
  const mainOf = (date: ISODate) => (mains.length > 1 && date >= mains[1].date ? mains[1] : mains[0]);
  // скоропортящееся, которое нельзя заморозить, — докупка ближе к дате
  const topupNeeds: Need[] = [];
  const freezeAt = new Map<Need, string>();
  for (const n of needs) {
    const p = PRODUCTS[n.productId];
    const m = mainOf(n.date);
    const gap = diffDays(n.date, m.date);
    if (p.storage !== 'fridge' || gap <= p.shelf_days) continue;
    if (p.freezable) freezeAt.set(n, m.id);
    else topupNeeds.push(n);
  }
  const candidates = Array.from(new Set(TEMPLATE.topup_candidates.map((d) => dateAt(cfg, positionOf(d, cfg.relaxDay))))).sort();
  const chosen: ISODate[] = [];
  const topupOf = new Map<Need, ISODate>();
  const intervals = topupNeeds.map((n) => ({ n, from: addDays(n.date, -PRODUCTS[n.productId].shelf_days), to: n.date })).sort((a, b) => a.to.localeCompare(b.to));
  for (const iv of intervals) {
    let t = chosen.filter((c) => c >= iv.from && c <= iv.to).sort().pop();
    if (!t) {
      t = candidates.filter((c) => c >= iv.from && c <= iv.to).pop() ?? iv.to;
      chosen.push(t);
    }
    topupOf.set(iv.n, t);
  }
  chosen.sort();
  const topups = chosen.map((d, i) => ({ id: `shop-${cfg.instanceId}-t${i + 1}`, date: d, title: 'Докупка свежего' }));

  type Ev = { id: string; date: ISODate; title: string; kind: 'main' | 'topup'; needs: Need[] };
  const evs: Ev[] = [...mains.map((m) => ({ ...m, kind: 'main' as const, needs: [] as Need[] })), ...topups.map((t) => ({ ...t, kind: 'topup' as const, needs: [] as Need[] }))];
  evs.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'main' ? -1 : 1));
  for (const n of needs) {
    const t = topupOf.get(n);
    const id = t ? topups.find((x) => x.date === t)!.id : mainOf(n.date).id;
    evs.find((e) => e.id === id)!.needs.push(n);
  }

  // остатки: партии с датой «годен до»
  const lots = new Map<string, { qty: number; until: ISODate }[]>();
  const thawNeeds: ShopBuild['thawNeeds'] = [];
  const events: ShoppingEvent[] = [];
  for (const e of evs) {
    const byProduct = new Map<string, Need[]>();
    for (const n of e.needs) { const a = byProduct.get(n.productId) ?? []; a.push(n); byProduct.set(n.productId, a); }
    const lines: ShopLine[] = [];
    for (const [pid, ns] of byProduct) {
      const p = PRODUCTS[pid];
      ns.sort((a, b) => a.date.localeCompare(b.date));
      const stock = lots.get(pid) ?? [];
      let fromStock = 0, rest = 0;
      for (const n of ns) {
        let q = n.qty;
        for (const lot of stock) {
          if (lot.until < n.date || lot.qty <= 1e-6) continue;
          const take = Math.min(lot.qty, q);
          lot.qty -= take; q -= take; fromStock += take;
          if (q <= 1e-6) break;
        }
        rest += q;
      }
      let buy = 0, packs: number | null = null;
      if (rest > 1e-6) {
        if (isByWeight(pid)) {
          if (p.piece_g) {
            const net = p.edible_ratio < 1 ? rest * p.edible_ratio : rest;
            const pcs = Math.ceil(net / p.piece_g - 0.05);
            buy = Math.max(rest, Math.round(pcs * p.piece_g / (p.edible_ratio || 1)));
          } else buy = Math.ceil(rest / 50) * 50;
        } else {
          packs = Math.ceil(rest / p.pack.size - 1e-9);
          buy = packs * p.pack.size;
        }
      }
      const leftover = Math.max(0, buy - rest);
      const need = ns.reduce((s, n) => s + n.qty, 0);
      const freezeNow = ns.filter((n) => freezeAt.get(n) === e.id).reduce((s, n) => s + n.qty, 0);
      const notes: string[] = [];
      if (freezeNow > 0) {
        const late = ns.filter((n) => freezeAt.get(n) === e.id);
        notes.push(`Сразу заморозить ${fmtQ(pid, freezeNow)} — понадобится ${Array.from(new Set(late.map((n) => fmtShort(n.date)))).join(', ')}; разморозить в холодильнике накануне.`);
        for (const n of late) if (n.cookId) thawNeeds.push({ cookId: n.cookId, productId: pid, qty: n.qty });
      }
      if (p.storage === 'freezer' && THAW_CATEGORIES.includes(p.category)) for (const n of ns) if (n.cookId) thawNeeds.push({ cookId: n.cookId, productId: pid, qty: n.qty });
      if (leftover > 0.5) {
        const until = addDays(e.date, p.storage === 'fridge' && p.freezable ? 90 : p.shelf_days);
        stock.push({ qty: leftover, until });
        lots.set(pid, stock);
        if (p.storage === 'fridge' && p.freezable && leftover >= p.pack.size * 0.1) notes.push(`Останется ≈${fmtQ(pid, leftover)} — заморозить, пригодится в следующих готовках.`);
      }
      const cost = (p.unit === 'pcs' ? buy : buy / 1000) * p.price;
      lines.push({
        productId: pid, need: round1(need), fromStock: round1(fromStock), buy: round1(buy), packs, cost: Math.round(cost),
        leftover: round1(leftover), freezeNow: round1(freezeNow), notes,
        needs: ns.map((n): ShoppingNeed => ({ date: n.date, label: n.label, qty: round1(n.qty) })),
      });
    }
    const cats = TEMPLATE.categories;
    lines.sort((a, b) => cats.indexOf(PRODUCTS[a.productId].category) - cats.indexOf(PRODUCTS[b.productId].category) || PRODUCTS[a.productId].name.localeCompare(PRODUCTS[b.productId].name, 'ru'));
    const dates = e.needs.map((n) => n.date);
    const covers = dates.length ? { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) } : null;
    const items: ShoppingItem[] = lines.map((l) => ({
      itemId: l.productId, category: PRODUCTS[l.productId].category, name: PRODUCTS[l.productId].name,
      unit: PRODUCTS[l.productId].unit === 'g' ? 'г' : PRODUCTS[l.productId].unit === 'ml' ? 'мл' : 'шт.',
      qty: l.buy, pricePerUnit: PRODUCTS[l.productId].price, priceEstimate: l.cost, note: l.notes.join(' ') || null,
    }));
    // закупка — до первой готовки этого дня
    const cookTime = cooks.filter((c) => c.date === e.date).map((c) => c.time ?? '').sort()[0];
    const cm = cookTime ? /(\d{1,2}):(\d{2})/.exec(cookTime) : null;
    const time = cm ? `${String(Math.max(7, +cm[1] - 1)).padStart(2, '0')}:${cm[2]}` : shopTime(e.date, e.kind);
    events.push({
      id: e.id, date: e.date, title: e.title, kind: e.kind, time,
      forDatesText: covers ? rangeText([covers.from, covers.to]) : null, covers,
      items, lines, source: 'seed', patchId: null, instanceId: cfg.instanceId,
    });
  }
  if (topups.length) issues.push({ level: 'info', text: `Скоропортящиеся продукты (молочное, бананы, зелень, томаты и т. п.) нельзя купить на 2 недели вперёд: запланировано ${topups.length} ${plural(topups.length, 'небольшая докупка', 'небольшие докупки', 'небольших докупок')} свежего.` });
  if (today && mains[0].date < today && cfg.startDate >= today) issues.push({ level: 'warn', text: 'Первая закупка уже должна была пройти.' });
  return { events, thawNeeds };
}

const THAW_CATEGORIES = ['Рыба и морепродукты', 'Мясо и птица'];

function round1(x: number) { return Math.round(x * 10) / 10; }

function fmtQ(pid: string, q: number): string {
  const p = PRODUCTS[pid];
  if (p.unit === 'pcs') return `${Math.round(q)} шт.`;
  const u = p.unit === 'g' ? ['г', 'кг'] : ['мл', 'л'];
  return q >= 1000 ? `${(Math.round(q / 10) / 100).toLocaleString('ru-RU')} ${u[1]}` : `${Math.round(q)} ${u[0]}`;
}

/** Покупка для показа: «2 × лоток ≈900 г», «≈7 шт. (≈1,3 кг)», «550 г». */
export function buyText(l: ShopLine): string {
  const p = PRODUCTS[l.productId];
  if (l.buy <= 0) return 'не нужно — хватит остатка';
  if (l.packs != null) {
    if (p.unit === 'pcs') return `${l.packs} × ${p.pack.label}`;
    return packNoun(p.pack.label) === 'шт.' ? `${l.packs} шт.` : `${l.packs} × ${p.pack.label}`;
  }
  if (p.piece_g) {
    const pcs = Math.round(l.buy * (p.edible_ratio || 1) / p.piece_g);
    return `≈${pcs} шт. (≈${fmtQ(l.productId, l.buy)})`;
  }
  return `≈${fmtQ(l.productId, l.buy)} (по весу)`;
}

export function needText(l: ShopLine): string {
  return fmtQ(l.productId, l.need);
}

// ------------------------------------------------------------------ калорийность

export function cardNutrition(card: MealCard): DishNutrition {
  return sumNutrition(card.parts.map((p) => dishNutrition(p.dishId, p.qty)));
}

export function dayNutrition(day: PlanDay): DishNutrition | null {
  if (!day.mealCards) return null;
  return sumNutrition(MEAL_SLOTS.map((s) => cardNutrition(day.mealCards![s])));
}

// ------------------------------------------------------------------ применение к данным

export interface ReplanResult {
  ops: Op[];
  instance: PlanInstance;
  /** Отметки, которые относятся к прежнему плану и попадают в изменяемые даты. */
  mealMarks: number;
  eventMarks: string[];
  importedKept: number;
}

function hasDayMarks(data: AppData, date: ISODate): boolean {
  return Object.values(data.taskStatus).some((s) => s.status !== 'planned' && (s.taskId.startsWith(`meal:${date}:`) || s.taskId === `box:${date}`));
}

/**
 * Операции, чтобы перейти на новый план (дата старта, релакс-день).
 * Прошедшие дни с отметками остаются историей; тренировки, вес, фото и отметки не удаляются.
 * force — заменить и прошедшие дни (миграция: даты те же, меню подробнее).
 */
export function replanOps(data: AppData, cfg: PlanSettings, today: ISODate, opts: { force?: boolean; now?: string } = {}): ReplanResult {
  const inst = buildInstance(cfg, today);
  const ops: Op[] = [];
  const newDays = new Map(inst.planDays.map((d) => [d.date, d]));
  let mealMarks = 0, importedKept = 0;
  const keepOld = (date: ISODate) => !opts.force && date < today && hasDayMarks(data, date);
  for (const old of Object.values(data.planDays)) {
    if (old.source !== 'seed') continue;
    if (keepOld(old.date)) { newDays.delete(old.date); continue; }
    if (!newDays.has(old.date)) ops.push({ store: 'planDays', del: old.date });
  }
  for (const d of newDays.values()) {
    const old = data.planDays[d.date];
    if (old && old.source === 'import') { importedKept++; continue; }
    if (old && old.source === 'seed' && old.instanceId !== cfg.instanceId && d.date >= today && hasDayMarks(data, d.date)) mealMarks++;
    ops.push({ store: 'planDays', put: d });
  }
  const eventMarks: string[] = [];
  const newIds = new Set([...inst.cookingEvents.map((e) => e.id), ...inst.shoppingEvents.map((e) => e.id)]);
  for (const [store, prefix] of [['cookingEvents', 'cook'], ['shoppingEvents', 'shop']] as const) {
    for (const e of Object.values(data[store]) as (CookingEvent | ShoppingEvent)[]) {
      if (e.source !== 'seed' || newIds.has(e.id)) continue;
      if (!opts.force && e.date < today) continue; // история
      const st = data.taskStatus[`${prefix}:${e.id}`]?.status;
      if (st && st !== 'planned') eventMarks.push(`${prefix === 'cook' ? 'Готовка' : 'Закупка'} ${fmtShort(e.date)}`);
      ops.push({ store, del: e.id });
    }
  }
  for (const e of inst.cookingEvents) ops.push({ store: 'cookingEvents', put: e });
  for (const e of inst.shoppingEvents) ops.push({ store: 'shoppingEvents', put: e });
  ops.push({ store: 'settings', put: { ...data.settings, plan: cfg } });
  return { ops, instance: inst, mealMarks, eventMarks, importedKept };
}

/** Текущий план (по записям), если он создан из шаблона. */
export function currentInstanceDays(data: AppData): PlanDay[] {
  const id = data.settings.plan?.instanceId;
  return Object.values(data.planDays).filter((d) => d.instanceId === id).sort((a, b) => a.date.localeCompare(b.date));
}

/** Остаток порций партии на дату: приготовлено минус отмеченные съеденными приёмы. */
export function portionsLeft(data: AppData, e: CookingEvent, it: CookItem): { total: number; eaten: number; left: number } {
  let eaten = 0;
  for (const u of it.uses) {
    const st = data.taskStatus[`meal:${u.date}:${u.slot}`]?.status;
    if (st === 'done') eaten += u.qty;
  }
  const total = it.qty;
  return { total, eaten: Math.min(total, eaten), left: Math.max(0, Math.round((total - eaten) * 100) / 100) };
}
