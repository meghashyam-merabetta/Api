import test from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../src/models/index.js';
import { listLabs } from '../src/admin/labs/labs.controller.js';
import { labsRoutes } from '../src/admin/labs/labs.routes.js';
import {
  createLabSchema,
  labIdParamsSchema,
  listLabsQuerySchema,
  updateLabSchema,
} from '../src/admin/labs/labs.schema.js';

const validLab = {
  id: 'redcliffe',
  name: 'Redcliffe Labs',
  description: 'Home sample collection and digital reports',
  rating: 4.8,
  image: 'lab.png',
  color: '#e26570',
  bg: '#fff0f1',
  active: true,
  city: 'Pune',
  homeCollection: true,
};

test('admin lab schemas match the app-facing labs table', () => {
  assert.deepEqual(createLabSchema.parse(validLab), validLab);
  assert.throws(() => createLabSchema.parse({ ...validLab, id: 'Bad ID' }));
  assert.throws(() => createLabSchema.parse({ ...validLab, rating: 5.1 }));
  assert.throws(() => createLabSchema.parse({ ...validLab, color: 'red' }));
  assert.throws(() => updateLabSchema.parse({}));
  assert.equal(updateLabSchema.safeParse({ id: 'changed' }).success, false);
  assert.equal(labIdParamsSchema.parse({ labId: 'redcliffe' }).labId, 'redcliffe');
  assert.deepEqual(listLabsQuerySchema.parse({}), {
    limit: 20,
    offset: 0,
    sort_by: 'name',
    sort_order: 'asc',
  });
});

test('admin lab routes provide authenticated CRUD definitions', () => {
  assert.deepEqual(
    labsRoutes.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    [
      'GET /:labId/image',
      'POST /:labId/image',
      'PUT /:labId/image',
      'GET /',
      'POST /',
      'GET /:labId',
      'PATCH /:labId',
      'DELETE /:labId',
    ],
  );
  assert.ok(labsRoutes.every((route) => route.auth !== false));
});

test('admin lab list applies filters, safe sorting, and pagination', async (t) => {
  let options;
  t.mock.method(models.lab, 'findAndCountAll', async (value) => {
    options = value;
    return {
      rows: [{ id: 'redcliffe' }],
      count: 1,
    };
  });
  let body;
  await listLabs(
    {
      validatedQuery: {
        limit: 10,
        offset: 0,
        search: 'Pune',
        city: 'Pune',
        active: 'true',
        homeCollection: 'true',
        sort_by: 'rating',
        sort_order: 'desc',
      },
    },
    {
      set() {},
      json(value) {
        body = value;
      },
    },
  );
  assert.equal(options.where.city, 'Pune');
  assert.equal(options.where.active, true);
  assert.equal(options.where.homeCollection, true);
  assert.deepEqual(options.order, [
    ['rating', 'DESC'],
    ['id', 'ASC'],
  ]);
  assert.deepEqual(body.pagination, { total: 1, limit: 10, offset: 0, hasMore: false });
});
