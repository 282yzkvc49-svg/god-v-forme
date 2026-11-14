// Экспорт всех товаров из раздела «Закупки» в JSON — для сверки каждой позиции с каталогом «Азбуки вкуса».
// Одна запись items[] — один товар в одной закупке, как строка в приложении; ничего не объединяется и не сокращается.
// Цены — ориентир по ценам av.ru на дату снимка комплекта, а не собранная корзина.
import type { AppData, ShoppingEvent } from '../state/types';
import type { ISODate } from '../lib/dates';
import { BASE_PRODUCTS, PRODUCTS, TEMPLATE, qtyFactor, type Product } from './catalog';
import { BUDGET_RUB, buyText, needText, planEnd } from './plan';
import { avState } from './avCheck';

export const SHOP_EXPORT_SCHEMA = 'god-v-forme/shopping-products';
export const SHOP_EXPORT_VERSION = '1.0.0';

const UNIT_RU: Record<Product['unit'], string> = { g: 'г', ml: 'мл', pcs: 'шт.' };
const KIND_RU: Record<string, string> = { main: 'основная закупка', topup: 'докупка свежего', trip: 'перекусы в командировку', other: 'закупка' };

/** Номер карточки из адреса https://av.ru/i/<номер>. */
export function avCardNumber(url: string | null | undefined): string | null {
  const m = /^https:\/\/av\.ru\/i\/(\d+)\/?$/.exec(url ?? '');
  return m ? m[1] : null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface Substitution { original_name: string; original_av_url: string | null; grams_factor: number }

function substitution(id: string): Substitution | null {
  const p = PRODUCTS[id], orig = BASE_PRODUCTS[id];
  if (!p?.substituteFor || !orig) return null;
  return { original_name: orig.name, original_av_url: orig.url ?? null, grams_factor: qtyFactor(id) };
}

function taskStatus(data: AppData, e: ShoppingEvent, today: ISODate): 'done' | 'skipped' | 'planned' | 'not_logged' {
  const st = data.taskStatus[`shop:${e.id}`]?.status;
  if (st === 'done' || st === 'skipped') return st;
  const d = data.taskMoves[`shop:${e.id}`]?.toDate ?? e.date;
  return d < today ? 'not_logged' : 'planned';
}

export interface ShopExportItem {
  purchase_id: string;
  purchase_date: ISODate;
  purchase_time: string | null;
  purchase_title: string;
  purchase_kind: string;
  purchase_kind_label: string;
  purchase_in_current_plan: boolean;
  line_no: number;
  product_id: string;
  name: string;
  category: string;
  quantity_needed: number | null;
  quantity_from_stock: number | null;
  quantity_to_buy: number;
  unit: string;
  unit_label: string;
  quantity_needed_text: string | null;
  to_buy_text: string;
  packs: number | null;
  pack_size: number | null;
  pack_unit: string | null;
  pack_label: string | null;
  price_per_pack_rub: number | null;
  price_per_unit_rub: number | null;
  price_unit: string | null;
  planned_cost_rub: number;
  counted_in_total: boolean;
  av_url: string | null;
  av_card_number: string | null;
  article: string | null;
  listing_status: string | null;
  /** Подтверждённая пользователем замена недоступного товара: что было в меню. */
  substitution: Substitution | null;
  archived_product: boolean;
  availability_check: string | null;
  bought: boolean;
  at_home: boolean;
  actual_price_rub: number | null;
  needed_for: { date: ISODate; use_date: ISODate | null; what: string; quantity: number }[];
  notes: string[];
}

export function buildShoppingExport(data: AppData, today: ISODate, appVersion: string, generatedAt: string) {
  const cfg = data.settings.plan;
  const events = Object.values(data.shoppingEvents).sort((a, b) => (a.date + (a.time ?? '') + a.title).localeCompare(b.date + (b.time ?? '') + b.title));
  const all: ShopExportItem[] = [];
  const allPurchases = events.map((e) => {
    const kind = e.kind ?? 'other';
    const current = !cfg || e.instanceId === cfg.instanceId || !e.instanceId;
    const base = {
      purchase_id: e.id, purchase_date: e.date, purchase_time: e.time ?? null, purchase_title: e.title,
      purchase_kind: kind, purchase_kind_label: KIND_RU[kind] ?? KIND_RU.other, purchase_in_current_plan: current,
    };
    let cost = 0, n = 0;
    if (e.lines) {
      e.lines.forEach((l, i) => {
        const p = PRODUCTS[l.productId];
        const chk = data.shoppingChecks[`${e.id}:${l.productId}`];
        const atHome = !!chk?.atHome;
        const it: ShopExportItem = {
          ...base, line_no: i + 1, product_id: l.productId,
          name: p?.name ?? l.productId, category: p?.category ?? '',
          quantity_needed: r2(l.need), quantity_from_stock: r2(l.fromStock), quantity_to_buy: r2(l.buy),
          unit: p?.unit ?? '', unit_label: p ? UNIT_RU[p.unit] : '',
          quantity_needed_text: p ? needText(l) : null, to_buy_text: p ? buyText(l) : String(l.buy),
          packs: l.packs, pack_size: p?.pack.size ?? null, pack_unit: p ? UNIT_RU[p.unit] : null, pack_label: p?.pack.label ?? null,
          price_per_pack_rub: p?.pack_price ?? null, price_per_unit_rub: p?.price ?? null,
          price_unit: p ? (p.unit === 'pcs' ? '₽ за шт.' : p.unit === 'g' ? '₽ за кг' : '₽ за л') : null,
          planned_cost_rub: l.cost, counted_in_total: !atHome,
          av_url: p?.url ?? null, av_card_number: avCardNumber(p?.url), article: null,
          listing_status: p?.listing_status ?? null,
          substitution: substitution(l.productId),
          archived_product: !!p?.archived,
          availability_check: p?.url && kind !== 'trip' ? avState(data, l.productId) : null,
          bought: !!chk?.bought, at_home: atHome, actual_price_rub: chk?.actualPrice ?? null,
          needed_for: l.needs.map((x) => ({ date: x.date, use_date: x.use ?? null, what: x.label, quantity: r2(x.qty) })),
          notes: l.notes,
        };
        all.push(it);
        if (!atHome) cost += l.cost;
        n++;
      });
    } else {
      e.items.forEach((x, i) => {
        const chk = data.shoppingChecks[`${e.id}:${x.itemId}`];
        all.push({
          ...base, line_no: i + 1, product_id: x.itemId, name: x.name, category: x.category,
          quantity_needed: null, quantity_from_stock: null, quantity_to_buy: x.qty, unit: x.unit, unit_label: x.unit,
          quantity_needed_text: null, to_buy_text: `${x.qty} ${x.unit}`,
          packs: null, pack_size: null, pack_unit: null, pack_label: null,
          price_per_pack_rub: null, price_per_unit_rub: x.pricePerUnit, price_unit: x.pricePerUnit != null ? `₽ за ${x.unit}` : null,
          planned_cost_rub: x.priceEstimate ?? 0, counted_in_total: true,
          av_url: null, av_card_number: null, article: null, listing_status: null,
          substitution: null, archived_product: true,
          availability_check: null, bought: !!chk?.bought, at_home: !!chk?.atHome, actual_price_rub: chk?.actualPrice ?? null,
          needed_for: [], notes: x.note ? [x.note] : [],
        });
        cost += x.priceEstimate ?? 0;
        n++;
      });
    }
    return {
      ...base, status: taskStatus(data, e, today), moved_to: data.taskMoves[`shop:${e.id}`]?.toDate ?? null,
      for_dates: e.forDatesText ?? null, covers: e.covers ?? null, items_count: n, planned_cost_rub: Math.round(cost),
      in_home_budget: kind !== 'trip',
    };
  });
  // закупки текущего меню — items; закупки прежних планов, оставшиеся в разделе «Закупки» как история, — history_items
  const items = all.filter((i) => i.purchase_in_current_plan);
  const historyItems = all.filter((i) => !i.purchase_in_current_plan);
  const purchases = allPurchases.filter((p) => p.purchase_in_current_plan);
  const historyPurchases = allPurchases.filter((p) => !p.purchase_in_current_plan);
  // справочник: каждый товар текущих закупок один раз (для сверки карточки); позиции закупок — в items
  const productIds = Array.from(new Set(items.filter((i) => PRODUCTS[i.product_id]).map((i) => i.product_id)));
  const products = productIds.map((id) => {
    const p = PRODUCTS[id];
    const rows = items.filter((i) => i.product_id === id);
    return {
      product_id: id, name: p.name, category: p.category, unit: p.unit, unit_label: UNIT_RU[p.unit],
      pack_size: p.pack.size, pack_label: p.pack.label, price_per_pack_rub: p.pack_price ?? null,
      av_url: p.url ?? null, av_card_number: avCardNumber(p.url), article: null, listing_status: p.listing_status ?? null,
      catalog_checked_date: p.checked_date ?? null, archived_product: !!p.archived,
      substitution: substitution(id),
      availability_check: p.url ? avState(data, id) : null,
      purchases: rows.map((r) => `${r.purchase_date} ${r.purchase_title}`),
      total_to_buy: r2(rows.reduce((s, r) => s + r.quantity_to_buy, 0)),
      total_packs: rows.every((r) => r.packs != null) ? rows.reduce((s, r) => s + (r.packs ?? 0), 0) : null,
      total_planned_cost_rub: Math.round(rows.reduce((s, r) => s + (r.counted_in_total ? r.planned_cost_rub : 0), 0)),
    };
  });
  const home = purchases.filter((p) => p.in_home_budget);
  return {
    schema: SHOP_EXPORT_SCHEMA,
    schema_version: SHOP_EXPORT_VERSION,
    app: { name: 'Мой год в форме', version: appVersion },
    generated_at: generatedAt,
    today,
    menu: { id: cfg?.menuId ?? null, template_id: TEMPLATE.id, start_date: cfg?.startDate ?? null, end_date: cfg ? planEnd(cfg) : null },
    notes: [
      'items — полный список: одна запись = один товар в одной закупке, как строка в разделе «Закупки». Ничего не объединено и не пропущено, включая позиции «хватит остатка» (quantity_to_buy = 0) и «есть дома».',
      'quantity_needed — сколько нужно по меню к этой закупке (масса покупки с учётом несъедобной части); quantity_from_stock — покроет остаток прошлых закупок; quantity_to_buy — сколько купить. Единицы: g — граммы, ml — миллилитры, pcs — штуки.',
      'packs — сколько упаковок купить (null — товар по весу, см. to_buy_text); pack_size и pack_label — фасовка одной упаковки.',
      'planned_cost_rub — плановая стоимость строки по ценам av.ru на дату снимка комплекта. Это ориентир, а не собранная корзина: наличие и доставка по адресу подтверждаются только в корзине av.ru.',
      'av_card_number — номер из адреса карточки av.ru/i/<номер>. article — артикул: в данных комплекта артикулы не указаны, поэтому null.',
      'availability_check — отметка пользователя на экране «Проверить на av.ru»: unchecked (не проверено), available (есть в корзине), unavailable (недоступен, замена не выбрана), replaced (замена подтверждена).',
      'items и purchases — все закупки текущего меню: основные, докупки свежего и перекусы в командировки. Их и нужно сверять с каталогом «Азбуки вкуса».',
      'history_items и history_purchases — закупки прежних планов, которые остались в разделе «Закупки» как история (до перехода на «Азбуку вкуса»; товары без карточек av.ru). Для сверки с каталогом не нужны.',
      'products — справочник: каждый товар текущих закупок один раз, со ссылкой и суммой по всем закупкам; позиции закупок — в items.',
    ],
    totals: {
      purchases: purchases.length,
      items: items.length,
      products: products.length,
      planned_cost_rub_all: Math.round(purchases.reduce((s, p) => s + p.planned_cost_rub, 0)),
      planned_cost_rub_home: Math.round(home.reduce((s, p) => s + p.planned_cost_rub, 0)),
      planned_cost_rub_trips: Math.round(purchases.filter((p) => !p.in_home_budget).reduce((s, p) => s + p.planned_cost_rub, 0)),
      budget_rub: BUDGET_RUB,
      history_purchases: historyPurchases.length,
      history_items: historyItems.length,
    },
    purchases,
    items,
    products,
    history_purchases: historyPurchases,
    history_items: historyItems,
  };
}

export function shoppingExportFileName(today: ISODate): string {
  return `zakupki_vse_tovary_${today}.json`;
}
