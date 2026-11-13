import test from 'node:test';
import assert from 'node:assert/strict';
import { planIndependentProducts } from '../src/shared/product-migration-plan.js';
import { createProductSchema } from '../src/admin/products/products.schema.js';

const base = {
  id: '1',
  name: 'T-Shirt',
  sku: null,
  stock_quantity: 0,
  regular_price: '100',
  sale_price: null,
};
test('independent attributes retain exact casing and reject client-supplied actors', () => {
  const data = createProductSchema.parse({
    product_code: 'XL-BLUE',
    product_name: 'XL Blue',
    slug: 'xl-blue',
    details: { specifications: { Size: 'XL', size: 'xl', Color: 'Blue', color: 'blue' } },
    product_group_code: 'TSH-001',
  });
  assert.deepEqual(data.details.specifications, {
    Size: 'XL',
    size: 'xl',
    Color: 'Blue',
    color: 'blue',
  });
  assert.equal(
    createProductSchema.safeParse({ ...data, updated_by: 'fake' }).success,
    false,
  );
});
test('migration plan allocates independent IDs and blocks ambiguous shared stock, SKU and vendor warehouses', () => {
  const variants = [
    { id: '10', product_id: '1', sku: 'XL-BLUE', stock_quantity: 0 },
    { id: '11', product_id: '1', sku: 'XL-BLACK', stock_quantity: 0 },
  ];
  const planned = planIndependentProducts({
    products: [base],
    variants,
    offers: [],
    inventory: [],
  });
  assert.equal(planned.can_apply, true);
  assert.equal(planned.planned_products.length, 2);
  assert.ok(planned.planned_products.every((row) => row.reuse_product_id === null));
  assert.equal(
    planIndependentProducts({
      products: [{ ...base, stock_quantity: 10 }],
      variants,
      offers: [],
      inventory: [],
    }).can_apply,
    false,
  );
  const collision = planIndependentProducts({
    products: [base, { ...base, id: '2', sku: 'XL-BLUE' }],
    variants,
    offers: [],
    inventory: [],
  });
  assert.ok(collision.conflicts.some((row) => row.sku === 'XL-BLUE'));
  const offers = [
    {
      id: '1',
      variant_id: '10',
      offer_status: 'active',
      mrp: '100',
      selling_price: '90',
      currency: 'INR',
    },
    {
      id: '2',
      variant_id: '10',
      offer_status: 'active',
      mrp: '100',
      selling_price: '80',
      currency: 'INR',
    },
  ];
  const inventory = offers.map((row) => ({
    id: row.id,
    vendor_product_id: row.id,
    warehouse_code: 'W1',
    quantity_on_hand: 4,
    quantity_reserved: 0,
  }));
  assert.equal(
    planIndependentProducts({ products: [base], variants, offers, inventory }).conflicts
      .length,
    2,
  );
});
