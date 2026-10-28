import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { ProductImageCleanup } from '../src/models/catalog-reliability.model.js';
import { s3 } from '../src/shared/image_upload.js';
import {
  processImageCleanup,
  queueImageCleanup,
  reserveImage,
  stageImage,
} from '../src/shared/image-storage.js';
import { reconcileProductImages } from '../src/shared/product-image-reconciliation.js';
import { env } from '../src/config/env.js';
import { png } from '../test-support/image-fixtures.js';

// Explicitly opt in against an isolated DB. All S3 calls are replaced with an in-memory fake.
test(
  'authenticated catalog retries, failure recovery and reconciliation',
  {
    skip: process.env.RUN_CATALOG_RELIABILITY_DB_TESTS !== 'true',
  },
  async (t) => {
    assert.match(env.DB_NAME, /^codex_catalog_reliability_test/);
    const originalSend = s3.send;
    const objects = new Map();
    let deleteFailure = false;
    let headFailure = false;
    let truncatedListing = false;
    s3.send = async (command) => {
      const { Key, Body } = command.input;
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          assert.equal(command.input.IfNoneMatch, '*');
          assert.ok(!objects.has(Key), 'Never overwrite an existing object');
          objects.set(Key, Buffer.from(Body));
          return {};
        case 'DeleteObjectCommand':
          if (deleteFailure) throw new Error('Injected S3 outage');
          objects.delete(Key);
          return {};
        case 'HeadObjectCommand':
          if (headFailure)
            throw Object.assign(new Error('Forbidden'), {
              $metadata: { httpStatusCode: 403 },
            });
          if (!objects.has(Key))
            throw Object.assign(new Error('Missing'), { name: 'NotFound' });
          return {};
        case 'ListObjectsV2Command':
          return {
            Contents: [...objects.keys()].map((key) => ({
              Key: key,
              LastModified: new Date(0),
            })),
            IsTruncated: truncatedListing,
          };
        default:
          throw new Error(`Unexpected S3 call ${command.constructor.name}`);
      }
    };
    const origin = env.ALLOWED_ORIGINS[0];
    const agent = request.agent(app);
    const post = (path, body, key) => {
      const req = agent.post(`/api/admin${path}`).set('Origin', origin);
      if (key) req.set('Idempotency-Key', key);
      return req.send(body);
    };
    const jsonWrite = (method, path, body = {}) =>
      agent[method](`/api/admin${path}`).set('Origin', origin).send(body);
    const upload = (id, key, buffer = png) => {
      const req = agent.post(`/api/admin/products/${id}/images`).set('Origin', origin);
      if (key) req.set('Idempotency-Key', key);
      return req.attach('uploadimage', buffer, {
        filename: 'image.png',
        contentType: 'image/png',
      });
    };
    const replace = (id, imageId) =>
      agent
        .put(`/api/admin/products/${id}/images/${imageId}`)
        .set('Origin', origin)
        .attach('uploadimage', png, {
          filename: 'replacement.png',
          contentType: 'image/png',
        });
    const due = () =>
      ProductImageCleanup.update({ not_before: new Date(0) }, { where: {} });
    try {
      await models.customer.sync();
      await models.user.sync();
      await models.session.sync();
      for (let pass = 0; pass < 2; pass++) {
        for (const file of [
          '014-product-orders.sql',
          '023-admin-catalog-base.sql',
          '024-admin-catalog-details.sql',
          '025-admin-catalog-compatibility.sql',
          '026-product-schema-alignment.sql',
          '022-product-images.sql',
          '027-admin-catalog-reliability.sql',
        ])
          await sequelize.query(
            await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
          );
      }
      await sequelize.query(
        'TRUNCATE products, categories, brands, product_catalog, product_variant_attributes, product_image_cleanup, admin_catalog_requests, users RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Test Admin',
        email: 'catalog@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      assert.equal((await agent.get('/api/admin/auth/me')).status, 401);
      const login = await post('/auth/login', {
        email: 'catalog@example.invalid',
        password: 'test-password',
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.match(
        login.headers['set-cookie'][0],
        /admin_auth=.*Path=\/api\/admin;.*HttpOnly/,
      );
      assert.equal((await agent.get('/api/admin/auth/me')).status, 200);
      const body = {
        product_name: 'Recovery test',
        slug: 'recovery-test',
        regular_price: 100,
      };
      let id;
      await t.test(
        'product replay, concurrent retries, changed payload, actor scope and rolled back retry',
        async () => {
          const responses = await Promise.all([
            post('/products', body, 'product-1'),
            post('/products', body, 'product-1'),
          ]);
          assert.deepEqual(
            responses.map((r) => r.status),
            [201, 201],
          );
          assert.deepEqual(responses[0].body, responses[1].body);
          id = responses[0].body.data.product_id;
          assert.equal(await models.product.count(), 1);
          assert.ok(responses.some((r) => r.headers['idempotency-replayed'] === 'true'));
          assert.equal(
            (await post('/products', { ...body, slug: 'different' }, 'product-1')).status,
            409,
          );
          assert.equal((await post('/products', body, 'invalid key')).status, 400);
          const failBody = { product_name: 'Rollback', slug: 'rollback' };
          const upsert = models.productCatalog.upsert;
          models.productCatalog.upsert = async () => {
            throw new Error('Injected publication failure');
          };
          try {
            assert.equal((await post('/products', failBody, 'rollback')).status, 500);
          } finally {
            models.productCatalog.upsert = upsert;
          }
          assert.equal((await post('/products', failBody, 'rollback')).status, 201);
          // A second actor using the same key has an independent request namespace.
          await models.user.create({
            realm: 'admin',
            name: 'Other Admin',
            email: 'other@example.invalid',
            passwordHash: await bcrypt.hash('test-password', 4),
          });
          const other = request.agent(app);
          await other
            .post('/api/admin/auth/login')
            .set('Origin', origin)
            .send({ email: 'other@example.invalid', password: 'test-password' });
          const actorResponse = await other
            .post('/api/admin/products')
            .set('Origin', origin)
            .set('Idempotency-Key', 'product-1')
            .send({ ...body, slug: 'other-actor' });
          assert.equal(actorResponse.status, 201);
          assert.notEqual(actorResponse.body.data.product_id, id);
        },
      );
      let image;
      await t.test(
        'image upload replay hashes actual content and rejects forged MIME',
        async () => {
          const first = await upload(id, 'upload-1');
          assert.equal(first.status, 201, JSON.stringify(first.body));
          image = first.body.data[0];
          const repeat = await upload(id, 'upload-1');
          assert.equal(repeat.headers['idempotency-replayed'], 'true');
          assert.deepEqual(repeat.body, first.body);
          assert.equal(objects.size, 1);
          const different = Buffer.concat([png, Buffer.from('different')]);
          assert.equal((await upload(id, 'upload-1', different)).status, 409);
          assert.equal(
            (await upload(id, 'forged', Buffer.from('not an image'))).status,
            400,
          );
          assert.equal(await models.productImage.count({ where: { product_id: id } }), 1);
        },
      );
      await t.test(
        'failed replacement preserves old bytes and rows; crash journals clean staged objects',
        async () => {
          const upsert = models.productCatalog.upsert;
          models.productCatalog.upsert = async () => {
            throw new Error('Injected DB failure after S3 put');
          };
          try {
            assert.equal((await replace(id, image.id)).status, 500);
          } finally {
            models.productCatalog.upsert = upsert;
          }
          assert.equal(
            (await models.productImage.findByPk(image.id)).s3_key,
            image.s3_key,
          );
          assert.deepEqual(objects.get(image.s3_key), png);
          assert.equal(objects.size, 2);
          await due();
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.size, 1);
          assert.ok(objects.has(image.s3_key));
        },
      );
      await t.test(
        'replacement commits a new key; failed old-object cleanup retries without a broken image',
        async () => {
          deleteFailure = true;
          const result = await replace(id, image.id);
          assert.equal(result.status, 200);
          const next = result.body.data;
          assert.notEqual(next.s3_key, image.s3_key);
          assert.equal(next.id, image.id);
          assert.ok(objects.has(next.s3_key));
          await processImageCleanup({ limit: 100 });
          const job = await ProductImageCleanup.findByPk(image.s3_key);
          assert.equal(job.attempts, 1);
          assert.equal(objects.size, 2);
          deleteFailure = false;
          await due();
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.size, 1);
          image = next;
        },
      );
      await t.test(
        'deletion rollback preserves storage; committed deletion survives S3 outage',
        async () => {
          const upsert = models.productCatalog.upsert;
          models.productCatalog.upsert = async () => {
            throw new Error('Injected publication failure');
          };
          try {
            assert.equal(
              (await jsonWrite('delete', `/products/${id}/images/${image.id}`)).status,
              500,
            );
          } finally {
            models.productCatalog.upsert = upsert;
          }
          assert.ok(await models.productImage.findByPk(image.id));
          assert.ok(objects.has(image.s3_key));
          deleteFailure = true;
          assert.equal(
            (await jsonWrite('delete', `/products/${id}/images/${image.id}`)).status,
            204,
          );
          assert.equal(await models.productImage.findByPk(image.id), null);
          await processImageCleanup({ limit: 100 });
          assert.ok(objects.has(image.s3_key));
          deleteFailure = false;
          await due();
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.size, 0);
        },
      );
      await t.test(
        'failed multi-upload is atomic and leaves durable cleanup; referenced objects are protected',
        async () => {
          const create = models.productImage.create;
          let calls = 0;
          models.productImage.create = function (...args) {
            if (++calls === 2) throw new Error('Injected second image failure');
            return create.apply(this, args);
          };
          try {
            const result = await agent
              .post(`/api/admin/products/${id}/images`)
              .set('Origin', origin)
              .attach('uploadimage', png, 'a.png')
              .attach('uploadimage', png, 'b.png');
            assert.equal(result.status, 500);
          } finally {
            models.productImage.create = create;
          }
          assert.equal(await models.productImage.count(), 0);
          assert.equal(objects.size, 2);
          await due();
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.size, 0);
          image = (await upload(id, 'protected')).body.data[0];
          await queueImageCleanup(image.s3_key);
          await processImageCleanup({ limit: 100 });
          assert.ok(objects.has(image.s3_key));
          assert.equal(await ProductImageCleanup.findByPk(image.s3_key), null);
        },
      );
      await t.test(
        'cleanup workers skip an in-flight upload journal and recover it after rollback',
        async () => {
          const key = await reserveImage('products', id, { mimetype: 'image/png' });
          await ProductImageCleanup.update(
            { not_before: new Date(0) },
            { where: { s3_key: key } },
          );
          await assert.rejects(
            sequelize.transaction(async (transaction) => {
              await stageImage(key, { mimetype: 'image/png', buffer: png }, transaction);
              await processImageCleanup({ limit: 100 });
              assert.ok(objects.has(key));
              throw new Error('Simulated process interruption');
            }),
            /Simulated process interruption/,
          );
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.has(key), false);
        },
      );
      await t.test(
        'variants preserve case and replay concurrent creations; manual pricing and sorting remain compatible',
        async () => {
          await jsonWrite('patch', `/products/${id}`, {
            product_type: 'variable',
            offer_percent: 10,
          });
          assert.equal(
            (
              await jsonWrite('patch', `/products/${id}`, {
                offer_percent: null,
                sale_price: 70,
              })
            ).body.data.sale_price,
            70,
          );
          for (const [name, values] of [
            ['Size', ['M']],
            ['size', ['m']],
            ['Colour', ['Blue', 'blue']],
          ])
            assert.equal(
              (await post('/variant-attributes', { name, values })).status,
              201,
            );
          const variant = {
            sku: 'CASE-1',
            attributes: { Size: 'M', size: 'm', Colour: 'Blue' },
          };
          const results = await Promise.all([
            post(`/products/${id}/variants`, variant, 'variant-1'),
            post(`/products/${id}/variants`, variant, 'variant-1'),
          ]);
          assert.deepEqual(
            results.map((r) => r.status),
            [201, 201],
          );
          assert.deepEqual(results[0].body, results[1].body);
          assert.equal(await models.productVariant.count(), 1);
          const variantId = results[0].body.data.id;
          assert.deepEqual(
            (
              await jsonWrite('patch', `/products/${id}/variants/${variantId}`, {
                attributes: { Size: 'M', size: 'm', Colour: 'blue' },
              })
            ).body.data.attributes,
            { Size: 'M', size: 'm', Colour: 'blue' },
          );
          const sorted = await agent.get(
            '/api/admin/products?sort_by=product_name&sort_order=desc&limit=1',
          );
          assert.equal(sorted.status, 200);
          assert.equal(sorted.body.pagination.hasMore, true);
        },
      );
      await t.test(
        'reconciliation is read-only by default, protects unrelated objects and repairs missing references',
        async () => {
          objects.delete(image.s3_key);
          const orphan = `upload/${id}j.png`;
          objects.set(orphan, png);
          objects.set('upload/unrelated.png', png);
          const report = await reconcileProductImages();
          assert.equal(report.missing.length, 1);
          assert.deepEqual(report.orphans, [orphan]);
          assert.ok(await models.productImage.findByPk(image.id));
          assert.ok(objects.has(orphan));
          await reconcileProductImages({ apply: true });
          assert.equal(await models.productImage.findByPk(image.id), null);
          assert.equal(objects.has(orphan), false);
          assert.ok(objects.has('upload/unrelated.png'));
          headFailure = true;
          image = (await upload(id, 'head-error')).body.data[0];
          await assert.rejects(reconcileProductImages({ apply: true }), /Forbidden/);
          assert.ok(await models.productImage.findByPk(image.id));
          headFailure = false;
          truncatedListing = true;
          await assert.rejects(reconcileProductImages(), /invalid continuation/);
          truncatedListing = false;
        },
      );
      await t.test(
        'product cascade retains cleanup work and logout revokes authentication',
        async () => {
          deleteFailure = true;
          assert.equal((await jsonWrite('delete', `/products/${id}`)).status, 204);
          assert.equal(await models.productImage.count(), 0);
          assert.equal(await models.productVariant.count(), 0);
          assert.ok(await ProductImageCleanup.findByPk(image.s3_key));
          await processImageCleanup();
          deleteFailure = false;
          await due();
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.has(image.s3_key), false);
          const logout = await post('/auth/logout', {});
          assert.equal(logout.status, 204);
          assert.equal((await agent.get('/api/admin/auth/me')).status, 401);
        },
      );
    } finally {
      s3.send = originalSend;
      await sequelize.close();
    }
  },
);
