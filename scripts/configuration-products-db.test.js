import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';

test(
  'configuration products keep the current editor flow and own independent identity/stock',
  { skip: process.env.RUN_CONFIGURATION_DB_TESTS !== 'true' },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_configuration_test/);
    assert.ok(['127.0.0.1', 'localhost'].includes(process.env.DB_HOST));
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { productCatalog } = await import('../src/app/products/catalog.js');
    const { reserveStock, settleStock } = await import('../src/app/orders/inventory.js');
    const { configurationStock } =
      await import('../src/shared/configuration-products.js');
    const sql = (text, replacements = {}) =>
      sequelize.query(text, { replacements, type: 'SELECT' });
    const agent = request.agent(app),
      origin = env.ALLOWED_ORIGINS[0];
    const write = (method, path, body, key) => {
      const r = agent[method]('/api/admin/' + path).set('Origin', origin);
      if (key) r.set('Idempotency-Key', key);
      return r.send(body);
    };
    const get = async (path) => {
      const r = await agent.get('/api/admin/' + path);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const ok = (r, status = 200) => {
      assert.equal(r.status, status, JSON.stringify(r.body));
      return r.body.data;
    };
    let group,
      ids = [];
    const variants = [];
    try {
      const runtimeQuery = sequelize.query;
      sequelize.query = (sql, options = {}) =>
        runtimeQuery(sql, { ...options, productStorage: false });
      await models.customer.sync();
      await models.user.sync();
      await models.session.sync();
      await models.adminProfile.sync();
      for (const f of [
        '014-product-orders.sql',
        '023-admin-catalog-base.sql',
        '024-admin-catalog-details.sql',
        '025-admin-catalog-compatibility.sql',
        '026-product-schema-alignment.sql',
        '022-product-images.sql',
        '027-admin-catalog-reliability.sql',
        '035-product-specification-fields.sql',
        '036-product-soft-delete.sql',
      ])
        await sequelize.query(
          await readFile(new URL('../sql/' + f, import.meta.url), 'utf8'),
          { productStorage: false },
        );
      await sequelize.query(
        await readFile(
          new URL(
            '../test-support/configuration-inventory-fixtures.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      for (const f of [
        '038-variant-image-galleries.sql',
        '039-configuration-product-compatibility.sql',
        '037-recursive-category-deletion-audit.sql',
      ]) {
        if (
          env.VARIANT_PRODUCT_FIELDS_ENABLED &&
          f === '039-configuration-product-compatibility.sql'
        )
          continue;
        await sequelize.query(
          await readFile(new URL('../sql/' + f, import.meta.url), 'utf8'),
          { productStorage: false },
        );
      }
      if (env.VARIANT_PRODUCT_FIELDS_ENABLED)
        await sequelize.query(
          await readFile(
            new URL('../sql/040-variant-backed-product-fields.sql', import.meta.url),
            'utf8',
          ),
          { productStorage: false },
        );
      if (env.VARIANT_PRODUCT_FIELDS_ENABLED) {
        await sequelize.query(
          await readFile(
            new URL(
              '../sql/039-configuration-product-compatibility.sql',
              import.meta.url,
            ),
            'utf8',
          ),
          { productStorage: false },
        );
        const [schema] = await sequelize.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='products'",
          { type: 'SELECT', productStorage: false },
        );
        assert.equal(schema.n, 9);
      }
      sequelize.query = runtimeQuery;
      const admin = await models.user.create({
        realm: 'admin',
        name: 'Test',
        email: 'configuration@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      await models.adminProfile.create({ userId: admin.id, permissions: ['*'] });
      ok(
        await agent
          .post('/api/admin/auth/login')
          .set('Origin', origin)
          .send({ email: 'configuration@example.invalid', password: 'test-password' }),
      );
      await models.category.create({
        category_id: 2,
        category_name: 'Daily Living',
        slug: 'daily-living',
      });
      await models.category.create({
        category_id: 98,
        category_name: 'Adult Diaper Pants',
        slug: 'pants',
        parent_category_id: 2,
      });
      await models.variantAttribute.create({ name: 'Size', values: ['S', 'M', 'L'] });
      await models.variantAttribute.create({ name: 'Colour', values: ['Blue', 'blue'] });
      group = ok(
        await write('post', 'products', {
          product_name: 'BP Machine',
          slug: 'bp-machine',
          product_type: 'variable',
          product_status: 'active',
          regular_price: 100,
          sale_price: 90,
          category_ids: [98],
        }),
        201,
      );
      await t.test(
        'S/M/L create three real product rows without changing variant POST paths',
        async () => {
          for (const size of ['S', 'M', 'L'])
            variants.push(
              ok(
                await write(
                  'post',
                  `products/${group.product_id}/variants`,
                  {
                    sku: 'BP-' + size,
                    attributes: { Size: size, Colour: 'Blue' },
                    regular_price: 100,
                    sale_price: 80,
                    stock_quantity: 10,
                  },
                  'create-' + size,
                ),
                201,
              ),
            );
          ids = variants.map((v) => v.individual_product_id);
          assert.equal(new Set(ids).size, 3);
          assert.ok(ids.every((id) => id !== group.product_id));
          assert.equal(
            (await sql('SELECT * FROM products WHERE id IN (:ids)', { ids })).length,
            3,
          );
          for (const id of ids) {
            const p = (await get('products/' + id)).data;
            assert.equal(p.product_type, 'simple');
            assert.equal(p.stock_quantity, 10);
            assert.equal(p.group_product_id, group.product_id);
          }
        },
      );
      await t.test(
        'lost-response replays retain IDs and create no extra product or inventory rows',
        async () => {
          const replay = ok(
            await write(
              'post',
              `products/${group.product_id}/variants`,
              {
                sku: 'BP-S',
                attributes: { Size: 'S', Colour: 'Blue' },
                regular_price: 100,
                sale_price: 80,
                stock_quantity: 10,
              },
              'create-S',
            ),
            201,
          );
          assert.equal(replay.individual_product_id, ids[0]);
          assert.equal(
            (await sql('SELECT * FROM product_configuration_links')).length,
            3,
          );
          assert.equal(
            (await sql('SELECT * FROM inventory WHERE product_id IN (:ids)', { ids }))
              .length,
            3,
          );
        },
      );
      await t.test(
        'default list keeps one UI group; individual view returns three sellable configurations',
        async () => {
          assert.equal((await get('products?limit=100')).pagination.total, 1);
          const rows = await get('products?view=individual&category_id=98&limit=100');
          assert.equal(rows.pagination.total, 3);
          const groupRead = (await get('products/' + group.product_id)).data;
          assert.deepEqual(
            new Set(groupRead.variants.map((v) => v.individual_product_id)),
            new Set(ids),
          );
        },
      );
      await t.test(
        'variant PATCH preserves identity, case-sensitive attributes and independent stock/prices',
        async () => {
          const updated = ok(
            await write(
              'patch',
              `products/${group.product_id}/variants/${variants[0].id}`,
              {
                attributes: { Size: 'S', Colour: 'blue' },
                regular_price: 120,
                sale_price: 95,
                stock_quantity: 7,
              },
            ),
          );
          assert.equal(updated.individual_product_id, ids[0]);
          const p = (await get('products/' + ids[0])).data;
          assert.deepEqual(p.attributes, { Size: 'S', Colour: 'blue' });
          assert.equal(Number(p.sale_price), 95);
          assert.equal(p.stock_quantity, 7);
          assert.equal((await get('products/' + ids[1])).data.stock_quantity, 10);
        },
      );
      await t.test(
        'group edit propagates shared description/categories without replacing size pricing or IDs',
        async () => {
          ok(
            await write('patch', 'products/' + group.product_id, {
              description: 'Shared edited description',
              category_ids: [2, 98],
              primary_category_id: 2,
            }),
          );
          const p = (await get('products/' + ids[0])).data;
          assert.equal(p.description, 'Shared edited description');
          assert.equal(Number(p.sale_price), 95);
          assert.equal(p.categories.length, 2);
        },
      );
      await t.test(
        'public list/detail use exact configuration product IDs and preserve descendant filtering',
        async () => {
          const r = await request(app).get('/api/app/products?category=2&limit=100');
          assert.equal(r.status, 200, JSON.stringify(r.body));
          assert.equal(r.body.total, 3);
          assert.deepEqual(new Set(r.body.data.map((p) => p.productId)), new Set(ids));
          const detail = await request(app).get('/api/app/products/product:' + ids[0]);
          assert.equal(detail.status, 200);
          assert.equal(detail.body.data.stock, 7);
        },
      );
      await t.test(
        'effective galleries follow exact size products without copying or losing image objects',
        async () => {
          await models.productImage.create({
            product_id: group.product_id,
            image_url: 'https://example.invalid/base.jpg',
            s3_key: 'test/base.jpg',
            is_primary: true,
          });
          const custom = await models.variantImage.create({
            variant_id: variants[0].id,
            image_url: 'https://example.invalid/s.jpg',
            s3_key: 'test/s.jpg',
            is_primary: true,
          });
          ok(
            await write(
              'patch',
              `products/${group.product_id}/variants/${variants[0].id}/images`,
              { use_product_images: false },
            ),
          );
          const own = (await get('products/' + ids[0] + '/images')).data;
          assert.equal(own[0].id, custom.id);
          assert.equal(
            (await get('products/' + ids[1] + '/images')).data[0].s3_key,
            'test/base.jpg',
          );
          const catalog = await productCatalog();
          assert.deepEqual(catalog.products.find((p) => p.productId === ids[0]).images, [
            'https://example.invalid/s.jpg',
          ]);
          assert.deepEqual(catalog.products.find((p) => p.productId === ids[1]).images, [
            'https://example.invalid/base.jpg',
          ]);
        },
      );
      await t.test(
        'direct product-ID edits update the same size and reject duplicate attribute combinations',
        async () => {
          ok(
            await write('patch', 'products/' + ids[1], {
              regular_price: 150,
              sale_price: 130,
              offer_percent: null,
              stock_quantity: 12,
            }),
          );
          const v = (await get(`products/${group.product_id}/variants/${variants[1].id}`))
            .data;
          assert.equal(v.individual_product_id, ids[1]);
          assert.equal(Number(v.sale_price), 130);
          assert.equal(v.stock_quantity, 12);
          const duplicate = await write('patch', 'products/' + ids[1], {
            attributes: { Size: 'S', Colour: 'blue' },
          });
          assert.equal(duplicate.status, 409);
          assert.equal((await get('products/' + ids[1])).data.attributes.Size, 'M');
          ok(await write('patch', 'products/' + ids[1], { stock_quantity: 10 }));
        },
      );
      await t.test(
        'reservation and deduction affect only the selected size and do not double-deduct',
        async () => {
          const customer = await models.customer.create({
            name: 'Test Customer',
            phone: '9999999999',
          });
          await sequelize.query(
            "INSERT INTO product_checkouts(id,customer_id,request_key,fingerprint,amount_paise,payload) VALUES('MB00000000001',:customer,'stock-test','fingerprint',100,'{}')",
            { replacements: { customer: customer.id } },
          );
          await sequelize.transaction((tr) =>
            reserveStock('MB00000000001', [{ id: 'product:' + ids[0], quantity: 2 }], tr),
          );
          assert.equal(await configurationStock(ids[0]), 5);
          assert.equal(await configurationStock(ids[1]), 10);
          await sequelize.transaction((tr) => settleStock('MB00000000001', true, tr));
          await sequelize.transaction((tr) => settleStock('MB00000000001', true, tr));
          assert.equal(await configurationStock(ids[0]), 5);
          assert.equal(await configurationStock(ids[1]), 10);
          const row = (
            await sql('SELECT * FROM inventory WHERE product_id=:id', { id: ids[0] })
          )[0];
          assert.equal(row.quantity_on_hand, 5);
          assert.equal(row.quantity_reserved, 0);
        },
      );
      await t.test(
        'failed create rolls back variant, product, mapping and stock together',
        async () => {
          const before = await sql('SELECT count(*)::int n FROM products');
          const r = await write('post', `products/${group.product_id}/variants`, {
            sku: 'BP-M',
            attributes: { Size: 'S', Colour: 'Blue' },
            stock_quantity: 99,
          });
          assert.ok(r.status >= 400);
          assert.equal(
            (await sql('SELECT count(*)::int n FROM products'))[0].n,
            before[0].n,
          );
          assert.equal(
            (await sql('SELECT * FROM product_configuration_links')).length,
            3,
          );
        },
      );
      await t.test(
        'deleting one size archives only its product and preserves inventory/history',
        async () => {
          ok(
            await write(
              'delete',
              `products/${group.product_id}/variants/${variants[2].id}`,
              {},
            ),
            204,
          );
          assert.equal((await agent.get('/api/admin/products/' + ids[2])).status, 404);
          assert.equal((await get('products/' + ids[1])).data.product_status, 'active');
          assert.equal(
            (await sql('SELECT * FROM inventory WHERE product_id=:id', { id: ids[2] }))
              .length,
            1,
          );
          assert.equal(
            (await get(`products/${group.product_id}/variants`)).data.length,
            2,
          );
        },
      );
      await t.test(
        'approved fingerprint conversion preserves legacy warehouse rows and creates stable identities',
        async () => {
          const { inspectConfigurationConversion, applyConfigurationConversion } =
            await import('../src/shared/configuration-conversion.js');
          const old = await models.product.create({
            product_name: 'Legacy BP',
            slug: 'legacy-bp',
            product_type: 'variable',
            product_status: 'inactive',
            regular_price: 100,
            sale_price: 80,
          });
          await models.productCategory.create({
            product_id: old.product_id,
            category_id: 98,
            is_primary: true,
          });
          const oldVariant = await models.productVariant.create({
            product_id: old.product_id,
            sku: 'LEGACY-BP',
            attributes: { Size: 'M' },
            regular_price: 100,
            sale_price: 80,
            stock_quantity: 4,
          });
          const vendor = await sql(
            "INSERT INTO vendors(vendor_code,name,vendor_status) VALUES('test','Test','active') RETURNING id",
          );
          const offer = await sql(
            'INSERT INTO vendor_products(vendor_id,variant_id,mrp,selling_price) VALUES(:vendor,:variant,100,80) RETURNING id',
            { vendor: vendor[0].id, variant: oldVariant.id },
          );
          const inv = await sql(
            'INSERT INTO inventory(vendor_product_id,quantity_on_hand,quantity_reserved) VALUES(:offer,6,2) RETURNING *',
            { offer: offer[0].id },
          );
          const plan = await sequelize.transaction((tr) =>
            inspectConfigurationConversion(tr, [old.product_id]),
          );
          assert.equal(plan.can_apply, true);
          await assert.rejects(
            () => applyConfigurationConversion('stale', [old.product_id]),
            /fingerprint/,
          );
          const result = await applyConfigurationConversion(plan.fingerprint, [
            old.product_id,
          ]);
          assert.equal(result.converted.length, 1);
          const after = (
            await sql('SELECT * FROM inventory WHERE id=:id', { id: inv[0].id })
          )[0];
          assert.equal(after.quantity_on_hand, 6);
          assert.equal(after.quantity_reserved, 2);
          assert.equal(after.vendor_product_id, inv[0].vendor_product_id);
          assert.equal(String(after.product_id), result.converted[0].product_id);
          const migrated = await models.product.findByPk(result.converted[0].product_id);
          assert.equal(migrated.product_status, 'inactive');
          const replay = await sequelize.transaction((tr) =>
            inspectConfigurationConversion(tr, [old.product_id]),
          );
          assert.equal(replay.planned.length, 0);
          ok(
            await write('patch', 'products/' + old.product_id, {
              product_status: 'active',
            }),
          );
          const alias = await request(app).get('/api/app/products/shop:' + offer[0].id);
          assert.equal(alias.status, 200, JSON.stringify(alias.body));
          assert.equal(alias.body.data.productId, result.converted[0].product_id);
          assert.equal(alias.body.data.id, 'shop:' + offer[0].id);
          assert.equal(alias.body.data.stock, 4);
          ok(await write('delete', 'products/' + old.product_id, {}), 204);
        },
      );
      await t.test(
        'existing remove-all-variants then switch-to-simple workflow keeps working',
        async () => {
          const simpleGroup = ok(
            await write('post', 'products', {
              product_name: 'Switch test',
              slug: 'switch-test',
              product_type: 'variable',
              product_status: 'active',
              regular_price: 100,
            }),
            201,
          );
          const v = ok(
            await write('post', `products/${simpleGroup.product_id}/variants`, {
              sku: 'SWITCH-M',
              attributes: { Size: 'M' },
              stock_quantity: 0,
            }),
            201,
          );
          ok(
            await write(
              'delete',
              `products/${simpleGroup.product_id}/variants/${v.id}`,
              {},
            ),
            204,
          );
          const single = ok(
            await write('patch', 'products/' + simpleGroup.product_id, {
              product_type: 'simple',
              stock_quantity: 8,
            }),
          );
          assert.equal(single.is_configuration_group, false);
          assert.equal(single.inventory_managed, true);
          assert.equal(single.stock_quantity, 8);
          assert.equal(
            (await get('products/' + single.product_id)).data.stock_quantity,
            8,
          );
          ok(await write('delete', 'products/' + simpleGroup.product_id, {}), 204);
        },
      );
      await t.test(
        'category preview includes configuration products and group deletion archives all sizes',
        async () => {
          const plan = (await get('categories/2/deletion-preview')).data;
          assert.ok(plan.products_to_soft_delete.some((p) => String(p.id) === ids[0]));
          ok(await write('delete', 'products/' + group.product_id, {}), 204);
          assert.equal((await agent.get('/api/admin/products/' + ids[0])).status, 404);
          assert.equal((await productCatalog()).products.length, 0);
          assert.equal(
            (await sql('SELECT * FROM inventory WHERE product_id IN (:ids)', { ids }))
              .length,
            3,
          );
        },
      );
    } finally {
      await sequelize.close();
    }
  },
);
