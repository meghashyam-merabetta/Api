import { normalizeCategoryName } from './category-identity.js';
import { HttpError } from './errors.js';

// Same lock as the workbook importer/reconciler, so ordinary API writes cannot
// race a normalized name check. This needs no production index or schema change.
export async function lockCategoryWrites(connection, transaction) {
  await connection.query("SET LOCAL lock_timeout = '10s'", { transaction });
  await connection.query('LOCK TABLE public.categories IN SHARE ROW EXCLUSIVE MODE', {
    transaction,
  });
}

export async function assertUniqueCategorySibling(
  Category,
  name,
  parentId,
  transaction,
  excludeId,
) {
  const candidates = await Category.findAll({
    where: { parent_category_id: parentId ?? null },
    transaction,
  });
  const duplicate = candidates.find(
    (row) =>
      String(row.category_id) !== String(excludeId) &&
      normalizeCategoryName(row.category_name) === normalizeCategoryName(name),
  );
  if (duplicate)
    throw new HttpError(
      409,
      `A category with this name already exists under the same parent (category ${duplicate.category_id})`,
    );
}
