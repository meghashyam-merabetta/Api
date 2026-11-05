import { query } from './store.js';
export async function nativeCatalog(transaction, imageUrl, categoryIcon) {
  const categories = await query(
    'SELECT id::text,name,slug,parent_id::text AS "parentId",sort_order AS "sortOrder",description,image_url AS image FROM categories WHERE is_active ORDER BY sort_order,id',
    {},
    transaction,
  );
  const brands = await query(
    'SELECT id::text,name,slug,logo_url AS logo,description FROM brands WHERE is_active ORDER BY name,id',
    {},
    transaction,
  );
  const rows = await query(
    `SELECT p.*,d.full_description,d.short_description,d.specifications,d.size,d.colour,d.additional_attributes,b.name AS brand_name,
 COALESCE((SELECT sum(i.available_quantity) FROM product_inventory i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.product_id=p.id AND i.is_active AND w.is_active),0) AS available_stock,
 COALESCE((SELECT jsonb_agg(pi.image_url ORDER BY pi.is_primary DESC,pi.sort_order,pi.id) FROM product_images pi WHERE pi.product_id=p.id),'[]') AS image_urls
 FROM products p LEFT JOIN product_details d ON d.product_id=p.id LEFT JOIN brands b ON b.id=p.brand_id
 WHERE p.product_status='active' AND p.is_active AND NOT p.is_deleted AND (p.brand_id IS NULL OR b.is_active) ORDER BY p.id`,
    {},
    transaction,
  );
  const products = [];
  for (const p of rows) {
    const assigned = [p.category_id, p.subcategory_id]
      .filter((x) => x !== null && x !== undefined)
      .map(String);
    if (!assigned.length || assigned.some((id) => !categories.some((c) => c.id === id)))
      continue;
    const ids = new Set(assigned);
    let valid = true;
    for (const id of assigned) {
      let next = categories.find((c) => c.id === id);
      const visited = new Set();
      while (next?.parentId) {
        if (visited.has(next.parentId)) {
          valid = false;
          break;
        }
        visited.add(next.parentId);
        next = categories.find((c) => c.id === next.parentId);
        if (!next) {
          valid = false;
          break;
        }
        ids.add(next.id);
      }
    }
    if (
      !valid ||
      p.selling_price === null ||
      p.selling_price === undefined ||
      p.mrp === null ||
      p.mrp === undefined
    )
      continue;
    const price = Number(p.selling_price),
      mrp = Number(p.mrp);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(mrp) || mrp < price)
      continue;
    const images = [...new Set(p.image_urls.filter(Boolean).map(imageUrl))].slice(0, 6);
    products.push({
      id: `product:${p.id}`,
      productId: String(p.id),
      individual_product_id: String(p.id),
      variantId: String(p.id),
      product_group_code: p.additional_attributes?.product_group_code ?? null,
      variantName: [p.size, p.colour].filter(Boolean).join(' / '),
      name: p.product_name,
      subtitle: p.short_description || p.product_name,
      description: p.full_description || '',
      sku: p.sku,
      attributes: {
        ...p.specifications,
        ...(p.size ? { Size: p.size } : {}),
        ...(p.colour ? { Colour: p.colour } : {}),
      },
      brandId:
        p.brand_id === null || p.brand_id === undefined ? null : String(p.brand_id),
      brandName: p.brand_name ?? '',
      categoryId: String(p.category_id ?? p.subcategory_id),
      categoryIds: [...ids],
      categories: assigned.map((id) => categories.find((c) => c.id === id).name),
      price,
      mrp,
      stock: Number(p.available_stock ?? 0),
      available: Number(p.available_stock ?? 0) > 0,
      min_order_quantity: 1,
      max_order_quantity: null,
      use_product_images: true,
      image: images[0] ?? null,
      images,
      rating: 'Not rated',
    });
  }
  return {
    products,
    categories: categories.map((c) => ({
      ...c,
      image: c.image?.trim() ? imageUrl(c.image.trim()) : null,
      icon: categoryIcon(c.name),
      color: '#77409A',
      bg: '#F8F3FC',
    })),
    labs: [],
    tests: [],
    offerings: [],
    brands,
  };
}
