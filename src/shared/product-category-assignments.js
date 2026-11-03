import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { HttpError } from './errors.js';
import { mappingEvent } from './catalog-audit.js';

// Caller holds the product row lock. Preserve unchanged links and their original metadata.
export async function assignProductCategories(productId, ids, primary, transaction) {
  const unique = [...new Set(ids.map(String))];
  if (primary !== null && primary !== undefined && !unique.includes(String(primary)))
    throw new HttpError(400, 'The primary category must be included in category_ids');
  const categories = unique.length
    ? await sequelize.query(
        'SELECT id,name FROM categories WHERE id IN (:ids) ORDER BY id FOR SHARE',
        { replacements: { ids: unique }, type: QueryTypes.SELECT, transaction },
      )
    : [];
  if (categories.length !== unique.length)
    throw new HttpError(400, 'One or more categories were not found');
  const previous = await sequelize.query(
    'SELECT pc.*,c.name AS category_name FROM product_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.product_id=:id ORDER BY pc.category_id',
    { replacements: { id: productId }, type: QueryTypes.SELECT, transaction },
  );
  const previousIds = new Set(previous.map((row) => String(row.category_id)));
  const oldPrimary = previous.find((row) => row.is_primary)?.category_id ?? null;
  for (const row of previous) {
    if (unique.includes(String(row.category_id))) continue;
    await sequelize.query(
      'DELETE FROM product_categories WHERE product_id=:product AND category_id=:category',
      { replacements: { product: productId, category: row.category_id }, transaction },
    );
    await mappingEvent(
      productId,
      'category_removed',
      { category_id: row.category_id, category_name: row.category_name },
      null,
      transaction,
    );
  }
  for (const category of unique) {
    if (previousIds.has(category)) continue;
    await sequelize.query(
      `INSERT INTO product_categories(product_id,category_id,is_primary,created_by,updated_by)
      VALUES(:product,:category,FALSE,NULLIF(current_setting('catalog.actor',true),'')::uuid,NULLIF(current_setting('catalog.actor',true),'')::uuid)`,
      { replacements: { product: productId, category }, transaction },
    );
    await mappingEvent(
      productId,
      'category_added',
      null,
      {
        category_id: category,
        category_name: categories.find((row) => String(row.id) === category)?.name,
      },
      transaction,
    );
  }
  if (String(oldPrimary ?? '') !== String(primary ?? '')) {
    await sequelize.query(
      `UPDATE product_categories SET is_primary=COALESCE(category_id=CAST(:primary AS bigint),FALSE),updated_at=clock_timestamp(),updated_by=NULLIF(current_setting('catalog.actor',true),'')::uuid
      WHERE product_id=:product AND is_primary IS DISTINCT FROM COALESCE(category_id=CAST(:primary AS bigint),FALSE)`,
      { replacements: { product: productId, primary: primary ?? null }, transaction },
    );
    // Null clearing must never violate NOT NULL.
    await mappingEvent(
      productId,
      'primary_category_changed',
      {
        primary_category_id: oldPrimary,
        category_name: previous.find((row) => row.is_primary)?.category_name ?? null,
      },
      {
        primary_category_id: primary ?? null,
        category_name:
          categories.find((row) => String(row.id) === String(primary))?.name ?? null,
      },
      transaction,
    );
  }
}
