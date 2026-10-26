import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePricing,
  effectivePrice,
} from '../src/admin/products/catalog-fields.js';
import {
  createProductSchema,
  updateProductSchema,
  listQuerySchema,
} from '../src/admin/products/products.schema.js';

test('pricing validates merged PATCH data, aliases, zero offers and quantity boundaries', () => {
  assert.deepEqual(normalizePricing({ mrp: 100, offer_price: 80 }), {
    regular_price: 100,
    sale_price: 80,
  });
  assert.equal(
    normalizePricing({ offer_percent: 100 }, { regular_price: '99.99' }).sale_price,
    0,
  );
  assert.equal(
    normalizePricing({ regular_price: 200 }, { offer_percent: '20' }).sale_price,
    160,
  );
  assert.equal(
    normalizePricing({ offer_percent: 0 }, { regular_price: '99.99' }).sale_price,
    99.99,
  );
  assert.throws(
    () => normalizePricing({ regular_price: 50 }, { sale_price: '80' }),
    /cannot exceed/,
  );
  assert.throws(
    () => normalizePricing({ regular_price: null }, { sale_price: '80' }),
    /requires/,
  );
  assert.throws(
    () => normalizePricing({ min_order_quantity: 5 }, { max_order_quantity: 3 }),
    /max_order_quantity/,
  );
  assert.throws(() => normalizePricing({ mrp: 100, regular_price: 200 }), /must agree/);
  assert.throws(() => normalizePricing({ offer_percent: 10 }), /required/);
  assert.equal(
    effectivePrice({
      regular_price: '100',
      sale_price: '80',
      special_discount_enabled: true,
      special_discount_percent: 10,
      festival_offer_enabled: true,
      festival_offer_percent: 5,
    }),
    68.4,
  );
  assert.equal(effectivePrice({ regular_price: 100, sale_price: 0 }), 0);
});

test('product contract accepts specifications and rejects invalid price, tax and sort values', () => {
  const body = {
    product_name: 'Diaper M',
    slug: 'diaper-m',
    mrp: 999,
    offer_price: 799,
    gst_rate: 5,
    keywords: ['adult', 'diaper'],
    unit_count: 10,
    water_resistant: true,
    package_length: 20,
    company_address: 'Example',
  };
  assert.equal(createProductSchema.parse(body).unit_count, 10);
  for (const invalid of [
    { gst_rate: 101 },
    { unit_count: 0 },
    { regular_price: -1 },
    { sale_price: 1.001 },
    { water_resistant: 'false' },
  ])
    assert.equal(createProductSchema.safeParse({ ...body, ...invalid }).success, false);
  assert.equal(updateProductSchema.safeParse({}).success, false);
  assert.equal(
    updateProductSchema.safeParse({ category_ids: [1], primary_category_id: 2 }).success,
    false,
  );
  assert.equal(
    listQuerySchema.safeParse({ sort_by: 'name; DROP TABLE products' }).success,
    false,
  );
});

test('image multipart writes require a trusted origin and permit PUT replacement', async () => {
  const { csrfGuard } = await import('../src/shared/security.js');
  const { env } = await import('../src/config/env.js');
  for (const [method, url] of [
    ['POST', '/api/admin/products/1/images'],
    ['PUT', '/api/admin/products/1/images/2'],
  ]) {
    const request = (origin, type) => ({
      method,
      path: url,
      get: (name) => (name === 'origin' ? origin : undefined),
      is: (expected) => type === expected,
    });
    let accepted = false;
    csrfGuard(request(env.ALLOWED_ORIGINS[0], 'multipart/form-data'), {}, () => {
      accepted = true;
    });
    assert.equal(accepted, true);
    assert.throws(
      () =>
        csrfGuard(
          request('https://untrusted.example', 'multipart/form-data'),
          {},
          () => {},
        ),
      (error) => error.status === 403,
    );
    assert.throws(
      () => csrfGuard(request(undefined, 'multipart/form-data'), {}, () => {}),
      (error) => error.status === 403,
    );
    assert.throws(
      () => csrfGuard(request(env.ALLOWED_ORIGINS[0], 'application/json'), {}, () => {}),
      (error) => error.status === 415,
    );
  }
});
