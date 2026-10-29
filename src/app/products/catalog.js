import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
export function productImageUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = env.PRODUCT_IMAGE_BASE_URL.replace(/\/+$/, '');
  return base ? base + '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/') : path;
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
  const categories = await sequelize.query(
    'SELECT id::text,name,slug,parent_id::text AS "parentId",sort_order AS "sortOrder",description,image_url AS image FROM categories WHERE is_active ORDER BY sort_order,id',
    { type: QueryTypes.SELECT, transaction },
  );
  const brands = await sequelize.query(
    'SELECT id::text,name,slug,logo_url AS logo,description FROM brands WHERE is_active ORDER BY name,id',
    { type: QueryTypes.SELECT, transaction },
  );
  const rows = await sequelize.query(
    `SELECT p.id::text AS product_id,p.name,p.description,p.short_description,
    p.brand_id::text,b.name AS brand_name,v.id::text AS variant_id,v.variant_name,v.sku,v.attributes,
    o.id::text AS offer_id,o.selling_price,o.mrp,
    COALESCE((SELECT sum(greatest(0,i.quantity_on_hand-i.quantity_reserved)) FROM inventory i WHERE i.vendor_product_id=o.id),0)::int AS stock,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id::text,'name',c.name) ORDER BY pc.is_primary DESC,c.sort_order,c.id) FROM product_categories pc JOIN categories c ON c.id=pc.category_id AND c.is_active WHERE pc.product_id=p.id),'[]') AS categories,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('url',pi.image_url,'alt',pi.alt_text) ORDER BY pi.is_primary DESC,pi.sort_order,pi.id) FROM product_images pi WHERE pi.product_id=p.id),'[]') AS images
    FROM products p JOIN product_variants v ON v.product_id=p.id AND v.is_active
    JOIN vendor_products o ON o.variant_id=v.id AND o.offer_status='active' AND o.currency='INR' AND o.selling_price>0 AND o.mrp>=o.selling_price
    JOIN vendors vendor ON vendor.id=o.vendor_id AND vendor.vendor_status='active'
    LEFT JOIN brands b ON b.id=p.brand_id
    WHERE p.product_status='active' AND (p.brand_id IS NULL OR b.is_active)
    ORDER BY p.name,p.id,v.id,o.selling_price,o.id`,
    { type: QueryTypes.SELECT, transaction },
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!row.categories.length) continue;
    const prior = grouped.get(row.variant_id);
    if (!prior || (prior.stock === 0 && row.stock > 0)) grouped.set(row.variant_id, row);
  }
  const products = [...grouped.values()].map((row) => {
    const images = [...new Set(row.images.map((i) => i.url).filter(Boolean).map(productImageUrl))].slice(0, 6);
    const categoryIds = new Set(row.categories.map((c) => c.id));
    for (const id of [...categoryIds]) {
      let parent = categories.find((c) => c.id === id)?.parentId;
      while (parent && !categoryIds.has(parent)) {
        categoryIds.add(parent);
        parent = categories.find((c) => c.id === parent)?.parentId;
      }
    }
    return {
      id: 'shop:' + row.offer_id,
      productId: row.product_id,
      variantId: row.variant_id,
      name: row.name.trim(),
      subtitle:
        row.short_description?.trim() ||
        row.variant_name ||
        row.brand_name ||
        row.name.trim(),
      description: row.description || row.short_description || '',
      brandId: row.brand_id,
      brandName: row.brand_name || '',
      variantName: row.variant_name || '',
      sku: row.sku,
      attributes: row.attributes,
      categoryId: row.categories[0].id,
      categoryIds: [...categoryIds],
      categories: row.categories.map((c) => c.name),
      price: Number(row.selling_price),
      mrp: Number(row.mrp),
      stock: row.stock,
      available: row.stock > 0,
      image: images[0] || 'medicine.png',
      images,
      rating: 'Not rated',
    };
  });
  return {
    categories: categories.map((c) => ({
      ...c,
      image: c.image?.trim() ? productImageUrl(c.image.trim()) : null,
      icon: categoryIcon(c.name),
      color: '#77409A',
      bg: '#F8F3FC',
    })),
    brands,
    products,
    labs: [],
    tests: [],
    offerings: [],
  };
}
export async function sellableProduct(id, quantity, transaction) {
  if (!/^shop:\d+$/.test(id))
    throw new HttpError(
      422,
      'This product is no longer available. Please choose it again from Products.',
    );
  const product = (await productCatalog(transaction)).products.find((p) => p.id === id);
  if (!product) throw new HttpError(422, 'This product is no longer available.');
  if (!product.available || quantity > product.stock)
    throw new HttpError(
      422,
      `Only ${product.stock} units of ${product.name} are available.`,
    );
  return product;
}
