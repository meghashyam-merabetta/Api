import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { png, jpeg } from '../test-support/image-fixtures.js';

test(
  'variant galleries: isolation, inheritance, sharing, retries, storefront and cleanup',
  { skip: process.env.RUN_VARIANT_GALLERY_DB_TESTS !== 'true' },
  async (t) => {
    assert.match(process.env.DB_NAME, /^codex_variant_galleries_test/);
    const { app } = await import('../src/app.js');
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { s3 } = await import('../src/shared/image_upload.js');
    const { env } = await import('../src/config/env.js');
    const { productCatalog } = await import('../src/app/products/catalog.js');
    const { processImageCleanup } = await import('../src/shared/image-storage.js');
    const { ProductImageCleanup } =
      await import('../src/models/catalog-reliability.model.js');
    const send = s3.send,
      objects = new Map();
    let uploads = 0,
      failPut = false,
      failDelete = false;
    s3.send = async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        if (failPut) throw Error('Injected upload failure');
        assert.equal(command.input.IfNoneMatch, '*');
        assert.ok(!objects.has(Key));
        objects.set(Key, Buffer.from(Body));
        uploads++;
      } else if (command.constructor.name === 'DeleteObjectCommand') {
        if (failDelete) throw Error('Injected deletion failure');
        objects.delete(Key);
      } else throw Error('Unexpected storage request');
      return {};
    };
    const agent = request.agent(app),
      origin = env.ALLOWED_ORIGINS[0];
    const json = (method, path, body = {}) =>
      agent[method](`/api/admin/products${path}`).set('Origin', origin).send(body);
    const upload = (method, path, key, data = png, type = 'image/png') => {
      const call = agent[method](`/api/admin/products${path}`).set('Origin', origin);
      if (key) call.set('Idempotency-Key', key);
      return call.attach('uploadimage', data, { filename: 'image', contentType: type });
    };
    const get = async (path) => {
      const result = await agent.get(`/api/admin/products${path}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.data;
    };
    let product, variants, base, paths;
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
        '035-product-specification-fields.sql',
        '035-admin-integration-gaps.sql',
        '036-product-soft-delete.sql',
        '036-independent-products-audit.sql',
        '038-variant-image-galleries.sql',
      ])
        await sequelize.query(
          await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'),
        );
      await sequelize.query(
        'TRUNCATE products,categories,brands,product_catalog,users,vendors,admin_catalog_requests,product_image_cleanup RESTART IDENTITY CASCADE',
      );
      await models.user.create({
        realm: 'admin',
        name: 'Gallery test',
        email: 'gallery@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      assert.equal(
        (
          await agent
            .post('/api/admin/auth/login')
            .set('Origin', origin)
            .send({ email: 'gallery@example.invalid', password: 'test-password' })
        ).status,
        200,
      );
      product = await models.product.create({
        product_name: 'Gallery fixture',
        slug: 'gallery-fixture',
        product_type: 'variable',
        regular_price: 100,
        product_status: 'active',
      });
      variants = await Promise.all(
        ['M', 'L', 'XL'].map((size) =>
          models.productVariant.create({
            product_id: product.product_id,
            sku: `gallery-${size}`,
            attributes: { Size: size },
            stock_quantity: 5,
          }),
        ),
      );
      base = `/${product.product_id}`;
      paths = variants.map((variant) => `${base}/variants/${variant.id}/images`);
      await t.test(
        'security, product compatibility and exact variant ownership',
        async () => {
          assert.equal(
            (await request(app).get(`/api/admin/products${paths[0]}`)).status,
            401,
          );
          assert.equal(
            (
              await agent
                .post(`/api/admin/products${paths[0]}`)
                .set('Origin', 'https://invalid.example')
                .attach('uploadimage', png, 'image.png')
            ).status,
            403,
          );
          assert.equal((await json('post', paths[0])).status, 415);
          assert.equal(
            (await upload('post', paths[0], null, Buffer.from('fake'))).status,
            400,
          );
          assert.equal(
            (
              await upload(
                'post',
                paths[0].replace(`/variants/${variants[0].id}/`, '/variants/999999/'),
              )
            ).status,
            404,
          );
          const other = await models.product.create({
            product_name: 'Other',
            slug: 'other',
          });
          assert.equal(
            (
              await agent.get(
                `/api/admin/products/${other.product_id}/variants/${variants[0].id}/images`,
              )
            ).status,
            404,
          );
          assert.equal((await upload('post', `${base}/images`)).status, 201);
          for (const path of paths) {
            const gallery = await get(path);
            assert.equal(gallery.use_product_images, true);
            assert.equal(gallery.custom_images.length, 0);
            assert.equal(gallery.effective_images.length, 1);
          }
        },
      );
      await t.test(
        'three independent galleries and concurrent idempotent upload retries',
        async () => {
          for (const [index, path] of paths.entries()) {
            const count = uploads;
            const [first, retry] = await Promise.all([
              upload('post', path, `variant-${index}`),
              upload('post', path, `variant-${index}`),
            ]);
            assert.equal(first.status, 201, JSON.stringify(first.body));
            assert.equal(retry.status, 201);
            assert.deepEqual(first.body, retry.body);
            assert.equal(uploads, count + 1);
            assert.equal(first.body.data.use_product_images, false);
            assert.equal(first.body.data.custom_images.length, 1);
          }
          assert.equal(
            new Set(
              (await Promise.all(paths.map(get))).map(
                (g) => g.effective_images[0].s3_key,
              ),
            ).size,
            3,
          );
          const duplicateKey = await upload(
            'post',
            paths[0],
            'variant-0',
            jpeg,
            'image/jpeg',
          );
          assert.equal(duplicateKey.status, 409);
          const list = await get(`${base}/variants`);
          assert.equal(list.length, 3);
          assert.ok(list.every((v) => v.gallery.effective_images.length === 1));
          const details = await get(base);
          assert.ok(
            details.variants.every((v) => v.gallery.effective_images.length === 1),
          );
          assert.equal((await get(`${base}/images`)).length, 1);
        },
      );
      await t.test(
        'sharing cannot remove a product image referenced by an independent product',
        async () => {
          const [image] = await get(`${base}/images`);
          const other = await models.product.findOne({ where: { slug: 'other' } });
          await sequelize.query(
            'INSERT INTO independent_product_images(product_id,source_image_id) VALUES(:product,:image)',
            { replacements: { product: other.product_id, image: image.id } },
          );
          const before = await get(paths[0]);
          const blocked = await json('post', `${base}/variants/images/share`, {
            source_variant_id: variants[0].id,
          });
          assert.equal(blocked.status, 409);
          assert.deepEqual(await get(paths[0]), before);
          assert.equal((await get(`${base}/images`))[0].id, image.id);
          assert.ok(objects.has(image.s3_key));
          await sequelize.query(
            'DELETE FROM independent_product_images WHERE product_id=:product',
            { replacements: { product: other.product_id } },
          );
        },
      );
      let sharedKey;
      await t.test(
        'share M without any upload and inherit for existing/future variants',
        async () => {
          const count = uploads;
          const m = await get(paths[0]);
          sharedKey = m.effective_images[0].s3_key;
          const shareCall = () =>
            agent
              .post(`/api/admin/products${base}/variants/images/share`)
              .set('Origin', origin)
              .set('Idempotency-Key', 'share-m')
              .send({ source_variant_id: variants[0].id });
          const shared = await shareCall();
          const retry = await shareCall();
          assert.equal(retry.headers['idempotency-replayed'], 'true');
          assert.deepEqual(retry.body, shared.body);
          assert.equal(shared.status, 200, JSON.stringify(shared.body));
          assert.equal(uploads, count);
          for (const path of paths) {
            const g = await get(path);
            assert.equal(g.use_product_images, true);
            assert.equal(g.effective_images[0].s3_key, sharedKey);
          }
          const future = await models.productVariant.create({
            product_id: product.product_id,
            sku: 'future',
            attributes: { Size: 'XXL' },
          });
          assert.equal(
            (await get(`${base}/variants/${future.id}/images`)).effective_images[0]
              .s3_key,
            sharedKey,
          );
          assert.ok(objects.has(sharedKey));
        },
      );
      await t.test(
        'override L; primary changes and replacement do not change M/XL',
        async () => {
          const l = await get(paths[1]);
          const changed = await upload(
            'put',
            `${paths[1]}/${l.custom_images[0].id}`,
            'replace-l',
            jpeg,
            'image/jpeg',
          );
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
          const count = uploads;
          const retry = await upload(
            'put',
            `${paths[1]}/${l.custom_images[0].id}`,
            'replace-l',
            jpeg,
            'image/jpeg',
          );
          assert.equal(retry.headers['idempotency-replayed'], 'true');
          assert.deepEqual(retry.body, changed.body);
          assert.equal(uploads, count);
          assert.equal(changed.body.data.use_product_images, false);
          assert.notEqual(changed.body.data.effective_images[0].s3_key, sharedKey);
          const extra = await upload('post', paths[1]);
          assert.equal(extra.status, 201);
          const image = extra.body.data.custom_images.find((i) => !i.is_primary);
          assert.equal(
            (await json('patch', `${paths[1]}/${image.id}/primary`)).status,
            200,
          );
          assert.equal((await get(paths[1])).primary_image.id, image.id);
          assert.equal((await get(paths[0])).effective_images[0].s3_key, sharedKey);
          assert.equal((await get(paths[2])).effective_images[0].s3_key, sharedKey);
          assert.equal((await json('delete', `${paths[0]}/${image.id}`)).status, 404);
        },
      );
      await t.test(
        'empty custom persists; primary repair; no fallback in cache/storefront',
        async () => {
          const g = await get(paths[1]);
          for (const image of g.custom_images)
            assert.equal((await json('delete', `${paths[1]}/${image.id}`)).status, 204);
          const empty = await get(paths[1]);
          assert.equal(empty.use_product_images, false);
          assert.deepEqual(empty.effective_images, []);
          assert.equal(empty.primary_image, null);
          const cache = await models.productCatalog.findByPk(`variant:${variants[1].id}`);
          assert.deepEqual(cache.data.images, []);
          assert.equal(cache.data.image, null);
          const category = await models.category.create({
            category_name: 'Gallery category',
            slug: 'gallery-category',
          });
          await models.productCategory.create({
            product_id: product.product_id,
            category_id: category.category_id,
            is_primary: true,
          });
          await sequelize.query(
            "INSERT INTO vendors(vendor_code,name,vendor_status) VALUES('gallery','Gallery','active')",
          );
          await sequelize.query(
            "INSERT INTO vendor_products(vendor_id,variant_id,selling_price,mrp) SELECT (SELECT id FROM vendors WHERE vendor_code='gallery'),id,80,100 FROM product_variants WHERE product_id=:id",
            { replacements: { id: product.product_id } },
          );
          const storefront = await productCatalog();
          const item = storefront.products.find(
            (p) => p.variantId === String(variants[1].id),
          );
          assert.ok(item);
          assert.deepEqual(item.images, []);
          assert.equal(item.image, null);
          const m = storefront.products.find(
            (p) => p.variantId === String(variants[0].id),
          );
          assert.equal(m.images.length, 1);
          assert.equal(
            (await json('patch', paths[1], { use_product_images: true })).status,
            200,
          );
          assert.equal((await get(paths[1])).effective_images[0].s3_key, sharedKey);
          assert.equal(
            (await json('patch', paths[1], { use_product_images: false })).status,
            200,
          );
          assert.deepEqual((await get(paths[1])).effective_images, []);
        },
      );
      await t.test(
        'shared object survives product/M changes until last reference removed',
        async () => {
          const m = await get(paths[0]);
          assert.equal(
            (await json('delete', `${paths[0]}/${m.custom_images[0].id}`)).status,
            204,
          );
          assert.ok(objects.has(sharedKey)); // Product still owns it.
          const productImages = await get(`${base}/images`);
          assert.equal(
            (await json('delete', `${base}/images/${productImages[0].id}`)).status,
            204,
          );
          assert.equal(objects.has(sharedKey), false);
        },
      );
      await t.test(
        'upload rollback, max ten files and deferred cleanup on outage',
        async () => {
          failPut = true;
          const before = await get(paths[1]);
          const failed = await upload('post', paths[1]);
          assert.equal(failed.status, 500);
          assert.deepEqual(await get(paths[1]), before);
          failPut = false;
          for (let i = 0; i < 10; i++)
            assert.equal((await upload('post', paths[1])).status, 201);
          assert.equal((await upload('post', paths[1])).status, 400);
          assert.equal(
            (
              await agent
                .post(`/api/admin/products${paths[1]}`)
                .set('Origin', origin)
                .attach('uploadimage', png, 'a.png')
                .attach('uploadimage', png, 'b.png')
            ).status,
            400,
          );
          assert.equal(
            (await upload('post', paths[2], null, Buffer.alloc(5 * 1024 * 1024 + 1)))
              .status,
            400,
          );
          const image = (await get(paths[1])).custom_images[0];
          failDelete = true;
          assert.equal((await json('delete', `${paths[1]}/${image.id}`)).status, 204);
          assert.ok(objects.has(image.s3_key));
          failDelete = false;
          await ProductImageCleanup.update({ not_before: new Date(0) }, { where: {} });
          await processImageCleanup({ limit: 100 });
          assert.equal(objects.has(image.s3_key), false);
        },
      );
      await t.test(
        'share empty gallery explicitly empties default with no fallback',
        async () => {
          // M was explicitly emptied above; XL still has an unrelated retained custom image.
          const response = await json('post', `${base}/variants/images/share`, {
            source_variant_id: variants[0].id,
          });
          assert.equal(response.status, 200);
          for (const path of paths) {
            const g = await get(path);
            assert.equal(g.use_product_images, true);
            assert.deepEqual(g.effective_images, []);
          }
          assert.deepEqual(await get(`${base}/images`), []);
        },
      );
    } finally {
      s3.send = send;
      await sequelize.close();
    }
  },
);
