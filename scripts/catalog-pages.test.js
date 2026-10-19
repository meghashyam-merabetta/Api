import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackage, parseCatalogPage } from '../src/app/redcliffe-labs/catalog.js';

const row = (type = 'test') => ({
  code: 'TEST001', name: 'Example', type,
  package_center_prices: { offer_price: 100, package_price: 150 },
  category_for_web: [{ name: 'Heart' }],
});
test('provider type distinguishes packages from tests independently of parameters', () => {
  assert.equal(normalizePackage(row('package')).catalogType, 'package');
  assert.equal(normalizePackage({ ...row(), parameters: 40 }).catalogType, 'test');
});
test('pagination rejects skipped pages, empty responses and unidentifiable tests', () => {
  const body = { status: 'success', count: 3001, data: [row()], links: { next: '?page=202' } };
  assert.equal(parseCatalogPage(body, 201).next, 202);
  assert.throws(() => parseCatalogPage(body, 200));
  assert.throws(() => parseCatalogPage({ ...body, data: [] }, 201));
  assert.throws(() => parseCatalogPage({ ...body, data: [{ ...row(), code: '' }] }, 201));
});
