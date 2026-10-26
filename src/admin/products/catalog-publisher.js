import { models } from '../../models/index.js';
import { effectivePrice } from './catalog-fields.js';

// All callers hold the parent product lock, so checkout and admin writes agree.
export async function publishProductCatalog(productId, transaction) {
  const product = await models.product.findByPk(productId, { transaction });
  if (!product) return;
  const images = await models.productImage.findAll({
    where: { product_id: productId },
    order: [
      ['is_primary', 'DESC'],
      ['sort_order', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  const variants = await models.productVariant.findAll({
    where: { product_id: productId },
    transaction,
  });
  const categories = await models.productCategory.findAll({
    where: { product_id: productId },
    transaction,
  });
  await deactivateProductCatalog(productId, transaction);
  const base = product.toJSON();
  const categoryIds = categories.map((row) => String(row.category_id));
  const primary = categories.find((row) => row.is_primary)?.category_id;
  const items = product.product_type === 'variable' ? variants : [null];
  for (const variant of items) {
    const id = variant ? `variant:${variant.id}` : `product:${productId}`;
    const details = variant?.toJSON();
    const pricing =
      details?.regular_price === null || details?.regular_price === undefined
        ? base
        : {
            ...base,
            regular_price: details.regular_price,
            sale_price: details.sale_price,
          };
    const price = effectivePrice(pricing);
    const data = {
      ...base,
      ...details,
      id,
      name: variant
        ? `${product.product_name} - ${variant.display_name || variant.sku}`
        : product.product_name,
      price,
      effective_price: price,
      mrp:
        pricing.regular_price === null || pricing.regular_price === undefined
          ? null
          : Number(pricing.regular_price),
      subtitle: product.short_description,
      image: images[0]?.image_url ?? null,
      images: images.map((image) => image.toJSON()),
      categoryId: primary ? String(primary) : (categoryIds[0] ?? null),
      category_ids: categoryIds,
      stock_quantity: variant ? variant.stock_quantity : product.stock_quantity,
      source_product_id: String(productId),
      source_variant_id: variant ? String(variant.id) : null,
    };
    await models.productCatalog.upsert(
      {
        id,
        data,
        active:
          product.product_status === 'active' &&
          (!variant || variant.is_active) &&
          price !== null,
      },
      { transaction },
    );
  }
}

export async function deactivateProductCatalog(productId, transaction) {
  await models.productCatalog.update(
    { active: false },
    { where: { 'data.source_product_id': String(productId) }, transaction },
  );
}
