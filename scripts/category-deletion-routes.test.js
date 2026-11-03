import test from 'node:test';
import assert from 'node:assert/strict';
import { categoriesRoutes } from '../src/admin/categories/categories.routes.js';
import { deleteCategory, deletionPreview } from '../src/admin/categories/categories.controller.js';

test('recursive category deletion and read-only preview are registered with admin authentication', () => {
  const deletion = categoriesRoutes.find(r => r.method === 'delete' && r.path === '/:categoryId');
  const preview = categoriesRoutes.find(r => r.method === 'get' && r.path === '/:categoryId/deletion-preview');
  assert.equal(deletion.handler, deleteCategory);
  assert.equal(deletion.auth, true);
  assert.equal(preview.handler, deletionPreview);
  assert.equal(preview.auth, true);
  assert.deepEqual(deletion.query.parse({}), {});
  assert.equal(deletion.query.parse({ response: 'summary' }).response, 'summary');
});
