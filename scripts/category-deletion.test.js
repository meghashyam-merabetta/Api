import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryDeletionTree } from '../src/shared/category-deletion.js';

test('category deletion deduplicates overlapping roots and orders descendants before parents', () => {
  const rows = [
    { id: '36', parent_id: null },
    { id: '37', parent_id: '36' },
    { id: '38', parent_id: '37' },
    { id: '41', parent_id: null },
  ];
  assert.deepEqual(
    categoryDeletionTree(rows, [36, 37, 36]).map((row) => row.id),
    ['38', '37', '36'],
  );
  assert.deepEqual(
    categoryDeletionTree(rows, [37]).map((row) => row.id),
    ['38', '37'],
  );
});

test('category deletion rejects missing IDs and corrupt cycles before planning writes', () => {
  assert.throws(() => categoryDeletionTree([], [28]), /not found/);
  assert.throws(
    () =>
      categoryDeletionTree(
        [
          { id: 1, parent_id: 2 },
          { id: 2, parent_id: 1 },
        ],
        [1],
      ),
    /cycle/,
  );
});
