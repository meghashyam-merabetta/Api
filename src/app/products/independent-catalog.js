import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { MAX_PRODUCT_IMAGES } from '../../shared/product-images.js';
import { effectivePrice } from '../../shared/catalog-fields.js';

export async function independentCatalog(transaction) {
  const options = { type: QueryTypes.SELECT, transaction };
  const categories = await sequelize.query(
    'SELECT id::text,name,slug,parent_id::text AS "parentId",description,image_url AS image FROM categories WHERE is_active ORDER BY sort_order,id',
    options,
  );
  const brands = await sequelize.query(
    'SELECT id::text,name,slug,logo_url AS logo,description FROM brands WHERE is_active ORDER BY name,id',
    options,
  );
  const rows = await sequelize.query(
    `SELECT p.*,b.name AS brand_name,
    COALESCE((SELECT sum(i.quantity_on_hand-i.quantity_reserved) FROM inventory i WHERE i.product_id=p.id),0)::bigint AS available_stock,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id::text,'name',c.name) ORDER BY pc.is_primary DESC,c.sort_order,c.id) FROM product_categories pc JOIN categories c ON c.id=pc.category_id AND c.is_active WHERE pc.product_id=p.id),'[]') AS assigned_categories,
    COALESCE((SELECT jsonb_agg(images.image_url ORDER BY images.is_primary DESC,images.sort_order,images.id) FROM (SELECT id,image_url,is_primary,sort_order FROM product_images WHERE product_id=p.id UNION ALL SELECT pi.id,pi.image_url,l.is_primary,l.sort_order FROM independent_product_images l JOIN product_images pi ON pi.id=l.source_image_id WHERE l.product_id=p.id) images),'[]') AS image_urls
    FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.inventory_managed AND p.product_status='active' AND COALESCE(to_jsonb(p)->>'deleted_at','')='' AND (p.brand_id IS NULL OR b.is_active) ORDER BY p.name,p.id`,
    options,
  );
  const products = rows
    .filter(
      (row) =>
        row.assigned_categories.length &&
        effectivePrice(row) !== null &&
        effectivePrice(row) > 0,
    )
    .map((row) => {
      const ids = new Set(row.assigned_categories.map((c) => c.id));
      for (const id of [...ids]) {
        let ancestor = categories.find((c) => c.id === id)?.parentId;
        while (ancestor && !ids.has(ancestor)) {
          ids.add(ancestor);
          ancestor = categories.find((c) => c.id === ancestor)?.parentId;
        }
      }
      const images = [...new Set(row.image_urls)].slice(0, MAX_PRODUCT_IMAGES);
      return {
        id: `product:${row.id}`,
        productId: String(row.id),
        variantId: null,
        name: row.name,
        subtitle: row.short_description || row.name,
        description: row.description || '',
        brandId: row.brand_id === null ? null : String(row.brand_id),
        brandName: row.brand_name || '',
        sku: row.sku,
        attributes: row.attributes,
        product_group_code: row.product_group_code,
        categoryId: row.assigned_categories[0].id,
        categoryIds: [...ids],
        categories: row.assigned_categories.map((c) => c.name),
        price: effectivePrice(row),
        mrp: Number(row.regular_price),
        stock: Number(row.available_stock),
        available: row.available_stock > 0,
        min_order_quantity: row.min_order_quantity,
        max_order_quantity: row.max_order_quantity,
        image: images[0] || 'medicine.png',
        images,
        rating: 'Not rated',
      };
    });
  return { categories, brands, products, labs: [], tests: [], offerings: [] };
}
