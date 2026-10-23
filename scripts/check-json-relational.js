import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/config/database.js';

const apply = process.argv.includes('--apply');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const transaction = await sequelize.transaction();
const query = (sql, replacements) => sequelize.query(sql, { transaction, replacements, logging: false, type: QueryTypes.SELECT });
try {
  await query("SET LOCAL statement_timeout = '120s'");
  await query("SET LOCAL lock_timeout = '10s'");
  await sequelize.query(readFileSync(new URL('../sql/028-json-relational-storage.sql', import.meta.url), 'utf8'), { transaction, logging: false });
  await sequelize.query(readFileSync(new URL('../sql/029-app-json-scope.sql', import.meta.url), 'utf8'), { transaction, logging: false });
  const sources = await query('SELECT * FROM json_relational.sources ORDER BY source_table');
  const appSources = new Set(['customer_addresses','customer_contact_backfill_audit','customer_login_logs','customer_otp_challenges','lab_bookings','lab_packages','lab_service_areas','order_details','orders','product_checkouts','product_catalog','product_variants','vendors','third_party_api_logs']);
  assert.ok(sources.every(source => appSources.has(source.source_table)), 'Only App/API sources may be mirrored');
  let nodeCount = 0;
  for (const source of sources) {
    const name = quote(source.source_table);
    const [counts] = await query(`SELECT
      (SELECT count(*) FROM public.${name} s CROSS JOIN unnest(ARRAY[:columns]::text[]) c
       CROSS JOIN LATERAL json_relational.nodes(CASE WHEN c='response_body' THEN json_relational.response_document(to_jsonb(s)->c) ELSE to_jsonb(s)->c END,ARRAY[c]) n)::int AS expected,
      (SELECT count(*) FROM json_relational.${name})::int AS actual`, { columns: source.json_columns });
    assert.equal(counts.actual, counts.expected, source.source_table + ' backfill count');
    nodeCount += counts.actual;
  }
  const [headerCounts] = await query(`SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM lab_bookings) AS expected,
    (SELECT count(*) FROM app_reporting.order_headers) AS actual`);
  assert.equal(String(headerCounts.actual), String(headerCounts.expected));
  const [packageCounts] = await query('SELECT (SELECT count(*) FROM lab_packages) AS expected,(SELECT count(*) FROM app_reporting.lab_packages) AS actual');
  assert.equal(String(packageCounts.actual), String(packageCounts.expected));
  const nodes = await query(`SELECT * FROM json_relational.nodes('{
    "empty":[],"nil":null,"list":[true,12.50,"12.50",{},[false]],"slash/key":"text"}'::jsonb)`);
  assert.equal(nodes.find(n => n.field_path.join('/') === 'list/1').number_value, '12.50');
  assert.equal(nodes.find(n => n.field_path.join('/') === 'list/2').text_value, '12.50');
  assert.equal(nodes.find(n => n.field_path.join('/') === 'nil').value_type, 'null');
  assert.equal(nodes.find(n => n.field_path.join('/') === 'empty').value_type, 'array');
  assert.ok(nodes.some(n => n.field_path.length === 1 && n.field_path[0] === 'slash/key'));
  await query('SAVEPOINT fixtures');
  const [customer] = await query('SELECT id FROM customers LIMIT 1');
  assert.ok(customer, 'Need one customer for rollback-only FK checks');
  const id = 'MB99123199999';
  const marker = randomUUID();
  const payload = {
    id, kind: 'products', status: 'Processing', paymentStatus: 'Cash on delivery', paymentMethod: 'cod',
    total: 175, subtotal: 150, discount: 15, delivery: 40, couponCode: 'RELATIONALTEST',
    addressSnapshot: { line1: 'Saved order address', city: 'Pune', postalCode: '411001', location: { latitude: 18.5, longitude: 73.8 } },
    items: [{ id: 'shop:123', quantity: 2, snapshot: { name: 'Test item', price: 75, mrp: 100, productId: '123', variantId: '456' } }],
  };
  await query(`INSERT INTO orders(id,customer_id,request_key,fingerprint,amount_paise,payload)
    VALUES(:id,:customer,:key,:fingerprint,17500,CAST(:payload AS jsonb))`, {
    id, customer: customer.id, key: marker, fingerprint: 'a'.repeat(64), payload: JSON.stringify(payload),
  });
  let [header] = await query('SELECT * FROM app_reporting.order_headers WHERE source_id=:id', { id });
  assert.equal(Number(header.total), 175);
  assert.equal(header.payment_method, 'cod');
  const [item] = await query('SELECT * FROM app_reporting.order_items WHERE source_id=:id', { id });
  assert.equal(item.product_id, '123');
  assert.equal(Number(item.quantity), 2);
  payload.total = 100; payload.items = []; payload.addressSnapshot.city = 'Mumbai';
  await query('UPDATE orders SET payload=CAST(:payload AS jsonb) WHERE id=:id', { id, payload: JSON.stringify(payload) });
  [header] = await query('SELECT * FROM app_reporting.order_headers WHERE source_id=:id', { id });
  assert.equal(Number(header.total), 100);
  assert.equal((await query('SELECT * FROM app_reporting.order_items WHERE source_id=:id', { id })).length, 0);
  const [city] = await query('SELECT city FROM app_reporting.order_addresses WHERE source_id=:id', { id });
  assert.equal(city.city, 'Mumbai');
  const [mirrored] = await query("SELECT text_value FROM json_relational.orders WHERE id=:id AND field_path=ARRAY['payload','addressSnapshot','city']", { id });
  assert.equal(mirrored.text_value, 'Mumbai');
  await query('DELETE FROM orders WHERE id=:id', { id });
  assert.equal((await query('SELECT * FROM app_reporting.order_headers WHERE source_id=:id', { id })).length, 0);
  assert.equal((await query('SELECT * FROM json_relational.orders WHERE id=:id', { id })).length, 0);
  const bookingId = randomUUID();
  const labPayload = { ...payload, kind: 'labs', recipient: { id: 'saved-person', name: 'First patient' },
    items: [{ id: 'redcliffe:TEST', quantity: 1, snapshot: { packageCode: 'TEST', name: 'Lab test', price: 100 } }],
    additionalMembers: [{ id: 'second-person', name: 'Second patient', items: [{ id: 'redcliffe:TEST', quantity: 1, snapshot: { packageCode: 'TEST', price: 100 } }] }],
    reports: [{ id: 'report-1', patientId: 'second-person', label: 'Test report' }],
  };
  await query('INSERT INTO lab_bookings(id,customer_id,request_key,payload) VALUES(:id,:customer,:key,CAST(:payload AS jsonb))', { id: bookingId, customer: customer.id, key: marker, payload: JSON.stringify(labPayload) });
  assert.equal((await query('SELECT * FROM app_reporting.order_patients WHERE source_id=:id', { id: bookingId })).length, 2);
  assert.equal((await query('SELECT * FROM app_reporting.order_items WHERE source_id=:id', { id: bookingId })).length, 2);
  assert.equal((await query('SELECT * FROM app_reporting.order_reports WHERE source_id=:id', { id: bookingId })).length, 1);
  await query('ROLLBACK TO SAVEPOINT fixtures');
  if (apply) await transaction.commit(); else await transaction.rollback();
  console.log(`PASS: ${sources.length} source tables, ${nodeCount} nodes; typed backfill, insert/update/delete, nested arrays, multiple patients and rollback. ${apply ? 'Migration committed.' : 'Dry run rolled back.'}`);
} catch (error) {
  await transaction.rollback();
  console.error('Relational storage check failed:', error.message);
  process.exitCode = 1;
} finally { await sequelize.close(); }
