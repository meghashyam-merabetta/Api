import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { buildRouter } from '../src/shared/routes.js';
import { productsRoutes } from '../src/admin/products/products.routes.js';
import { variantAttributeRoutes } from '../src/admin/variants/variants.routes.js';
import { productRoutes } from '../src/app/products/products.routes.js';
import { env } from '../src/config/env.js';

// Legacy compatibility only. Independent checkout/concurrency is tested in
// independent-products-db.test.js; parent/variant counters are not new stock owners.
test(
  'provided product schema: historical migration, variant metadata, publication and legacy offer compatibility',
  {
    skip: process.env.RUN_PRODUCT_SCHEMA_DB_TESTS !== 'true',
  },
  async () => {
    assert.match(process.env.DB_NAME, /^codex_catalog_schema_test/);
    assert.equal(env.INDEPENDENT_PRODUCTS_ENABLED, false);
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
      const response = await request(app).post(url).send(body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.data;
    };
    const sql = async (file) =>
      sequelize.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
    const select = async (sql, replacements = {}) =>
      sequelize.query(sql, { replacements, type: 'SELECT' });
    try {
      await models.customer.sync();
      await models.user.sync();
      for (const file of [
        '014-product-orders.sql',
        '023-admin-catalog-base.sql',
        '024-admin-catalog-details.sql',
        '025-admin-catalog-compatibility.sql',
        '026-product-schema-alignment.sql',
        '022-product-images.sql',
        '027-admin-catalog-reliability.sql',
        '035-product-specification-fields.sql',
        '035-admin-integration-gaps.sql',
        '036-independent-products-audit.sql',
        '038-variant-image-galleries.sql',
      ])
        await sql(file);
      const customer = await models.customer.create({
        firstName: 'Historical',
        email: 'historical@example.invalid',
        phone: '9876543210',
      });
      const legacy = 'MB111111111111111111';
      await sequelize.query(
        `INSERT INTO orders(id,customer_id,request_key,fingerprint,amount_paise,payload,order_number) VALUES(:id,:customer,'historical','historical-fingerprint',100,'{"items":[]}', 'MB26010100007')`,
        { replacements: { id: legacy, customer: customer.id } },
      );
      await sql('026-product-schema-alignment.sql');
      await sql('026-product-schema-alignment.sql');
      const [historical] = await select('SELECT * FROM product_checkouts WHERE id=:id', {
        id: legacy,
      });
      assert.equal(historical.customer_id, customer.id);
      assert.equal(historical.stock_state, 'legacy');
      assert.equal(historical.fingerprint, 'historical-fingerprint');
      assert.equal(
        (
          await select(
            "SELECT last_number FROM product_order_counters WHERE order_day='2026-01-01'",
          )
        )[0].last_number,
        7,
      );
      await sequelize.query("UPDATE orders SET fingerprint='conflict' WHERE id=:id", {
        replacements: { id: legacy },
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
        /Conflicting orders/,
      );
      assert.equal(
        (
          await select('SELECT fingerprint FROM product_checkouts WHERE id=:id', {
            id: legacy,
          })
        )[0].fingerprint,
        'historical-fingerprint',
      );
      const category = await models.category.create({
        category_name: 'Care',
        slug: 'care',
      });
      const product = await post('/admin/products', {
        product_name: 'Schema Care',
        slug: 'schema-care',
        product_status: 'active',
        mrp: 100,
        offer_price: 80,
        category_ids: [Number(category.category_id)],
      });
      await post('/admin/variant-attributes', { name: 'Size', values: ['M', 'L'] });
      const variant = await post(`/admin/products/${product.product_id}/variants`, {
        sku: 'SCHEMA-M',
        variant_name: 'Medium pack',
        barcode: '1234567890123',
        weight_grams: 250,
        attributes: { Size: 'M' },
        regular_price: 60,
        sale_price: 50,
        stock_quantity: 2,
      });
      const detailed = (
        await request(app).get(
          `/admin/products/${product.product_id}/variants/${variant.id}`,
        )
      ).body.data;
      assert.equal(detailed.variant_name, 'Medium pack');
      assert.equal(detailed.barcode, '1234567890123');
      assert.equal(detailed.weight_grams, 250);
      const published = await models.productCatalog.findByPk('variant:' + variant.id);
      assert.equal(published.data.source_product_id, product.product_id);
      assert.equal(published.data.price, 50);
      assert.equal(
        (
          await request(app)
            .patch(`/admin/products/${product.product_id}`)
            .send({ regular_price: 125 })
        ).status,
        200,
      );
      assert.equal(
        (await models.productCatalog.findByPk('variant:' + variant.id)).data.price,
        50,
      );
      // The legacy storefront contract uses offers/warehouse stock, not retained counters.
      const [vendor] = await select(
        "INSERT INTO vendors(vendor_code,name,vendor_status) VALUES(:code,'Schema vendor','active') RETURNING id",
        { code: randomUUID() },
      );
      const [offer] = await select(
        'INSERT INTO vendor_products(vendor_id,variant_id,mrp,selling_price) VALUES(:vendor,:variant,60,50) RETURNING id',
        { vendor: vendor.id, variant: variant.id },
      );
      await sequelize.query(
        "INSERT INTO inventory(vendor_product_id,warehouse_code,quantity_on_hand) VALUES(:offer,'W1',3)",
        { replacements: { offer: offer.id } },
      );
      const listing = await request(app).get(
        `/app/products?category=${category.category_id}&q=Schema`,
      );
      assert.equal(listing.status, 200, JSON.stringify(listing.body));
      assert.equal(listing.body.data[0].id, 'shop:' + offer.id);
      assert.equal(listing.body.data[0].stock, 3);
      const lookup = await request(app).get(
        '/app/products/' + encodeURIComponent('shop:' + offer.id),
      );
      assert.equal(lookup.status, 200);
      assert.equal(lookup.body.data.attributes.Size, 'M');
      assert.equal(lookup.body.data.price, 50);
      assert.equal(
        (await models.product.findByPk(product.product_id)).inventory_managed,
        false,
      );
      assert.equal((await models.productVariant.findByPk(variant.id)).stock_quantity, 2);
    } finally {
      await sequelize.close();
    }
  },
);
