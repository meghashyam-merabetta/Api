// Live curl smoke test. Creates and removes a temporary admin, product and S3 images.
// Run: NODE_ENV=test LOG_LEVEL=silent LOG_API_PAYLOADS=false node scripts/check-product-images-curl.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { s3 } from '../src/admin/products/product_image.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const run = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'product-images-curl-'));
const cookieJar = path.join(directory, 'cookies.txt');
const origin = env.ALLOWED_ORIGINS[0];
const slug = `curl-image-test-${randomUUID()}`;
const password = randomUUID();
let server, user, productId;
const keys = new Set();
const results = [];
let failed = false;
async function check(label, route, args, expected, required = true) {
  const output = path.join(directory, `response-${results.length}.json`);
  const { stdout } = await run('curl', [
    '--silent',
    '--show-error',
    '--max-time',
    '30',
    '--cookie',
    cookieJar,
    '--cookie-jar',
    cookieJar,
    '--header',
    `Origin: ${origin}`,
    '--output',
    output,
    '--write-out',
    '%{http_code}',
    ...args,
    `${base}${route}`,
  ]);
  const status = Number(stdout);
  const raw = await readFile(output, 'utf8');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  for (const image of Array.isArray(body?.data) ? body.data : [])
    if (image.s3_key) keys.add(image.s3_key);
  if (body?.data?.s3_key) keys.add(body.data.s3_key);
  const result = { test: label, status, expected, passed: status === expected };
  if (status !== expected) result.error = body?.error ?? body?.message ?? raw;
  results.push(result);
  console.log(JSON.stringify(result));
  if (!required && status !== expected) {
    failed = true;
    return body;
  }
  assert.equal(status, expected, `${label}: ${JSON.stringify(body)}`);
  return body;
}
let base;
try {
  await sequelize.authenticate();
  user = await models.user.create({
    realm: 'admin',
    name: 'Temporary curl image test',
    email: `${slug}@example.invalid`,
    passwordHash: await bcrypt.hash(password, 12),
    active: true,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const loginFile = path.join(directory, 'login.json');
  await writeFile(loginFile, JSON.stringify({ email: user.email, password }), {
    mode: 0o600,
  });
  await check(
    'Admin login',
    '/auth/login',
    [
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      `@${loginFile}`,
    ],
    200,
  );
  const json = (method, body = {}) => [
    '-X',
    method,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify(body),
  ];
  const created = await check(
    'Create temporary product',
    '/products',
    json('POST', { product_name: 'Temporary curl image test', slug }),
    201,
  );
  productId = created.data.product_id;
  const route = `/products/${productId}/images`;
  const firstFile = path.join(directory, 'first.png');
  const replacementFile = path.join(directory, 'replacement.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8Z8AAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(firstFile, png);
  await writeFile(replacementFile, Buffer.concat([png, Buffer.from('replacement-test')]));
  await check('List initially empty', route, [], 200).then((body) =>
    assert.equal(body.data.length, 0),
  );
  const upload = await check(
    'Upload two PNG images',
    route,
    [
      '-X',
      'POST',
      '-F',
      `uploadimage=@${firstFile};type=image/png`,
      '-F',
      `uploadimage=@${firstFile};type=image/png`,
    ],
    201,
  );
  assert.equal(upload.data.length, 2);
  assert.equal(upload.data.filter((image) => image.is_primary).length, 1);
  const [first, second] = upload.data;
  const readImage = async (label, url, expectedFile) => {
    const output = path.join(directory, 'download.png');
    const { stdout } = await run('curl', [
      '--silent',
      '--show-error',
      '--max-time',
      '30',
      '--output',
      output,
      '--write-out',
      '%{http_code}',
      url,
    ]);
    const status = Number(stdout);
    const passed =
      status === 200 && (await readFile(output)).equals(await readFile(expectedFile));
    console.log(JSON.stringify({ test: label, status, expected: 200, passed }));
    if (!passed) failed = true;
  };
  await readImage(
    'Read uploaded image URL and compare bytes',
    first.image_url,
    firstFile,
  );
  const list = await check('List persisted images', route, [], 200);
  assert.equal(list.data.length, 2);
  await check(
    'Get product includes uploaded images',
    `/products/${productId}`,
    [],
    200,
    false,
  ).then((body) => {
    if (body.data) assert.equal(body.data.images.length, 2);
  });
  await check(
    'Set second image primary',
    `${route}/${second.id}/primary`,
    json('PATCH'),
    200,
  );
  await check('Verify primary ordering', route, [], 200).then((body) => {
    assert.equal(body.data[0].id, second.id);
    assert.equal(body.data[0].is_primary, true);
  });
  const replaced = await check(
    'Replace first image using PUT multipart',
    `${route}/${first.id}`,
    ['-X', 'PUT', '-F', `uploadimage=@${replacementFile};type=image/png`],
    200,
  );
  assert.equal(replaced.data.id, first.id);
  assert.notEqual(replaced.data.s3_key, first.s3_key);
  assert.notEqual(replaced.data.image_url, first.image_url);
  await readImage(
    'Read replacement URL and compare bytes',
    replaced.data.image_url,
    replacementFile,
  );
  await check(
    'Publish product',
    `/products/${productId}`,
    json('PATCH', { product_status: 'active' }),
    200,
  );
  await check('Images persist after publishing', route, [], 200).then((body) =>
    assert.equal(body.data.length, 2),
  );
  await check(
    'Reject invalid image MIME',
    route,
    ['-X', 'POST', '-F', `uploadimage=@${firstFile};type=text/plain`],
    400,
  );
  await check(
    'Reject replacement without a file',
    `${route}/${first.id}`,
    ['-X', 'PUT', '-F', 'description=empty'],
    400,
  );
  await check('Reject invalid image ID', `${route}/invalid/primary`, json('PATCH'), 422);
  await check(
    'Reject missing image',
    `${route}/999999999999`,
    ['-X', 'PUT', '-F', `uploadimage=@${firstFile};type=image/png`],
    404,
  );
  await check(
    'Reject untrusted upload origin',
    route,
    [
      '-X',
      'POST',
      '-H',
      'Origin: https://untrusted.example',
      '-F',
      `uploadimage=@${firstFile};type=image/png`,
    ],
    403,
  );
  await check('Delete primary image', `${route}/${second.id}`, json('DELETE'), 204);
  await check('Remaining image becomes primary', route, [], 200).then((body) => {
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, first.id);
    assert.equal(body.data[0].is_primary, true);
  });
  await check('Delete replaced image', `${route}/${first.id}`, json('DELETE'), 204);
  await check('Verify image list empty', route, [], 200).then((body) =>
    assert.equal(body.data.length, 0),
  );
  await check(
    'Repeated deletion returns not found',
    `${route}/${first.id}`,
    json('DELETE'),
    404,
  );
  await check('Delete temporary product', `/products/${productId}`, json('DELETE'), 204);
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (productId) {
    const rows = await models.productImage.findAll({ where: { product_id: productId } });
    for (const row of rows) keys.add(row.s3_key);
    await models.productCatalog.destroy({
      where: { 'data.source_product_id': String(productId) },
    });
    await models.product.destroy({ where: { product_id: productId } });
  }
  for (const Key of keys)
    await s3.send(new DeleteObjectCommand({ Bucket: 'prod-merabetta', Key }));
  if (user) {
    await models.session.destroy({ where: { userId: user.id, realm: 'admin' } });
    await user.destroy();
  }
  await sequelize.close();
  await rm(directory, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
