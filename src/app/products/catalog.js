import { QueryTypes } from 'sequelize';
import { sequelize as database } from '../../config/database.js';
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

// Expose only customer-facing product detail fields; inventory and internal metadata stay private.
export function publicProductAttributes(specifications, product = {}, details = {}) {
  const attributes = specifications && typeof specifications === 'object' && !Array.isArray(specifications)
    ? { ...specifications } : (Array.isArray(specifications) && specifications.length) || (typeof specifications === 'string' && specifications.trim()) ? { specifications } : {};
  let additional = details?.additional_attributes;
  if (typeof additional === 'string') { try { additional = JSON.parse(additional); } catch { additional = null; } }
  if (additional && typeof additional === 'object' && !Array.isArray(additional)) {
    // Marketplace/import metadata is not useful in the customer-facing catalogue.
    const internal = /^(amazon|source_workbook|merchant_shipping|external_product_information|recommended_browse_nodes|condition_type|supplier_declared)/i;
    for (const [key, value] of Object.entries(additional)) {
      if (!internal.test(key) && (attributes[key] === undefined || attributes[key] === null)) attributes[key] = value;
    }
  }
  for (const key of ['size', 'dimensions', 'dimension', 'length', 'width', 'height', 'weight', 'product_weight', 'product_length', 'product_width', 'product_height', 'ideal_for', 'pack_of', 'pack_size', 'pack_quantity', 'colour', 'color', 'material', 'model', 'manufacturer', 'country_of_origin', 'warranty']) {
    const value = details?.[key] ?? product?.[key];
    if ((attributes[key] === null || attributes[key] === undefined) && value !== null && value !== undefined && value !== '') attributes[key] = value;
  }
  if (attributes.product_weight !== undefined && attributes.product_weight !== null && details?.weight_unit && /^(?:\d+(?:\.\d+)?)$/.test(String(attributes.product_weight).trim())) {
    attributes.product_weight = String(attributes.product_weight).trim() + ' ' + String(details.weight_unit).trim();
  }
  if (details?.dimension_unit) {
    for (const key of ['product_length', 'product_width', 'product_height']) {
      if (attributes[key] !== undefined && attributes[key] !== null && /^(?:\d+(?:\.\d+)?)$/.test(String(attributes[key]).trim()))
        attributes[key] = String(attributes[key]).trim() + ' ' + String(details.dimension_unit).trim();
    }
  }
  return attributes;
}

export async function productCatalog(transaction) {
  const categories = await database.query(
    'SELECT id::text,name,slug,parent_id::text AS "parentId",sort_order AS "sortOrder",description,image_url AS image FROM categories WHERE is_active ORDER BY sort_order,id',
    { type: QueryTypes.SELECT, transaction },
  );
  const brands = await database.query(
    'SELECT id::text,name,slug,logo_url AS logo,description FROM brands WHERE is_active ORDER BY name,id',
    { type: QueryTypes.SELECT, transaction },
  );
  const rows = await database.query(
    `SELECT p.id::text AS product_id,p.product_name AS name,d.full_description AS description,d.short_description,
    p.brand_id::text,b.name AS brand_name,p.sku,d.specifications AS attributes, to_jsonb(p) AS product_fields, to_jsonb(d) AS detail_fields,
    p.selling_price,p.mrp,
    COALESCE((SELECT sum(greatest(0,i.available_quantity)) FROM product_inventory i WHERE i.product_id=p.id AND i.is_active),0)::int AS stock,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id::text,'name',c.name) ORDER BY CASE WHEN c.id=p.subcategory_id THEN 0 ELSE 1 END,c.id) FROM categories c WHERE c.id IN (p.category_id,p.subcategory_id) AND c.is_active),'[]') AS categories,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('url',pi.image_url,'alt',pi.alt_text) ORDER BY pi.is_primary DESC,pi.sort_order,pi.id) FROM product_images pi WHERE pi.product_id=p.id),'[]') AS images
    FROM products p LEFT JOIN product_details d ON d.product_id=p.id
    LEFT JOIN brands b ON b.id=p.brand_id
    WHERE p.product_status='active' AND p.is_active AND NOT p.is_deleted
      AND p.selling_price>0 AND p.mrp>=p.selling_price
    ORDER BY p.product_name,p.id`,
    { type: QueryTypes.SELECT, transaction },
  );
  const products = rows.filter((row) => row.categories.length).map((row) => {
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
      id: 'product:' + row.product_id,
      productId: row.product_id,
      name: row.name.trim(),
      subtitle:
        row.short_description?.trim() ||
        row.brand_name ||
        row.name.trim(),
      description: row.description || row.short_description || '',
      brandId: row.brand_id,
      brandName: row.brand_name || '',
      variantName: '',
      sku: row.sku,
      attributes: publicProductAttributes(row.attributes, row.product_fields, row.detail_fields),
      categoryId: row.categories[0].id,
      categoryIds: [...categoryIds],
      categories: [...categoryIds].map((id) => categories.find((c) => c.id === id)?.name).filter(Boolean),
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
  if (!/^product:\d+$/.test(id))
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
