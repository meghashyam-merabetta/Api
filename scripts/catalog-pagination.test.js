import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogPage } from '../src/app/redcliffe-labs/catalog.js';

const row = { code: 'A', name: 'Test', package_center_prices: { offer_price: 10, package_price: 20 } };
test('catalogue page deduplicates codes for bulk upsert and follows query pagination', () => {
  const result = parseCatalogPage({ status: 'success', data: [row, { ...row, name: 'Updated' }, { name: 'No code' }], links: { next: '/packages/?page=2' } }, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].data.name, 'Updated');
  assert.equal(result.next, 2);
});
test('catalogue pagination rejects loops, missing pages and invalid data before saving', () => {
  for (const next of ['/packages/?page=1', '/packages/?page=0', '/packages/?page=201', '/packages/']) {
    assert.throws(() => parseCatalogPage({ status: 'success', data: [row], links: { next } }, 1), /pagination/);
  }
  assert.throws(() => parseCatalogPage({ status: 'failure', data: [] }, 1), /unavailable/);
  assert.equal(parseCatalogPage({ status: 'success', data: [row] }, 2).next, 0);
});
