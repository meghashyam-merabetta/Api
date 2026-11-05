import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';

test(
  'recursive category deletion: authenticated transactions and preserved business history',
  {
    skip: process.env.RUN_CATEGORY_DELETION_DB_TESTS !== 'true',
  },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_category_delete_test/);
    assert.ok(['127.0.0.1', 'localhost'].includes(process.env.DB_HOST));
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { s3 } = await import('../src/shared/image_upload.js');
    const { previewCategoryDeletion } =
      await import('../src/shared/category-deletion.js');
    const { assignProductCategories } =
      await import('../src/shared/product-category-assignments.js');
    const { publishProductCatalog } = await import('../src/shared/catalog-publisher.js');
    const originalSend = s3.send;
    s3.send = async () => {
      throw Error('Deletion must not write to storage');
    };
    const sql = (s, replacements = {}) =>
      sequelize.query(s, { replacements, type: 'SELECT' });
    const migrate = async (file) =>
      sequelize.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
    const agent = request.agent(app);
    const del = (id, query = '') =>
      agent
        .delete(`/api/admin/categories/${id}${query}`)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .send({});
    const preview = async (id) => {
      const r = await agent.get(`/api/admin/categories/${id}/deletion-preview`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.data;
    };
    const category = (id, parent = null) =>
      models.category.create({
        category_id: id,
        category_name: 'Category ' + id,
        slug: 'category-' + id,
        parent_category_id: parent,
      });
    const product = (id) =>
      models.product.create({
        product_id: id,
        product_name: 'Product ' + id,
        slug: 'product-' + id,
        sku: 'SKU-' + id,
        regular_price: 100,
        sale_price: 75,
        stock_quantity: 20,
        product_status: 'active',
      });
    const link = (p, c, primary = true) =>
      models.productCategory.create({
        product_id: p,
        category_id: c,
        is_primary: primary,
      });
    try {
      for (const model of [
        models.customer,
        models.user,
        models.session,
        models.adminProfile,
      ])
        await model.sync();
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
        '036-product-soft-delete.sql',
        '036-independent-products-audit.sql',
        '038-variant-image-galleries.sql',
        '037-recursive-category-deletion-audit.sql',
      ])
        await migrate(file);
      // Verify the migration is safely rerunnable.
      await migrate('037-recursive-category-deletion-audit.sql');
      const admin = await models.user.create({
        realm: 'admin',
        name: 'Delete test',
        email: 'delete@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      await models.adminProfile.create({ userId: admin.id, permissions: ['*'] });
      assert.equal(
        (
          await agent
            .post('/api/admin/auth/login')
            .set('Origin', env.ALLOWED_ORIGINS[0])
            .send({ email: 'delete@example.invalid', password: 'test-password' })
        ).status,
        200,
      );

      await t.test(
        'requires authentication, validates fingerprint and returns 404 for missing category',
        async () => {
          assert.equal(
            (
              await request(app)
                .delete('/api/admin/categories/28')
                .set('Origin', env.ALLOWED_ORIGINS[0])
                .send({})
            ).status,
            401,
          );
          assert.equal(
            (await request(app).get('/api/admin/categories/28/deletion-preview')).status,
            401,
          );
          assert.equal((await del(9999)).status, 404);
          assert.equal((await del(28, '?expected_fingerprint=invalid')).status, 422);
        },
      );
      await t.test(
        'empty category preserves legacy 204 and writes one admin-attributed deletion audit',
        async () => {
          await category(1);
          assert.equal((await del(1)).status, 204);
          const audits = await sql(
            "SELECT * FROM audit_logs WHERE entity_type='category' AND entity_id='1' AND action IN ('delete','CATEGORY_DELETED')",
          );
          assert.equal(audits.length, 1);
          assert.equal(audits[0].action, 'CATEGORY_DELETED');
          assert.equal(audits[0].changed_by, admin.id);
          assert.equal(audits[0].new_values.deleted_by, admin.id);
          assert.equal(audits[0].new_values.product_assignments_removed, 0);
          assert.equal(audits[0].old_values.name, 'Category 1');
          assert.ok(Number.isFinite(Date.parse(audits[0].new_values.deleted_at)));
          assert.equal(
            (
              await agent.get(
                '/api/admin/categories/1/audit-history?action=CATEGORY_DELETED',
              )
            ).body.pagination.total,
            1,
          );
        },
      );
      await t.test(
        'recursive preview is read-only and identifies exact shared products and primary changes',
        async () => {
          for (const [id, parent] of [
            [28, null],
            [36, null],
            [37, 36],
            [38, 37],
            [41, null],
          ])
            await category(id, parent);
          for (const id of [10, 11, 12, 13]) await product(id);
          for (const args of [
            [10, 36, true],
            [10, 37, false],
            [10, 41, false],
            [11, 38, true],
            [12, 41, true],
            [13, 28, true],
          ])
            await link(...args);
          await models.productVariant.create({
            id: 101,
            product_id: 10,
            sku: 'VAR-10',
            attributes: { Size: 'XL', Color: 'Blue' },
            stock_quantity: 8,
          });
          await models.productImage.create({
            product_id: 10,
            s3_key: 'upload/retained.png',
            image_url: 'https://example.invalid/retained.png',
            is_primary: true,
          });
          await sequelize.transaction((transaction) =>
            publishProductCatalog(10, transaction),
          );
          const before = await sql('SELECT count(*) AS count FROM audit_logs');
          const p = await preview(36);
          assert.deepEqual(
            p.categories_to_delete.map((c) => c.id),
            ['38', '37', '36'],
          );
          assert.deepEqual(
            p.products_to_soft_delete.map((p) => p.id),
            ['10', '11'],
          );
          assert.deepEqual(
            p.shared_products.map((p) => p.product_id),
            ['10'],
          );
          assert.equal(
            p.primary_category_changes.find((p) => p.product_id === '10').next_primary_id,
            '41',
          );
          assert.equal(p.counts.product_assignments_removed, 3);
          assert.equal(p.can_apply, true);
          assert.deepEqual(await sql('SELECT count(*) AS count FROM audit_logs'), before);
          assert.equal(await models.category.count(), 5);
        },
      );
      await t.test(
        'stale preview refuses writes and unknown cascading dependencies block deletion',
        async () => {
          const p = await preview(28);
          await category(29, 28);
          assert.equal(
            (await del(28, '?expected_fingerprint=' + p.fingerprint)).status,
            409,
          );
          await sequelize.query(
            'CREATE TABLE unexpected_category_refs(id int PRIMARY KEY, category_id bigint REFERENCES categories(id) ON DELETE CASCADE); INSERT INTO unexpected_category_refs VALUES(1,28)',
          );
          assert.equal((await preview(28)).blockers[0].referenced_rows, 1);
          assert.equal((await del(28)).status, 409);
          assert.ok(await models.product.findByPk(13));
          await sequelize.query('DROP TABLE unexpected_category_refs');
        },
      );
      await t.test(
        'locked product or category fails promptly with 409 instead of deadlocking',
        async () => {
          for (const table of ['products', 'categories']) {
            const tx = await sequelize.transaction();
            try {
              await sequelize.query(
                `SELECT id FROM ${table} WHERE id=${table === 'products' ? 13 : 28} FOR UPDATE`,
                { transaction: tx },
              );
              assert.equal((await del(28)).status, 409);
              assert.ok(await models.category.findByPk(28));
            } finally {
              await tx.rollback();
            }
          }
        },
      );
      await t.test(
        'failure after product/link changes rolls back data and audit entries together',
        async () => {
          await sequelize.query(
            "CREATE FUNCTION fail_category_delete_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced deletion failure'; END $$; CREATE TRIGGER fail_category_delete_test BEFORE DELETE ON categories FOR EACH ROW WHEN (OLD.id=36) EXECUTE FUNCTION fail_category_delete_test()",
          );
          const before = await sql('SELECT count(*) AS count FROM audit_logs');
          try {
            assert.equal((await del(36)).status, 500);
            assert.equal(await models.category.count(), 6);
            assert.ok(await models.product.findByPk(10));
            assert.equal(
              await models.productCategory.count({ where: { product_id: 10 } }),
              3,
            );
            assert.equal((await models.productVariant.findByPk(101)).is_active, true);
            assert.deepEqual(
              await sql('SELECT count(*) AS count FROM audit_logs'),
              before,
            );
          } finally {
            await sequelize.query(
              'DROP TRIGGER fail_category_delete_test ON categories; DROP FUNCTION fail_category_delete_test()',
            );
          }
        },
      );
      await t.test(
        'successful recursive deletion soft-deletes all linked products and preserves stock, orders, images and outside links',
        async () => {
          const customer = await models.customer.create({ firstName: 'History' });
          await sequelize.query(
            "INSERT INTO orders(id,customer_id,request_key,fingerprint,amount_paise,payload) VALUES('HISTORY',:id,'history','history',100,'{\"products\":[10]}'); INSERT INTO order_details(order_id,product_id,independent_product_id,quantity,unit_price_paise,snapshot) VALUES('HISTORY','product:10',10,1,100,'{\"name\":\"Product 10\"}')",
            { replacements: { id: customer.id } },
          );
          await sequelize.query(
            "INSERT INTO vendors(id,vendor_code,name) VALUES(1,'TEST','Test'); INSERT INTO vendor_products(id,vendor_id,variant_id,selling_price) VALUES(1,1,101,75); INSERT INTO inventory(product_id,warehouse_code,quantity_on_hand,quantity_reserved) VALUES(10,'DIRECT',20,2); INSERT INTO inventory(vendor_product_id,warehouse_code,quantity_on_hand,quantity_reserved) VALUES(1,'LEGACY',8,1)",
          );
          const before = {};
          for (const table of [
            'products',
            'product_variants',
            'orders',
            'order_details',
            'inventory',
            'stock_movements',
            'product_images',
          ])
            before[table] = await sql(`SELECT * FROM ${table} ORDER BY 1`);
          const plan = await preview(36);
          assert.equal(plan.preserved_inventory.length, 2);
          assert.equal(plan.preserved_order_references.length, 1);
          const result = await del(
            36,
            '?response=summary&expected_fingerprint=' + plan.fingerprint,
          );
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.data.products_soft_deleted, 2);
          assert.deepEqual(result.body.data.deleted_category_ids, ['38', '37', '36']);
          assert.equal(result.body.data.deleted_by, admin.id);
          assert.equal(await models.product.findByPk(10), null);
          assert.equal(await models.product.findByPk(11), null);
          assert.ok(await models.product.findByPk(12));
          assert.ok(await models.category.findByPk(41));
          assert.ok(await models.category.findByPk(28));
          const remaining = await models.productCategory.findAll({
            where: { product_id: 10 },
          });
          assert.equal(remaining.length, 1);
          assert.equal(remaining[0].category_id, '41');
          assert.equal(remaining[0].is_primary, true);
          assert.equal(await models.productVariant.findByPk(101), null);
          for (const table of [
            'orders',
            'order_details',
            'inventory',
            'stock_movements',
            'product_images',
          ])
            assert.deepEqual(
              await sql(`SELECT * FROM ${table} ORDER BY 1`),
              before[table],
              table + ' unchanged',
            );
          const afterProducts = await sql('SELECT * FROM products ORDER BY 1');
          for (const row of afterProducts) {
            const original = before.products.find((p) => p.id === row.id);
            for (const key of Object.keys(original).filter(
              (k) =>
                !['deleted_at', 'product_status', 'updated_at', 'updated_by'].includes(k),
            ))
              assert.deepEqual(row[key], original[key], key);
          }
          const afterVariants = await sql('SELECT * FROM product_variants ORDER BY 1');
          for (const row of afterVariants) {
            const original = before.product_variants.find((v) => v.id === row.id);
            for (const key of Object.keys(original).filter(
              (k) => !['deleted_at', 'is_active', 'updated_at'].includes(k),
            ))
              assert.deepEqual(row[key], original[key], 'variant.' + key);
          }
          const cached = await sql(
            "SELECT * FROM product_catalog WHERE id='variant:101'",
          );
          assert.equal(cached[0].active, false);
          assert.deepEqual(cached[0].data.category_ids, ['41']);
          assert.equal(cached[0].data.categoryId, '41');
          const audits = await sql(
            "SELECT * FROM audit_logs WHERE action='CATEGORY_DELETED' AND entity_id IN ('36','37','38')",
          );
          assert.equal(audits.length, 3);
          assert.ok(audits.every((a) => a.changed_by === admin.id));
          assert.equal(
            (
              await sql(
                "SELECT * FROM audit_logs WHERE entity_type='product_category' AND entity_id='10' AND action='primary_category_changed'",
              )
            ).length,
            1,
          );
          assert.equal((await del(36)).status, 404);
        },
      );
      await t.test(
        'new assignments to deleted category fail atomically and deleting another tree leaves unrelated product active',
        async () => {
          await assert.rejects(
            sequelize.transaction((tx) => assignProductCategories(12, [41, 37], 41, tx)),
            /not found/,
          );
          assert.equal((await del(28)).status, 204);
          assert.equal(await models.product.findByPk(13), null);
          assert.ok(await models.product.findByPk(12));
          assert.ok(await models.category.findByPk(41));
        },
      );
      await t.test(
        'unmapped catalog JSON dependencies block deletion, including numeric category IDs',
        async () => {
          await category(60);
          await sequelize.query(
            `INSERT INTO product_catalog(id,data,active) VALUES('external:60','{"category_ids":[60]}',true)`,
          );
          assert.equal((await preview(60)).blockers[0].catalog_id, 'external:60');
          assert.equal((await del(60)).status, 409);
          assert.ok(await models.category.findByPk(60));
          await sequelize.query("DELETE FROM product_catalog WHERE id='external:60'");
        },
      );
      await t.test(
        'inactive stale caches allow empty-tree deletion without deleting unassigned products, and roll back atomically',
        async () => {
          await category(70);
          await category(71, 70);
          await sequelize.query(`INSERT INTO product_catalog(id,data,active) VALUES
          ('product:12','{"source_product_id":"12","categoryId":"71","category_ids":["70","71","41"],"price":75,"stock_quantity":20}',false),
          ('variant:99999','{"source_product_id":"99999","categoryId":70,"category_ids":[70,41],"sku":"ORPHAN","price":42}',false)`);
          const beforeProduct = await sql('SELECT * FROM products WHERE id=12');
          const beforeCaches = await sql(
            "SELECT * FROM product_catalog WHERE id IN ('product:12','variant:99999') ORDER BY id",
          );
          const plan = await preview(70);
          assert.equal(plan.can_apply, true);
          assert.deepEqual(plan.blockers, []);
          assert.equal(plan.products_to_soft_delete.length, 0);
          assert.equal(plan.stale_catalog_projections_to_clean.length, 2);
          const tx = await sequelize.transaction();
          try {
            await sequelize.query(
              "SELECT id FROM product_catalog WHERE id='product:12' FOR UPDATE",
              { transaction: tx },
            );
            assert.equal((await del(70)).status, 409);
          } finally {
            await tx.rollback();
          }
          await sequelize.query(
            "CREATE FUNCTION fail_stale_cache_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$; CREATE TRIGGER fail_stale_cache_test BEFORE DELETE ON categories FOR EACH ROW WHEN (OLD.id=70) EXECUTE FUNCTION fail_stale_cache_test()",
          );
          const beforeAudit = await sql('SELECT count(*) AS count FROM audit_logs');
          try {
            assert.equal((await del(70)).status, 500);
            assert.deepEqual(
              await sql(
                "SELECT * FROM product_catalog WHERE id IN ('product:12','variant:99999') ORDER BY id",
              ),
              beforeCaches,
            );
            assert.deepEqual(
              await sql('SELECT count(*) AS count FROM audit_logs'),
              beforeAudit,
            );
            assert.ok(await models.category.findByPk(71));
          } finally {
            await sequelize.query(
              'DROP TRIGGER fail_stale_cache_test ON categories; DROP FUNCTION fail_stale_cache_test()',
            );
          }
          const result = await del(
            70,
            '?response=summary&expected_fingerprint=' + plan.fingerprint,
          );
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.data.products_soft_deleted, 0);
          assert.equal(result.body.data.stale_catalog_projections_cleaned, 2);
          assert.deepEqual(
            await sql('SELECT * FROM products WHERE id=12'),
            beforeProduct,
          );
          const after = await sql(
            "SELECT * FROM product_catalog WHERE id IN ('product:12','variant:99999') ORDER BY id",
          );
          assert.equal(after[0].active, false);
          assert.equal(after[0].data.price, 75);
          assert.equal(after[0].data.stock_quantity, 20);
          assert.deepEqual(after[0].data.category_ids, ['41']);
          assert.equal(after[0].data.categoryId, '41');
          assert.deepEqual(after[1].data.category_ids, [41]);
          assert.equal(after[1].data.categoryId, 41);
          assert.equal(after[1].data.price, 42);
          assert.equal(after[1].data.sku, 'ORPHAN');
          assert.equal(await models.category.findByPk(70), null);
          assert.equal(await models.category.findByPk(71), null);
          const audit = await sql(
            "SELECT * FROM audit_logs WHERE entity_type='product_catalog' AND action='category_reference_removed' ORDER BY entity_id",
          );
          assert.equal(audit.length, 2);
          assert.ok(audit.every((row) => row.changed_by === admin.id));
        },
      );
      await t.test(
        'already soft-deleted rows keep deletion timestamps and are made unsellable without altering stock',
        async () => {
          await product(60);
          await link(60, 60);
          await models.productVariant.create({
            id: 160,
            product_id: 60,
            sku: 'VAR-60',
            attributes: { Size: 'XL' },
            stock_quantity: 9,
          });
          await sequelize.query(
            "UPDATE products SET deleted_at='2020-01-01',product_status='active' WHERE id=60; UPDATE product_variants SET deleted_at='2020-01-01',is_active=true WHERE id=160",
          );
          const before = await sql(
            'SELECT deleted_at,stock_quantity FROM products WHERE id=60',
          );
          const plan = await preview(60);
          assert.equal(plan.counts.products_soft_deleted, 0);
          assert.equal(plan.counts.variants_soft_deleted, 0);
          assert.equal((await del(60)).status, 204);
          assert.deepEqual(
            await sql('SELECT deleted_at,stock_quantity FROM products WHERE id=60'),
            before,
          );
          assert.equal(
            (await sql('SELECT product_status FROM products WHERE id=60'))[0]
              .product_status,
            'archived',
          );
          const [variant] = await sql(
            'SELECT deleted_at,is_active,stock_quantity FROM product_variants WHERE id=160',
          );
          assert.equal(variant.is_active, false);
          assert.equal(variant.stock_quantity, 9);
          assert.equal(variant.deleted_at.toISOString(), '2020-01-01T00:00:00.000Z');
        },
      );
      await t.test(
        'schema prerequisite fails closed without any category or product writes',
        async () => {
          await category(50);
          await sequelize.query(
            'ALTER TABLE categories DISABLE TRIGGER catalog_category_delete_audit',
          );
          try {
            assert.equal((await previewCategoryDeletion([50])).can_apply, false);
            assert.equal((await del(50)).status, 503);
            assert.ok(await models.category.findByPk(50));
          } finally {
            await sequelize.query(
              'ALTER TABLE categories ENABLE TRIGGER catalog_category_delete_audit',
            );
          }
        },
      );
    } finally {
      s3.send = originalSend;
      await sequelize.close();
    }
  },
);
