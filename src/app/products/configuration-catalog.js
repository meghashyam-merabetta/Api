import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { variantGallery } from '../../shared/variant-galleries.js';
import { effectivePrice } from '../../shared/catalog-fields.js';

export async function configurationCatalog(transaction, categories, imageUrl) {
  const rows = await sequelize.query(
    `SELECT p.*, b.name AS brand_name,
    l.variant_id,l.group_product_id,
    COALESCE((SELECT sum(i.quantity_on_hand-i.quantity_reserved) FROM inventory i WHERE i.product_id=p.id),0)::int AS available_stock,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id::text,'name',c.name) ORDER BY pc.is_primary DESC,c.sort_order,c.id)
      FROM product_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.product_id=p.id AND c.is_active),'[]') AS assigned_categories
    FROM products p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN product_configuration_links l ON l.product_id=p.id
    WHERE p.inventory_managed AND NOT p.is_configuration_group AND p.product_status='active' AND p.deleted_at IS NULL AND (p.brand_id IS NULL OR b.is_active)
    ORDER BY p.id`,
    { type: QueryTypes.SELECT, transaction },
  );
  const products = [];
  for (const row of rows) {
    const price = effectivePrice(row);
    if (!row.assigned_categories.length || price === null || price <= 0) continue;
    let gallery, images;
    if (row.variant_id) {
      const variant = await models.productVariant.findByPk(row.variant_id, {
        transaction,
      });
      const group = await models.product.findByPk(row.group_product_id, { transaction });
      if (!variant?.is_active || !group || group.product_status !== 'active') continue;
      gallery = await variantGallery(variant, group, transaction);
      images = gallery.effective_images;
    } else
      images = await models.productImage.findAll({
        where: { product_id: row.id },
        order: [
          ['is_primary', 'DESC'],
          ['sort_order', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
      });
    const ids = new Set(row.assigned_categories.map((c) => c.id));
    for (const id of [...ids]) {
      let parent = categories.find((c) => c.id === id)?.parentId;
      while (parent && !ids.has(parent)) {
        ids.add(parent);
        parent = categories.find((c) => c.id === parent)?.parentId;
      }
    }
    const urls = images.map((i) => imageUrl(i.image_url));
    products.push({
      id: `product:${row.id}`,
      productId: String(row.id),
      individual_product_id: String(row.id),
      variantId: row.variant_id ? String(row.variant_id) : null,
      groupProductId: row.group_product_id ? String(row.group_product_id) : null,
      name: row.name,
      subtitle: row.short_description || row.name,
      description: row.description || '',
      sku: row.sku,
      attributes: row.attributes,
      brandId: row.brand_id === null ? null : String(row.brand_id),
      brandName: row.brand_name || '',
      categoryId: row.assigned_categories[0].id,
      categoryIds: [...ids],
      categories: row.assigned_categories.map((c) => c.name),
      price,
      mrp: Number(row.regular_price),
      stock: row.available_stock,
      available: row.available_stock > 0,
      min_order_quantity: row.min_order_quantity,
      max_order_quantity: row.max_order_quantity,
      ...(gallery ? { use_product_images: gallery.use_product_images } : {}),
      image: urls[0] ?? null,
      images: urls,
      rating: 'Not rated',
    });
  }
  return products;
}
