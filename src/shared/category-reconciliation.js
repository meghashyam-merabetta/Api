import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { normalizeCategoryName } from './category-identity.js';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value) => (value === null || value === undefined ? null : String(value));
const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  return [...groups.values()];
};
export class CategoryReconciliationError extends Error {}

export async function readCategorySnapshot(connection, transaction) {
  const options = { transaction, type: QueryTypes.SELECT, logging: false };
  const categories = await connection.query(
    'SELECT * FROM public.categories ORDER BY id',
    options,
  );
  const links = await connection.query(
    'SELECT pc.*,p.name AS product_name FROM public.product_categories pc LEFT JOIN public.products p ON p.id=pc.product_id ORDER BY pc.product_id,pc.category_id',
    options,
  );
  const constraints = await connection.query(
    "SELECT conname,conrelid::regclass::text AS source_table,confrelid::regclass::text AS target_table,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('public.categories'::regclass,'public.product_categories'::regclass) OR confrelid IN ('public.categories'::regclass,'public.product_categories'::regclass) ORDER BY conname",
    options,
  );
  const indexes = await connection.query(
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('categories','product_categories') ORDER BY tablename,indexname",
    options,
  );
  return { categories, links, constraints, indexes };
}

export function auditCategories(snapshot, workbook, beforeImport) {
  const { categories, links } = snapshot;
  const byId = new Map(categories.map((row) => [id(row.id), row]));
  const describe = (row) => ({
    id: id(row.id),
    name: row.name,
    parentId: id(row.parent_id),
    parentName: byId.get(id(row.parent_id))?.name ?? null,
    directChildren: categories.filter((child) => id(child.parent_id) === id(row.id))
      .length,
    activeChildren: categories.filter(
      (child) => id(child.parent_id) === id(row.id) && child.is_active,
    ).length,
    directProducts: links.filter((link) => id(link.category_id) === id(row.id)).length,
    primaryProducts: links.filter(
      (link) => id(link.category_id) === id(row.id) && link.is_primary,
    ).length,
    imageUrl: row.image_url,
    active: row.is_active,
    createdAt: row.created_at,
  });
  const siblingGroups = groupBy(
    categories,
    (row) => `${id(row.parent_id) ?? 'ROOT'}:${normalizeCategoryName(row.name)}`,
  ).filter((group) => group.length > 1);
  const sameNameGroups = groupBy(categories, (row) =>
    normalizeCategoryName(row.name),
  ).filter((group) => new Set(group.map((row) => id(row.parent_id))).size > 1);
  const orphanParents = categories
    .filter((row) => row.parent_id !== null && !byId.has(id(row.parent_id)))
    .map(describe);
  const cycles = [],
    repeatedAncestorNames = [];
  for (const row of categories) {
    const visited = new Set([id(row.id)]);
    let parent = byId.get(id(row.parent_id));
    while (parent) {
      if (visited.has(id(parent.id))) {
        cycles.push({ categoryId: id(row.id), ancestorId: id(parent.id) });
        break;
      }
      visited.add(id(parent.id));
      if (normalizeCategoryName(parent.name) === normalizeCategoryName(row.name))
        repeatedAncestorNames.push({
          categoryId: id(row.id),
          ancestorId: id(parent.id),
          reason:
            'Repeated ancestor name; semantic hierarchy requires review, not automatic reparenting',
        });
      parent = byId.get(id(parent.parent_id));
    }
  }
  const invalidProductLinks = links.filter(
    (link) => !byId.has(id(link.category_id)) || link.product_name === null,
  );
  const duplicateProductLinks = groupBy(
    links,
    (link) => `${link.product_id}:${link.category_id}`,
  ).filter((group) => group.length > 1);
  const primaryConflicts = groupBy(
    links.filter((link) => link.is_primary),
    (link) => id(link.product_id),
  )
    .filter((group) => group.length > 1)
    .map((group) => ({
      productId: id(group[0].product_id),
      categories: group.map((link) => id(link.category_id)),
    }));
  const workbookComparison = workbook.categories.map((source) => {
    const roots = categories.filter(
      (row) =>
        row.parent_id === null &&
        normalizeCategoryName(row.name) === normalizeCategoryName(source.name),
    );
    // Explicit previously selected workbook root; other duplicate roots stay in the audit.
    const root =
      roots.find(
        (row) =>
          id(row.id) ===
          (normalizeCategoryName(source.name) === 'daily living' ? '2' : null),
      ) ?? (roots.length === 1 ? roots[0] : null);
    const children = root
      ? categories.filter((row) => id(row.parent_id) === id(root.id))
      : [];
    const missing = source.subcategories
      .filter(
        (child) =>
          !children.some(
            (row) =>
              normalizeCategoryName(row.name) === normalizeCategoryName(child.name),
          ),
      )
      .map((child) => child.name);
    const elsewhere = missing.map((name) => ({
      name,
      candidates: categories
        .filter((row) => normalizeCategoryName(row.name) === normalizeCategoryName(name))
        .map(describe),
    }));
    const extraChildren = children
      .filter(
        (row) =>
          !source.subcategories.some(
            (child) =>
              normalizeCategoryName(row.name) === normalizeCategoryName(child.name),
          ),
      )
      .map(describe);
    return {
      name: source.name,
      rootId: id(root?.id),
      candidateRootIds: roots.map((row) => id(row.id)),
      workbookChildren: source.subcategories.length,
      foundChildren: source.subcategories.length - missing.length,
      missing,
      elsewhere,
      extraChildren,
    };
  });
  const relevantIds = new Set(
    [...siblingGroups.flat(), ...sameNameGroups.flat()].map((row) => id(row.id)),
  );
  const beforeIds = new Set((beforeImport?.categories ?? []).map((row) => id(row.id)));
  return {
    counts: {
      categories: categories.length,
      roots: categories.filter((row) => row.parent_id === null).length,
      activeCategories: categories.filter((row) => row.is_active).length,
      productLinks: links.length,
      distinctProducts: new Set(links.map((link) => id(link.product_id))).size,
    },
    rootDuplicates: siblingGroups
      .filter((group) => group[0].parent_id === null)
      .map((group) => group.map(describe)),
    sameParentDuplicates: siblingGroups
      .filter((group) => group[0].parent_id !== null)
      .map((group) => group.map(describe)),
    repeatedNamesAcrossParents: sameNameGroups.map((group) => group.map(describe)),
    orphanParents,
    cycles,
    repeatedAncestorNames,
    missingImages: categories.filter((row) => !row.image_url?.trim()).map(describe),
    invalidProductLinks,
    duplicateProductLinks,
    primaryConflicts,
    workbookComparison,
    preImportEvidence: [...relevantIds].map((categoryId) => ({
      categoryId,
      existedBeforeImport: beforeImport ? beforeIds.has(categoryId) : null,
    })),
    suspectedRecords: categories
      .filter((row) => relevantIds.has(id(row.id)))
      .map((row) => ({
        ...describe(row),
        proposedAction: ['50', '51'].includes(id(row.id))
          ? 'Propose consolidating into 2 / 1, retain source IDs as inactive records; approval required'
          : ['37', '39', '41'].includes(id(row.id))
            ? 'Preserve path and product links; cross-parent taxonomy needs separate business review'
            : 'Preserve; inspect exact path rather than deduplicating by name globally',
      })),
    constraints: snapshot.constraints,
    indexes: snapshot.indexes,
  };
}

