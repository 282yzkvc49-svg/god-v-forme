// Проверка товаров av.ru по адресу доставки пользователя и подтверждённые замены недоступных товаров.
// Карточка товара на av.ru не гарантирует доставку по адресу: доступность отмечает сам пользователь,
// открыв товар в своей корзине. Недоступный товар блокируется в закупках, пока не выбрана замена.
import type { Op } from '../state/idb';
import type { AppData, AvProductRec, ProductSub, ShoppingEvent } from '../state/types';
import type { ISODate } from '../lib/dates';
import { BASE_PRODUCTS, PRODUCTS, TEMPLATE, applyProductSubs, subQtyFactor, substitutedProduct, type Product } from './catalog';
import { replanOps } from './plan';
import { applyOps } from '../state/model';

/** Только индивидуальная карточка товара: https://av.ru/i/<номер>. */
export const AV_CARD_RE = /^https:\/\/av\.ru\/i\/\d+\/?$/;

export const AV_HOME = 'https://av.ru/';

/** Товары действующего меню (все — с индивидуальной карточкой av.ru). */
export function menuProductIds(): string[] {
  return TEMPLATE.products.filter((p) => !p.archived && p.url).map((p) => p.id);
}

export function avRec(data: AppData, productId: string): AvProductRec | null {
  return data.avProducts?.[productId] ?? null;
}

/** Недоступен по адресу, а замена ещё не подтверждена — в закупке позиция заблокирована. */
export function isBlocked(data: AppData, productId: string): boolean {
  const r = avRec(data, productId);
  return !!r && r.status === 'unavailable' && !r.sub;
}

export type AvState = 'unchecked' | 'available' | 'unavailable' | 'replaced';

export function avState(data: AppData, productId: string): AvState {
  const r = avRec(data, productId);
  if (!r) return 'unchecked';
  if (r.sub) return 'replaced';
  return r.status ?? 'unchecked';
}

export const AV_STATE_LABEL: Record<AvState, string> = {
  unchecked: 'не проверено', available: 'есть в корзине', unavailable: 'недоступен — нужна замена', replaced: 'замена подтверждена',
};

/** Товары закупки, которые нужно купить (без «хватит остатка»). */
export function orderProductIds(e: ShoppingEvent): string[] {
  return (e.lines ?? []).filter((l) => l.buy > 0 && PRODUCTS[l.productId]?.url).map((l) => l.productId);
}

export interface BasketState {
  address: boolean;
  total: number;
  available: string[];
  replaced: string[];
  unavailable: string[];
  unchecked: string[];
  /** «Корзина проверена» — адрес выбран, все товары есть или заменены по подтверждению. */
  verified: boolean;
}

export function basketState(data: AppData, ids: string[]): BasketState {
  const by: Record<AvState, string[]> = { unchecked: [], available: [], unavailable: [], replaced: [] };
  for (const id of Array.from(new Set(ids))) by[avState(data, id)].push(id);
  const address = !!data.settings.avAddressConfirmedAt;
  return {
    address, total: new Set(ids).size, available: by.available, replaced: by.replaced, unavailable: by.unavailable, unchecked: by.unchecked,
    verified: address && !by.unavailable.length && !by.unchecked.length && new Set(ids).size > 0,
  };
}

/** Подтверждённые замены из каталога меню: товары той же категории (все — с карточками av.ru). */
export function alternativesFor(data: AppData, productId: string): Product[] {
  const base = BASE_PRODUCTS[productId];
  if (!base) return [];
  return TEMPLATE.products
    .filter((p) => !p.archived && p.url && p.id !== productId && p.category === base.category && p.unit === base.unit)
    .filter((p) => avState(data, p.id) !== 'unavailable')
    .map((p) => BASE_PRODUCTS[p.id]);
}

export interface SubInput {
  catalogId?: string | null;
  name: string;
  url: string;
  packSize: number;
  packPrice: number;
  nutr?: ProductSub['nutr'];
  edibleRatio?: number | null;
}

