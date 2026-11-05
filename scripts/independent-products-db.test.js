import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';

test(
  'independent products: authenticated audits, inventory lifecycle, conversion and preserved references',
  {
    skip: process.env.RUN_INDEPENDENT_PRODUCTS_DB_TESTS !== 'true',
  },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_independent_test/);
    assert.ok(['127.0.0.1', 'localhost'].includes(process.env.DB_HOST));
    process.env.INDEPENDENT_PRODUCTS_ENABLED = 'true';
    process.env.IMAGE_STORAGE_MODE = 'local';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'independent-images-'));
    process.env.IMAGE_LOCAL_DIRECTORY = directory;
    process.env.IMAGE_LOCAL_BASE_URL = 'http://localhost:3000/uploads';
    const { app } = await import('../src/app.js');
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { env } = await import('../src/config/env.js');
    const { createOrder, applyPaymentStatus, findOrder } =
      await import('../src/app/orders/orders.controller.js');
    const { reserveStock, settleStock } = await import('../src/app/orders/inventory.js');
    const { inventorySummary } = await import('../src/shared/independent-inventory.js');
    const { assertIndependentCatalogReady } =
      await import('../src/shared/independent-readiness.js');
    const { inspectProductMigration } =
      await import('../src/shared/product-migration-plan.js');
    const { convertIndependentProducts } =
      await import('../src/shared/convert-independent-products.js');
    const { png } = await import('../test-support/image-fixtures.js');
    const savedFetch = global.fetch;
    const savedEnv = { ...env };
    const gatewayOrders = new Map();
    let gatewaySessions = 0;
    global.fetch = async (url, options) => {
      assert.ok(String(url).startsWith('https://smartgateway.hdfc.bank.in/'));
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      gatewaySessions++;
      const response = {
        order_id: body.order_id,
        payment_links: { web: 'https://smartgateway.hdfc.bank.in/pay/' + body.order_id },
      };
      gatewayOrders.set(body.order_id, body);
      return new Response(JSON.stringify(response), { status: 200 });
    };
    Object.assign(env, {
      HDFC_ENVIRONMENT: 'production',
      HDFC_API_KEY: 'test-only',
      HDFC_MERCHANT_ID: 'test-only',
      HDFC_CLIENT_ID: 'test-only',
      HDFC_RETURN_URL: 'https://test.example.com/api/payments/hdfc/return',
    });
    const sql = async (file) =>
      sequelize.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
    const select = async (sql, replacements = {}) =>
      sequelize.query(sql, { replacements, type: 'SELECT' });
    const agent = request.agent(app);
    const json = (method, url, body = {}, key) => {
      const call = agent[method]('/api/admin' + url).set(
        'Origin',
        env.ALLOWED_ORIGINS[0],
      );
      if (key) call.set('Idempotency-Key', key);
      return call.send(body);
    };
    const create = async (url, body, key) => {
      const result = await json('post', url, body, key);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.data;
    };
    const upload = (url) =>
      agent
        .post('/api/admin' + url)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .attach('uploadimage', png, { filename: 'test.png', contentType: 'image/png' });
    let admin, customer, blue, black, root, category;
    const checkout = async (
      product,
      quantity,
      key,
      paymentMethod = 'cod',
      credential = customer,
    ) => {
      let data;
      await createOrder(
        {
          credential,
          validated: {
            paymentMethod,
            requestKey: key,
            items: [{ id: 'product:' + product.product_id, quantity }],
            address: {
              addressLine1: 'Test road',
              city: 'Pune',
              state: 'Maharashtra',
              pincode: '411001',
            },
            notes: '',
          },
        },
        {
          status() {
            return this;
          },
          json(value) {
            data = value;
            return this;
          },
        },
      );
      return data;
    };
    const payment = async (id, status) => {
      const row = await findOrder(id);
      return applyPaymentStatus(id, {
        order_id: id,
        merchant_id: 'test-only',
        currency: 'INR',
        amount: (Number(row.amount_paise) / 100).toFixed(2),
        status,
        txn_id: 'verified-' + id,
        gateway: 'RAZORPAY',
        gateway_id: '21',
      });
    };
    try {
      await models.customer.sync();
      await models.user.sync();
      await models.session.sync();
      await models.adminProfile.sync();
      for (const file of [
        '014-product-orders.sql',
        '023-admin-catalog-base.sql',
        '024-admin-catalog-details.sql',
        '025-admin-catalog-compatibility.sql',
        '026-product-schema-alignment.sql',
        '022-product-images.sql',
        '027-admin-catalog-reliability.sql',
        '035-admin-integration-gaps.sql',
        '035-product-specification-fields.sql',
        '018-contact-coupons.sql',
        '012-third-party-api-logs.sql',
        '019-provider-response-body.sql',
        '036-product-soft-delete.sql',
      ])
        await sql(file);
      const [historicalProduct] = await select(
        "INSERT INTO products(name,slug,stock_quantity,created_at) VALUES('Historical product','historical-product',4,'2020-01-01T00:00:00Z') RETURNING id",
      );
      const [historicalCategory] = await select(
        "INSERT INTO categories(name,slug) VALUES('Historical category','historical-category') RETURNING id",
      );
      await sequelize.query(
        'INSERT INTO product_categories(product_id,category_id,is_primary) VALUES(:product,:category,TRUE)',
        {
          replacements: {
            product: historicalProduct.id,
            category: historicalCategory.id,
          },
        },
      );
      await sql('036-independent-products-audit.sql');
      await sql('038-variant-image-galleries.sql');
      await sql('036-independent-products-audit.sql');
      const [historicalLink] = await select(
        'SELECT * FROM product_categories WHERE product_id=:id',
        { id: historicalProduct.id },
      );
      assert.equal(historicalLink.created_at, null);
      assert.equal(historicalLink.created_by, null);

      await sequelize.query(
        `CREATE TABLE pricing_settings(id INTEGER PRIMARY KEY,product_delivery_charge_paise INTEGER DEFAULT 0,product_delivery_below_paise INTEGER DEFAULT 0,product_handling_charge_paise INTEGER DEFAULT 0,product_handling_below_paise INTEGER DEFAULT 0,lab_collection_charge_paise INTEGER DEFAULT 0,lab_collection_below_paise INTEGER DEFAULT 0,lab_markup_percent NUMERIC DEFAULT 0);INSERT INTO pricing_settings(id) VALUES(1)`,
      );
      admin = await models.user.create({
        realm: 'admin',
        name: 'Real audit admin',
        email: 'audit@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      await models.adminProfile.create({ userId: admin.id, permissions: ['*'] });
      customer = (
        await models.customer.create({
          firstName: 'Buyer',
          phone: '9876543210',
          email: 'buyer@example.invalid',
        })
      ).toJSON();
      assert.equal(
        (
          await json('post', '/auth/login', {
            email: 'audit@example.invalid',
            password: 'test-password',
          })
        ).status,
        200,
      );
      await t.test(
        'creates two independent configurations with exact attributes, authenticated actors and UTC timestamps',
        async () => {
          root = await create('/categories', {
            category_name: 'Clothing',
            slug: 'clothing',
          });
          category = await create('/categories', {
            category_name: 'T-Shirts',
            slug: 't-shirts',
            parent_category_id: Number(root.category_id),
          });
          const shared = {
            regular_price: 100,
            product_status: 'active',
            category_ids: [Number(category.category_id)],
            primary_category_id: Number(category.category_id),
            product_group_code: 'TSH-001',
          };
          blue = await create(
            '/products',
            {
              ...shared,
              product_name: 'T-Shirt XL Blue',
              slug: 'xl-blue',
              sku: 'XL-BLUE',
              attributes: { Size: 'XL', Color: 'Blue' },
              stock_quantity: 2,
            },
            'blue-create',
          );
          black = await create('/products', {
            ...shared,
            product_name: 'T-Shirt XL Black',
            slug: 'xl-black',
            sku: 'XL-BLACK',
            attributes: { Size: 'XL', Color: 'Black' },
            stock_quantity: 12,
          });
          assert.notEqual(blue.product_id, black.product_id);
          assert.equal(blue.stock_quantity, 2);
          assert.equal(black.stock_quantity, 12);
          assert.equal(blue.created_by, admin.id);
          assert.equal(category.created_by, admin.id);
          const zero = await create('/products', {
            product_name: 'No initial stock',
            slug: 'zero',
            sku: 'ZERO',
          });
          assert.equal(zero.inventory.available_quantity, 0);
          const history = await agent.get(
            `/api/admin/products/${blue.product_id}/audit-history`,
          );
          assert.equal(history.status, 200);
          const created = history.body.data.find(
            (row) => row.action === 'insert' && row.entity_type === 'product',
          );
          assert.equal(created.changed_by, admin.id);
          assert.equal(created.actor_name, 'Real audit admin');
          assert.ok(created.request_id);
          assert.ok(Math.abs(Date.now() - Date.parse(created.changed_at)) < 10000);
          assert.equal(
            (
              await json('patch', `/products/${blue.product_id}`, {
                updated_by: randomUUID(),
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await json('post', `/products/${blue.product_id}/variants`, {
                sku: 'CHILD',
                attributes: { Size: 'M' },
              })
            ).status,
            409,
          );
          const related = await agent.get(
            `/api/admin/products/${blue.product_id}/related`,
          );
          assert.equal(related.body.data[0].product_id, black.product_id);
        },
      );
      await t.test(
        'category differences are audited once; unchanged links keep original timestamps and actors',
        async () => {
          const [before] = await select(
            'SELECT * FROM product_categories WHERE product_id=:id',
            { id: blue.product_id },
          );
          const baseHistory = (
            await agent.get(
              `/api/admin/products/${blue.product_id}/audit-history?limit=100`,
            )
          ).body.data.length;
          assert.equal(
            (
              await json('patch', `/products/${blue.product_id}`, {
                category_ids: [Number(category.category_id)],
                primary_category_id: Number(category.category_id),
              })
            ).status,
            200,
          );
          const [unchanged] = await select(
            'SELECT * FROM product_categories WHERE product_id=:id',
            { id: blue.product_id },
          );
          assert.equal(
            unchanged.created_at.toISOString(),
            before.created_at.toISOString(),
          );
          assert.equal(
            unchanged.updated_at.toISOString(),
            before.updated_at.toISOString(),
          );
          assert.equal(
            (
              await agent.get(
                `/api/admin/products/${blue.product_id}/audit-history?limit=100`,
              )
            ).body.data.length,
            baseHistory,
          );
          assert.equal(
            (
              await json('patch', `/products/${blue.product_id}`, {
                category_ids: [Number(root.category_id), Number(category.category_id)],
                primary_category_id: Number(root.category_id),
              })
            ).status,
            200,
          );
          let events = (
            await agent.get(
              `/api/admin/products/${blue.product_id}/audit-history?limit=100`,
            )
          ).body.data;
          assert.equal(
            events.filter((row) => row.action === 'primary_category_changed').length,
            2,
          );
          const change = events.find((row) => row.action === 'primary_category_changed');
          assert.equal(
            String(change.old_values.primary_category_id),
            category.category_id,
          );
          assert.equal(String(change.new_values.primary_category_id), root.category_id);
          assert.equal(
            (
              await json('patch', `/products/${blue.product_id}`, {
                category_ids: [Number(root.category_id)],
                primary_category_id: Number(root.category_id),
              })
            ).status,
            200,
          );
          events = (
            await agent.get(
              `/api/admin/products/${blue.product_id}/audit-history?limit=100`,
            )
          ).body.data;
          assert.equal(
            events.filter((row) => row.action === 'category_removed').length,
            1,
          );
          assert.equal(
            (
              await json('patch', `/categories/${category.category_id}`, {
                category_name: 'Updated shirts',
              })
            ).status,
            200,
          );
          assert.equal(
            (await upload(`/categories/${category.category_id}/image`)).status,
            201,
          );
          const categoryEvents = (
            await agent.get(`/api/admin/categories/${category.category_id}/audit-history`)
          ).body.data;
          assert.ok(
            categoryEvents.some((row) => row.changed_fields.includes('image_url')),
          );
          assert.ok(categoryEvents.some((row) => row.changed_fields.includes('name')));
        },
      );
      await t.test(
        'selling out Blue affects only Blue and duplicate COD checkout never deducts twice',
        async () => {
          const order = await checkout(blue, 2, 'sell-blue-once');
          assert.ok(order.id);
          assert.equal((await inventorySummary(blue.product_id)).available_quantity, 0);
          assert.equal((await inventorySummary(black.product_id)).available_quantity, 12);
          const retry = await checkout(blue, 2, 'sell-blue-once');
          assert.equal(retry.id, order.id);
          assert.equal((await inventorySummary(blue.product_id)).available_quantity, 0);
          const lines = await select(
            'SELECT independent_product_id FROM order_details WHERE order_id=:id',
            { id: order.id },
          );
          assert.equal(String(lines[0].independent_product_id), blue.product_id);
          const history = (
            await agent.get(`/api/admin/products/${blue.product_id}/inventory-history`)
          ).body.data;
          assert.equal(
            history.filter((row) => row.movement_type === 'purchase').length,
            1,
          );
          assert.ok(history.every((row) => row.quantity_after >= 0));
          assert.equal(
            (
              await json('post', `/orders/${order.id}/cancel`, {
                reason: 'Customer cancelled before dispatch',
              })
            ).status,
            200,
          );
          assert.equal((await inventorySummary(blue.product_id)).available_quantity, 2);
          await json('post', `/orders/${order.id}/cancel`, { reason: 'Repeat' });
          assert.equal((await inventorySummary(blue.product_id)).available_quantity, 2);
        },
      );
      await t.test('concurrent orders cannot oversell the same product', async () => {
        const one = await create('/products', {
          product_name: 'Last unit',
          slug: 'one-unit',
          sku: 'ONE',
          stock_quantity: 1,
          regular_price: 100,
          product_status: 'active',
          category_ids: [Number(root.category_id)],
        });
        const buyer2 = (
          await models.customer.create({
            firstName: 'Buyer2',
            phone: '9876543211',
            email: 'buyer2@example.invalid',
          })
        ).toJSON();
        const outcomes = await Promise.allSettled([
          checkout(one, 1, 'concurrent-one', 'cod'),
          checkout(one, 1, 'concurrent-two', 'cod', buyer2),
        ]);
        assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
        assert.equal((await inventorySummary(one.product_id)).available_quantity, 0);
        assert.ok(
          (
            await select('SELECT * FROM inventory WHERE product_id=:id', {
              id: one.product_id,
            })
          ).every((row) => row.quantity_on_hand >= row.quantity_reserved),
        );
      });
      await t.test(
        'online reservation releases on failure; late successful payment reserves and settles exactly once',
        async () => {
          const initial = await inventorySummary(black.product_id);
          const online = await checkout(black, 3, 'online-release', 'online');
          assert.equal(gatewaySessions, 1);
          assert.equal((await inventorySummary(black.product_id)).reserved_quantity, 3);
          const retried = await checkout(black, 3, 'online-release', 'online');
          assert.equal(retried.id, online.id);
          assert.equal(gatewaySessions, 1);
          await payment(online.id, 'AUTHENTICATION_FAILED');
          await payment(online.id, 'AUTHENTICATION_FAILED');
          assert.equal(
            (await inventorySummary(black.product_id)).available_quantity,
            initial.available_quantity,
          );
          await payment(online.id, 'CHARGED');
          await payment(online.id, 'CHARGED');
          assert.equal(
            (await inventorySummary(black.product_id)).on_hand_quantity,
            initial.on_hand_quantity - 3,
          );
          assert.equal((await inventorySummary(black.product_id)).reserved_quantity, 0);
          const lines = await select(
            'SELECT independent_product_id FROM order_details WHERE order_id=:id',
            { id: online.id },
          );
          assert.equal(String(lines[0].independent_product_id), black.product_id);
        },
      );
      await t.test(
        'cancellation releases reservations and late charges require review without reclaiming stock',
        async () => {
          const initial = (await inventorySummary(black.product_id)).available_quantity;
          const online = await checkout(black, 1, 'cancel-online', 'online');
          assert.equal(
            (
              await json('post', `/orders/${online.id}/cancel`, {
                reason: 'Cancelled',
              })
            ).status,
            200,
          );
          assert.equal(
            (await inventorySummary(black.product_id)).available_quantity,
            initial,
          );
          await payment(online.id, 'CHARGED');
          assert.equal((await findOrder(online.id)).stock_state, 'review');
          assert.equal(
            (await inventorySummary(black.product_id)).available_quantity,
            initial,
          );
          assert.equal(
            (await select('SELECT id FROM orders WHERE id=:id', { id: online.id }))
              .length,
            0,
          );
        },
      );
      await t.test(
        'permissioned stock adjustments are idempotent and history is immutable even through SQL',
        async () => {
          const body = {
            delta: 5,
            reason: 'Warehouse restock',
            movement_type: 'restock',
          };
          const before = (await inventorySummary(black.product_id)).available_quantity;
          assert.equal(
            (
              await json(
                'post',
                `/products/${black.product_id}/inventory/adjustments`,
                body,
              )
            ).status,
            400,
          );
          assert.equal(
            (
              await json(
                'post',
                `/products/${black.product_id}/inventory/adjustments`,
                body,
                'restock-once',
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await json(
                'post',
                `/products/${black.product_id}/inventory/adjustments`,
                body,
                'restock-once',
              )
            ).status,
            200,
          );
          assert.equal(
            (await inventorySummary(black.product_id)).available_quantity,
            before + 5,
          );
          assert.equal(
            (
              await json(
                'post',
                `/products/${black.product_id}/inventory/adjustments`,
                { delta: -9999, reason: 'Invalid' },
                'invalid-stock',
              )
            ).status,
            409,
          );
          const history = (
            await agent.get(
              `/api/admin/products/${black.product_id}/inventory-history?action=restock&actor=${admin.id}&limit=1`,
            )
          ).body;
          assert.equal(history.pagination.total, 1);
          assert.equal(history.data[0].changed_by, admin.id);
          assert.equal(history.data[0].quantity_changed, 5);
          await assert.rejects(
            sequelize.query("UPDATE audit_logs SET action='tampered'"),
            /append-only/,
          );
          await assert.rejects(
            sequelize.query('DELETE FROM stock_movements'),
            /append-only/,
          );
          await assert.rejects(sequelize.query('TRUNCATE audit_logs'), /append-only/);
          assert.equal(
            (
              await request(app).get(
                `/api/admin/products/${black.product_id}/audit-history`,
              )
            ).status,
            401,
          );
        },
      );
      await t.test(
        'warehouse aggregation preserves independent ownership and records one restock movement',
        async () => {
          const product = await create('/products', {
            product_name: 'Multi warehouse',
            slug: 'multi-warehouse',
            sku: 'MULTI',
            regular_price: 100,
            product_status: 'active',
            category_ids: [Number(root.category_id)],
            stock_quantity: 2,
          });
          const adjustment = await json(
            'post',
            `/products/${product.product_id}/inventory/adjustments`,
            {
              warehouse_code: 'W2',
              delta: 3,
              reason: 'Second warehouse receipt',
              movement_type: 'restock',
            },
            'warehouse-two',
          );
          assert.equal(adjustment.status, 200, JSON.stringify(adjustment.body));
          assert.equal(adjustment.body.data.available_quantity, 5);
          assert.equal(adjustment.body.data.last_updated_by, admin.id);
          const history = (
            await agent.get(
              `/api/admin/products/${product.product_id}/inventory-history?action=restock`,
            )
          ).body;
          assert.equal(history.pagination.total, 1);
          assert.equal(history.data[0].quantity_changed, 3);
          assert.equal(
            (
              await json('patch', `/products/${product.product_id}`, {
                stock_quantity: 9,
              })
            ).status,
            409,
          );
          await checkout(product, 4, 'two-warehouse-order');
          assert.equal(
            (await inventorySummary(product.product_id)).available_quantity,
            1,
          );
        },
      );
      await t.test(
        'restricted staff cannot bypass stock permissions through product PATCH; history filters validate input',
        async () => {
          const restricted = await models.user.create({
            realm: 'admin',
            name: 'Read only',
            email: 'readonly@example.invalid',
            passwordHash: await bcrypt.hash('test-password', 4),
          });
          await models.adminProfile.create({ userId: restricted.id, permissions: [] });
          const other = request.agent(app);
          assert.equal(
            (
              await other
                .post('/api/admin/auth/login')
                .set('Origin', env.ALLOWED_ORIGINS[0])
                .send({ email: 'readonly@example.invalid', password: 'test-password' })
            ).status,
            200,
          );
          assert.equal(
            (
              await other
                .patch(`/api/admin/products/${black.product_id}`)
                .set('Origin', env.ALLOWED_ORIGINS[0])
                .send({ stock_quantity: 999 })
            ).status,
            403,
          );
          assert.equal(
            (
              await other
                .post(`/api/admin/products/${black.product_id}/inventory/adjustments`)
                .set('Origin', env.ALLOWED_ORIGINS[0])
                .set('Idempotency-Key', 'denied')
                .send({ delta: 1, reason: 'Denied' })
            ).status,
            403,
          );
          assert.equal(
            (
              await agent.get(
                `/api/admin/products/${black.product_id}/audit-history?from=invalid`,
              )
            ).status,
            422,
          );
          const first = (
            await agent.get(
              `/api/admin/products/${black.product_id}/inventory-history?limit=1&offset=0`,
            )
          ).body;
          const next = (
            await agent.get(
              `/api/admin/products/${black.product_id}/inventory-history?limit=1&offset=1`,
            )
          ).body;
          assert.equal(first.pagination.total, next.pagination.total);
          assert.notEqual(first.data[0].id, next.data[0].id);
        },
      );
      await t.test(
        'audit history rolls back with failed writes and archived products preserve stock and images',
        async () => {
          const before = await select('SELECT count(*) AS count FROM audit_logs');
          await assert.rejects(
            sequelize.transaction(async (transaction) => {
              await models.category.update(
                { description: 'Must rollback' },
                { where: { category_id: root.category_id }, transaction },
              );
              throw new Error('forced rollback');
            }),
            /forced rollback/,
          );
          assert.equal(
            (await select('SELECT count(*) AS count FROM audit_logs'))[0].count,
            before[0].count,
          );
          assert.equal((await upload(`/products/${blue.product_id}/images`)).status, 201);
          assert.equal(
            (await json('delete', `/products/${blue.product_id}`)).status,
            204,
          );
          assert.equal(
            (await models.product.findByPk(blue.product_id)).product_status,
            'archived',
          );
          assert.equal(
            await models.productImage.count({ where: { product_id: blue.product_id } }),
            1,
          );
          assert.equal((await inventorySummary(blue.product_id)).available_quantity, 2);
        },
      );
      await t.test(
        'legacy conversion preserves original products, variants, warehouse quantities, category links and order history',
        async () => {
          env.INDEPENDENT_PRODUCTS_ENABLED = false;
          const legacy = await models.product.create({
            product_name: 'Legacy shirt',
            slug: 'legacy-shirt',
            product_status: 'active',
            product_type: 'variable',
            regular_price: 100,
            stock_quantity: 0,
          });
          const v1 = await models.productVariant.create({
            product_id: legacy.product_id,
            sku: 'LEGACY-BLUE',
            attributes: { Size: 'XL', Color: 'Blue' },
            stock_quantity: 0,
          });
          const v2 = await models.productVariant.create({
            product_id: legacy.product_id,
            sku: 'LEGACY-BLACK',
            attributes: { Size: 'XL', Color: 'Black' },
            stock_quantity: 0,
          });
          await models.productCategory.create({
            product_id: legacy.product_id,
            category_id: root.category_id,
            is_primary: true,
          });
          const image = await models.productImage.create({
            product_id: legacy.product_id,
            image_url: 'https://example.invalid/legacy.png',
            s3_key: 'upload/legacy-original.png',
            is_primary: true,
          });
          const [vendor] = await select(
            "INSERT INTO vendors(vendor_code,name,vendor_status) VALUES('LEGACY','Legacy','active') RETURNING id",
          );
          const [offer1] = await select(
            'INSERT INTO vendor_products(vendor_id,variant_id,selling_price,mrp) VALUES(:vendor,:variant,80,100) RETURNING id',
            { vendor: vendor.id, variant: v1.id },
          );
          const [offer2] = await select(
            'INSERT INTO vendor_products(vendor_id,variant_id,selling_price,mrp) VALUES(:vendor,:variant,80,100) RETURNING id',
            { vendor: vendor.id, variant: v2.id },
          );
          await sequelize.query(
            "INSERT INTO inventory(vendor_product_id,warehouse_code,quantity_on_hand,quantity_reserved) VALUES(:one,'W1',9,2),(:two,'W1',6,0)",
            { replacements: { one: offer1.id, two: offer2.id } },
          );
          const oldOrder = (
            await select(
              "INSERT INTO product_checkouts(id,customer_id,request_key,fingerprint,amount_paise,payload) VALUES('MB111111111111111111',:customer,'historical','historical',100,'{}') RETURNING id",
              { customer: customer.id },
            )
          )[0];
          await sequelize.query(
            'INSERT INTO orders SELECT * FROM product_checkouts WHERE id=:id',
            { replacements: { id: oldOrder.id } },
          );
          await sequelize.query(
            "INSERT INTO order_details(order_id,product_id,quantity,unit_price_paise,snapshot) VALUES(:order,:id,1,80,'{}')",
            { replacements: { order: oldOrder.id, id: 'shop:' + offer1.id } },
          );
          const oldCategoryCount = (
            await select(
              'SELECT count(*) AS count FROM product_categories WHERE product_id=:id',
              { id: historicalProduct.id },
            )
          )[0].count;
          const beforeVariants = await models.productVariant.count();
          env.INDEPENDENT_PRODUCTS_ENABLED = true;
          await assert.rejects(assertIndependentCatalogReady(), /cutover is incomplete/);
          env.INDEPENDENT_PRODUCTS_ENABLED = false;
          const { plan } = await sequelize.transaction(
            { readOnly: true },
            (transaction) => inspectProductMigration(transaction),
          );
          assert.equal(plan.can_apply, true, JSON.stringify(plan.conflicts));
          await assert.rejects(convertIndependentProducts('stale-fingerprint'), /stale/);
          const converted = await convertIndependentProducts(plan.fingerprint);
          assert.equal(converted.mappings.length, 2);
          assert.equal(await models.productVariant.count(), beforeVariants);
          assert.equal(
            (
              await select(
                'SELECT count(*) AS count FROM product_categories WHERE product_id=:id',
                { id: historicalProduct.id },
              )
            )[0].count,
            oldCategoryCount,
          );
          assert.equal(
            (await inventorySummary(historicalProduct.id)).available_quantity,
            4,
          );
          assert.equal(
            (
              await select('SELECT created_at FROM products WHERE id=:id', {
                id: historicalProduct.id,
              })
            )[0].created_at.toISOString(),
            '2020-01-01T00:00:00.000Z',
          );
          assert.ok(await models.product.findByPk(legacy.product_id));
          assert.equal(
            (await models.product.findByPk(legacy.product_id)).product_status,
            'archived',
          );
          const mapped = await select(
            'SELECT * FROM legacy_variant_products ORDER BY variant_id',
          );
          assert.notEqual(
            mapped[0].independent_product_id,
            mapped[1].independent_product_id,
          );
          assert.equal(
            (await inventorySummary(mapped[0].independent_product_id)).available_quantity,
            7,
          );
          assert.equal(
            (await inventorySummary(mapped[1].independent_product_id)).available_quantity,
            6,
          );
          assert.equal(
            (
              await models.productCategory.findOne({
                where: { product_id: mapped[0].independent_product_id },
              })
            ).category_id,
            root.category_id,
          );
          assert.equal(
            (
              await select(
                'SELECT independent_product_id FROM order_details WHERE order_id=:id',
                { id: oldOrder.id },
              )
            )[0].independent_product_id,
            mapped[0].independent_product_id,
          );
          assert.equal(
            (await models.productImage.findByPk(image.id)).s3_key,
            'upload/legacy-original.png',
          );
          env.INDEPENDENT_PRODUCTS_ENABLED = true;
          await assertIndependentCatalogReady();
          const detail = await agent.get(
            `/api/admin/products/${mapped[0].independent_product_id}`,
          );
          assert.equal(
            detail.body.data.images[0].image_url,
            'https://example.invalid/legacy.png',
          );
          const oldAlias = await request(app).get(
            '/api/app/products/' + encodeURIComponent('shop:' + offer1.id),
          );
          assert.equal(oldAlias.status, 200);
          assert.equal(
            oldAlias.body.data.productId,
            String(mapped[0].independent_product_id),
          );
          const freshPlan = await sequelize.transaction(
            { readOnly: true },
            (transaction) => inspectProductMigration(transaction),
          );
          assert.equal(freshPlan.plan.planned_products.length, 0);
          await convertIndependentProducts(freshPlan.plan.fingerprint);
          // Shared image replacement becomes a private image and never mutates the source S3 key.
          const replaced = await agent
            .put(
              `/api/admin/products/${mapped[0].independent_product_id}/images/${image.id}`,
            )
            .set('Origin', env.ALLOWED_ORIGINS[0])
            .attach('uploadimage', png, {
              filename: 'private.png',
              contentType: 'image/png',
            });
          assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
          assert.notEqual(replaced.body.data.id, image.id);
          assert.equal(
            (await models.productImage.findByPk(image.id)).image_url,
            'https://example.invalid/legacy.png',
          );
        },
      );
      await t.test('reservation replay does not duplicate movement records', async () => {
        const product = black;
        const created = await checkout(product, 1, 'reservation-replay', 'online');
        const before = (
          await select(
            'SELECT count(*) AS count FROM stock_movements WHERE order_id=:id',
            { id: created.id },
          )
        )[0].count;
        const row = await findOrder(created.id);
        await sequelize.transaction((transaction) =>
          reserveStock(created.id, row.payload.items, transaction),
        );
        assert.equal(
          (
            await select(
              'SELECT count(*) AS count FROM stock_movements WHERE order_id=:id',
              { id: created.id },
            )
          )[0].count,
          before,
        );
        await sequelize.transaction((transaction) =>
          settleStock(created.id, false, transaction),
        );
      });
    } finally {
      global.fetch = savedFetch;
      Object.assign(env, savedEnv);
      await sequelize.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
