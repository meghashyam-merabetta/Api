import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Op } from 'sequelize';
import { app } from '../src/app.js';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';

const paths = ['/api/app/labs/lablisting', '/api/app/lablisting', '/api/lablisting'];

test('lablisting canonical and legacy URLs share filtering, pagination and validation', async (t) => {
  const calls = [];
  t.mock.method(models.lab, 'findAndCountAll', async (options) => {
    calls.push(options);
    return {
      rows: [{ id: 'test-lab', toJSON: () => ({ id: 'test-lab', name: 'Test Lab' }) }],
      count: 42,
    };
  });
  t.mock.method(sequelize, 'query', async (sql, options) => {
    assert.match(sql, /FROM lab_packages WHERE active/);
    assert.deepEqual(options.replacements.ids, ['test-lab']);
    return [{ lab_id: 'test-lab', count: 7 }];
  });
  for (const path of paths) {
    const response = await request(app)
      .get(path)
      .query({
        page: 2,
        limit: 5,
        search: 'blood',
        city: 'Delhi',
        homeCollection: 'true',
      });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, {
      data: [{ id: 'test-lab', name: 'Test Lab', testCount: 7 }],
      pagination: { page: 2, limit: 5, total: 42, totalPages: 9 },
    });
    const options = calls.at(-1);
    assert.equal(options.limit, 5);
    assert.equal(options.offset, 5);
    assert.equal(options.where.city, 'Delhi');
    assert.equal(options.where.homeCollection, true);
    assert.equal(options.where[Op.or][0].name[Op.iLike], '%blood%');
    const count = calls.length;
    assert.equal((await request(app).get(path).query({ limit: 0 })).status, 422);
    assert.equal((await request(app).get(path).query({ unknown: 'value' })).status, 422);
    assert.equal(calls.length, count, 'Invalid requests must not query the database');
  }
});