/** Проверяет и собирает замену. Ссылка — только на индивидуальную карточку av.ru; карточки не придумываются. */
export function makeSub(productId: string, input: SubInput, now: string): { sub: ProductSub | null; errors: string[] } {
  const base = BASE_PRODUCTS[productId];
  const errors: string[] = [];
  if (!base) errors.push('Неизвестный товар.');
  const from = input.catalogId ? BASE_PRODUCTS[input.catalogId] : null;
  const url = (from?.url ?? input.url ?? '').trim();
  if (!AV_CARD_RE.test(url)) errors.push('Нужна ссылка на карточку товара вида https://av.ru/i/123456 — откройте товар на av.ru и скопируйте адрес страницы.');
  const name = (from?.name ?? input.name ?? '').trim();
  if (name.length < 3) errors.push('Укажите название товара как на av.ru.');
  const packSize = from ? from.pack.size : input.packSize;
  const packPrice = from ? from.pack_price ?? 0 : input.packPrice;
  if (!(packSize > 0)) errors.push('Укажите фасовку (вес или количество в упаковке).');
  if (!(packPrice > 0)) errors.push('Укажите цену упаковки с av.ru.');
  const nutr = from ? from.nutr : input.nutr ?? null;
  if (nutr && !(nutr.kcal >= 0 && nutr.p >= 0 && nutr.f >= 0 && nutr.c >= 0)) errors.push('Пищевая ценность — неотрицательные числа на 100 г.');
  if (errors.length || !base) return { sub: null, errors };
  return {
    sub: {
      catalogId: from ? from.id : null, name, url, packSize, packPrice, nutr,
      edibleRatio: from ? from.edible_ratio : input.edibleRatio ?? null,
      qtyFactor: subQtyFactor(base, nutr), confirmedAt: now,
    },
    errors: [],
  };
}

/** Как будет выглядеть товар после замены (для предпросмотра). */
export function previewSub(productId: string, sub: ProductSub): Product {
  return substitutedProduct(BASE_PRODUCTS[productId], sub);
}

/** Рецепты меню, где есть товар. */
export function recipesWith(productId: string): string[] {
  return TEMPLATE.dishes.filter((d) => !d.archived && d.ingredients.some((i) => i.product === productId)).map((d) => d.id);
}

/**
 * Отметка доступности или замена: запись проверки + пересчёт плана (закупки, упаковки, цены, граммовки,
 * калорийность) по уже заменённому справочнику. Отметки «куплено» и «есть дома» сохраняются.
 */
export function productCheckOps(data: AppData, productId: string, patch: Partial<Pick<AvProductRec, 'status' | 'sub'>>, today: ISODate, now: string): Op[] {
  const prev = data.avProducts?.[productId];
  const rec: AvProductRec = {
    productId, status: prev?.status ?? null, checkedAt: prev?.checkedAt ?? null, sub: prev?.sub ?? null, updatedAt: now,
    ...patch,
  };
  if ('status' in patch) rec.checkedAt = patch.status ? now : null;
  if (patch.status === 'available') rec.sub = null;
  const ops: Op[] = [{ store: 'avProducts', put: rec }];
  const subChanged = JSON.stringify(prev?.sub ?? null) !== JSON.stringify(rec.sub);
  const cfg = data.settings.plan;
  if (!subChanged || !cfg) return ops;
  const next = applyOps(data, ops);
  applyProductSubs(next.avProducts);
  try {
    // с сегодняшнего дня: прошедшие закупки — история, купленное не меняется
    return [...ops, ...replanOps(next, cfg, today, { now, keepPast: true, overwriteMarked: true }).ops];
  } finally {
    applyProductSubs(data.avProducts);
  }
}

/** Сбросить проверку товаров (например, перед следующей закупкой): замены остаются. */
export function resetChecksOps(data: AppData, ids: string[], now: string): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const r = data.avProducts?.[id];
    if (!r || r.sub || !r.status) continue;
    ops.push({ store: 'avProducts', put: { ...r, status: null, checkedAt: null, updatedAt: now } });
  }
  return ops;
}
