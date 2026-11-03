import { env } from '../config/env.js';
import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { HttpError } from './errors.js';
import { auditContext, catalogTransaction } from './catalog-audit.js';
import { assignProductCategories } from './product-category-assignments.js';
import { lockCategoryWrites } from './category-write.js';

const byId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const select = (sql, transaction, replacements = {}) =>
  sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

// Both preview and execution use this exact scope calculation. No name matching.
export function categoryDeletionTree(categories, requestedIds) {
  const roots = [...new Set(requestedIds.map(String))].sort(byId);
  const rows = new Map(categories.map((row) => [String(row.id), row]));
  const depths = new Map();
  function visit(id, depth, path) {
    if (path.has(id)) throw new HttpError(409, 'Category hierarchy contains a cycle');
    if ((depths.get(id) ?? -1) >= depth) return;
    depths.set(id, depth);
    const next = new Set([...path, id]);
    for (const row of categories)
      if (String(row.parent_id) === id) visit(String(row.id), depth + 1, next);
  }
  for (const id of roots) {
    if (!rows.has(id)) throw new HttpError(404, `Category ${id} not found`);
    visit(id, 0, new Set());
  }
  return [...depths]
    .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
    .map(([id, depth]) => ({ ...rows.get(id), depth }));
}

export async function inspectCategoryDeletion(ids, transaction) {
  const categories = await select('SELECT * FROM categories ORDER BY id', transaction);
  const tree = categoryDeletionTree(categories, ids);
  const categoryIds = tree.map((row) => String(row.id));
  const links = await select(
    `SELECT pc.*,c.name AS category_name FROM product_categories pc
    JOIN categories c ON c.id=pc.category_id WHERE pc.product_id IN
    (SELECT product_id FROM product_categories WHERE category_id IN (:ids))
    ORDER BY pc.product_id,pc.category_id`,
    transaction,
    { ids: categoryIds },
  );
  const productIds = [...new Set(links.map((row) => String(row.product_id)))].sort(byId);
  const removed = links.filter((row) => categoryIds.includes(String(row.category_id)));
  const products = productIds.length
    ? await select(
        `SELECT p.id,p.name,p.sku,p.product_status,
    NULLIF(to_jsonb(p)->>'deleted_at','') AS deleted_at,
    regular_price,sale_price,stock_quantity FROM products p WHERE id IN (:ids) ORDER BY id`,
        transaction,
        { ids: productIds },
      )
    : [];
  const variants = productIds.length
    ? await select(
        `SELECT v.id,v.product_id,v.sku,v.is_active,NULLIF(to_jsonb(v)->>'deleted_at','') AS deleted_at,
    stock_quantity FROM product_variants v WHERE product_id IN (:ids) ORDER BY id`,
        transaction,
        { ids: productIds },
      )
    : [];
  const shared = productIds
    .map((id) => ({
      product_id: id,
      remaining_assignments: links.filter(
        (row) =>
          String(row.product_id) === id && !categoryIds.includes(String(row.category_id)),
      ),
    }))
    .filter((row) => row.remaining_assignments.length);
  const primaryChanges = productIds.flatMap((id) => {
    const before = links.filter((row) => String(row.product_id) === id);
    const after = before.filter((row) => !categoryIds.includes(String(row.category_id)));
    const previous = before.find((row) => row.is_primary)?.category_id ?? null;
    const next =
      after.find((row) => row.is_primary)?.category_id ?? after[0]?.category_id ?? null;
    return String(previous) === String(next)
      ? []
      : [{ product_id: id, previous_primary_id: previous, next_primary_id: next }];
  });
  const foreignKeys = await select(
    `SELECT n.nspname AS schema_name,t.relname AS table_name,
    c.conname,pg_get_constraintdef(c.oid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND c.confrelid='public.categories'::regclass ORDER BY n.nspname,t.relname,c.conname`,
    transaction,
  );
  const blockers = [];
  for (const key of foreignKeys) {
    const known =
      key.schema_name === 'public' &&
      key.target_columns.join() === 'id' &&
      ((key.table_name === 'categories' && key.columns.join() === 'parent_id') ||
        (key.table_name === 'product_categories' &&
          key.columns.join() === 'category_id'));
    if (known) continue;
    // Unknown dependencies require explicit handling even if their FK would cascade.
    if (key.columns.length !== 1 || key.target_columns.join() !== 'id') {
      blockers.push({ ...key, reason: 'Unsupported category foreign key' });
      continue;
    }
    const [count] = await select(
      `SELECT count(*)::int AS count FROM ${quote(key.schema_name)}.${quote(key.table_name)}
      WHERE ${quote(key.columns[0])} IN (:ids)`,
      transaction,
      { ids: categoryIds },
    );
    if (count.count) blockers.push({ ...key, referenced_rows: count.count });
  }
  const projections = await select(
    `SELECT pc.id,pc.active,pc.data->>'source_product_id' AS source_product_id,
    pc.data->>'categoryId' AS category_id,pc.data->'category_ids' AS category_ids,
    EXISTS(SELECT 1 FROM products p WHERE p.id IN (:products) AND
      (pc.data->>'source_product_id'=p.id::text OR pc.id='product:'||p.id OR
       pc.id IN (SELECT 'variant:'||v.id FROM product_variants v WHERE v.product_id=p.id) OR
       pc.id IN (SELECT 'shop:'||vp.id FROM vendor_products vp JOIN product_variants v ON v.id=vp.variant_id WHERE v.product_id=p.id))) AS handled
    FROM product_catalog pc WHERE pc.data->>'categoryId' IN (:categories)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(pc.data->'category_ids')='array' THEN pc.data->'category_ids' ELSE '[]'::jsonb END) item(value) WHERE item.value IN (:categories))
      ORDER BY pc.id`,
    transaction,
    { products: productIds.length ? productIds : ['-1'], categories: categoryIds },
  );
  // Inactive cache rows are not live product assignments. They can outlive
  // reassignment or physical removal of their original product. Scrub only the
  // deleted category references; never expand the product-deletion scope.
  const staleProjections = projections.filter((row) => !row.handled && !row.active);
  for (const row of projections.filter((row) => !row.handled && row.active))
    blockers.push({
      reason: 'Unmapped catalog projection references a deleted category',
      catalog_id: row.id,
    });
  const inventory = productIds.length
    ? await select(
        `SELECT i.* FROM inventory i
    LEFT JOIN vendor_products vp ON vp.id=i.vendor_product_id
    LEFT JOIN product_variants v ON v.id=vp.variant_id
    WHERE i.product_id IN (:ids) OR v.product_id IN (:ids) ORDER BY i.id`,
        transaction,
        { ids: productIds },
      )
    : [];
  const orders = productIds.length
    ? await select(
        `SELECT od.order_id,od.product_id,od.independent_product_id
    FROM order_details od WHERE od.independent_product_id IN (:ids)
    OR od.product_id IN (SELECT 'shop:'||vp.id FROM vendor_products vp JOIN product_variants v ON v.id=vp.variant_id WHERE v.product_id IN (:ids))
    OR od.product_id IN (SELECT 'product:'||id FROM products WHERE id IN (:ids)) ORDER BY od.order_id,od.product_id`,
        transaction,
        { ids: productIds },
      )
    : [];
  const [schema] = await select(
    `SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.categories'::regclass
    AND tgname='catalog_category_delete_audit' AND tgenabled IN ('O','A')
    AND tgfoid=to_regprocedure('public.catalog_category_delete_audit()'))
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.categories'::regclass
      AND tgname='catalog_audit' AND (tgtype::int & 8) <> 0)
    AND (${env.VARIANT_PRODUCT_FIELDS_ENABLED ? "EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.product_records'::regclass AND tgname='write_product_record' AND tgenabled IN ('O','A'))" : "EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.products'::regclass AND tgname='catalog_audit' AND tgenabled IN ('O','A'))"}) AS audit_ready,
    (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${env.VARIANT_PRODUCT_FIELDS_ENABLED ? "'product_records','product_variant_records'" : "'products','product_variants'"}) AND column_name='deleted_at') AS soft_delete_ready`,
    transaction,
  );
  const scope = {
    requested_category_ids: [...new Set(ids.map(String))].sort(byId),
    categories_to_delete: tree,
    products_to_soft_delete: products,
    variants_to_soft_delete: variants,
    assignments_to_remove: removed,
    shared_products: shared,
    primary_category_changes: primaryChanges,
    foreign_keys: foreignKeys,
    catalog_projection_dependencies: projections,
    stale_catalog_projections_to_clean: staleProjections,
    blockers,
  };
  return {
    ...scope,
    fingerprint: createHash('sha256').update(JSON.stringify(scope)).digest('hex'),
    counts: {
      stale_catalog_projections_cleaned: staleProjections.length,
      categories_deleted: tree.length,
      subcategories_deleted: tree.length - new Set(ids.map(String)).size,
      product_assignments_removed: removed.length,
      affected_product_count: productIds.length,
      products_soft_deleted: products.filter((p) => !p.deleted_at).length,
      variants_soft_deleted: variants.filter((v) => !v.deleted_at).length,
      shared_product_count: shared.length,
      subcategories_detached: 0,
    },
    preserved_inventory: inventory,
    preserved_order_references: orders,
    required_migrations: [
      ...(!schema.soft_delete_ready ? ['036-product-soft-delete.sql'] : []),
      ...(!schema.audit_ready ? ['037-recursive-category-deletion-audit.sql'] : []),
    ],
    can_apply: blockers.length === 0 && schema.audit_ready && schema.soft_delete_ready,
    images:
      'Retained for soft-deleted products and historical references; no storage writes.',
  };
}

