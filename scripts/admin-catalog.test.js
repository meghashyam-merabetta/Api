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
    normalizePricing({ has_accessories: false }, { has_accessories: true, accessories: 'Old' }),
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

test('product contract accepts specifications and rejects invalid price, tax and sort values', () => {
  const body = {
    product_name: 'Diaper M',
    slug: 'diaper-m',
    barcode: '8901234567890',
    item_condition: 'new',
    reusable: false,
    has_accessories: true,
    accessories: 'Disposal bag included',
    product_length: 60,
    product_breadth: 90,
    product_height: 0.5,
    product_dimension_unit: 'cm',
    gift_options_available: true,
    gift_options_charge: 50,
    gift_wrap_available: true,
    gift_wrap_charge: 25,
    manufacturer_sku: 'MSKU-100',
    brand_type: 'company',
    is_customisable: false,
    model_number: 'MDL-2026',
    manufacturer_contact_name: 'John Doe',
    manufacturer_phone: '+919876543210',
    manufacturer_email: 'factory@example.com',
    license_number: 'LIC-998877',
    repacker_name: 'Care Packagers',
    repacker_address: 'Pune MIDC',
    age_min: 18,
    age_max: 80,
    age_unit: 'years',
    audience_age_group: 'adults',
    product_uses: 'Hospital bed protection',
    special_instructions: 'Store in a cool dry place',
    material_composition: 'Non-woven top sheet + fluff pulp',
    material_type: 'Waterproof backing',
    resistance_level: 'High',
    heat_resistant: false,
    gas_resistant: false,
    physical_state: 'solid',
    pattern: 'Diamond embossed',
    hazard_classification: 'Non-hazardous',
    net_weight: 450,
    net_weight_unit: 'g',
    manufacturing_date: '2026-10-01',
    fulfillment_channel: 'merabetta',
    seller_handling_days: 2,
    business_offer_percent: 5,
    sale_start_date: '2026-10-15',
    sale_end_date: '2026-11-15',
    shipping_template: 'STD-MED',
    seller_pincodes: ['411001', '400001'],
    battery_required: false,
    battery_consumption: 'N/A',
    cosmetic_features: 'Soft breathable top layer',
    mrp: 999,
    offer_price: 799,
    gst_rate: 5,
    keywords: ['adult', 'diaper'],
    unit_count: 10,
    water_resistant: true,
    package_length: 20,
    company_address: 'Example',
  };
  const parsed = createProductSchema.parse(body);
  assert.equal(parsed.unit_count, 10);
  assert.equal(parsed.barcode, '8901234567890');
  assert.equal(parsed.item_condition, 'new');
  assert.equal(parsed.reusable, false);
  assert.equal(parsed.product_length, 60);
  assert.equal(parsed.product_breadth, 90);
  assert.equal(parsed.gift_options_charge, 50);
  assert.equal(parsed.gift_wrap_charge, 25);
  assert.equal(parsed.manufacturer_sku, 'MSKU-100');
  assert.deepEqual(parsed.seller_pincodes, ['411001', '400001']);
  for (const invalid of [
    { gst_rate: 101 },
    { unit_count: 0 },
    { regular_price: -1 },
    { sale_price: 1.001 },
    { water_resistant: 'false' },
    { item_condition: 'used' },
    { product_length: -5 },
    { gift_options_charge: -10 },
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
