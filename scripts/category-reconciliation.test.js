import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCategories,
  planCategoryReconciliation,
} from '../src/shared/category-reconciliation.js';

const row = (id, name, parent_id = null) => ({
  id: String(id),
  name,
  parent_id: parent_id === null ? null : String(parent_id),
  slug: `c-${id}`,
  image_url: null,
  is_active: true,
});
const snapshot = () => ({
  categories: [
    row(2, 'Daily Living'),
    row(50, 'Daily Living '),
    row(1, 'Adult Diaper', 2),
    row(51, 'Adult Diaper', 50),
    row(36, 'Health & Beauty'),
    row(37, 'Healthcare Products', 36),
    row(38, 'Health & Personal Care'),
    row(39, 'Healthcare Products', 38),
    row(41, 'Healthcare Products'),
  ],
  links: [
    { product_id: '10', category_id: '50', is_primary: false, product_name: 'Product' },
    { product_id: '10', category_id: '51', is_primary: true, product_name: 'Product' },
  ],
  constraints: [],
  indexes: [],
});
const proposal = { categoryMap: { 50: '2', 51: '1' } };

test('audit distinguishes sibling duplicates, legitimate cross-parent names and malformed hierarchies', () => {
  const data = snapshot();
  data.categories.push(
    row(60, 'Shared', 37),
    row(61, 'Shared', 41),
    row(62, ' SHARED ', 37),
    row(63, 'Orphan', 999),
    row(64, 'Loop', 65),
    row(65, 'Loop2', 64),
  );
  const audit = auditCategories(
    data,
    { categories: [] },
    { categories: [row(2, 'Daily Living'), row(50, 'Daily Living')] },
  );
  assert.equal(audit.rootDuplicates.length, 1);
  assert.equal(audit.sameParentDuplicates.length, 1);
  assert.ok(
    audit.repeatedNamesAcrossParents.some(
      (group) =>
        group.some((record) => record.id === '37') &&
        group.some((record) => record.id === '41'),
    ),
  );
  assert.equal(audit.orphanParents[0].id, '63');
  assert.ok(audit.cycles.length);
  assert.equal(
    audit.preImportEvidence.find((record) => record.categoryId === '50')
      .existedBeforeImport,
    true,
  );
});

test('plan preserves primary flags, IDs and images while merging destination link collisions', () => {
  const data = snapshot();
  data.categories[0].image_url = 'https://keep.example/image.png';
  data.links.push({
    product_id: '10',
    category_id: '1',
    is_primary: false,
    product_name: 'Product',
  });
  const plan = planCategoryReconciliation(data, proposal);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.totals.categoryDeletes, 0);
  assert.equal(plan.totals.s3Writes, 0);
  assert.equal(plan.totals.linksBefore, 3);
  assert.equal(plan.totals.linksAfter, 2);
  assert.equal(
    plan.linkChanges.find((change) => change.fromCategoryId === '51')
      .destinationPrimaryAfter,
    true,
  );
  assert.deepEqual(plan.categoryChanges.map((change) => change.id).sort(), ['50', '51']);
  assert.deepEqual(plan.imageChanges, []);
  assert.ok(
    !plan.categoryChanges.some((change) => ['37', '39', '41'].includes(change.id)),
  );
});

test('cross-parent taxonomy guesses, missing IDs, chained maps and child collisions block apply', () => {
  assert.ok(
    planCategoryReconciliation(snapshot(), { categoryMap: { 37: '41' } }).conflicts.some(
      (message) => message.includes('Cross-parent'),
    ),
  );
  assert.ok(
    planCategoryReconciliation(snapshot(), { categoryMap: { 999: '2' } }).conflicts
      .length,
  );
  assert.ok(
    planCategoryReconciliation(snapshot(), { categoryMap: { 50: '2', 2: '1' } }).conflicts
      .length,
  );
  assert.ok(
    planCategoryReconciliation(snapshot(), { categoryMap: { 50: '2' } }).conflicts.some(
      (message) => message.includes('explicit reviewed child mapping'),
    ),
  );
});
