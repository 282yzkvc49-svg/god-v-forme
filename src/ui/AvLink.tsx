// Ссылка на товар av.ru: карточка товара или подборка категории, фасовка и цена упаковки (ориентир, не корзина).
import { PRODUCTS } from '../domain/catalog';
import { fmtRub } from '../lib/util';

const nf = (x: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: x < 1 ? 2 : 1 }).format(x);

/** qty — сколько продукта нужно (в единицах рецепта: съедобная часть); показывается доля упаковки. */
export function AvLink({ productId, qty, showPack = true }: { productId: string; qty?: number; showPack?: boolean }) {
  const p = PRODUCTS[productId];
  if (!p?.url) return null;
  const gross = qty == null ? null : p.unit !== 'pcs' && p.edible_ratio < 1 ? qty / p.edible_ratio : qty;
  const packs = gross == null || !p.pack.size ? null : gross / p.pack.size;
  const category = p.listing_status === 'category_listing';
  return (
    <span className="av-link">
      <a href={p.url} target="_blank" rel="noopener noreferrer" title={category ? 'Ссылка ведёт на подборку категории, где есть этот товар' : 'Карточка товара на av.ru'}>
        av.ru{category ? ': подборка' : ''} ↗
      </a>
      {showPack && <span>{p.pack.label}{p.pack_price != null ? ` ≈${fmtRub(p.pack_price)}` : ''}</span>}
      {packs != null && packs >= 0.01 && <span>≈{nf(packs)} уп.</span>}
    </span>
  );
}

/** Есть ли у товара ссылка на av.ru (в прежнем меню — нет). */
export function hasAvLink(productId: string | null | undefined): boolean {
  return !!productId && !!PRODUCTS[productId]?.url;
}
