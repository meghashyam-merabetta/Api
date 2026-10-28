import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { env } from '../src/config/env.js';
import { buildRouter } from '../src/shared/routes.js';
import { productsRoutes } from '../src/admin/products/products.routes.js';
import { variantAttributeRoutes } from '../src/admin/variants/variants.routes.js';
import { productRoutes } from '../src/app/products/products.routes.js';
import {
  createOrder,
  findOrder,
  syncOrder,
  orderView,
} from '../src/app/orders/orders.controller.js';

// Never point this opt-in suite at a shared database: it resets catalog/checkout fixtures.
test(
  'provided product schema: legacy migration, variant fields, publication, counters and checkout stock',
  {
    skip: process.env.RUN_PRODUCT_SCHEMA_DB_TESTS !== 'true',
  },
  async () => {
    assert.match(process.env.DB_NAME, /^codex_catalog_schema_test/);
    const originalFetch = global.fetch;
    const savedGateway = { ...env };
    const gatewayOrders = new Map();
    let sessionCalls = 0;
    const legacyId = 'MB111111111111111111';
    const app = express();
    app.use(express.json());
    const auth = (_req, _res, next) => next();
    app.use('/admin/products', buildRouter(auth, productsRoutes));
    app.use('/admin/variant-attributes', buildRouter(auth, variantAttributeRoutes));
    app.use('/app/products', buildRouter(auth, productRoutes));
    app.use((error, _req, res, _next) =>
      res
        .status(
          error instanceof UniqueConstraintError
            ? 409
            : error.name === 'ZodError'
              ? 422
              : (error.status ?? 500),
        )
        .json({ error: error.message }),
    );
    const post = async (url, body) => {
      const result = await request(app).post(url).send(body);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.data;
    };
    const sql = async (file) =>
      sequelize.query(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
    const checkout = async (customer, items, overrides = {}) => {
      let result,
        status = 200;
      await createOrder(
        {
          credential: customer.toJSON(),
          validated: {
            requestKey: randomUUID(),
            items,
            address: {
              line1: 'Test Road',
              city: 'Pune',
              state: 'Maharashtra',
              postalCode: '411001',
            },
            notes: '',
            ...overrides,
          },
        },
        {
          status(code) {
            status = code;
            return this;
          },
          json(value) {
            result = value;
          },
        },
      );
      return { ...result, httpStatus: status };
    };
    try {
      await models.customer.sync();
      await sql('014-product-orders.sql');
      await sql('023-admin-catalog-base.sql');
      await sql('024-admin-catalog-details.sql');
      await sql('025-admin-catalog-compatibility.sql');
      await sql('026-product-schema-alignment.sql');
      await sql('022-product-images.sql');
      await sql('027-admin-catalog-reliability.sql');
      await sql('035-product-specification-fields.sql');
      await sql('018-contact-coupons.sql');
      await sql('012-third-party-api-logs.sql');
      await sql('019-provider-response-body.sql');
      await sequelize.query(
        'TRUNCATE products, categories, brands, product_catalog, product_variant_attributes, orders, product_checkouts, product_order_counters RESTART IDENTITY CASCADE',
      );
      const firstCustomer = await models.customer.create({
        firstName: 'Schema',
        lastName: 'Test',
        phone: '9876543210',
        email: `${randomUUID()}@example.invalid`,
      });
      const secondCustomer = await models.customer.create({
        firstName: 'Schema',
        lastName: 'Second',
        phone: '9876543211',
        email: `${randomUUID()}@example.invalid`,
      });
      await sequelize.query(
        "INSERT INTO orders(id,customer_id,request_key,fingerprint,amount_paise,payload) VALUES(:id,:customer,'legacy-request','legacy-fingerprint',100,'{\"items\":[]}')",
        { replacements: { id: legacyId, customer: firstCustomer.id } },
      );
      await sql('026-product-schema-alignment.sql');
      await sql('026-product-schema-alignment.sql');
      assert.equal((await findOrder(legacyId, firstCustomer.id)).stock_state, 'legacy');
      assert.equal(await models.productCheckout.count(), 1);
      // A conflicting history ID must roll back instead of overwriting checkout data.
      await sequelize.query("UPDATE orders SET fingerprint='conflict' WHERE id=:id", {
        replacements: { id: legacyId },
      });
      await assert.rejects(
        sequelize.transaction(async (transaction) =>
          sequelize.query(
            await readFile(
              new URL('../sql/026-product-schema-alignment.sql', import.meta.url),
              'utf8',
            ),
            { transaction },
          ),
        ),
        /Conflicting/,
      );
      await sequelize.query(
        "UPDATE orders SET fingerprint='legacy-fingerprint' WHERE id=:id",
        { replacements: { id: legacyId } },
      );
      Object.assign(env, {
        HDFC_ENVIRONMENT: 'sandbox',
        HDFC_API_KEY: 'mocksecret',
        HDFC_MERCHANT_ID: 'mockmerchant',
        HDFC_CLIENT_ID: 'mockclient',
        HDFC_RETURN_URL: 'https://merchant.example/payments/return',
      });
      global.fetch = async (url, options) => {
        if (options.method === 'POST') {
          sessionCalls++;
          const body = JSON.parse(options.body);
          gatewayOrders.set(body.order_id, { amount: body.amount, status: 'CHARGED' });
          return Response.json({
            order_id: body.order_id,
            payment_links: {
              web: 'https://smartgateway.hdfcuat.bank.in/payment-page/test',
            },
          });
        }
        const id = url.split('/').at(-1),
          payment = gatewayOrders.get(id);
        assert.ok(payment);
        return Response.json({
          order_id: id,
          merchant_id: 'mockmerchant',
          currency: 'INR',
          amount: payment.amount,
          status: payment.status,
          txn_id: 'mocktxn',
        });
      };
      const category = await models.category.create({
        category_name: 'Care',
        slug: 'care',
      });
      const simple = await post('/admin/products', {
        product_name: 'Schema Simple',
        slug: 'schema-simple',
        product_status: 'active',
        regular_price: 100,
        stock_quantity: 3,
        category_ids: [Number(category.category_id)],
      });
      const catalogId = `product:${simple.product_id}`;
      const listing = await request(app).get(
        `/app/products?category_id=${category.category_id}&search=Schema`,
      );
      assert.equal(listing.status, 200, JSON.stringify(listing.body));
      assert.equal(listing.body.data[0].id, catalogId);
      assert.equal(listing.body.data[0].price, 100);
      assert.equal((await request(app).get(`/app/products/${catalogId}`)).status, 200);
      const key = randomUUID();
      const attempts = await Promise.allSettled([
        checkout(firstCustomer, [{ id: catalogId, quantity: 2 }], { requestKey: key }),
        checkout(secondCustomer, [{ id: catalogId, quantity: 2 }]),
      ]);
      assert.equal(
        attempts.filter((value) => value.status === 'fulfilled').length,
        1,
        JSON.stringify(
          attempts.map(
            (result) => result.reason?.sql ?? result.reason?.message ?? result.status,
          ),
        ),
      );
      assert.equal(
        attempts.filter(
          (value) => value.status === 'rejected' && value.reason.status === 409,
        ).length,
        1,
      );
      const winnerIndex = attempts.findIndex((value) => value.status === 'fulfilled');
      const winnerCustomer = winnerIndex === 0 ? firstCustomer : secondCustomer;
      const winner = attempts[winnerIndex].value;
      assert.equal(winner.total, 240);
      assert.match(winner.orderNumber, /^MB\d{11}$/);
      assert.equal(winner.stockState, 'reserved');
      assert.equal((await models.product.findByPk(simple.product_id)).stock_quantity, 1);
      assert.equal(
        (await models.productCatalog.findByPk(catalogId)).data.stock_quantity,
        1,
      );
      const callCount = sessionCalls;
      const retry = await checkout(winnerCustomer, [{ id: catalogId, quantity: 2 }]);
      assert.equal(retry.id, winner.id);
      assert.equal(sessionCalls, callCount);
      const saved = await findOrder(winner.id, winnerCustomer.id);
      await assert.rejects(
        findOrder(winner.id, randomUUID()),
        (error) => error.status === 404,
      );
      const paid = await syncOrder(saved);
      assert.equal(paid.payment_status, 'CHARGED');
      assert.equal(paid.stock_state, 'committed');
      assert.ok(paid.payment_checked_at);
      assert.equal(orderView(paid).paymentUrl, null);
      gatewayOrders.get(winner.id).status = 'AUTHENTICATION_FAILED';
      assert.equal((await syncOrder(saved)).payment_status, 'CHARGED');
      assert.equal((await models.product.findByPk(simple.product_id)).stock_quantity, 1);
      const counterBefore = (await models.productOrderCounter.findOne()).last_number;
      await assert.rejects(
        checkout(firstCustomer, [{ id: catalogId, quantity: 1 }], {
          couponCode: 'DOES_NOT_EXIST',
        }),
        (error) => error.status === 422,
      );
      assert.equal((await models.product.findByPk(simple.product_id)).stock_quantity, 1);
      assert.equal(
        (await models.productOrderCounter.findOne()).last_number,
        counterBefore,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/admin/products/${simple.product_id}`)
            .send({ regular_price: 125 })
        ).status,
        200,
      );
      assert.equal((await models.productCatalog.findByPk(catalogId)).data.price, 125);
      assert.equal((await findOrder(winner.id)).payload.items[0].snapshot.price, 100);
      await post('/admin/variant-attributes', { name: 'Size', values: ['M', 'L'] });
      const variable = await post('/admin/products', {
        product_name: 'Schema Variable',
        slug: 'schema-variable',
        product_type: 'variable',
        product_status: 'active',
        regular_price: 60,
      });
      const medium = await post(`/admin/products/${variable.product_id}/variants`, {
        sku: 'SCHEMA-M',
        variant_name: 'Medium pack',
        barcode: '1234567890123',
        weight_grams: 250,
        attributes: { Size: 'M' },
        regular_price: 60,
        stock_quantity: 2,
      });
      const variantResponse = await request(app).get(
        `/admin/products/${variable.product_id}/variants/${medium.id}`,
      );
      assert.equal(variantResponse.status, 200);
      assert.equal(variantResponse.body.data.variant_name, 'Medium pack');
      assert.equal(variantResponse.body.data.barcode, '1234567890123');
      assert.equal(variantResponse.body.data.weight_grams, 250);
      const variantCatalogId = `variant:${medium.id}`;
      const variantCheckout = await checkout(firstCustomer, [
        { id: variantCatalogId, quantity: 1 },
      ]);
      assert.equal(variantCheckout.stockState, 'reserved');
      assert.equal((await models.productVariant.findByPk(medium.id)).stock_quantity, 1);
      assert.equal(
        (
          await request(app).delete(
            `/admin/products/${variable.product_id}/variants/${medium.id}`,
          )
        ).status,
        204,
      );
      assert.equal(
        (await request(app).get(`/app/products/${variantCatalogId}`)).status,
        404,
      );
      assert.equal(
        (await findOrder(variantCheckout.id)).payload.items[0].snapshot.barcode,
        '1234567890123',
      );
      await models.productCatalog.create({
        id: 'legacy-seed',
        active: true,
        data: { name: 'Seed', price: 52 },
      });
      const unmanaged = await checkout(firstCustomer, [
        { id: 'legacy-seed', quantity: 1 },
      ]);
      assert.equal(unmanaged.stockState, 'unmanaged');
      assert.notEqual(unmanaged.orderNumber, winner.orderNumber);
      await sequelize.query(
        "UPDATE product_checkouts SET payment_expiry=now()-interval '1 minute' WHERE id=:id",
        { replacements: { id: unmanaged.id } },
      );
      assert.equal(orderView(await findOrder(unmanaged.id)).paymentUrl, null);
      const lastCounter = (await models.productOrderCounter.findOne()).last_number;
      await models.productOrderCounter.update({ last_number: 99999 }, { where: {} });
      await assert.rejects(
        checkout(firstCustomer, [{ id: 'legacy-seed', quantity: 2 }]),
        (error) => error.status === 503,
      );
      await models.productOrderCounter.update(
        { last_number: lastCounter },
        { where: {} },
      );
      await request(app)
        .patch(`/admin/products/${simple.product_id}`)
        .send({ product_status: 'draft' });
      assert.equal((await request(app).get(`/app/products/${catalogId}`)).status, 404);
    } finally {
      global.fetch = originalFetch;
      Object.assign(env, savedGateway);
      await sequelize.close();
    }
  },
);
