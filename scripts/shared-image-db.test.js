import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { ProductImageCleanup } from '../src/models/catalog-reliability.model.js';
import {
  processImageCleanup,
  managedImageKeyFromUrl,
} from '../src/shared/image-storage.js';
import { s3 } from '../src/shared/image_upload.js';
import { env } from '../src/config/env.js';
import { png, jpeg } from '../test-support/image-fixtures.js';

test(
  'authenticated shared category/brand image CRUD and durable cleanup',
  { skip: process.env.RUN_SHARED_IMAGE_DB_TESTS !== 'true' },
  async () => {
    assert.match(env.DB_NAME, /^codex_shared_images_test/);
    const send = s3.send;
    const objects = new Map();
    let failPut = false,
      failDelete = false;
    s3.send = async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        if (failPut) throw Error('Injected storage outage');
        assert.equal(command.input.IfNoneMatch, '*');
        assert.ok(!objects.has(Key));
        objects.set(Key, Buffer.from(Body));
      } else if (command.constructor.name === 'DeleteObjectCommand') {
        if (failDelete) throw Error('Injected deletion outage');
        objects.delete(Key);
      } else throw Error(`Unexpected S3 call: ${command.constructor.name}`);
      return {};
    };
    const origin = env.ALLOWED_ORIGINS[0];
    const agent = request.agent(app);
    const json = (method, path, body = {}) =>
      agent[method](`/api/admin${path}`).set('Origin', origin).send(body);
    const upload = (method, path, buffer = png, type = 'image/png') =>
      agent[method](`/api/admin${path}`)
        .set('Origin', origin)
        .attach('uploadimage', buffer, { filename: 'image', contentType: type });
    const due = () =>
      ProductImageCleanup.update({ not_before: new Date(0) }, { where: {} });
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
      ]) {
        await sequelize.query(
          await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
        );
      }
      await sequelize.query(
        'TRUNCATE products, categories, brands, product_catalog, product_variant_attributes, product_image_cleanup, admin_catalog_requests, users RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Image Test',
        email: 'images@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      assert.equal((await upload('post', '/categories/1/image')).status, 401);
      assert.equal(
        (
          await json('post', '/auth/login', {
            email: 'images@example.invalid',
            password: 'test-password',
          })
        ).status,
        200,
      );
      const categoryResponse = await json('post', '/categories', {
        category_name: 'Image category',
        slug: 'image-category',
        category_image: 'https://external.example/old.png',
      });
      assert.equal(categoryResponse.status, 201);
      const categoryId = categoryResponse.body.data.category_id;
      const brandResponse = await json('post', '/brands', {
        brand_name: 'Image Brand',
        slug: 'image-brand',
      });
      assert.equal(brandResponse.status, 201);
      const brandId = brandResponse.body.data.brand_id;
      const categoryPath = `/categories/${categoryId}/image`,
        brandPath = `/brands/${brandId}/image`;
      assert.equal((await agent.get(`/api/admin${brandPath}`)).body.data.image_url, null);
      assert.equal((await upload('post', '/categories/999999/image')).status, 404);
      assert.equal((await upload('post', '/brands/invalid/image')).status, 422);
      assert.equal(
        (
          await agent
            .post(`/api/admin${brandPath}`)
            .set('Origin', 'https://untrusted.example')
            .attach('uploadimage', png, 'image.png')
        ).status,
        403,
      );
      assert.equal((await json('put', brandPath, {})).status, 415);
      assert.equal((await upload('post', brandPath, Buffer.from('forged'))).status, 400);
      assert.equal(objects.size, 0);
      assert.equal(await ProductImageCleanup.count(), 0);
      const categoryUpload = await upload('post', categoryPath);
      assert.equal(categoryUpload.status, 201, JSON.stringify(categoryUpload.body));
      const firstUrl = categoryUpload.body.data.image_url;
      const firstKey = managedImageKeyFromUrl(firstUrl);
      assert.equal(categoryUpload.body.data.category_id, categoryId);
      assert.ok(firstKey.startsWith(`upload/categories/${categoryId}/`));
      assert.deepEqual(objects.get(firstKey), png);
      assert.equal(
        (await agent.get(`/api/admin/categories/${categoryId}`)).body.data.category_image,
        firstUrl,
      );
      const brandUpload = await upload('put', brandPath);
      assert.equal(brandUpload.status, 200);
      const brandUrl = brandUpload.body.data.image_url;
      const brandKey = managedImageKeyFromUrl(brandUrl);
      assert.ok(brandKey.startsWith(`upload/brands/${brandId}/`));
      assert.equal(
        (await agent.get(`/api/admin/brands/${brandId}`)).body.data.image_url,
        brandUrl,
      );
      // Cross-entity references protect objects from asynchronous cleanup.
      assert.equal(
        (await json('patch', `/brands/${brandId}`, { image_url: firstUrl })).status,
        200,
      );
      const replacement = await upload('put', categoryPath, jpeg, 'image/jpeg');
      assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
      const replacementUrl = replacement.body.data.image_url;
      const replacementKey = managedImageKeyFromUrl(replacementUrl);
      assert.notEqual(replacementUrl, firstUrl);
      assert.deepEqual(objects.get(replacementKey), jpeg);
      await due();
      await processImageCleanup();
      assert.ok(objects.has(firstKey));
      assert.ok(objects.has(replacementKey));
      assert.equal(objects.has(brandKey), false);
      assert.equal(
        (await json('patch', `/brands/${brandId}`, { image_url: null })).status,
        200,
      );
      await processImageCleanup();
      assert.equal(objects.has(firstKey), false);
      // Rejected or failed uploads never replace the current image.
      failPut = true;
      assert.equal((await upload('put', categoryPath)).status, 500);
      failPut = false;
      assert.equal(
        (await agent.get(`/api/admin${categoryPath}`)).body.data.image_url,
        replacementUrl,
      );
      await due();
      await processImageCleanup();
      const update = models.category.prototype.update;
      models.category.prototype.update = async function (values, options) {
        if (Object.hasOwn(values, 'category_image'))
          throw Error('Injected database failure');
        return update.call(this, values, options);
      };
      try {
        assert.equal((await upload('put', categoryPath)).status, 500);
      } finally {
        models.category.prototype.update = update;
      }
      assert.ok(objects.size > 1);
      assert.equal(
        (await agent.get(`/api/admin${categoryPath}`)).body.data.image_url,
        replacementUrl,
      );
      await due();
      await processImageCleanup();
      assert.equal(objects.size, 1);
      assert.ok(objects.has(replacementKey));
      assert.equal((await json('delete', categoryPath)).status, 204);
      assert.equal(
        (await agent.get(`/api/admin${categoryPath}`)).body.data.image_url,
        null,
      );
      assert.equal(
        (await agent.get(`/api/admin/categories/${categoryId}`)).body.data.category_image,
        null,
      );
      failDelete = true;
      await processImageCleanup({ limit: 1 });
      assert.ok(objects.has(replacementKey));
      assert.equal((await ProductImageCleanup.findByPk(replacementKey)).attempts, 1);
      failDelete = false;
      await due();
      await processImageCleanup();
      assert.equal(objects.size, 0);
      assert.equal((await json('delete', categoryPath)).status, 204);
      const nextCategory = await upload('post', categoryPath);
      assert.equal(nextCategory.status, 201);
      assert.equal(
        (
          await json('patch', `/categories/${categoryId}`, {
            category_image: 'https://external.example/new.png',
          })
        ).status,
        200,
      );
      await processImageCleanup();
      assert.equal(objects.size, 0);
      await upload('post', categoryPath);
      await upload('post', brandPath);
      assert.equal(objects.size, 2);
      assert.equal((await json('delete', `/categories/${categoryId}`)).status, 204);
      assert.equal((await json('delete', `/brands/${brandId}`)).status, 204);
      await processImageCleanup();
      assert.equal(objects.size, 0);
      assert.equal(await ProductImageCleanup.count(), 0);
    } finally {
      s3.send = send;
      await sequelize.close();
    }
  },
);
