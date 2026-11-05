import { productCatalog } from './catalog.js';
import { HttpError } from '../../shared/errors.js';
export async function listProducts(req, res) {
  const catalog = await productCatalog();
  const { category, brand, q, limit, offset } = req.validatedQuery;
  const items = catalog.products.filter(
    (p) =>
      (!category || p.categoryIds.includes(category)) &&
      (!brand || p.brandId === brand) &&
      (!q ||
        (p.name + ' ' + p.subtitle + ' ' + p.brandName)
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  res.json({ data: items.slice(offset, offset + limit), total: items.length });
}
export async function getProduct(req, res) {
  const selectedId = /^\d+$/.test(req.validatedParams.id)
    ? 'product:' + req.validatedParams.id
    : req.validatedParams.id;
  const product = (await productCatalog()).products.find((p) => p.id === selectedId);
  if (!product) throw new HttpError(404, 'Product not found');
  res.json({ data: product });
}
