import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import {
  readCategorySnapshot,
  planCategoryReconciliation,
  applyCategoryReconciliation,
} from '../src/shared/category-reconciliation.js';

test(
  'category consolidation, duplicate prevention and APIs preserve identities, products and primary selections',
  { skip: process.env.RUN_CATEGORY_RECONCILIATION_DB_TESTS !== 'true' },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_category_reconciliation_test/);
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { s3 } = await import('../src/shared/image_upload.js');
    const { publishProductCatalog } = await import('../src/shared/catalog-publisher.js');
    const originalSend = s3.send;
    s3.send = async () => {
      throw Error('Category audit/reconciliation must not write to S3');
    };
    const proposal = { categoryMap: { 50: '2', 51: '1' } };
    const snapshot = () => readCategorySnapshot(sequelize);
    const apply = (plan, publish = publishProductCatalog) =>
      applyCategoryReconciliation({
        connection: sequelize,
        proposal,
        target: {},
        approvedPlanHash: plan.planHash,
        publish,
      });
    const agent = request.agent(app);
    const json = (method, route, body) =>
      agent[method](`/api/admin${route}`)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .send(body);
    const makeCategory = (
      category_id,
      category_name,
      parent_category_id = null,
      category_image = null,
    ) => ({
      category_id,
      category_name,
      parent_category_id,
      category_image,
      slug: `category-${category_id}`,
    });
    try {
      await models.customer.sync();
      await models.user.sync();
      await models.session.sync();
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
      ])
        await sequelize.query(
          await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
        );
      await sequelize.query(
        'TRUNCATE categories,products,brands,product_catalog,product_image_cleanup,admin_catalog_requests,users RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Category test',
        email: 'categories@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      assert.equal(
        (
          await json('post', '/auth/login', {
            email: 'categories@example.invalid',
            password: 'test-password',
          })
        ).status,
        200,
      );
      await models.category.bulkCreate([
        makeCategory(2, 'Daily Living', null, 'https://keep.example/canonical.png'),
        makeCategory(50, 'Daily Living ', null, 'https://keep.example/source.png'),
        makeCategory(1, 'Adult Diaper', 2),
        makeCategory(51, 'Adult Diaper', 50),
        makeCategory(52, 'Unique child', 50),
        makeCategory(36, 'Health & Beauty'),
        makeCategory(37, 'Healthcare Products', 36),
        makeCategory(38, 'Health & Personal Care'),
        makeCategory(39, 'Healthcare Products', 38),
        makeCategory(
          41,
          'Healthcare Products',
          null,
          'https://keep.example/healthcare.png',
        ),
      ]);
      await sequelize.query(
        "SELECT setval(pg_get_serial_sequence('categories','id'),(SELECT max(id) FROM categories),true)",
      );
      for (const n of [10, 11, 12, 13])
        await models.product.create({
          product_id: n,
          product_name: `Product ${n}`,
          slug: `product-${n}`,
          regular_price: 100,
          product_status: 'active',
        });
      await models.productCategory.bulkCreate([
        { product_id: 10, category_id: 50, is_primary: false },
        { product_id: 10, category_id: 51, is_primary: true },
        { product_id: 11, category_id: 1, is_primary: false },
        { product_id: 11, category_id: 51, is_primary: true },
        { product_id: 12, category_id: 37, is_primary: true },
        { product_id: 13, category_id: 2, is_primary: true },
        { product_id: 13, category_id: 51, is_primary: false },
      ]);
      await t.test(
        'API blocks normalized NULL-parent duplicates and allows same names under different parents',
        async () => {
          assert.equal(
            (
              await json('post', '/categories', {
                category_name: ' Ｄaily   Living ',
                slug: 'duplicate-root',
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await json('post', '/categories', {
                category_name: 'Adult  Diaper',
                slug: 'duplicate-child',
                parent_category_id: 2,
              })
            ).status,
            409,
          );
          const concurrent = await Promise.all([
            json('post', '/categories', {
              category_name: 'Shared',
              slug: 'shared-1',
              parent_category_id: 37,
            }),
            json('post', '/categories', {
              category_name: ' SHARED ',
              slug: 'shared-2',
              parent_category_id: 37,
            }),
          ]);
          assert.deepEqual(concurrent.map((result) => result.status).sort(), [201, 409]);
          assert.equal(
            (
              await json('post', '/categories', {
                category_name: 'Shared',
                slug: 'shared-other-parent',
                parent_category_id: 41,
              })
            ).status,
            201,
          );
          assert.equal(
            (await json('patch', '/categories/52', { parent_category_id: 52 })).status,
            400,
          );
          // Updating metadata on legacy duplicates remains possible without making new duplicates.
          assert.equal(
            (await json('patch', '/categories/50', { description: 'Preserve history' }))
              .status,
            200,
          );
        },
      );
      const before = await snapshot();
      const plan = planCategoryReconciliation(before, proposal);
      assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
      await t.test(
        'dry run is read-only; stale approval and publication failure cannot leave partial corrections',
        async () => {
          assert.deepEqual(await snapshot(), before);
          await assert.rejects(apply({ ...plan, planHash: '0'.repeat(64) }), /stale/);
          await assert.rejects(
            apply(plan, async () => {
              throw Error('Injected catalog failure');
            }),
            /Injected/,
          );
          assert.deepEqual(await snapshot(), before);
        },
      );
      await apply(plan);
      await t.test(
        'consolidation preserves rows/images and transfers each primary association without duplicates',
        async () => {
          const after = await snapshot();
          assert.equal(after.categories.length, before.categories.length);
          assert.equal((await models.category.findByPk(50)).is_active, false);
          assert.equal((await models.category.findByPk(51)).is_active, false);
          assert.equal((await models.category.findByPk(52)).parent_category_id, '2');
          assert.equal(
            (await models.category.findByPk(50)).category_image,
            'https://keep.example/source.png',
          );
          assert.equal(
            (await models.category.findByPk(2)).category_image,
            'https://keep.example/canonical.png',
          );
          assert.equal(
            await models.productCategory.count({ where: { category_id: [50, 51] } }),
            0,
          );
          assert.equal(
            (
              await models.productCategory.findOne({
                where: { product_id: 11, category_id: 1 },
              })
            ).is_primary,
            true,
          );
          assert.equal(
            (
              await models.productCategory.findOne({
                where: { product_id: 13, category_id: 2 },
              })
            ).is_primary,
            true,
          );
          assert.equal(
            (
              await models.productCategory.findOne({
                where: { product_id: 13, category_id: 1 },
              })
            ).is_primary,
            false,
          );
          assert.equal(
            (await models.productCatalog.findByPk('product:10')).data.categoryId,
            '1',
          );
          for (const categoryId of [37, 39, 41])
            assert.deepEqual(
              after.categories.find((row) => String(row.id) === String(categoryId)),
              before.categories.find((row) => String(row.id) === String(categoryId)),
            );
          const next = planCategoryReconciliation(after, proposal);
          assert.deepEqual(next.categoryChanges, []);
          assert.deepEqual(next.linkChanges, []);
          assert.deepEqual(next.imageChanges, []);
          await apply(next);
          assert.deepEqual(await snapshot(), after);
        },
      );
      await t.test(
        'root, direct-child, tree and product APIs expose valid hierarchy, image URLs and primary flags',
        async () => {
          const roots = await agent.get(
            '/api/admin/categories?roots_only=true&is_active=true&limit=100',
          );
          assert.equal(roots.status, 200);
          assert.equal(
            roots.body.data.filter(
              (row) => row.category_name.trim().toLowerCase() === 'daily living',
            ).length,
            1,
          );
          const children = await agent.get(
            '/api/admin/categories?parent_category_id=2&is_active=true',
          );
          assert.ok(children.body.data.every((row) => row.parent_category_id === '2'));
          const tree = await agent.get('/api/admin/categories/tree?is_active=true');
          const canonical = tree.body.data.find((row) => row.category_id === '2');
          assert.equal(canonical.image_url, 'https://keep.example/canonical.png');
          assert.equal(canonical.subcategories.length, 2);
          const product = await agent.get('/api/admin/products/10');
          assert.equal(product.status, 200);
          assert.equal(
            product.body.data.categories.find((row) => row.ProductCategory.is_primary)
              .category_id,
            '1',
          );
        },
      );
    } finally {
      s3.send = originalSend;
      await sequelize.close();
    }
  },
);
