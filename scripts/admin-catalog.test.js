import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePricing, effectivePrice } from '../src/shared/catalog-fields.js';
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

  // Conditional Accessories, Gift Options, and Gift Wrap rules
  assert.deepEqual(normalizePricing({ accessories: '2 Reusable Pads' }), {
    accessories: '2 Reusable Pads',
    has_accessories: true,
  });
  assert.deepEqual(
    normalizePricing(
      { has_accessories: false },
      { has_accessories: true, accessories: 'Old' },
    ),
    { has_accessories: false, accessories: null },
  );
  assert.throws(
    () => normalizePricing({ has_accessories: true }),
    /accessories is required/,
  );
  assert.deepEqual(
    normalizePricing({ gift_options_available: true, gift_options_charge: 49.5 }),
    { gift_options_available: true, gift_options_charge: 49.5 },
  );
  assert.deepEqual(
    normalizePricing(
      { gift_options_available: false },
      { gift_options_available: true, gift_options_charge: '49.50' },
    ),
    { gift_options_available: false, gift_options_charge: null },
  );
  assert.throws(
    () => normalizePricing({ gift_options_available: true }),
    /gift_options_charge is required/,
  );
  assert.throws(
    () => normalizePricing({ gift_options_charge: 25 }),
    /requires gift_options_available/,
  );
  assert.deepEqual(
    normalizePricing({ gift_wrap_available: true, gift_wrap_charge: 30 }),
    { gift_wrap_available: true, gift_wrap_charge: 30 },
  );
  assert.throws(
    () => normalizePricing({ gift_wrap_available: true }),
    /gift_wrap_charge is required/,
  );
  assert.throws(
    () => normalizePricing({ gift_wrap_charge: 30 }),
    /requires gift_wrap_available/,
  );
});

test('native product contract uses details and rejects invalid money, tax and sorting', () => {
  const body = {
    product_code: 'DIAPER-M',
    product_name: 'Diaper M',
    slug: 'diaper-m',
    mrp: 999,
    selling_price: 799,
    tax_rate: 5,
    details: {
      size: 'M',
      product_length: 60,
      product_width: 90,
      product_height: 0.5,
      dimension_unit: 'cm',
      specifications: { reusable: false },
    },
  };
  const parsed = createProductSchema.parse(body);
  assert.equal(parsed.details.product_width, 90);
  assert.equal(parsed.details.specifications.reusable, false);
  for (const invalid of [
    { tax_rate: 101 },
    { selling_price: -1 },
    { selling_price: 1.001 },
    { base_price: 1 },
    { product_type: 'other' },
    { mrp: 1 },
  ])
    assert.equal(createProductSchema.safeParse({ ...body, ...invalid }).success, false);
  assert.equal(updateProductSchema.safeParse({}).success, false);
  assert.equal(updateProductSchema.safeParse({ category_ids: [1] }).success, false);
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
    ['POST', '/api/admin/banners/home-offer/image'],
    ['PUT', '/api/admin/banners/home-offer/image'],
    ['POST', '/api/admin/banners/home-offer/mobile-image'],
    ['PUT', '/api/admin/banners/home-offer/mobile-image'],
    ['POST', '/api/admin/banners/batch'],
    ['POST', '/api/admin/labs/redcliffe/image'],
    ['PUT', '/api/admin/labs/redcliffe/image'],
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

test('catalog inputs stay within PostgreSQL storage bounds and never silently replace an explicit sale price', () => {
  for (const body of [
    { stock_quantity: 2147483648 },
    { min_order_quantity: 2147483648 },
    { unit_count: 2147483648 },
    { age_max: 2147483648 },
    { seller_handling_days: 2147483648 },
    { weight: 1000000000 },
    { package_height: 1.0001 },
    { product_breadth: 1000000000000 },
    { net_weight: 1.0001 },
  ]) {
    assert.equal(
      updateProductSchema.safeParse(body).success,
      false,
      JSON.stringify(body),
    );
  }
  assert.equal(
    updateProductSchema.safeParse({
      stock_quantity: 2147483647,
      details: { product_weight: 9999999.999 },
    }).success,
    true,
  );
  assert.throws(
    () => normalizePricing({ regular_price: 100, offer_percent: 20, sale_price: 50 }),
    /conflicts with offer_percent/,
  );
  assert.throws(
    () =>
      normalizePricing({ sale_price: 50 }, { regular_price: '100', offer_percent: '20' }),
    /clear offer_percent/,
  );
  assert.equal(
    normalizePricing(
      { offer_percent: null, sale_price: 50 },
      { regular_price: '100', offer_percent: '20' },
    ).sale_price,
    50,
  );
  assert.equal(
    normalizePricing({ regular_price: 100, offer_percent: 20, sale_price: 80 })
      .sale_price,
    80,
  );
  assert.equal(
    normalizePricing({ regular_price: 100, offer_percent: 20, sale_price: null })
      .sale_price,
    80,
  );
});
