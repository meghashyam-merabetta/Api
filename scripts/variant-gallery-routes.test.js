import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { sequelize } from '../src/config/database.js';
import { png } from '../test-support/image-fixtures.js';

test('all seven variant gallery routes are mounted and require admin authentication', async (t) => {
  t.mock.method(sequelize, 'query', async () => {
    throw new Error('Unauthenticated route probes must not access the database');
  });
  const root = '/api/admin/products/1/variants';
  const origin =
    env.ALLOWED_ORIGINS.find((value) => value !== '*') ?? 'http://localhost:5173';
  for (const [method, path, multipart] of [
    ['get', `${root}/2/images`],
    ['post', `${root}/2/images`, true],
    ['put', `${root}/2/images/3`, true],
    ['delete', `${root}/2/images/3`],
    ['patch', `${root}/2/images/3/primary`],
    ['patch', `${root}/2/images`],
    ['post', `${root}/images/share`],
  ]) {
    let call = request(app)[method](path).set('Origin', origin);
    if (multipart)
      call = call.attach('uploadimage', png, {
        filename: 'image.png',
        contentType: 'image/png',
      });
    else if (method !== 'get') call = call.send({});
    const result = await call;
    assert.equal(
      result.status,
      401,
      `${method.toUpperCase()} ${path}: ${JSON.stringify(result.body)}`,
    );
  }
});
