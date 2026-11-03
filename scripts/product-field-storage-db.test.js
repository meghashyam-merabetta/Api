import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test(
  'all product extension fields survive relocation, unchanged API writes and verified inverse migration',
  { skip: process.env.RUN_PRODUCT_FIELD_DB_TESTS !== 'true' },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_product_fields_test/);
    assert.equal(process.env.DB_HOST, '127.0.0.1');
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { productCoreFields } = await import('../src/shared/product-field-manifest.js');
    const {
      inspectProductFieldStorage,
      applyProductFieldStorage,
      restoreProductFieldColumns,
    } = await import('./lib/product-field-migration.js');
    const raw = (s, replacements = {}) =>
      sequelize.query(s, { replacements, type: 'SELECT', productStorage: false });
    const exec = (s) => sequelize.query(s, { productStorage: false });
    const preview = () =>
      sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, (tr) =>
        inspectProductFieldStorage(tr),
      );
    const agent = request.agent(app),
      origin = env.ALLOWED_ORIGINS[0];
    const write = (method, path, body = {}) =>
      agent[method]('/api/admin/' + path)
        .set('Origin', origin)
        .send(body);
    const ok = (r, status = 200) => {
      assert.equal(r.status, status, JSON.stringify(r.body));
      return r.body.data;
    };
    let oldProducts, oldVariants, actor;
    try {
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
        await exec(await readFile(new URL('../sql/' + f, import.meta.url), 'utf8'));
      await exec(
        await readFile(
          new URL(
            '../test-support/configuration-inventory-fixtures.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await exec(
        await readFile(
          new URL('../sql/038-variant-image-galleries.sql', import.meta.url),
          'utf8',
        ),
      );
      await exec(
        await readFile(
          new URL('../sql/037-recursive-category-deletion-audit.sql', import.meta.url),
          'utf8',
        ),
      );
      // Actual UAT has the original 100 columns; schema 039 has not run there.
      actor = await models.user.create({
        realm: 'admin',
        name: 'Test',
        email: 'fields@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      await models.adminProfile.create({ userId: actor.id, permissions: ['*'] });
      await models.category.create({
        category_id: 2,
        category_name: 'Daily Living',
        slug: 'daily-living',
      });
      await sequelize.transaction(async (tr) => {
        await sequelize.query(
          "SELECT set_config('catalog.actor',:id,true),set_config('catalog.actor_type','admin',true)",
          { replacements: { id: actor.id }, transaction: tr, productStorage: false },
        );
        await sequelize.query(
          `INSERT INTO products(id,name,slug,product_status,product_type,sku,product_code,regular_price,sale_price,
    stock_quantity,offer_percent,has_accessories,accessories,gift_wrap_available,gift_wrap_charge,reusable,keywords,
    attributes,weight,weight_unit,manufacturing_date,sale_start_date,seller_pincodes,description)
    VALUES(5000,'Fixture parent','fixture-parent','active','variable','PARENT-SKU','CODE-1',125.50,100.25,30,20.12,
    true,'Cable',true,5.75,false,'["FROM products", "Size"]','{"Size":"parent","number":42}',1.123,'kg','2026-01-02','2026-01-03','["400001"]',
    'Unicode ₹ and text FROM products, apostrophe '' and newline')`,
          { transaction: tr, productStorage: false },
        );
        await sequelize.query(
          "INSERT INTO products(id,name,slug,product_status,sku,regular_price,keywords) VALUES(5001,'Simple fixture','simple-fixture','inactive','SIMPLE-SKU',0,'null'::jsonb)",
          { transaction: tr, productStorage: false },
        );
      });
      await raw('UPDATE products SET company_address=:text WHERE id=5000', {
        text: randomBytes(12000).toString('base64'),
      });
      await exec("SELECT setval(pg_get_serial_sequence('products','id'),5001,true)");
      await exec(
        'INSERT INTO product_variants(id,product_id,sku,attributes,stock_quantity,regular_price,sale_price) VALUES(7,5000,\'M-SKU\',\'{"Size":"M","Colour":"Blue"}\',30,125.50,100.25)',
      );
      await exec("SELECT setval(pg_get_serial_sequence('product_variants','id'),7,true)");
      oldProducts = (
        await raw('SELECT to_jsonb(p) AS value FROM products p ORDER BY id')
      ).map((r) => r.value);
      oldVariants = (
        await raw('SELECT to_jsonb(v) AS value FROM product_variants v ORDER BY id')
      ).map((r) => r.value);
      await t.test(
        'refuses stale plans and rolls back every change for an unreviewed dependent view',
        async () => {
          const before = await preview();
          assert.equal(before.fields_to_move.length, 91);
          await assert.rejects(() => applyProductFieldStorage('stale'), /fingerprint/);
          await exec(
            'CREATE VIEW test_dependent_product_view AS SELECT regular_price FROM products',
          );
          const plan = await preview();
          assert.equal(plan.can_apply, false);
          await assert.rejects(
            () => applyProductFieldStorage(plan.fingerprint),
            /conflicts/,
          );
          await assert.rejects(
            () =>
              sequelize.transaction(async (transaction) =>
                sequelize.query(
                  await readFile(
                    new URL(
                      '../sql/040-variant-backed-product-fields.sql',
                      import.meta.url,
                    ),
                    'utf8',
                  ),
                  { transaction, productStorage: false },
                ),
              ),
            (e) => e.parent?.code === '2BP01',
          );
          assert.equal(
            (
              await raw(
                "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='products'",
              )
            )[0].n,
            100,
          );
          assert.equal(
            (await raw('SELECT count(*)::int n FROM product_variants'))[0].n,
            1,
          );
          await exec('DROP VIEW test_dependent_product_view');
        },
      );
      await t.test(
        'copies every value before removing 91 columns, preserving typed null/JSON/numeric/date data',
        async () => {
          const before = await preview();
          const result = await applyProductFieldStorage(before.fingerprint);
          assert.equal(result.fields_moved, 91);
          assert.deepEqual(
            new Set(result.physical_product_columns),
            new Set(productCoreFields),
          );
          const actual = (
            await raw('SELECT to_jsonb(p) AS value FROM product_records p ORDER BY id')
          ).map(({ value }) => {
            delete value.is_configuration_group;
            return value;
          });
          assert.deepEqual(actual, oldProducts);
          const stored = await raw(
            'SELECT product_id,attributes FROM product_variants WHERE attributes @> \'{"__product_store":true}\' ORDER BY product_id',
          );
          assert.equal(stored.length, 2);
          assert.equal(Object.keys(stored[0].attributes.__product_fields).length, 92);
          assert.equal(stored[0].attributes.__product_fields.stock_quantity, 30);
          assert.equal(stored[0].attributes.__product_fields.reusable, false);
          assert.equal(stored[0].attributes.__product_fields.regular_price, 125.5);
          assert.deepEqual(
            (
              await raw(
                'SELECT to_jsonb(v) AS value FROM product_variants v WHERE NOT attributes @> \'{"__product_store":true}\' ORDER BY id',
              )
            ).map((r) => r.value),
            oldVariants,
          );
        },
      );
      await t.test(
        'reapplying is idempotent and the original UI sees only real variants',
        async () => {
          assert.equal(
            (await applyProductFieldStorage('old-fingerprint')).already_applied,
            true,
          );
          const { assertProductFieldStorageReady } =
            await import('../src/shared/product-storage-readiness.js');
          await assertProductFieldStorageReady();
          env.VARIANT_PRODUCT_FIELDS_ENABLED = false;
          await assert.rejects(
            () => assertProductFieldStorageReady(),
            /already installed/,
          );
          env.VARIANT_PRODUCT_FIELDS_ENABLED = true;
          const bootstrap = spawnSync(
            process.execPath,
            ['--import', './test-support/env.js', 'scripts/migrate.js'],
            {
              cwd: new URL('..', import.meta.url),
              env: { ...process.env, VARIANT_PRODUCT_FIELDS_ENABLED: 'false' },
              encoding: 'utf8',
              timeout: 15000,
            },
          );
          assert.notEqual(bootstrap.status, 0);
          assert.match(bootstrap.stderr, /Legacy bootstrap is disabled/);

          ok(
            await agent
              .post('/api/admin/auth/login')
              .set('Origin', origin)
              .send({ email: 'fields@example.invalid', password: 'test-password' }),
          );
          const p = ok(await agent.get('/api/admin/products/5000'));
          assert.equal(p.product_name, 'Fixture parent');
          assert.equal(Number(p.regular_price), 125.5);
          assert.deepEqual(
            p.variants.map((v) => v.id),
            ['7'],
          );
          const rows = await agent.get('/api/admin/products/5000/variants');
          ok(rows);
          assert.equal(rows.body.pagination.total, 1);
          assert.deepEqual(rows.body.data[0].attributes, { Size: 'M', Colour: 'Blue' });
          const simple = ok(await agent.get('/api/admin/products/5001'));
          assert.equal(simple.variants.length, 0);
        },
      );
      await t.test(
        'flat product PATCH persists JSON values, keeps checks/uniqueness and writes one actor-attributed audit',
        async () => {
          const before = await raw(
            "SELECT count(*)::int n FROM audit_logs WHERE entity_type='product' AND entity_id='5000'",
          );
          ok(
            await write('patch', 'products/5000', {
              regular_price: 150,
              sale_price: 120,
              offer_percent: null,
              description: 'Edited',
              weight: 2.345,
              reusable: true,
            }),
          );
          const stored = (
            await raw(
              "SELECT attributes->'__product_fields' AS fields FROM product_variants WHERE product_id=5000 AND attributes @> '{\"__product_store\":true}'",
            )
          )[0].fields;
          assert.equal(stored.regular_price, 150);
          assert.equal(stored.reusable, true);
          assert.equal(stored.weight, 2.345);
          ok(
            await write('patch', 'products/5001', { description: 'Null JSON retained' }),
          );
          assert.equal(
            (await raw('SELECT keywords FROM product_records WHERE id=5001'))[0].keywords,
            null,
          );
          const after = await raw(
            "SELECT * FROM audit_logs WHERE entity_type='product' AND entity_id='5000' ORDER BY id DESC",
          );
          assert.equal(after.length, before[0].n + 1);
          assert.equal(after[0].changed_by, actor.id);
          const duplicate = await write('patch', 'products/5000', {
            sku: 'SIMPLE-SKU',
            description: 'Must roll back',
          });
          assert.equal(duplicate.status, 409);
          assert.equal(
            ok(await agent.get('/api/admin/products/5000')).description,
            'Edited',
          );
          await assert.rejects(() =>
            exec('UPDATE product_records SET sale_price=2000 WHERE id=5000'),
          );
          await assert.rejects(
            () =>
              exec(
                "UPDATE product_variants SET attributes=jsonb_set(attributes,'{__product_fields,stock_quantity}','999') WHERE product_id=5000 AND attributes @> '{\"__product_store\":true}'",
              ),
            /product_records/,
          );
        },
      );
      await t.test(
        'new/simple product creation defaults and soft deletion still work without extra product columns',
        async () => {
          const p = ok(
            await write('post', 'products', {
              product_name: 'New simple',
              slug: 'new-simple',
              regular_price: 100,
              category_ids: [2],
            }),
            201,
          );
          assert.equal(p.product_type, 'simple');
          assert.equal(p.stock_quantity, 0);
          ok(await write('delete', 'products/' + p.product_id), 204);
          assert.equal(
            (await agent.get('/api/admin/products/' + p.product_id)).status,
            404,
          );
          const row = (
            await raw('SELECT * FROM product_records WHERE id=:id', { id: p.product_id })
          )[0];
          assert.equal(row.product_status, 'archived');
          assert.ok(row.deleted_at);
          assert.equal(
            (
              await raw(
                "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='products'",
              )
            )[0].n,
            9,
          );
        },
      );
      await t.test(
        'recursive category deletion archives JSON-backed products and preserves the physical core rows',
        async () => {
          await models.category.create({
            category_id: 9,
            category_name: 'Delete root',
            slug: 'delete-root',
          });
          await models.category.create({
            category_id: 10,
            category_name: 'Delete child',
            slug: 'delete-child',
            parent_category_id: 9,
          });
          await models.variantAttribute.create({ name: 'Size', values: ['M'] });
          const product = ok(
            await write('post', 'products', {
              product_name: 'Delete fixture',
              slug: 'delete-fixture',
              product_type: 'variable',
              product_status: 'active',
              regular_price: 10,
              category_ids: [10],
            }),
            201,
          );
          const variant = ok(
            await write('post', `products/${product.product_id}/variants`, {
              sku: 'DELETE-M',
              attributes: { Size: 'M' },
              stock_quantity: 0,
            }),
            201,
          );
          ok(await write('delete', 'categories/9'), 204);
          const row = (
            await raw('SELECT * FROM product_records WHERE id=:id', {
              id: product.product_id,
            })
          )[0];
          assert.ok(row.deleted_at);
          assert.equal(row.product_status, 'archived');
          assert.equal(
            (
              await raw('SELECT count(*)::int n FROM products WHERE id=:id', {
                id: product.product_id,
              })
            )[0].n,
            1,
          );
          assert.ok(
            (
              await raw('SELECT deleted_at FROM product_variants WHERE id=:id', {
                id: variant.id,
              })
            )[0].deleted_at,
          );
          const audits = await raw(
            "SELECT * FROM audit_logs WHERE entity_type='category' AND entity_id='9' AND action='CATEGORY_DELETED'",
          );
          assert.equal(audits.length, 1);
          assert.equal(audits[0].changed_by, actor.id);
        },
      );
      await t.test(
        'verified inverse migration restores old columns and only removes internal storage rows',
        async () => {
          const before = await preview();
          const expectedVariants = (
            await raw(
              'SELECT to_jsonb(v) value FROM product_variants v WHERE NOT attributes @> \'{"__product_store":true}\' ORDER BY id',
            )
          ).map((r) => r.value);
          const expected = (
            await raw('SELECT to_jsonb(p) value FROM product_records p ORDER BY id')
          ).map((r) => {
            delete r.value.is_configuration_group;
            return r.value;
          });
          await assert.rejects(() => restoreProductFieldColumns('stale'), /fingerprint/);
          const result = await restoreProductFieldColumns(before.fingerprint);
          assert.equal(result.columns_restored, 91);
          const restored = (
            await raw('SELECT to_jsonb(p) value FROM products p ORDER BY id')
          ).map((r) => r.value);
          assert.deepEqual(restored, expected);
          assert.deepEqual(
            (
              await raw('SELECT to_jsonb(v) value FROM product_variants v ORDER BY id')
            ).map((r) => r.value),
            expectedVariants,
          );
          assert.equal(
            (await raw("SELECT to_regclass('public.product_records') IS NULL AS gone"))[0]
              .gone,
            true,
          );
        },
      );
    } finally {
      await sequelize.close();
    }
  },
);
