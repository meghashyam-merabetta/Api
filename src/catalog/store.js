import { sequelize } from '../config/database.js';
import { HttpError } from '../shared/errors.js';
export const query = (sql, replacements = {}, transaction) =>
  sequelize.query(sql, {
    replacements,
    transaction,
    type: 'SELECT',
    productStorage: false,
  });
export async function audit(req, type, identity, before, after, transaction, action) {
  const keys = [
    ...new Set([...Object.keys(before || {}), ...Object.keys(after || {})]),
  ].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  await query(
    `INSERT INTO audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id) VALUES(:type,:id,:action,CAST(:old AS jsonb),CAST(:new AS jsonb),ARRAY[:keys]::text[],:actor,:actorType,:request) RETURNING id`,
    {
      type,
      id: String(identity),
      action: action || (before ? 'update' : 'create'),
      old: JSON.stringify(before),
      new: JSON.stringify(after),
      keys: keys.length ? keys : ['updated_at'],
      actor: req?.auth?.userId ?? null,
      actorType: req?.auth?.userId ? 'admin' : 'system',
      request: req?.id ?? null,
    },
    transaction,
  );
}
export async function findProduct(id, transaction, lock = false) {
  const [row] = await query(
    `SELECT * FROM products WHERE id=:id AND NOT is_deleted${lock ? ' FOR UPDATE' : ''}`,
    { id },
    transaction,
  );
  if (!row) throw new HttpError(404, 'Product not found');
  return row;
}
export async function validateReferences(values, transaction) {
  for (const [key, table] of [
    ['brand_id', 'brands'],
    ['vendor_id', 'vendors'],
  ])
    if (
      values[key] !== null &&
      values[key] !== undefined &&
      !(
        await query(
          `SELECT id FROM ${table} WHERE id=:id FOR SHARE`,
          { id: values[key] },
          transaction,
        )
      ).length
    )
      throw new HttpError(422, `${key} not found`);
  let root;
  if (values.category_id !== null && values.category_id !== undefined) {
    [root] = await query(
      'SELECT id,parent_id FROM categories WHERE id=:id FOR SHARE',
      { id: values.category_id },
      transaction,
    );
    if (!root) throw new HttpError(422, 'Category not found');
    if (root.parent_id !== null)
      throw new HttpError(422, 'category_id must identify a root category');
  }
  if (values.subcategory_id !== null && values.subcategory_id !== undefined) {
    const chain = await query(
      'WITH RECURSIVE ancestors AS (SELECT id,parent_id,ARRAY[id] path FROM categories WHERE id=:id UNION ALL SELECT c.id,c.parent_id,a.path||c.id FROM categories c JOIN ancestors a ON c.id=a.parent_id WHERE NOT c.id=ANY(a.path)) SELECT id,parent_id FROM ancestors',
      { id: values.subcategory_id },
      transaction,
    );
    if (
      !root ||
      !chain.some((c) => String(c.id) === String(root.id)) ||
      String(values.subcategory_id) === String(root.id)
    )
      throw new HttpError(422, 'Subcategory must belong to the selected category');
  }
}
