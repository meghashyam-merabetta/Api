import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createLocalImageClient } from '../src/shared/image-client.js';
import { updateProductSchema } from '../src/admin/products/products.schema.js';
import { validateAdditionalProductDetails } from '../src/shared/product-details.js';
import { createWarehouseSchema } from '../src/admin/warehouses/warehouses.schema.js';
import { createAdminSchema } from '../src/admin/management/admin.schema.js';

test('additional details are typed and partial updates validate stored relationships', () => {
  for (const input of [
    { heat_resistant: 'false' },
    { business_offer_percent: 101 },
    { age_min: 1.5 },
    { fulfillment_channel: 'unknown' },
    { manufacturer_email: 'invalid' },
    { manufacturing_date: '2026-02-30' },
    { seller_pincodes: ['012345'] },
  ])
    assert.equal(
      updateProductSchema.safeParse(input).success,
      false,
      JSON.stringify(input),
    );
  assert.throws(
    () =>
      validateAdditionalProductDetails(
        { age_min: 10 },
        { age_max: 5, age_unit: 'years' },
      ),
    /Minimum age/,
  );
  assert.throws(
    () => validateAdditionalProductDetails({ product_length: 0 }, {}),
    /product_dimension_unit/,
  );
  assert.throws(
    () =>
      validateAdditionalProductDetails({ net_weight_unit: null }, { net_weight: 0.5 }),
    /net_weight_unit/,
  );
  assert.doesNotThrow(() =>
    validateAdditionalProductDetails(
      { age_min: null, age_max: null, age_unit: null },
      { age_min: 1, age_max: 2, age_unit: 'years' },
    ),
  );
  assert.equal(
    createWarehouseSchema.safeParse({ warehouseName: 'Only name' }).success,
    false,
  );
});

test('normal CMS admins receive inventory adjustment permission by default', () => {
  const result = createAdminSchema.parse({
    name: 'CMS Admin',
    email: 'cms-admin@example.invalid',
    password: 'Valid-password-123',
    city: 'Pune',
    pincode: '411001',
    state: 'Maharashtra',
  });

  assert.deepEqual(result.permissions, ['inventory.adjust']);
  assert.deepEqual(
    createAdminSchema.parse({
      name: 'Restricted Admin',
      email: 'restricted@example.invalid',
      password: 'Valid-password-123',
      city: 'Pune',
      pincode: '411001',
      state: 'Maharashtra',
      permissions: [],
    }).permissions,
    [],
  );
});

test('local storage uses immutable files, safe paths and real provider listing/deletion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-provider-test-'));
  const client = createLocalImageClient(directory);
  const key = 'upload/products/1/12345678-1234-1234-1234-123456789012.png';
  try {
    await client.send(new PutObjectCommand({ Key: key, Body: Buffer.from('bytes') }));
    await assert.rejects(
      client.send(new PutObjectCommand({ Key: key, Body: Buffer.from('replacement') })),
      { code: 'EEXIST' },
    );
    await client.send(new HeadObjectCommand({ Key: key }));
    const page = await client.send(
      new ListObjectsV2Command({ Prefix: 'upload/products/' }),
    );
    assert.equal(page.Contents[0].Key, key);
    assert.equal(page.IsTruncated, false);
    await assert.rejects(
      client.send(new PutObjectCommand({ Key: '../escape', Body: Buffer.from('bytes') })),
      /Invalid local image key/,
    );
    await client.send(new DeleteObjectCommand({ Key: key }));
    await client.send(new DeleteObjectCommand({ Key: key }));
    await assert.rejects(
      client.send(new HeadObjectCommand({ Key: key })),
      (error) => error.$metadata.httpStatusCode === 404,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
