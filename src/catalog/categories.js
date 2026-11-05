import { sequelize } from '../config/database.js';
import { query, findProduct, audit } from './store.js';
import { HttpError } from '../shared/errors.js';
import { fingerprint } from '../shared/catalog-idempotency.js';
import { queueImageUrlCleanup } from '../shared/image-storage.js';
async function preview(id, t) {
  const categories = await query(
    'WITH RECURSIVE tree AS (SELECT id,name,parent_id,image_url FROM categories WHERE id=:id UNION SELECT c.id,c.name,c.parent_id,c.image_url FROM categories c JOIN tree t ON c.parent_id=t.id) SELECT * FROM tree ORDER BY id',
    { id },
    t,
  );
  if (!categories.length) throw new HttpError(404, 'Category not found');
  const products = await query(
    'SELECT id FROM products WHERE NOT is_deleted AND (category_id IN (:ids) OR subcategory_id IN (:ids)) ORDER BY id',
    { ids: categories.map((c) => c.id) },
    t,
  );
  return { categories, products, fingerprint: fingerprint({ categories, products }) };
}
export async function deletionPreview(req, res) {
  res.json({ data: await preview(req.validatedParams.categoryId) });
}
export async function deleteCategory(req, res) {
  const result = await sequelize.transaction(async (t) => {
    await query('LOCK TABLE categories IN SHARE ROW EXCLUSIVE MODE', {}, t);
    const plan = await preview(req.validatedParams.categoryId, t);
    if (
      req.validatedQuery?.expected_fingerprint &&
      req.validatedQuery.expected_fingerprint !== plan.fingerprint
    )
      throw new HttpError(
        409,
        'Category dependencies changed; refresh the deletion preview',
      );
    for (const p of plan.products) {
      const before = await findProduct(p.id, t, true);
      const [after] = await query(
        "UPDATE products SET is_deleted=true,is_active=false,product_status='archived',category_id=NULL,subcategory_id=NULL,updated_at=now() WHERE id=:id RETURNING *",
        { id: p.id },
        t,
      );
      await audit(req, 'product', p.id, before, after, t, 'delete');
    }
    await query(
      'UPDATE products SET category_id=CASE WHEN category_id IN (:ids) THEN NULL ELSE category_id END,subcategory_id=CASE WHEN subcategory_id IN (:ids) THEN NULL ELSE subcategory_id END WHERE category_id IN (:ids) OR subcategory_id IN (:ids) RETURNING id',
      { ids: plan.categories.map((c) => c.id) },
      t,
    );
    // Categories are removed recursively; product/order/audit identity remains retained.
    for (const c of plan.categories) {
      await audit(req, 'category', c.id, c, null, t, 'delete');
      await queueImageUrlCleanup(c.image_url, t);
    }
    await query(
      'DELETE FROM categories WHERE id IN (:ids) RETURNING id',
      { ids: plan.categories.map((c) => c.id) },
      t,
    );
    return {
      deleted_categories: plan.categories.length,
      deleted_products: plan.products.length,
    };
  });
  if (req.validatedQuery?.response === 'summary') return res.json({ data: result });
  res.status(204).end();
}
