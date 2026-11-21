import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { Op, Sequelize, Transaction } from 'sequelize';
import { ZodError } from 'zod';
import { createVariableProductHandlers } from '../src/admin/variable-products/variable-products.service.js';
import { variableProductRoutes } from '../src/admin/variable-products/variable-products.routes.js';
import {
  createVariableProductSchema,
  updateVariableProductSchema,
  variableProductParamsSchema,
} from '../src/admin/variable-products/variable-products.schema.js';
import { defineProductVariant } from '../src/models/product-variant.model.js';
import { buildRouter } from '../src/shared/routes.js';
import { HttpError } from '../src/shared/errors.js';

// No app/config imports, .env loading, real credentials, or database connections.
const clone = (value) => structuredClone(value);
const variantInput = (sku = 'TEE-M-RED', attributes = { Size: 'M', Color: 'Red' }) => ({
  sku,
  attributes,
  regular_price: 100,
  sale_price: 80,
  stock_quantity: 5,
});
const createInput = (overrides = {}) => ({
  product_code: 'TEE',
  product_name: 'Cotton tee',
  slug: 'cotton-tee',
  variants: [variantInput()],
  ...overrides,
});
const parent = (overrides = {}) => ({
  id: '42',
  product_code: 'TEE',
  product_name: 'Cotton tee',
  slug: 'cotton-tee',
  product_type: 'variable',
  is_deleted: false,
  mrp: '0.00',
  selling_price: '0.00',
  ...overrides,
});
const storedVariant = (overrides = {}) => ({
  ...variantInput(),
  id: '1000000000',
  product_id: '42',
  regular_price: '100.00',
  sale_price: '80.00',
  variant_name: null,
  barcode: null,
  weight_grams: null,
  use_product_images: true,
  is_active: true,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function fixture({
  products = [],
  variants = [],
  failVariantInsert = 0,
  auditError,
} = {}) {
  const state = {
    products: clone(products),
    variants: clone(variants),
    details: {},
    audits: [],
  };
  const trace = [];
  let active;
  let inserts = 0;
  let nextVariant = 1000000010n;
  const txCheck = (options, operation) => {
    assert.equal(
      options.transaction,
      active,
      `${operation} must use the same transaction`,
    );
    assert.ok(active, `${operation} must run inside a transaction`);
    trace.push(operation);
  };
  function wrap(value, type) {
    return {
      ...value,
      toJSON: () => clone(value),
      async update(changes, options) {
        txCheck(options, `${type}.update`);
        assert.equal(active.readOnly, false);
        Object.assign(value, clone(changes));
        return wrap(value, type);
      },
    };
  }
  const definitions = [
    { name: 'Size', values: ['M', 'L', 'XL', 'XXL'] },
    { name: 'Color', values: ['Red', 'Blue'] },
    { name: 'Weight', values: ['100 g', '200 g'] },
    { name: 'Volume', values: ['250 ml', '500 ml'] },
    { name: 'Count', values: ['1', '2'] },
  ];
  const dependencies = {
    sequelize: {
      async transaction(options, callback) {
        assert.equal(active, undefined);
        trace.push({ transaction: options });
        const snapshot = clone(state);
        active = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, ...options };
        try {
          const result = await callback(active);
          trace.push('commit');
          return result;
        } catch (error) {
          Object.assign(state, snapshot);
          trace.push('rollback');
          throw error;
        } finally {
          active = undefined;
        }
      },
      async query(sql, options) {
        if (active.readOnly) {
          txCheck(options, 'readOnly');
          assert.equal(sql, 'SET TRANSACTION READ ONLY');
          return;
        }
        txCheck(options, 'lock');
        assert.equal(
          sql,
          'LOCK TABLE public.product_variants IN SHARE ROW EXCLUSIVE MODE',
        );
        assert.equal(active.isolationLevel, Transaction.ISOLATION_LEVELS.READ_COMMITTED);
      },
    },
    Product: {
      async findOne(options) {
        txCheck(options, 'product.find');
        const value = state.products.find(
          (row) => row.id === options.where.id && !row.is_deleted,
        );
        return value ? wrap(value, 'product') : null;
      },
      async create(values, options) {
        txCheck(options, 'product.create');
        const value = { id: '43', is_deleted: false, ...clone(values) };
        state.products.push(value);
        return wrap(value, 'product');
      },
    },
    ProductVariant: {
      async findAll(options) {
        txCheck(options, 'variant.find');
        assert.equal(options.paranoid, false, 'Preserve all stored variants');
        return state.variants
          .filter((value) =>
            options.where.product_id
              ? value.product_id === String(options.where.product_id)
              : options.where.sku[Op.in].includes(value.sku),
          )
          .map((value) => wrap(value, 'variant'));
      },
      async create(values, options) {
        txCheck(options, 'variant.create');
        if (++inserts === failVariantInsert)
          throw new Error('Injected variant insert failure');
        const value = storedVariant({
          id: String(nextVariant++),
          ...clone(values),
          regular_price: values.regular_price.toFixed(2),
          sale_price:
            values.sale_price === null || values.sale_price === undefined
              ? null
              : values.sale_price.toFixed(2),
        });
        state.variants.push(value);
        return wrap(value, 'variant');
      },
    },
    VariantAttribute: {
      async findAll(options) {
        txCheck(options, 'attribute.find');
        assert.equal(options.lock, active.LOCK.SHARE);
        return definitions.filter((row) => options.where.name[Op.in].includes(row.name));
      },
    },
    productValues(input) {
      const values = { ...input };
      delete values.details;
      delete values.description;
      return values;
    },
    async validateReferences(_values, transaction) {
      txCheck({ transaction }, 'references');
    },
    async saveDetails(id, input, transaction) {
      txCheck({ transaction }, 'details.save');
      state.details[id] = { ...state.details[id], ...input.details };
    },
    async getFullProduct(id, transaction) {
      txCheck({ transaction }, 'product.full');
      return {
        ...clone(state.products.find((row) => row.id === id)),
        details: clone(state.details[id] ?? {}),
        images: [],
      };
    },
    async audit(_req, _entity, id, before, after, transaction) {
      txCheck({ transaction }, 'audit');
      if (auditError) throw auditError;
      state.audits.push({ id, before: clone(before), after: clone(after) });
    },
  };
  const handlers = createVariableProductHandlers(dependencies);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/admin/variable-products',
    buildRouter((req, _res, next) => {
      if (req.get('x-test-admin') !== 'yes')
        throw new HttpError(401, 'Authentication required');
      next();
    }, variableProductRoutes(handlers)),
  );
  app.use((error, _req, res, _next) => {
    res
      .status(error instanceof ZodError ? 422 : (error.status ?? 500))
      .json({ error: error.message });
  });
  async function call(method, input, id = '42') {
    const req = {
      validated:
        method === 'create'
          ? createVariableProductSchema.parse(input)
          : method === 'update'
            ? updateVariableProductSchema.parse(input)
            : undefined,
      validatedParams: variableProductParamsSchema.parse({ id }),
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      location(value) {
        this.locationValue = value;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    await handlers[method](req, res);
    return res;
  }
  return { state, trace, call, app, dependencies };
}

test('POST creates a variable parent, details and variants atomically', async () => {
  const f = fixture();
  const res = await f.call(
    'create',
    createInput({
      details: {
        full_description: 'Soft cotton',
        specifications: { Material: 'Cotton' },
      },
      variants: [variantInput(), variantInput('TEE-L-RED', { Size: 'L', Color: 'Red' })],
    }),
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.locationValue, '/api/admin/variable-products/43');
  assert.equal(res.body.data.product_type, 'variable');
  assert.equal(res.body.data.details.full_description, 'Soft cotton');
  assert.equal(res.body.data.variants.length, 2);
  assert.equal(res.body.data.variants[0].product_id, '43');
  assert.equal(res.body.data.variants[0].id, '1000000010');
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.trace.filter((item) => item?.transaction).length, 1);
  assert.equal(f.trace[1], 'lock');
  assert.equal(f.trace.at(-1), 'commit');
});

test('dynamic Weight, Volume and Count attributes use the existing master', async () => {
  const f = fixture();
  const attributes = { Weight: '100 g', Volume: '250 ml', Count: '2' };
  const res = await f.call(
    'create',
    createInput({ variants: [variantInput('PACK', attributes)] }),
  );
  assert.deepEqual(res.body.data.variants[0].attributes, attributes);
});

test('GET returns complete parent and every variant without precision loss or writes', async () => {
  const id = '9007199254740993';
  const variants = [
    storedVariant({ id }),
    storedVariant({
      id: '9007199254740994',
      sku: 'OLD',
      attributes: { Size: 'L' },
      is_active: false,
      deleted_at: '2026-01-02T00:00:00.000Z',
    }),
  ];
  const f = fixture({ products: [parent()], variants });
  const res = await f.call('get');
  assert.deepEqual(res.body.data.variants, variants);
  assert.deepEqual(res.body.data.images, []);
  assert.deepEqual(res.body.data.details, {});
  assert.equal(f.trace[0].transaction.readOnly, true);
  assert.equal(
    f.trace[0].transaction.isolationLevel,
    Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  );
  assert.ok(!f.trace.includes('lock'));
  assert.ok(f.trace.includes('readOnly'));
  assert.ok(
    !f.trace.some(
      (item) => typeof item === 'string' && /create|update|save|audit/.test(item),
    ),
  );
});

test('PATCH changes a variant, adds XXL, and preserves omitted variants and IDs', async () => {
  const unchanged = storedVariant({
    id: '1000000001',
    sku: 'TEE-L',
    attributes: { Size: 'L' },
  });
  const f = fixture({ products: [parent()], variants: [storedVariant(), unchanged] });
  const res = await f.call('update', {
    product_name: 'Updated tee',
    variants: [
      {
        id: '1000000000',
        sku: 'TEE-XL-BLUE',
        attributes: { Size: 'XL', Color: 'Blue' },
        sale_price: 70,
      },
      variantInput('TEE-XXL', { Size: 'XXL', Color: 'Red' }),
    ],
  });
  assert.equal(res.body.data.product_name, 'Updated tee');
  assert.equal(res.body.data.variants.length, 3);
  assert.equal(res.body.data.variants[0].id, '1000000000');
  assert.equal(res.body.data.variants[0].regular_price, '100.00');
  assert.equal(res.body.data.variants[0].sale_price, 70);
  assert.deepEqual(res.body.data.variants[1], unchanged);
  assert.equal(res.body.data.variants[2].attributes.Size, 'XXL');
});

test('parent-only PATCH preserves all variants, including inactive rows', async () => {
  const variants = [storedVariant({ is_active: false })];
  const f = fixture({ products: [parent()], variants });
  await f.call('update', { product_name: 'New name' });
  assert.deepEqual(f.state.variants, variants);
  assert.ok(!f.trace.includes('variant.update'));
});

test('PATCH permits null sale price and explicit false/zero values', async () => {
  const f = fixture({ products: [parent()], variants: [storedVariant()] });
  await f.call('update', {
    variants: [
      {
        id: '1000000000',
        sale_price: null,
        stock_quantity: 0,
        is_active: false,
        use_product_images: false,
      },
    ],
  });
  assert.equal(f.state.variants[0].sale_price, null);
  assert.equal(f.state.variants[0].stock_quantity, 0);
  assert.equal(f.state.variants[0].is_active, false);
  assert.equal(f.state.variants[0].use_product_images, false);
});

for (const [label, variant] of [
  ['same SKU', variantInput('TEE-M-RED', { Size: 'L' })],
  [
    'same combination with reordered keys',
    variantInput('OTHER', { Color: 'Red', Size: 'M' }),
  ],
]) {
  test(`POST rejects ${label}`, async () => {
    const f = fixture();
    await assert.rejects(
      f.call('create', createInput({ variants: [variantInput(), variant] })),
      { status: 409 },
    );
    assert.equal(f.state.products.length, 0);
    assert.equal(f.trace.at(-1), 'rollback');
  });
  test(`PATCH rejects ${label} against an omitted variant`, async () => {
    const f = fixture({ products: [parent()], variants: [storedVariant()] });
    await assert.rejects(f.call('update', { variants: [variant] }), { status: 409 });
    assert.deepEqual(f.state.variants, [storedVariant()]);
  });
}

test('variant SKUs are unique across parents, including deleted rows', async () => {
  const f = fixture({
    variants: [storedVariant({ deleted_at: '2026-01-02T00:00:00.000Z' })],
  });
  await assert.rejects(f.call('create', createInput()), { status: 409 });
  assert.equal(f.state.products.length, 0);
});

test('PATCH rejects a SKU owned by another product', async () => {
  const f = fixture({
    products: [parent()],
    variants: [
      storedVariant(),
      storedVariant({
        id: '1000000001',
        product_id: '99',
        sku: 'TAKEN',
      }),
    ],
  });
  await assert.rejects(
    f.call('update', { variants: [{ id: '1000000000', sku: 'TAKEN' }] }),
    { status: 409 },
  );
});

test('PATCH cannot steal a variant ID or submit the same ID twice', async () => {
  const f = fixture({ products: [parent()], variants: [storedVariant()] });
  await assert.rejects(
    f.call('update', { variants: [{ id: '9999999999', sku: 'NEW' }] }),
    { status: 422 },
  );
  await assert.rejects(
    f.call('update', { variants: [{ id: '1000000000' }, { id: '1000000000' }] }),
    { status: 422 },
  );
});

test('PATCH cannot restore or edit a soft-deleted variant', async () => {
  const f = fixture({
    products: [parent()],
    variants: [storedVariant({ deleted_at: '2026-01-02T00:00:00.000Z' })],
  });
  await assert.rejects(
    f.call('update', { variants: [{ id: '1000000000', sku: 'NEW' }] }),
    { status: 409 },
  );
});

test('PATCH checks partial price changes against stored prices', async () => {
  const f = fixture({ products: [parent()], variants: [storedVariant()] });
  await assert.rejects(
    f.call('update', { variants: [{ id: '1000000000', regular_price: 50 }] }),
    { status: 422 },
  );
  await assert.rejects(
    f.call('update', { variants: [{ id: '1000000000', sale_price: 101 }] }),
    { status: 422 },
  );
});

test('unknown master attribute and option are rejected', async () => {
  for (const attributes of [{ Unknown: 'M' }, { Size: 'NOT-IN-MASTER' }]) {
    const f = fixture();
    await assert.rejects(
      f.call('create', createInput({ variants: [variantInput('NEW', attributes)] })),
      { status: 422 },
    );
    assert.equal(f.state.products.length, 0);
  }
});

test('unchanged historical attribute values survive unrelated PATCH', async () => {
  const f = fixture({
    products: [parent()],
    variants: [storedVariant({ attributes: { Retired: 'Original' } })],
  });
  await f.call('update', { variants: [{ id: '1000000000', sale_price: 75 }] });
  assert.deepEqual(f.state.variants[0].attributes, { Retired: 'Original' });
});

test('POST rolls back parent, details and prior variant inserts on a later failure', async () => {
  const f = fixture({ failVariantInsert: 2 });
  await assert.rejects(
    f.call(
      'create',
      createInput({ variants: [variantInput(), variantInput('NEW', { Size: 'L' })] }),
    ),
    /Injected/,
  );
  assert.deepEqual(f.state, { products: [], variants: [], details: {}, audits: [] });
  assert.ok(f.trace.includes('product.create'));
  assert.equal(f.trace.at(-1), 'rollback');
});

test('PATCH rolls back existing edits when a newly added variant fails', async () => {
  const f = fixture({
    products: [parent()],
    variants: [storedVariant()],
    failVariantInsert: 1,
  });
  const before = clone(f.state);
  await assert.rejects(
    f.call('update', {
      product_name: 'Must roll back',
      variants: [
        { id: '1000000000', sale_price: 70 },
        variantInput('NEW', { Size: 'L' }),
      ],
    }),
    /Injected/,
  );
  assert.deepEqual(f.state, before);
  assert.ok(f.trace.includes('variant.update'));
});

test('audit failures roll back the entire transaction', async () => {
  const f = fixture({ auditError: new Error('Injected audit failure') });
  await assert.rejects(f.call('create', createInput()), /Injected audit/);
  assert.equal(f.state.products.length, 0);
  assert.equal(f.state.variants.length, 0);
});

for (const [code, status] of [
  ['23505', 409],
  ['23503', 422],
  ['23514', 422],
  ['23502', 422],
  ['40001', 409],
  ['40P01', 409],
]) {
  test(`database error ${code} returns a sanitized ${status}`, async () => {
    const error = Object.assign(new Error('Internal SQL details'), { parent: { code } });
    const f = fixture({ auditError: error });
    await assert.rejects(
      f.call('create', createInput()),
      (result) => result.status === status && !result.message.includes('Internal SQL'),
    );
    assert.equal(f.state.products.length, 0);
  });
}

test('GET and PATCH reject missing/deleted products and simple-to-variable conversion', async () => {
  for (const method of ['get', 'update']) {
    for (const [products, status] of [
      [[], 404],
      [[parent({ is_deleted: true })], 404],
      [[parent({ product_type: 'simple' })], 409],
    ]) {
      const f = fixture({ products });
      await assert.rejects(f.call(method, { product_name: 'Changed' }), { status });
      assert.deepEqual(f.state.products, products);
    }
  }
});

test('schemas validate required fields, prices, stocks, attributes and immutable fields', () => {
  const invalid = [
    { product_name: '' },
    { product_code: '' },
    { slug: 'Invalid Slug' },
    { product_type: 'simple' },
    { stock_quantity: 1 },
    { initial_inventory: {} },
    { variants: [] },
    { variants: Array.from({ length: 501 }, () => variantInput()) },
    ...[
      { sku: '' },
      { regular_price: -1 },
      { regular_price: 1.001 },
      { regular_price: Infinity },
      { regular_price: '100' },
      { regular_price: null },
      { sale_price: 101 },
      { sale_price: -1 },
      { stock_quantity: -1 },
      { stock_quantity: 0.5 },
      { stock_quantity: 2147483648 },
      { weight_grams: -1 },
      { attributes: {} },
      { attributes: { Size: '' } },
      { attributes: { Size: ' M' } },
      { attributes: { ' Size': 'M' } },
      { attributes: { Size: ['M'] } },
      { id: '1000000000' },
      { product_id: '9' },
      { deleted_at: null },
    ].map((overrides) => ({ variants: [{ ...variantInput(), ...overrides }] })),
  ];
  for (const overrides of invalid)
    assert.equal(
      createVariableProductSchema.safeParse(createInput(overrides)).success,
      false,
      JSON.stringify(overrides),
    );
  assert.equal(updateVariableProductSchema.safeParse({}).success, false);
  assert.equal(updateVariableProductSchema.safeParse({ variants: [] }).success, false);
  assert.equal(
    updateVariableProductSchema.safeParse({ product_type: 'simple' }).success,
    false,
  );
  assert.equal(
    updateVariableProductSchema.safeParse({ variants: [{ sku: 'NEW' }] }).success,
    false,
  );
});

test('BIGINT params preserve large IDs and reject unsafe or invalid identities', () => {
  assert.equal(
    variableProductParamsSchema.parse({ id: '9007199254740993' }).id,
    '9007199254740993',
  );
  assert.equal(variableProductParamsSchema.parse({ id: 42 }).id, '42');
  for (const id of [
    '0',
    '-1',
    '1.2',
    'abc',
    '9223372036854775808',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(variableProductParamsSchema.safeParse({ id }).success, false);
});

test('real route definitions enforce auth and validation, and support POST → GET → PATCH', async () => {
  const f = fixture();
  const path = '/api/admin/variable-products';
  for (const [method, url] of [
    ['post', path],
    ['get', `${path}/42`],
    ['patch', `${path}/42`],
  ])
    await request(f.app)[method](url).send({}).expect(401);
  assert.equal(f.trace.length, 0, 'Authentication must run before database work');
  await request(f.app).post(path).set('x-test-admin', 'yes').send({}).expect(422);
  await request(f.app).get(`${path}/not-an-id`).set('x-test-admin', 'yes').expect(422);
  assert.equal(f.trace.length, 0);
  const created = await request(f.app)
    .post(path)
    .set('x-test-admin', 'yes')
    .send(createInput())
    .expect(201);
  const id = created.body.data.id;
  const variantId = created.body.data.variants[0].id;
  await request(f.app).get(`${path}/${id}`).set('x-test-admin', 'yes').expect(200);
  const updated = await request(f.app)
    .patch(`${path}/${id}`)
    .set('x-test-admin', 'yes')
    .send({ variants: [{ id: variantId, sale_price: 60 }] })
    .expect(200);
  assert.equal(updated.body.data.variants[0].id, variantId);
  assert.equal(updated.body.data.variants[0].sale_price, 60);
});

test('actual Sequelize model matches supplied columns and always targets public when scoped', async () => {
  // Constructing Sequelize does not open a connection. Forbid any acquisition.
  const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
  sequelize.connectionManager.getConnection = async () => {
    throw new Error('Database access forbidden in this test');
  };
  const legacy = defineProductVariant(sequelize);
  const model = legacy.schema('public');
  assert.equal(model.getTableName().schema, 'public');
  assert.equal(model.getTableName().tableName, 'product_variants');
  assert.equal(model.rawAttributes.id.type.key, 'BIGINT');
  assert.equal(model.rawAttributes.id.autoIncrement, true);
  assert.equal(model.rawAttributes.attributes.type.key, 'JSONB');
  assert.equal(model.options.paranoid, true);
  assert.deepEqual(
    Object.keys(model.rawAttributes)
      .filter((key) => key !== 'display_name')
      .sort(),
    [
      'id',
      'product_id',
      'sku',
      'attributes',
      'variant_name',
      'barcode',
      'weight_grams',
      'regular_price',
      'sale_price',
      'stock_quantity',
      'use_product_images',
      'is_active',
      'created_at',
      'updated_at',
      'deleted_at',
    ].sort(),
  );
  assert.deepEqual(
    model.rawAttributes,
    legacy.rawAttributes,
    'Scoping must not change the legacy mapping',
  );
  const statements = [];
  sequelize.query = async (sql, options) => {
    statements.push(typeof sql === 'string' ? sql : sql.query);
    if (options.instance) return [options.instance, 1];
    return [];
  };
  await model.findAll({ where: { product_id: '42' }, paranoid: false });
  const row = await model.create({ product_id: '42', ...variantInput() });
  row.setDataValue('id', '1000000000');
  await row.update({ sale_price: 70 });
  assert.equal(statements.length, 3);
  for (const sql of statements) {
    assert.match(sql, /"public"\."product_variants"/);
    assert.doesNotMatch(sql, /json_relational/);
  }
  assert.doesNotMatch(statements[0], /"deleted_at" IS NULL/);
  await sequelize.close();
});
