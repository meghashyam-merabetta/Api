import { nativeCatalog } from '../../catalog/catalog.js';
import { HttpError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
export function productImageUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = env.PRODUCT_IMAGE_BASE_URL.replace(/\/+$/, '');
  return base
    ? base + '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
    : path;
}
export function categoryIcon(name) {
  const rules = [
    [/diaper|absorbent/i, 'water-outline'],
    [/baby|child/i, 'happy-outline'],
    [/mobility|wheelchair|assistive/i, 'accessibility-outline'],
    [/monitor|device|equipment/i, 'pulse-outline'],
    [/beauty|personal/i, 'sparkles-outline'],
    [/mask|glove|cap/i, 'shield-checkmark-outline'],
    [/bandage|gau[zg]e|first aid/i, 'bandage-outline'],
    [/living/i, 'home-outline'],
    [/health|medical/i, 'medkit-outline'],
  ];
  return rules.find(([pattern]) => pattern.test(name))?.[1] || 'grid-outline';
}

export async function productCatalog(transaction) {
  return nativeCatalog(transaction, productImageUrl, categoryIcon);
}
export async function sellableProduct(id, quantity, transaction) {
  if (/^[1-9]\d*$/.test(id)) id = 'product:' + id;
  if (!/^product:[1-9]\d*$/.test(id))
    throw new HttpError(
      422,
      'This product is no longer available. Please choose it again from Products.',
    );
  const product = (await productCatalog(transaction)).products.find((p) => p.id === id);
  if (!product) throw new HttpError(422, 'This product is no longer available.');
  if (
    quantity < (product.min_order_quantity ?? 1) ||
    (product.max_order_quantity !== null &&
      product.max_order_quantity !== undefined &&
      quantity > product.max_order_quantity)
  )
    throw new HttpError(422, 'Product quantity is outside its order limits');
  if (!product.available || quantity > product.stock)
    throw new HttpError(
      422,
      `Only ${product.stock} units of ${product.name} are available.`,
    );
  return product;
}
