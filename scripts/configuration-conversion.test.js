import test from 'node:test';
import assert from 'node:assert/strict';
import { planConfigurationConversion } from '../src/shared/configuration-conversion.js';
const snapshot = () => ({
  products: [
    {
      id: '10',
      stock_quantity: 0,
      product_status: 'active',
      regular_price: '100',
      sale_price: '80',
    },
  ],
  variants: [
    {
      id: '1',
      product_id: '10',
      sku: 'S',
      attributes: { Size: 'S' },
      is_active: true,
      regular_price: '100',
      sale_price: '80',
      stock_quantity: 5,
    },
    {
      id: '2',
      product_id: '10',
      sku: 'M',
      attributes: { Size: 'M' },
      is_active: true,
      regular_price: '100',
      sale_price: '80',
      stock_quantity: 7,
    },
  ],
  links: [],
  offers: [],
  inventory: [],
});
test('conversion plans separate products without inventing stock or changing exact attributes', () => {
  const p = planConfigurationConversion(snapshot());
  assert.equal(p.can_apply, true);
  assert.equal(p.planned.length, 2);
  assert.deepEqual(
    p.planned.map((p) => p.initial_available),
    [5, 7],
  );
  assert.deepEqual(p.planned[0].attributes, { Size: 'S' });
});
test('conversion refuses ambiguous shared stock and preserves existing ownership', () => {
  const s = snapshot();
  s.products[0].stock_quantity = 20;
  s.offers = [{ id: '8', variant_id: '1', currency: 'INR' }];
  s.inventory = [
    {
      id: '9',
      vendor_product_id: '8',
      product_id: '10',
      warehouse_code: 'DEFAULT',
      quantity_on_hand: 5,
      quantity_reserved: 0,
    },
  ];
  const p = planConfigurationConversion(s);
  assert.equal(p.can_apply, false);
  assert.ok(p.conflicts[0].reasons.some((r) => r.includes('ownership')));
  assert.ok(p.conflicts[0].reasons.some((r) => r.includes('allocation')));
});
test('converted, deleted and inactive-source records are not resurrected or duplicated', () => {
  const s = snapshot();
  s.links = [{ variant_id: '1' }];
  s.variants[1].deleted_at = '2026-11-02';
  assert.equal(planConfigurationConversion(s).planned.length, 0);
  const inactive = snapshot();
  inactive.products[0].product_status = 'inactive';
  assert.ok(
    planConfigurationConversion(inactive).planned.every(
      (p) => p.product_status === 'inactive',
    ),
  );
});

test('an explicit variant-stock decision has a distinct fingerprint and does not suppress warehouse conflicts', () => {
  const s = snapshot();
  s.products[0].stock_quantity = 5;
  const strict = planConfigurationConversion(s);
  const accepted = planConfigurationConversion(s, { stockSource: 'variants' });
  assert.equal(strict.can_apply, false);
  assert.equal(accepted.can_apply, true);
  assert.notEqual(strict.fingerprint, accepted.fingerprint);
  s.inventory = [
    {
      id: '9',
      product_id: '10',
      vendor_product_id: null,
      warehouse_code: 'DEFAULT',
      quantity_on_hand: 5,
      quantity_reserved: 0,
    },
  ];
  assert.equal(
    planConfigurationConversion(s, { stockSource: 'variants' }).can_apply,
    false,
  );
});
