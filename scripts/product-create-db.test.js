import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';

// This suite mutates fixtures only in a dedicated, explicitly named test DB.
test(
  'authenticated product creation: screenshot payload, boundaries, duplicates, atomicity and retries',
  {
    skip: process.env.RUN_PRODUCT_CREATE_DB_TESTS !== 'true',
  },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_product_create_test/);
    const { app } = await import('../src/app.js');
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { AdminCatalogRequest } =
      await import('../src/models/catalog-reliability.model.js');
    const { s3 } = await import('../src/shared/image_upload.js');
    const { env } = await import('../src/config/env.js');
    const originalSend = s3.send;
    s3.send = async () => {
      throw Error('Product metadata must not call S3');
    };
    const origin = env.ALLOWED_ORIGINS[0];
    const agent = request.agent(app);
    const post = (body, key) => {
      const call = agent.post('/api/admin/products').set('Origin', origin);
      if (key) call.set('Idempotency-Key', key);
      return call.send(body);
    };
    const patch = (id, body) =>
      agent.patch(`/api/admin/products/${id}`).set('Origin', origin).send(body);
    const minimal = (slug) => ({
      product_name: 'Test Wheelchair',
      slug,
      regular_price: 100,
      sale_price: 80,
    });
    let id, category, child, brand;
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
        '036-independent-products-audit.sql',
        '036-product-soft-delete.sql',
        '038-variant-image-galleries.sql',
      ])
        await sequelize.query(
          await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
        );
      await sequelize.query(
        'TRUNCATE products,categories,brands,product_catalog,product_variant_attributes,product_image_cleanup,admin_catalog_requests,users RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Product Test',
        email: 'product-create@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      assert.equal(
        (
          await agent
            .post('/api/admin/auth/login')
            .set('Origin', origin)
            .send({ email: 'product-create@example.invalid', password: 'test-password' })
        ).status,
        200,
      );
      category = await models.category.create({
        category_name: 'Mobility',
        slug: 'mobility',
      });
      child = await models.category.create({
        category_name: 'Wheelchairs',
        slug: 'wheelchairs',
        parent_category_id: category.category_id,
      });
      brand = await models.brand.create({ brand_name: 'Brand', slug: 'brand' });
      const categoryIds = [Number(category.category_id), Number(child.category_id)];
      await t.test(
        'authentication, Origin, media type, strict fields and malformed JSON remain enforced',
        async () => {
          assert.equal(
            (
              await request(app)
                .post('/api/admin/products')
                .set('Origin', origin)
                .send(minimal('anonymous'))
            ).status,
            401,
          );
          assert.equal(
            (await agent.post('/api/admin/products').send(minimal('missing-origin')))
              .status,
            403,
          );
          assert.equal(
            (
              await agent
                .post('/api/admin/products')
                .set('Origin', origin)
                .type('text')
                .send('test')
            ).status,
            415,
          );
          assert.equal((await post({})).status, 422);
          assert.equal(
            (await post({ ...minimal('unknown-field'), unexpected: true })).status,
            422,
          );
          assert.equal(
            (
              await agent
                .post('/api/admin/products')
                .set('Origin', origin)
                .type('json')
                .send('{broken')
            ).status,
            400,
          );
        },
      );
      await t.test(
        'the screenshot payload persists all data, categories and catalog together, with a Location header',
        async () => {
          const response = await post({
            ...minimal('postman-wheelchair'),
            product_status: 'active',
            product_type: 'simple',
            product_code: 'PM-WC-02',
            sku: 'PM-WC-SKU-02',
            regular_price: 5000,
            sale_price: 4500,
            stock_quantity: 25,
            min_order_quantity: 1,
            target_audience: 'Elderly',
            hsn_code: '87131010',
            gst_rate: 5,
            weight: 12.5,
            weight_unit: 'kg',
            unit_count: 1,
            package_length: 90,
            package_breadth: 65,
            package_height: 85,
            dimension_unit: 'cm',
            material: 'Stainless Steel',
            colour: 'Black',
            package_type: 'Box',
            shelf_life: '5 Years',
            water_resistant: true,
            hazardous_clause: 'None',
            manufactured_in: 'India',
            company_name: 'Arrex Rollers Pvt Ltd',
            company_address: 'MIDC Industrial Area, Pune',
            packer_name: 'Arrex Rollers Pvt Ltd',
            packer_address: 'MIDC Industrial Area, Pune',
            keywords: ['wheelchair', 'folding wheelchair', 'elderly mobility'],
            brand_id: Number(brand.brand_id),
            category_ids: [...categoryIds, categoryIds[1]],
            primary_category_id: categoryIds[1],
          });
          assert.equal(response.status, 201, JSON.stringify(response.body));
          id = response.body.data.product_id;
          assert.equal(response.headers.location, `/api/admin/products/${id}`);
          assert.equal(response.body.data.effective_price, 4500);
          assert.equal(Number(response.body.data.weight), 12.5);
          assert.equal(response.body.data.stock_quantity, 25);
          const detail = await agent.get(response.headers.location);
          assert.equal(detail.status, 200);
          assert.equal(detail.body.data.categories.length, 2);
          assert.equal(detail.body.data.brand.brand_name, 'Brand');
          const links = await models.productCategory.findAll({
            where: { product_id: id },
          });
          assert.equal(links.length, 2);
          assert.equal(
            String(links.find((link) => link.is_primary).category_id),
            String(child.category_id),
          );
          const catalog = await models.productCatalog.findByPk(`product:${id}`);
          assert.equal(catalog.active, true);
          assert.equal(catalog.data.price, 4500);
          assert.equal(catalog.data.categoryId, String(child.category_id));
          assert.deepEqual(catalog.data.images, []);
        },
      );
      await t.test(
        'PostgreSQL numeric overflow and precision loss are rejected before writing',
        async () => {
          const count = await models.product.count();
          const invalid = [
            { stock_quantity: 2147483648 },
            { min_order_quantity: 2147483648 },
            { max_order_quantity: 2147483648 },
            { unit_count: 2147483648 },
            { age_min: 2147483648, age_unit: 'years' },
            { seller_handling_days: 2147483648 },
            { weight: 1000000000 },
            { package_length: 1000000000 },
            { product_length: 1000000000000, product_dimension_unit: 'cm' },
            { net_weight: 1000000000000, net_weight_unit: 'g' },
            { weight: 1.0001 },
            { package_breadth: 3.0001 },
          ];
          for (const [index, body] of invalid.entries()) {
            const response = await post({
              ...minimal(`invalid-number-${index}`),
              ...body,
            });
            assert.equal(
              response.status,
              422,
              JSON.stringify({ body, response: response.body }),
            );
            assert.ok(response.body.details.length);
          }
          assert.equal(await models.product.count(), count);
          assert.equal(
            (
              await post({
                ...minimal('numeric-boundary'),
                stock_quantity: 2147483647,
                weight: 999999999.999,
              })
            ).status,
            201,
          );
        },
      );
      await t.test(
        'relationship and contradictory pricing errors are actionable and leave no partial rows',
        async () => {
          const count = await models.product.count();
          for (const [body, status] of [
            [{ brand_id: 999999 }, 400],
            [{ category_ids: [999999] }, 400],
            [
              { category_ids: [categoryIds[0]], primary_category_id: categoryIds[1] },
              422,
            ],
            [{ min_order_quantity: 5, max_order_quantity: 2 }, 400],
            [{ offer_percent: 10, sale_price: 50 }, 400],
          ]) {
            const response = await post({ ...minimal('invalid-relationship'), ...body });
            assert.equal(response.status, status, JSON.stringify(response.body));
          }
          assert.equal(await models.product.count(), count);
          const free = await post({
            ...minimal('free-offer'),
            sale_price: 0,
            offer_percent: 100,
          });
          assert.equal(free.status, 201);
          assert.equal(free.body.data.effective_price, 0);
          assert.equal((await patch(id, { offer_percent: 10 })).status, 200);
          const conflict = await patch(id, { sale_price: 4000 });
          assert.equal(conflict.status, 400);
          assert.match(conflict.body.error, /clear offer_percent/);
          assert.equal(
            (await patch(id, { offer_percent: null, sale_price: 4000 })).status,
            200,
          );
        },
      );
      await t.test(
        'duplicate slug, SKU and product code report the exact conflicting field',
        async () => {
          for (const [field, value] of [
            ['slug', 'postman-wheelchair'],
            ['sku', 'PM-WC-SKU-02'],
            ['product_code', 'PM-WC-02'],
          ]) {
            const response = await post({
              ...minimal(`duplicate-${field.replaceAll('_', '-')}`),
              [field]: value,
            });
            assert.equal(response.status, 409, JSON.stringify(response.body));
            assert.ok(response.body.details.some((detail) => detail.path === field));
            assert.ok(!JSON.stringify(response.body).includes('SELECT'));
          }
        },
      );
      await t.test(
        'concurrent retries create one product; publication failure rolls back product, links and replay record',
        async () => {
          const body = {
            ...minimal('concurrent-product'),
            category_ids: categoryIds,
            primary_category_id: categoryIds[1],
          };
          const responses = await Promise.all([
            post(body, 'concurrent-create'),
            post(body, 'concurrent-create'),
          ]);
          assert.deepEqual(
            responses.map((response) => response.status),
            [201, 201],
          );
          assert.deepEqual(responses[0].body, responses[1].body);
          assert.equal(await models.product.count({ where: { slug: body.slug } }), 1);
          assert.ok(
            responses.some(
              (response) => response.headers['idempotency-replayed'] === 'true',
            ),
          );
          assert.equal(
            (await post({ ...body, product_name: 'Changed' }, 'concurrent-create'))
              .status,
            409,
          );
          const upsert = models.productCatalog.upsert;
          const before = {
            products: await models.product.count(),
            links: await models.productCategory.count(),
            catalog: await models.productCatalog.count(),
            requests: await AdminCatalogRequest.count(),
          };
          models.productCatalog.upsert = async () => {
            throw Error('Injected private database detail');
          };
          try {
            const failed = await post(
              { ...body, slug: 'rollback-product' },
              'retry-after-rollback',
            );
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'Internal server error');
          } finally {
            models.productCatalog.upsert = upsert;
          }
          assert.deepEqual(
            {
              products: await models.product.count(),
              links: await models.productCategory.count(),
              catalog: await models.productCatalog.count(),
              requests: await AdminCatalogRequest.count(),
            },
            before,
          );
          assert.equal(
            (await post({ ...body, slug: 'rollback-product' }, 'retry-after-rollback'))
              .status,
            201,
          );
        },
      );
      await t.test(
        'full product metadata accepts more than 16 KB, retains a 128 KB cap and leaves other JSON limits intact',
        async () => {
          const description = 'A'.repeat(32000);
          const response = await post({ ...minimal('large-metadata'), description });
          assert.equal(response.status, 201, JSON.stringify(response.body));
          assert.equal(response.body.data.description, description);
          assert.equal(
            (await post({ ...minimal('too-large'), description: 'A'.repeat(140000) }))
              .status,
            413,
          );
          assert.equal(await models.product.count({ where: { slug: 'too-large' } }), 0);
          assert.equal(
            (
              await agent
                .post('/api/admin/brands')
                .set('Origin', origin)
                .send({
                  brand_name: 'Large',
                  slug: 'large',
                  description: 'A'.repeat(20000),
                })
            ).status,
            413,
          );
        },
      );
    } finally {
      s3.send = originalSend;
      await sequelize.close();
    }
  },
);
