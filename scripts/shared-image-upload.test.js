import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createImageUpload } from '../src/shared/image_upload.js';
import { managedImageKeyFromUrl, imageUrl } from '../src/shared/image-storage.js';
import { png, jpeg, webp } from '../test-support/image-fixtures.js';

function uploadApp(options) {
  const app = express();
  app.post('/image', createImageUpload(options), (req, res) =>
    res.json({ count: req.files.length }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.message }),
  );
  return app;
}

test('shared Multer accepts real JPEG, PNG and WebP and rejects forged images', async () => {
  const app = uploadApp();
  for (const [buffer, type] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
    [webp, 'image/webp'],
  ]) {
    const result = await request(app)
      .post('/image')
      .attach('uploadimage', buffer, { filename: 'image', contentType: type });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.count, 1);
  }
  for (const [buffer, type] of [
    [Buffer.from('not an image'), 'image/png'],
    [png, 'image/jpeg'],
    [png, 'text/plain'],
  ]) {
    assert.equal(
      (
        await request(app)
          .post('/image')
          .attach('uploadimage', buffer, { filename: 'fake.png', contentType: type })
      ).status,
      400,
    );
  }
  assert.equal(
    (await request(app).post('/image').attach('wrong-field', png, 'image.png')).status,
    400,
  );
  assert.equal(
    (await request(app).post('/image').type('multipart/form-data').send('')).status,
    400,
  );
});

test('resource policies enforce one or ten files, per-file sizes and aggregate bytes', async () => {
  const single = uploadApp();
  assert.equal(
    (
      await request(single)
        .post('/image')
        .attach('uploadimage', png, 'a.png')
        .attach('uploadimage', png, 'b.png')
    ).status,
    400,
  );
  const batch = uploadApp({ maxFiles: 10, maxTotalBytes: 10 * 1024 * 1024 });
  let ten = request(batch).post('/image');
  for (let i = 0; i < 10; i++) ten = ten.attach('uploadimage', png, `${i}.png`);
  assert.equal((await ten).body.count, 10);
  let eleven = request(batch).post('/image');
  for (let i = 0; i < 11; i++) eleven = eleven.attach('uploadimage', png, `${i}.png`);
  assert.equal((await eleven).status, 400);
  assert.equal(
    (
      await request(uploadApp({ maxFileBytes: png.length - 1 }))
        .post('/image')
        .attach('uploadimage', png, 'large.png')
    ).status,
    400,
  );
  assert.equal(
    (
      await request(uploadApp({ maxFiles: 2, maxTotalBytes: png.length * 2 - 1 }))
        .post('/image')
        .attach('uploadimage', png, 'a.png')
        .attach('uploadimage', png, 'b.png')
    ).status,
    400,
  );
});

test('URL cleanup accepts only managed keys in the configured image bucket', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const resource of ['products', 'categories', 'brands']) {
    const key = `upload/${resource}/7/${uuid}.png`;
    assert.equal(managedImageKeyFromUrl(imageUrl(key)), key);
    assert.equal(managedImageKeyFromUrl(`${imageUrl(key)}?v=1`), key);
  }
  assert.equal(managedImageKeyFromUrl(imageUrl('upload/7j.jpg')), 'upload/7j.jpg');
  for (const url of [
    'https://outside.example/upload/7j.jpg',
    imageUrl('other/file.png'),
    'bad-url',
    null,
  ])
    assert.equal(managedImageKeyFromUrl(url), null);
});