// No category DELETE, no slug changes, no S3 operations. The plan enumerates
// every source link removal only after its destination association is preserved.
export function planCategoryReconciliation(snapshot, proposal, target = {}) {
  const { categories, links } = snapshot;
  const mapping = new Map(Object.entries(proposal.categoryMap ?? {}));
  const byId = new Map(categories.map((row) => [id(row.id), row]));
  const conflicts = [],
    categoryChanges = [],
    linkChanges = [],
    imageChanges = [];
  if (!mapping.size) conflicts.push('Provide an explicit categoryMap');
  for (const [sourceId, targetId] of mapping) {
    if (
      !/^[1-9][0-9]*$/.test(sourceId) ||
      !/^[1-9][0-9]*$/.test(targetId) ||
      sourceId === targetId ||
      mapping.has(targetId)
    ) {
      conflicts.push(`Invalid or chained mapping ${sourceId} -> ${targetId}`);
      continue;
    }
    const source = byId.get(sourceId),
      canonical = byId.get(targetId);
    if (!source || !canonical) {
      conflicts.push(`Missing category ${sourceId} / ${targetId}`);
      continue;
    }
    if (normalizeCategoryName(source.name) !== normalizeCategoryName(canonical.name))
      conflicts.push(
        `Names differ for ${sourceId} / ${targetId}; no inferred merges allowed`,
      );
    if (
      (mapping.get(id(source.parent_id)) ?? id(source.parent_id)) !==
      id(canonical.parent_id)
    )
      conflicts.push(
        `Cross-parent mapping ${sourceId} -> ${targetId} requires separate taxonomy approval`,
      );
    if (!canonical.is_active)
      conflicts.push(`Canonical category ${targetId} must be active`);
    if (source.is_active)
      categoryChanges.push({
        id: sourceId,
        before: { is_active: true, parent_id: id(source.parent_id) },
        after: { is_active: false, parent_id: id(source.parent_id) },
        reason: `Retain retired ID; canonical category is ${targetId}`,
      });
    if (!canonical.image_url && source.image_url) {
      const already = imageChanges.find((change) => change.id === targetId);
      if (already && already.image_url !== source.image_url)
        conflicts.push(`Conflicting images for canonical ${targetId}`);
      else if (!already) imageChanges.push({ id: targetId, image_url: source.image_url });
    }
  }
  for (const child of categories) {
    const destination = mapping.get(id(child.parent_id));
    if (!destination || mapping.has(id(child.id))) continue;
    const collision = categories.find(
      (row) =>
        id(row.parent_id) === destination &&
        normalizeCategoryName(row.name) === normalizeCategoryName(child.name) &&
        id(row.id) !== id(child.id),
    );
    if (collision) {
      conflicts.push(
        `Child ${child.id} collides with ${collision.id}; add an explicit reviewed child mapping`,
      );
      continue;
    }
    categoryChanges.push({
      id: id(child.id),
      before: { is_active: child.is_active, parent_id: id(child.parent_id) },
      after: { is_active: child.is_active, parent_id: destination },
      reason: 'Move nonduplicate child under canonical parent',
    });
  }
  const resultLinks = new Map(
    links.map((link) => [
      `${link.product_id}:${link.category_id}`,
      {
        product_id: id(link.product_id),
        category_id: id(link.category_id),
        is_primary: link.is_primary,
      },
    ]),
  );
  for (const link of links) {
    const canonical = mapping.get(id(link.category_id));
    if (!canonical) continue;
    const key = `${link.product_id}:${canonical}`,
      existing = resultLinks.get(key);
    const after = {
      product_id: id(link.product_id),
      category_id: canonical,
      is_primary: Boolean(existing?.is_primary || link.is_primary),
    };
    linkChanges.push({
      productId: id(link.product_id),
      productName: link.product_name,
      fromCategoryId: id(link.category_id),
      toCategoryId: canonical,
      sourcePrimary: link.is_primary,
      destinationExisted: Boolean(existing),
      destinationPrimaryBefore: existing?.is_primary ?? null,
      destinationPrimaryAfter: after.is_primary,
    });
    resultLinks.set(key, after);
    resultLinks.delete(`${link.product_id}:${link.category_id}`);
  }
  const primaryConflicts = groupBy(
    [...resultLinks.values()].filter((link) => link.is_primary),
    (link) => link.product_id,
  ).filter((group) => group.length > 1);
  if (primaryConflicts.length)
    conflicts.push(
      'Multiple primary categories require separate review; no primary category will be guessed',
    );
  const productIds = [...new Set(linkChanges.map((change) => change.productId))].sort();
  // Validate resulting graph, including mapping an ancestor into its descendant.
  const parents = new Map(categories.map((row) => [id(row.id), id(row.parent_id)]));
  for (const change of categoryChanges) parents.set(change.id, change.after.parent_id);
  for (const start of parents.keys()) {
    const seen = new Set();
    let current = start;
    while (current) {
      if (seen.has(current)) {
        conflicts.push(`Hierarchy cycle involving ${start}`);
        break;
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  const count = (rows, categoryId) =>
    rows.filter((row) => id(row.category_id) === categoryId).length;
  const categoryCounts = [...new Set([...mapping.keys(), ...mapping.values()])].map(
    (categoryId) => ({
      categoryId,
      productsBefore: count(links, categoryId),
      productsAfter: count([...resultLinks.values()], categoryId),
      childrenBefore: categories.filter((row) => id(row.parent_id) === categoryId).length,
      childrenAfter: [...parents.values()].filter((parent) => parent === categoryId)
        .length,
    }),
  );
  const plan = {
    version: 1,
    mode: 'dry-run',
    target,
    proposal,
    snapshotHash: digest(snapshot),
    conflicts: [...new Set(conflicts)],
    categoryChanges,
    linkChanges,
    imageChanges,
    affectedProductIds: productIds,
    categoryCounts,
    totals: {
      categoryRowsBefore: categories.length,
      categoryRowsAfter: categories.length,
      activeCategoriesBefore: categories.filter((row) => row.is_active).length,
      activeCategoriesAfter:
        categories.filter((row) => row.is_active).length -
        categoryChanges.filter(
          (change) => change.before.is_active && !change.after.is_active,
        ).length,
      linksBefore: links.length,
      linksAfter: resultLinks.size,
      sourceLinksToMove: linkChanges.length,
      affectedProducts: productIds.length,
      categoryDeletes: 0,
      s3Writes: 0,
    },
  };
  plan.planHash = digest(plan);
  return plan;
}

export async function applyCategoryReconciliation({
  connection,
  snapshotReader = readCategorySnapshot,
  proposal,
  target,
  approvedPlanHash,
  publish,
  log = () => {},
}) {
  return connection.transaction(async (transaction) => {
    await connection.query("SET LOCAL lock_timeout = '10s'", { transaction });
    await connection.query(
      'LOCK TABLE public.categories, public.product_categories, public.products, public.product_catalog IN SHARE ROW EXCLUSIVE MODE',
      { transaction },
    );
    const snapshot = await snapshotReader(connection, transaction);
    const plan = planCategoryReconciliation(snapshot, proposal, target);
    if (plan.conflicts.length)
      throw new CategoryReconciliationError('Reconciliation has unresolved conflicts');
    if (plan.planHash !== approvedPlanHash)
      throw new CategoryReconciliationError(
        'Approved plan is stale; run another dry run',
      );
    for (const change of plan.linkChanges) {
      await connection.query(
        'INSERT INTO public.product_categories(product_id,category_id,is_primary) VALUES(:product,:category,:primary) ON CONFLICT(product_id,category_id) DO UPDATE SET is_primary = product_categories.is_primary OR EXCLUDED.is_primary',
        {
          replacements: {
            product: change.productId,
            category: change.toCategoryId,
            primary: change.destinationPrimaryAfter,
          },
          transaction,
        },
      );
      await connection.query(
        'DELETE FROM public.product_categories WHERE product_id=:product AND category_id=:category',
        {
          replacements: { product: change.productId, category: change.fromCategoryId },
          transaction,
        },
      );
      log({ event: 'product-category-moved', ...change });
    }
    for (const change of plan.categoryChanges) {
      await connection.query(
        'UPDATE public.categories SET parent_id=:parent,is_active=:active,updated_at=now() WHERE id=:id',
        {
          replacements: {
            id: change.id,
            parent: change.after.parent_id,
            active: change.after.is_active,
          },
          transaction,
        },
      );
      log({ event: 'category-updated', ...change });
    }
    for (const change of plan.imageChanges) {
      await connection.query(
        'UPDATE public.categories SET image_url=:url,updated_at=now() WHERE id=:id AND image_url IS NULL',
        { replacements: { id: change.id, url: change.image_url }, transaction },
      );
    }
    for (const productId of plan.affectedProductIds)
      await publish(productId, transaction);
    return { ...plan, mode: 'applied' };
  });
}
