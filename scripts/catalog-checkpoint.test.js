import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sequelize } from 'sequelize';
import sqlUtils from 'sequelize/lib/utils/sql';
const { injectReplacements } = sqlUtils;

test('catalogue checkpoint binds all parameters, including the processed increment', () => {
  const source = readFileSync(new URL('../src/app/redcliffe-labs/catalog.js', import.meta.url), 'utf8');
  const sql = source.match(/"(UPDATE lab_catalog_sync SET status=:status[^"\n]+)"/)[1];
  const database = new Sequelize('postgres://test:test@localhost/test', { logging: false });
  for (const done of [false, true]) {
    const bound = injectReplacements(sql, database.dialect, {
      status: done ? 'complete' : 'syncing', next: 2, count: 15, total: 1731, done,
    });
    assert.doesNotMatch(bound, /:[a-z]+/i);
    assert.match(bound, /processed\s*=\s*processed\s*\+\s*15/);
    assert.match(bound, new RegExp(`CASE WHEN ${done} THEN now\\(\\)`));
  }
});