export function previewCategoryDeletion(ids) {
  return sequelize.transaction(
    { readOnly: true, isolationLevel: 'REPEATABLE READ' },
    async (transaction) => {
      await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
      return inspectCategoryDeletion(ids, transaction);
    },
  );
}

export async function executeCategoryDeletion(req, id, expectedFingerprint) {
  try {
    return await catalogTransaction(req, async (transaction) => {
      await auditContext(req, transaction, { reason: 'Recursive category deletion' });
      await lockCategoryWrites(sequelize, transaction);
      await sequelize.query(
        'LOCK TABLE public.product_categories IN SHARE ROW EXCLUSIVE MODE',
        { transaction },
      );
      let plan = await inspectCategoryDeletion([id], transaction);
      const productIds = plan.products_to_soft_delete.map((row) => String(row.id));
      const categoryIds = plan.categories_to_delete.map((row) => String(row.id));
      // A writer may hold a product/category row while waiting for the junction lock.
      // NOWAIT makes this operation fail and roll back instead of deadlocking it.
      if (productIds.length)
        await select(
          'SELECT id FROM products WHERE id IN (:ids) ORDER BY id FOR UPDATE NOWAIT',
          transaction,
          { ids: productIds },
        );
      await select(
        'SELECT id FROM categories WHERE id IN (:ids) ORDER BY id FOR UPDATE NOWAIT',
        transaction,
        { ids: categoryIds },
      );
      if (productIds.length)
        await select(
          'SELECT id FROM product_variants WHERE product_id IN (:ids) ORDER BY id FOR UPDATE NOWAIT',
          transaction,
          { ids: productIds },
        );
      const projectionIds = plan.catalog_projection_dependencies.map((row) => row.id);
      if (projectionIds.length)
        await select(
          'SELECT id FROM product_catalog WHERE id IN (:ids) ORDER BY id FOR UPDATE NOWAIT',
          transaction,
          { ids: projectionIds },
        );
      plan = await inspectCategoryDeletion([id], transaction);
      if (expectedFingerprint && expectedFingerprint !== plan.fingerprint)
        throw new HttpError(409, 'Deletion preview is stale; review a fresh preview');
      if (plan.blockers.length)
        throw new HttpError(
          409,
          'Unreviewed category dependencies prevent deletion; see deletion-preview',
        );
      if (plan.required_migrations.length)
        throw new HttpError(
          503,
          'Category deletion requires separately approved migrations: ' +
            plan.required_migrations.join(', '),
        );
      for (const productId of productIds) {
        const remaining =
          plan.shared_products.find((row) => row.product_id === productId)
            ?.remaining_assignments ?? [];
        const primary =
          remaining.find((row) => row.is_primary)?.category_id ??
          remaining[0]?.category_id ??
          null;
        await assignProductCategories(
          productId,
          remaining.map((row) => row.category_id),
          primary,
          transaction,
        );
      }
      const [clock] = await select(
        'SELECT transaction_timestamp() AS deleted_at',
        transaction,
      );
      if (productIds.length) {
        await sequelize.query(
          `UPDATE products SET deleted_at=COALESCE(deleted_at,:at),product_status='archived' WHERE id IN (:ids) AND (deleted_at IS NULL OR product_status<>'archived')`,
          { replacements: { ids: productIds, at: clock.deleted_at }, transaction },
        );
        // Record before/after variant state; variants have no generic audit trigger.
        for (const variant of plan.variants_to_soft_delete.filter(
          (row) => !row.deleted_at || row.is_active,
        )) {
          await sequelize.query(
            `INSERT INTO audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id,reason)
            VALUES('product_variant',:id,'delete',CAST(:old AS jsonb),CAST(:new AS jsonb),ARRAY['deleted_at','is_active'],
            NULLIF(current_setting('catalog.actor',true),'')::uuid,current_setting('catalog.actor_type',true),NULLIF(current_setting('catalog.request_id',true),''),'Recursive category deletion')`,
            {
              transaction,
              replacements: {
                id: String(variant.id),
                old: JSON.stringify(variant),
                new: JSON.stringify({
                  ...variant,
                  deleted_at: variant.deleted_at ?? clock.deleted_at,
                  is_active: false,
                }),
              },
            },
          );
        }
        await sequelize.query(
          `UPDATE product_variants SET deleted_at=COALESCE(deleted_at,:at),is_active=FALSE,updated_at=:at
          WHERE product_id IN (:ids) AND (deleted_at IS NULL OR is_active)`,
          { replacements: { ids: productIds, at: clock.deleted_at }, transaction },
        );
        for (const productId of productIds) {
          const remaining =
            plan.shared_products.find((row) => row.product_id === productId)
              ?.remaining_assignments ?? [];
          const primary =
            remaining.find((row) => row.is_primary)?.category_id ??
            remaining[0]?.category_id ??
            null;
          await sequelize.query(
            `UPDATE product_catalog SET active=FALSE,
            data=jsonb_set(jsonb_set(data,'{category_ids}',CAST(:ids AS jsonb)),'{categoryId}',CAST(:primary AS jsonb))
            WHERE data->>'source_product_id'=:product OR id=:direct OR id IN
              (SELECT 'variant:'||id FROM product_variants WHERE product_id=:product) OR id IN
              (SELECT 'shop:'||vp.id FROM vendor_products vp JOIN product_variants v ON v.id=vp.variant_id WHERE v.product_id=:product)`,
            {
              transaction,
              replacements: {
                product: productId,
                direct: 'product:' + productId,
                ids: JSON.stringify(remaining.map((row) => String(row.category_id))),
                primary: JSON.stringify(primary === null ? null : String(primary)),
              },
            },
          );
        }
      }
      for (const projection of plan.stale_catalog_projections_to_clean) {
        const [cached] = await select(
          'SELECT data FROM product_catalog WHERE id=:id AND NOT active',
          transaction,
          { id: projection.id },
        );
        if (!cached)
          throw new HttpError(409, 'Catalog changed; review a fresh deletion preview');
        const previous = cached.data;
        const next = { ...previous };
        if (Array.isArray(previous.category_ids))
          next.category_ids = previous.category_ids.filter(
            (categoryId) => !categoryIds.includes(String(categoryId)),
          );
        if (categoryIds.includes(String(previous.categoryId)))
          next.categoryId = Array.isArray(next.category_ids)
            ? (next.category_ids[0] ?? null)
            : null;
        await sequelize.query(
          'UPDATE product_catalog SET data=CAST(:data AS jsonb) WHERE id=:id AND NOT active',
          {
            transaction,
            replacements: { id: projection.id, data: JSON.stringify(next) },
          },
        );
        await sequelize.query(
          `INSERT INTO audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id,reason)
          VALUES('product_catalog',:id,'category_reference_removed',CAST(:old AS jsonb),CAST(:new AS jsonb),ARRAY['categoryId','category_ids'],
          NULLIF(current_setting('catalog.actor',true),'')::uuid,current_setting('catalog.actor_type',true),NULLIF(current_setting('catalog.request_id',true),''),'Inactive cache reference cleanup during category deletion')`,
          {
            transaction,
            replacements: {
              id: projection.id,
              old: JSON.stringify({
                categoryId: previous.categoryId ?? null,
                category_ids: previous.category_ids ?? null,
              }),
              new: JSON.stringify({
                categoryId: next.categoryId ?? null,
                category_ids: next.category_ids ?? null,
              }),
            },
          },
        );
      }
      const summary = {
        ...plan.counts,
        deleted_category_id: String(id),
        deleted_category_name: plan.categories_to_delete.find(
          (row) => String(row.id) === String(id),
        ).name,
        deleted_category_ids: categoryIds,
        affected_product_ids: productIds,
        shared_product_ids: plan.shared_products.map((row) => row.product_id),
        stale_catalog_projection_ids_cleaned: plan.stale_catalog_projections_to_clean.map(
          (row) => row.id,
        ),
        deleted_by: req?.auth?.realm === 'admin' ? req.auth.userId : null,
        deleted_at: clock.deleted_at,
        fingerprint: plan.fingerprint,
      };
      for (const category of plan.categories_to_delete) {
        const assignments = plan.assignments_to_remove.filter(
          (row) => String(row.category_id) === String(category.id),
        );
        const detail = {
          counts_scope: 'entire_operation',
          ...summary,
          deleted_category_id: String(category.id),
          deleted_category_name: category.name,
          previous_parent_id: category.parent_id,
          direct_assignments_removed: assignments.length,
          direct_affected_product_ids: assignments.map((row) => String(row.product_id)),
          previous_children: plan.categories_to_delete
            .filter((row) => String(row.parent_id) === String(category.id))
            .map((row) => String(row.id)),
        };
        await sequelize.query(
          "SELECT set_config('catalog.category_delete_summary',:summary,true)",
          { transaction, replacements: { summary: JSON.stringify(detail) } },
        );
        const [residual] = await select(
          `SELECT
          (SELECT count(*) FROM categories WHERE parent_id=:id) +
          (SELECT count(*) FROM product_categories WHERE category_id=:id) AS count`,
          transaction,
          { id: category.id },
        );
        if (Number(residual.count))
          throw new HttpError(409, 'Category relationships changed; retry deletion');
        await sequelize.query('DELETE FROM categories WHERE id=:id', {
          transaction,
          replacements: { id: category.id },
        });
      }
      return summary;
    });
  } catch (error) {
    const code = error.original?.code ?? error.parent?.code;
    if (['55P03', '40P01', '40001'].includes(code))
      throw new HttpError(
        409,
        'Catalog is being edited; retry after reviewing a fresh preview',
      );
    if (code === '23503')
      throw new HttpError(
        409,
        'A remaining dependency prevents category deletion; no changes were saved',
      );
    throw error;
  }
}
