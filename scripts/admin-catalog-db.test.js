import { png, jpeg, webp } from '../test-support/image-fixtures.js';
import { processImageCleanup } from '../src/shared/image-storage.js';
import { ProductImageCleanup } from '../src/models/catalog-reliability.model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { buildRouter } from '../src/shared/routes.js';
import { productsRoutes } from '../src/admin/products/products.routes.js';
import { categoriesRoutes } from '../src/admin/categories/categories.routes.js';
import { brandsRoutes } from '../src/admin/brands/brands.routes.js';
import { variantAttributeRoutes } from '../src/admin/variants/variants.routes.js';
import { s3 } from '../src/shared/image_upload.js';

test(
  'catalog migrations and admin HTTP contracts against isolated PostgreSQL',
  { skip: process.env.RUN_CATALOG_DB_TESTS !== 'true' },
  async () => {
    assert.match(process.env.DB_NAME, /^codex_catalog_test/);
    const app = express();
    app.use(express.json());
    const auth = (_req, _res, next) => next();
    for (const [path, routes] of [
      ['products', productsRoutes],
      ['categories', categoriesRoutes],
      ['brands', brandsRoutes],
      ['variant-attributes', variantAttributeRoutes],
    ])
      app.use(`/${path}`, buildRouter(auth, routes));
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
    const send = s3.send;
    const objects = new Map();
    s3.send = async (command) => {
      const { Key, Body, ContentType } = command.input;
      if (command.constructor.name === 'HeadObjectCommand') {
        if (!objects.has(Key))
          throw Object.assign(new Error('Not found'), { name: 'NotFound' });
      } else if (command.constructor.name === 'PutObjectCommand')
        objects.set(Key, { Body, ContentType });
      else if (command.constructor.name === 'DeleteObjectCommand') objects.delete(Key);
      return {};
    };
    const create = async (path, body) => {
      const response = await request(app).post(path).send(body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.data;
    };
    try {
      await models.customer.sync();
      for (let pass = 0; pass < 2; pass++)
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
      await sequelize.query(
        'TRUNCATE products, categories, brands, product_variant_attributes, product_catalog, product_image_cleanup, admin_catalog_requests RESTART IDENTITY CASCADE',
      );
      const brand = await create('/brands', { brand_name: 'Joylife', slug: 'joylife' });
      assert.equal(
        (
          await request(app)
            .patch(`/brands/${brand.brand_id}`)
            .send({ brand_name: 'Joy Life' })
        ).body.data.brand_name,
        'Joy Life',
      );
      assert.equal((await request(app).get('/brands?all=true')).body.data.length, 1);
      assert.equal(
        (
          await request(app)
            .post('/brands')
            .send({ brand_name: 'Duplicate', slug: 'joylife' })
        ).status,
        409,
      );
      const root = await create('/categories', { category_name: 'Care', slug: 'care' });
      const child = await create('/categories', {
        category_name: 'Adult',
        slug: 'adult',
        parent_category_id: Number(root.category_id),
      });
      assert.equal(
        (await request(app).get('/categories?roots_only=true')).body.data.length,
        1,
      );
      assert.equal(
        (await request(app).get(`/categories?parent_category_id=${root.category_id}`))
          .body.data[0].category_id,
        child.category_id,
      );
      assert.equal(
        (await request(app).get('/categories/tree')).body.data[0].subcategories[0]
          .category_id,
        child.category_id,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/categories/${root.category_id}`)
            .send({ parent_category_id: Number(child.category_id) })
        ).status,
        400,
      );
      const product = await create('/products', {
        product_name: 'Joylife Pants',
        slug: 'joylife-pants',
        product_type: 'variable',
        brand_id: Number(brand.brand_id),
        product_code: 'JOY01',
        mrp: 100,
        offer_percent: 20,
        category_ids: [Number(child.category_id)],
        primary_category_id: Number(child.category_id),
        keywords: ['diaper'],
        gst_rate: 5,
        unit_count: 10,
        material: 'Cotton',
      });
      const id = product.product_id;
      assert.equal(product.sale_price, '80.00');
      assert.equal(product.effective_price, 80);
      assert.equal((await request(app).delete(`/brands/${brand.brand_id}`)).status, 409);
      assert.equal(
        (
          await request(app)
            .post('/products')
            .send({ product_name: 'Bad brand', slug: 'bad-brand', brand_id: 99999 })
        ).status,
        400,
      );
      assert.equal(
        (await request(app).patch(`/products/${id}`).send({ regular_price: 200 })).body
          .data.sale_price,
        160,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/products/${id}`)
            .send({ offer_percent: null, sale_price: 999 })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(app).get(
            `/products?brand_id=${brand.brand_id}&sort_by=product_name&sort_order=asc`,
          )
        ).body.data[0].product_id,
        id,
      );
      assert.equal(
        (await request(app).get('/products?search=diaper')).body.data.length,
        1,
      );
      assert.equal(
        (await request(app).get(`/products?category_id=${root.category_id}`)).body.data
          .length,
        0,
      );
      const attribute = await create('/variant-attributes', {
        name: 'Size',
        values: ['M', 'L', 'XL', 'XXL'],
      });
      assert.equal(
        (
          await request(app)
            .post('/variant-attributes')
            .send({ name: 'Bad', values: ['M,L'] })
        ).status,
        422,
      );
      const medium = await create(`/products/${id}/variants`, {
        sku: 'JOY-M',
        attributes: { Size: 'M' },
        regular_price: 100,
        sale_price: 90,
        stock_quantity: 5,
      });
      await create(`/products/${id}/variants`, {
        sku: 'JOY-L',
        attributes: { Size: 'L' },
        stock_quantity: 8,
      });
      assert.equal(
        (
          await request(app)
            .post(`/products/${id}/variants`)
            .send({ sku: 'JOY-UNKNOWN', attributes: { Size: 'S' } })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(app)
            .post(`/products/${id}/variants`)
            .send({ sku: 'JOY-DUPLICATE', attributes: { Size: 'M' } })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/products/${id}/variants/${medium.id}`)
            .send({ stock_quantity: 12 })
        ).body.data.stock_quantity,
        12,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/products/${id}/variants/${medium.id}`)
            .send({ regular_price: 10 })
        ).status,
        400,
      );
      assert.equal(
        (await request(app).patch(`/products/${id}`).send({ product_type: 'simple' }))
          .status,
        409,
      );
      assert.equal(
        (await request(app).delete(`/variant-attributes/${attribute.id}`)).status,
        409,
      );
      assert.equal(
        (
          await request(app)
            .patch(`/variant-attributes/${attribute.id}`)
            .send({ values: ['L'] })
        ).status,
        409,
      );
      const upload = await request(app)
        .post(`/products/${id}/images`)
        .attach('uploadimage', png, {
          filename: 'one.png',
          contentType: 'image/png',
        })
        .attach('uploadimage', webp, {
          filename: 'two.webp',
          contentType: 'image/webp',
        });
      assert.equal(upload.status, 201, JSON.stringify(upload.body));
      assert.equal(upload.body.data.filter((image) => image.is_primary).length, 1);
      assert.ok(upload.body.data[0].image_url.endsWith('.png'));
      const first = upload.body.data[0],
        second = upload.body.data[1];
      assert.equal(
        (await request(app).patch(`/products/${id}/images/${second.id}/primary`)).status,
        200,
      );
      assert.equal(
        (await request(app).patch(`/products/${id}/images/bad/primary`)).status,
        422,
      );
      const replacement = await request(app)
        .put(`/products/${id}/images/${first.id}`)
        .attach('uploadimage', png, {
          filename: 'new.png',
          contentType: 'image/png',
        });
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.body.data.s3_key, first.s3_key);
      await processImageCleanup({ limit: 100 });
      assert.equal(
        (await request(app).patch(`/products/${id}`).send({ product_status: 'active' }))
          .status,
        200,
      );
      const detail = (await request(app).get(`/products/${id}`)).body.data;
      assert.equal(detail.images.length, 2);
      assert.equal(detail.images[0].id, second.id);
      assert.equal(detail.variants.length, 2);
      assert.ok(detail.variants.some((v) => v.display_name === 'M'));
      assert.equal(detail.brand.brand_id, brand.brand_id);
      const list = await request(app).get('/products?sort_by=product_code');
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.equal(list.body.data[0].images.length, 2);
      assert.equal(
        (await request(app).delete(`/products/${id}/images/${second.id}`)).status,
        204,
      );
      assert.equal(
        (await request(app).get(`/products/${id}/images`)).body.data[0].is_primary,
        true,
      );
      await processImageCleanup({ limit: 100 });
      // A DB failure rolls back every image row; durable staging journals clean new objects.
      const originalCreate = models.productImage.create;
      let creates = 0;
      models.productImage.create = (...args) => {
        if (++creates === 2) throw Error('Simulated failure');
        return originalCreate.apply(models.productImage, args);
      };
      try {
        const failed = await request(app)
          .post(`/products/${id}/images`)
          .attach('uploadimage', jpeg, {
            filename: 'a.jpg',
            contentType: 'image/jpeg',
          })
          .attach('uploadimage', jpeg, {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          });
        assert.equal(failed.status, 500);
        assert.equal(
          (await request(app).get(`/products/${id}/images`)).body.data.length,
          1,
        );
        await ProductImageCleanup.update({ not_before: new Date(0) }, { where: {} });
        await processImageCleanup({ limit: 100 });
        assert.equal(objects.size, 1);
      } finally {
        models.productImage.create = originalCreate;
      }
      // Ten stored images, uploads above six files, and immutable keys.
      let fillRequest = request(app).post(`/products/${id}/images`);
      for (let index = 0; index < 9; index++) {
        fillRequest = fillRequest.attach('uploadimage', jpeg, {
          filename: `${index}.jpg`,
          contentType: 'image/jpeg',
        });
      }
      const filled = await fillRequest;
      assert.equal(filled.status, 201, JSON.stringify(filled.body));
      assert.equal(filled.body.data.length, 9);
      assert.equal(objects.size, 10);
      assert.ok(filled.body.data.at(-1).s3_key.startsWith(`upload/products/${id}/`));
      const fullList = (await request(app).get(`/products/${id}/images`)).body.data;
      assert.equal(fullList.length, 10);
      assert.equal(fullList.filter((image) => image.is_primary).length, 1);
      assert.equal(
        (await request(app).get(`/products/${id}`)).body.data.images.length,
        10,
      );
      const rejected = await request(app)
        .post(`/products/${id}/images`)
        .attach('uploadimage', png, {
          filename: 'extra.png',
          contentType: 'image/png',
        });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /maximum of 10 images/);
      assert.equal(objects.size, 10);
      const lastImage = filled.body.data.at(-1);
      assert.equal(
        (await request(app).delete(`/products/${id}/images/${lastImage.id}`)).status,
        204,
      );
      const reused = await request(app)
        .post(`/products/${id}/images`)
        .attach('uploadimage', png, {
          filename: 'reuse.png',
          contentType: 'image/png',
        });
      assert.equal(reused.status, 201, JSON.stringify(reused.body));
      assert.ok(reused.body.data[0].s3_key.endsWith(`.png`));
      assert.notEqual(reused.body.data[0].s3_key, lastImage.s3_key);
      await processImageCleanup({ limit: 100 });
      assert.equal(
        (await request(app).get(`/products/${id}/images`)).body.data.length,
        10,
      );
      const currentImages = (await request(app).get(`/products/${id}/images`)).body.data;
      for (const image of currentImages) {
        assert.equal(
          (await request(app).delete(`/products/${id}/images/${image.id}`)).status,
          204,
        );
      }
      await processImageCleanup({ limit: 100 });
      assert.equal(objects.size, 0);
      let tenFileRequest = request(app).post(`/products/${id}/images`);
      for (let index = 0; index < 10; index++) {
        tenFileRequest = tenFileRequest.attach('uploadimage', png, {
          filename: `${index}.png`,
          contentType: 'image/png',
        });
      }
      const tenFiles = await tenFileRequest;
      assert.equal(tenFiles.status, 201, JSON.stringify(tenFiles.body));
      assert.equal(tenFiles.body.data.length, 10);
      assert.equal(tenFiles.body.data.filter((image) => image.is_primary).length, 1);
      assert.equal(objects.size, 10);
      assert.equal((await request(app).delete(`/products/${id}`)).status, 204);
      await processImageCleanup({ limit: 100 });
      assert.equal(objects.size, 0);
      assert.equal(await models.productVariant.count(), 0);
      assert.equal(
        (await request(app).delete(`/variant-attributes/${attribute.id}`)).status,
        204,
      );
      assert.equal((await request(app).delete(`/brands/${brand.brand_id}`)).status, 204);
    } finally {
      s3.send = send;
      await sequelize.close();
    }
  },
);
