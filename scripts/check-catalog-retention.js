import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/config/database.js';

const source = readFileSync(new URL('../src/app/redcliffe-labs/catalog.js', import.meta.url), 'utf8');
const sql = source.match(/"(INSERT INTO lab_packages[^"\n]+)"/)[1];
assert.doesNotMatch(source, /SET\s+active\s*=\s*false/i);
const transaction = await sequelize.transaction({ logging: false });
try {
  const prefix = 'retention-' + randomUUID();
  const rows = [1, 2].map(n => ({ id: prefix + n, code: prefix + n,
    data: { name: 'Saved test ' + n, price: 100, mrp: 200, categories: ['Original'] }, raw: { code: prefix + n } }));
  const save = data => sequelize.query(sql, { replacements: { rows: JSON.stringify(data) }, transaction, logging: false });
  await save(rows);
  await save([{ ...rows[0], data: { name: 'Changed upstream name', price: 120, mrp: 250, categories: [] }, raw: { updated: true } }]);
  const result = await sequelize.query('SELECT * FROM lab_packages WHERE id IN (:ids) ORDER BY id', { replacements: { ids: rows.map(r => r.id) }, transaction, logging: false, type: QueryTypes.SELECT });
  assert.equal(result.length, 2);
  assert.ok(result.every(r => r.active));
  assert.equal(result[0].catalog_data.price, 120);
  assert.equal(result[0].catalog_data.mrp, 250);
  assert.equal(result[0].catalog_data.name, 'Saved test 1');
  assert.deepEqual(result[0].catalog_data.categories, ['Original']);
  assert.deepEqual(result[0].provider_data, { updated: true });
  assert.equal(result[1].catalog_data.price, 100);
  console.log('PASS: missing tests retained, new tests added, only existing price/MRP changed, raw provider response retained. Rolled back.');
} finally { await transaction.rollback(); await sequelize.close(); }
