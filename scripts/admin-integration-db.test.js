import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';

// Opt in only against a disposable DB and an isolated on-disk image provider.
test(
  'admin integration: all 43 details, warehouses, real local image CRUD and order reporting',
  {
    skip: process.env.RUN_ADMIN_INTEGRATION_DB_TESTS !== 'true',
  },
  async () => {
    assert.match(process.env.DB_NAME, /^codex_admin_integration_test/);
    process.env.IMAGE_STORAGE_MODE = 'local';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-local-images-'));
    process.env.IMAGE_LOCAL_DIRECTORY = directory;
    process.env.IMAGE_LOCAL_BASE_URL = 'http://localhost:3000/uploads';
    const { app } = await import('../src/app.js');
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { ProductImageCleanup } =
      await import('../src/models/catalog-reliability.model.js');
    const { processImageCleanup } = await import('../src/shared/image-storage.js');
    const { png, jpeg } = await import('../test-support/image-fixtures.js');
    const { env } = await import('../src/config/env.js');
    const { additionalProductFields } = await import('../src/shared/product-details.js');
    const agent = request.agent(app);
    const json = (method, url, body = {}) =>
      agent[method](`/api/admin${url}`).set('Origin', env.ALLOWED_ORIGINS[0]).send(body);
    const upload = (method, url, bytes = png, type = 'image/png') =>
      agent[method](`/api/admin${url}`)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .attach('uploadimage', bytes, { filename: 'image', contentType: type });
    const due = () =>
      ProductImageCleanup.update({ not_before: new Date(0) }, { where: {} });
    try {
      await sequelize.query('DROP TABLE IF EXISTS orders CASCADE');
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
        '037-recursive-category-deletion-audit.sql',
      ])
        await sequelize.query(
          await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
        );
      // Re-applying is safe and preserves data.
      await sequelize.query(
        await readFile(
          new URL('../sql/035-admin-integration-gaps.sql', import.meta.url),
          'utf8',
        ),
      );
      await sequelize.query(
        'TRUNCATE products, categories, brands, product_catalog, product_variant_attributes, product_image_cleanup, admin_catalog_requests, warehouses, users RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Integration',
        email: 'integration@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      for (const url of ['/orders', '/warehouses', '/image-storage'])
        assert.equal((await request(app).get(`/api/admin${url}`)).status, 401);
      assert.equal(
        (
          await json('post', '/auth/login', {
            email: 'integration@example.invalid',
            password: 'test-password',
          })
        ).status,
        200,
      );
      assert.deepEqual((await agent.get('/api/admin/image-storage')).body.data, {
        mode: 'local',
        isolated: true,
        bucket: null,
      });
      const details = {
        manufacturer_sku: 'M-123',
        brand_type: 'company',
        is_customisable: true,
        model_number: 'V2',
        manufacturer_contact_name: 'Contact',
        manufacturer_phone: '9876543210',
        manufacturer_email: 'contact@example.invalid',
        license_number: 'L-123',
        repacker_name: 'Repacker',
        repacker_address: 'Address',
        age_min: 0,
        age_max: 12,
        age_unit: 'months',
        audience_age_group: 'infants',
        product_uses: 'Use',
        special_instructions: 'Instructions',
        material_composition: 'Cotton',
        material_type: 'Textile',
        resistance_level: 'High',
        heat_resistant: false,
        gas_resistant: false,
        physical_state: 'solid',
        pattern: 'Plain',
        reusable: true,
        hazard_classification: 'None',
        net_weight: 0.25,
        net_weight_unit: 'kg',
        product_length: 1.25,
        product_breadth: 2.5,
        product_height: 3,
        product_dimension_unit: 'cm',
        manufacturing_date: '2026-01-01',
        fulfillment_channel: 'merabetta',
        seller_handling_days: 0,
        business_offer_percent: 15.25,
        sale_start_date: '2026-10-01',
        sale_end_date: '2026-10-31',
        shipping_template: 'standard',
        seller_pincodes: ['110001', '560001'],
        accessories: 'Case',
        battery_required: false,
        battery_consumption: 'None',
        cosmetic_features: 'Blue',
      };
      assert.equal(Object.keys(details).length, 43);
      assert.deepEqual(
        Object.keys(details).sort(),
        Object.keys(additionalProductFields).sort(),
      );
      const product = await json('post', '/products', {
        product_name: 'Integration draft',
        slug: 'integration-draft',
        ...details,
      });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const id = product.body.data.product_id;
      const checkDetails = (data) => {
        for (const [key, value] of Object.entries(details)) {
          if (typeof value === 'number') assert.equal(Number(data[key]), value, key);
          else assert.deepEqual(data[key], value, key);
        }
      };
      details.manufacturer_sku = 'M-456';
      const patchedDetails = await json('patch', `/products/${id}`, details);
      assert.equal(patchedDetails.status, 200, JSON.stringify(patchedDetails.body));
      checkDetails(patchedDetails.body.data);
      checkDetails((await agent.get(`/api/admin/products/${id}`)).body.data);
      checkDetails((await agent.get('/api/admin/products')).body.data[0]);
      const [catalog] = await sequelize.query(
        'SELECT data FROM product_catalog WHERE id=:id',
        { replacements: { id: `product:${id}` } },
      );
      checkDetails(catalog[0].data);
      assert.equal((await json('patch', `/products/${id}`, { age_max: -1 })).status, 422);
      assert.equal((await json('patch', `/products/${id}`, { age_min: 20 })).status, 422);
      assert.equal(
        (await json('patch', `/products/${id}`, { age_unit: null })).status,
        422,
      );
      assert.equal(
        (await json('patch', `/products/${id}`, { manufacturing_date: '2026-02-30' }))
          .status,
        422,
      );
      assert.equal(
        (await json('patch', `/products/${id}`, { sale_end_date: '2026-09-30' })).status,
        422,
      );
      assert.equal(
        (await json('patch', `/products/${id}`, { seller_pincodes: ['000000'] })).status,
        422,
      );
      assert.equal(
        (
          await json('patch', `/products/${id}`, {
            manufacturer_sku: null,
            age_min: null,
            age_max: null,
            age_unit: null,
          })
        ).status,
        200,
      );
      assert.equal(
        (await agent.get(`/api/admin/products/${id}`)).body.data.manufacturer_sku,
        null,
      );
      // Exercise all file endpoints with real PNG/JPEG bytes, no S3 mocks.
      for (const [resource, body, idKey] of [
        ['categories', { category_name: 'Test', slug: 'test' }, 'category_id'],
        ['brands', { brand_name: 'Test', slug: 'test' }, 'brand_id'],
      ]) {
        const created = await json('post', `/${resource}`, body);
        assert.equal(created.status, 201);
        const base = `/${resource}/${created.body.data[idKey]}`;
        assert.equal(
          (await upload('put', `${base}/image`, Buffer.from('fake'))).status,
          400,
        );
        assert.equal(
          (
            await agent
              .put(`/api/admin${base}/image`)
              .set('Origin', 'https://untrusted.invalid')
              .attach('uploadimage', png, 'x.png')
          ).status,
          403,
        );
        const first = await upload('post', `${base}/image`);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        const firstPath = new URL(first.body.data.image_url).pathname;
        const served = await agent.get(firstPath);
        assert.equal(served.status, 200);
        assert.deepEqual(served.body, png);
        const replacement = await upload('put', `${base}/image`, jpeg, 'image/jpeg');
        assert.equal(replacement.status, 200);
        assert.notEqual(replacement.body.data.image_url, first.body.data.image_url);
        assert.equal((await agent.get(firstPath)).status, 404);
        assert.equal((await json('delete', `${base}/image`)).status, 204);
        assert.equal(
          (await agent.get(new URL(replacement.body.data.image_url).pathname)).status,
          404,
        );
        assert.equal((await json('delete', base)).status, 204);
      }
      const imagePath = `/products/${id}/images`;
      const first = await agent
        .post(`/api/admin${imagePath}`)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .set('Idempotency-Key', 'integration-image-1')
        .attach('uploadimage', png, 'test.png');
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const replay = await agent
        .post(`/api/admin${imagePath}`)
        .set('Origin', env.ALLOWED_ORIGINS[0])
        .set('Idempotency-Key', 'integration-image-1')
        .attach('uploadimage', png, 'test.png');
      assert.equal(replay.headers['idempotency-replayed'], 'true');
      assert.deepEqual(replay.body, first.body);
      const imageId = first.body.data[0].id;
      const replaced = await upload('put', `${imagePath}/${imageId}`, jpeg, 'image/jpeg');
      assert.equal(replaced.status, 200);
      assert.equal(
        (await agent.get(new URL(first.body.data[0].image_url).pathname)).status,
        404,
      );
      const replacementPath = new URL(replaced.body.data.image_url).pathname;
      assert.equal((await agent.get(replacementPath)).status, 200);
      assert.equal((await json('delete', `${imagePath}/${imageId}`)).status, 204);
      assert.equal((await agent.get(replacementPath)).status, 404);
      assert.equal((await agent.get(`/api/admin${imagePath}`)).body.data.length, 0);
      assert.equal(await models.productImage.findByPk(imageId), null);
      const reuploaded = await upload('post', imagePath);
      assert.equal(reuploaded.status, 201, JSON.stringify(reuploaded.body));
      assert.notEqual(reuploaded.body.data[0].image_url, first.body.data[0].image_url);
      assert.equal(
        (await json('delete', `${imagePath}/${reuploaded.body.data[0].id}`)).status,
        204,
      );
      // A local worker must never consume another storage provider's journal.
      await ProductImageCleanup.create({
        s3_key: 'upload/999a.png',
        storage_scope: 's3:prod-merabetta',
      });
      await due();
      await processImageCleanup();
      assert.ok(await ProductImageCleanup.findByPk('upload/999a.png'));
      const warehouse = {
        warehouseName: 'Integration warehouse',
        formattedAddress: '12 Example Road',
        city: 'Delhi',
        state: 'Delhi',
        pincode: '110001',
        contactName: 'Test Contact',
        contactPhone: '9876543210',
        contactEmail: 'warehouse@example.invalid',
        gstin: '07ABCDE1234F1Z5',
        carrierReady: false,
      };
      assert.equal(
        (await json('post', '/warehouses', { ...warehouse, contactPhone: 'bad' })).status,
        422,
      );
      const created = await json('post', '/warehouses', warehouse);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const whId = created.body.data.id;
      assert.equal(
        (await agent.get(`/api/admin/warehouses/${whId}`)).body.data.warehouseName,
        warehouse.warehouseName,
      );
      assert.equal(
        (await agent.get('/api/admin/warehouses?search=Integration&active=true&limit=1'))
          .body.pagination.total,
        1,
      );
      assert.equal(
        (await json('patch', `/warehouses/${whId}`, { active: false })).status,
        200,
      );
      assert.equal(
        (await agent.get('/api/admin/warehouses?active=true')).body.pagination.total,
        0,
      );
      assert.equal((await json('delete', `/warehouses/${whId}`)).status, 204);
      assert.equal((await agent.get(`/api/admin/warehouses/${whId}`)).status, 404);
      // Minimal reporting fixture using the current deployed orders contract.
      await sequelize.query('DROP TABLE IF EXISTS orders CASCADE');
      await sequelize.query(
        'CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, customer_id uuid, order_number text, amount_paise bigint, payment_status text, payload jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())',
      );
      await sequelize.query(
        "INSERT INTO orders(id,order_number,amount_paise,payment_status,payload) VALUES ('integration-order','MB26102800001',25000,'COD',CAST(:payload AS jsonb)) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        {
          replacements: {
            payload: JSON.stringify({
              status: 'CONFIRMED',
              orderedBy: { name: 'Integration Customer', phone: '9876543210' },
              items: [],
            }),
          },
        },
      );
      const orders = await agent.get('/api/admin/orders?search=Integration');
      assert.equal(orders.status, 200, JSON.stringify(orders.body));
      assert.equal(orders.body.pagination.total, 1);
      assert.equal(orders.body.data[0].bookingNumber, 'MB26102800001');
      assert.equal((await agent.get('/api/admin/orders/MB26102800001')).status, 200);
      assert.equal((await agent.get('/api/admin/orders/export')).type, 'text/csv');
      assert.equal((await agent.get('/api/admin/orders/MB26102899999')).status, 404);
      assert.equal((await json('delete', `/products/${id}`)).status, 204);
    } finally {
      await sequelize.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
