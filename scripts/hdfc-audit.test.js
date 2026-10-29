import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { sequelize } from '../src/config/database.js';
import { nextOrderId } from '../src/app/orders/order-number.js';
import { applyPaymentStatus, verifiedStatus } from '../src/app/orders/orders.controller.js';
import { paymentReturnUrl, verifyReturnToken } from '../src/app/hdfc/return-token.js';
import { paymentReturn } from '../src/app/hdfc/callbacks.js';
import { receiptHtml } from '../src/app/hdfc/receipt.js';

const id = 'MB1234567890abcdef12';
const paid = { order_id: id, amount: '123.45', merchant_id: 'audit', currency: 'INR', status: 'CHARGED', txn_id: 'audit-txn', gateway: 'DUMMY', test_mode: true };
function setup(t) {
  const original = { ...env };
  Object.assign(env, { NODE_ENV: 'production', HDFC_ENVIRONMENT: 'sandbox', HDFC_MERCHANT_ID: 'audit', HDFC_API_KEY: 'unit-test-key', HDFC_CLIENT_ID: 'hdfcmaster', HDFC_RETURN_URL: 'https://uat.example.test/api/payments/hdfc/return' });
  t.after(() => Object.assign(env, original));
  return { id, customer_id: 'unit-test-customer', amount_paise: 12345, payment_status: 'PENDING', stock_state: 'released', payload: { paymentEnvironment: 'sandbox', items: [] }, payment_url: 'https://smartgateway.hdfcuat.bank.in/pay/test' };
}
test('gateway IDs are random alphanumeric under 21 chars', async () => {
  const ids = await Promise.all(Array.from({ length: 1000 }, () => nextOrderId()));
  assert.equal(new Set(ids).size, ids.length);
  for (const value of ids) assert.match(value, /^MB[a-f0-9]{18}$/);
});
test('signed return links bind the order, expire and reject tampering', t => {
  const row = setup(t);
  const now = 1800000000000;
  const token = paymentReturnUrl(row, now).split('/').pop();
  assert.equal(verifyReturnToken(token, now), id);
  assert.throws(() => verifyReturnToken(token.replace(id, 'MBaaaaaaaaaaaaaaaaaa'), now));
  assert.throws(() => verifyReturnToken(token + 'x', now));
  assert.throws(() => verifyReturnToken(token, now + 8 * 86400000));
  assert.throws(() => verifyReturnToken(['invalid'], now));
  assert.equal(new URL(paymentReturnUrl(row, now)).search, '');
});
test('sandbox CHARGED persists success but never writes orders or inventory', async t => {
  const row = setup(t);
  t.mock.method(sequelize, 'transaction', async fn => fn({}));
  const writes = [];
  t.mock.method(sequelize, 'query', async (sql, options) => {
    if (sql.startsWith('SELECT * FROM product_checkouts')) return [row];
    assert.ok(sql.startsWith('UPDATE product_checkouts SET'), sql);
    writes.push(options.replacements);
    return [];
  });
  const result = await applyPaymentStatus(id, paid);
  assert.equal(result.payment_status, 'CHARGED');
  assert.equal(result.payload.fulfillmentBlocked, true);
  assert.equal(result.stock_state, 'released');
  assert.equal(writes.length, 1);
  assert.equal(verifiedStatus(row, { ...paid, status: 'AUTHORIZING' }), 'PENDING');
  assert.throws(() => verifiedStatus(row, { ...paid, amount: '0.01' }));
});
function response() {
  return { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, type() { return this; }, send(html) { this.html = html; return this; } };
}
test('return ignores forged success, calls Status API and displays pending', async t => {
  const row = setup(t);
  let calls = 0;
  t.mock.method(sequelize, 'transaction', async fn => fn({}));
  t.mock.method(sequelize, 'query', async sql => sql.startsWith('SELECT * FROM product_checkouts') ? [row] : []);
  t.mock.method(globalThis, 'fetch', async url => {
    calls++; assert.equal(url, `https://smartgateway.hdfcuat.bank.in/orders/${id}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ...paid, status: 'AUTHORIZING' }) };
  });
  const res = response();
  await paymentReturn({ params: { token: paymentReturnUrl(row).split('/').pop() }, query: { order_id: id, status: 'CHARGED', amount: '0.01' } }, res);
  assert.equal(calls, 1);
  assert.match(res.html, /Payment verification pending/);
  assert.match(res.html, /INR 123.45/);
  assert.doesNotMatch(res.html, /Download receipt/);
});
test('return rejects wrong order before accessing database', async t => {
  const row = setup(t);
  t.mock.method(sequelize, 'query', () => assert.fail('Database must not be called'));
  await assert.rejects(paymentReturn({ params: { token: paymentReturnUrl(row).split('/').pop() }, query: { order_id: 'other' } }, response()), /does not match/);
});
test('paid return still verifies with gateway and offers receipt; outage cannot claim success', async t => {
  const row = { ...setup(t), payment_status: 'CHARGED', transaction_id: 'audit-txn', payment_url: null };
  t.mock.method(sequelize, 'transaction', async fn => fn({}));
  t.mock.method(sequelize, 'query', async sql => sql.startsWith('SELECT * FROM product_checkouts') ? [row] : []);
  let fail = false, count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; if (fail) throw new Error('offline'); return { ok: true, status: 200, text: async () => JSON.stringify(paid) }; });
  const req = { params: { token: paymentReturnUrl(row).split('/').pop() }, query: {} };
  const success = response(); await paymentReturn(req, success);
  assert.match(success.html, /Payment successful/);
  assert.match(success.html, /Download receipt/);
  const download = response(); await paymentReturn({ ...req, query: { download: '1' } }, download);
  assert.match(download.headers['Content-Disposition'], /attachment/);
  fail = true;
  const pending = response(); await paymentReturn(req, pending);
  assert.equal(pending.statusCode, 202);
  assert.doesNotMatch(pending.html, /Payment successful/);
  assert.equal(count, 3);
});
test('receipt escapes transaction fields and does not expose customer PII', t => {
  const row = { ...setup(t), payment_status: 'CHARGED', transaction_id: '<script>alert(1)</script>' };
  const html = receiptHtml(row);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /unit-test-customer/);
});
test('verified live payment is promoted once; duplicate charged result is idempotent', async t => {
  const row = setup(t);
  env.HDFC_ENVIRONMENT = 'production';
  Object.assign(row, { stock_state: 'deducted', payload: { paymentEnvironment: 'production', items: [] }, payment_url: 'https://smartgateway.hdfc.bank.in/pay/test' });
  const data = { ...paid, gateway: 'HDFC', gateway_id: 2, test_mode: false };
  const writes = [];
  t.mock.method(sequelize, 'transaction', async fn => fn({}));
  t.mock.method(sequelize, 'query', async (sql) => {
    if (sql.startsWith('SELECT * FROM product_checkouts')) return [row];
    if (sql.startsWith('SELECT payload')) return [{ payload: row.payload }];
    writes.push(sql); return [];
  });
  await applyPaymentStatus(id, data);
  assert.equal(writes.filter(sql => sql.startsWith('INSERT INTO orders')).length, 1);
  row.payment_status = 'CHARGED';
  const before = writes.length;
  await applyPaymentStatus(id, data);
  assert.equal(writes.length, before);
});
test('live charged settles reserved stock; sandbox charged only releases old reservations', async t => {
  const row = setup(t);
  row.stock_state = 'reserved';
  const statements = [];
  t.mock.method(sequelize, 'transaction', async fn => fn({}));
  t.mock.method(sequelize, 'query', async sql => {
    statements.push(sql);
    if (sql.startsWith('SELECT * FROM product_checkouts')) return [row];
    if (sql.startsWith('SELECT r.inventory_id')) return [{ inventory_id: 1, quantity: 2 }];
    if (sql.startsWith('UPDATE inventory')) return [{ id: 1 }];
    if (sql.startsWith('SELECT payload')) return [{ payload: row.payload }];
    return [];
  });
  await applyPaymentStatus(id, paid);
  assert.ok(statements.some(sql => sql.startsWith('UPDATE inventory')));
  assert.ok(statements.every(sql => !sql.includes('quantity_on_hand=quantity_on_hand -')));
  assert.ok(statements.every(sql => !sql.startsWith('INSERT INTO orders')));
  statements.length = 0;
  env.HDFC_ENVIRONMENT = 'production';
  row.payload.paymentEnvironment = 'production';
  row.payment_url = 'https://smartgateway.hdfc.bank.in/pay/test';
  await applyPaymentStatus(id, { ...paid, gateway: 'HDFC', gateway_id: 2, test_mode: false });
  assert.ok(statements.some(sql => sql.includes('quantity_on_hand=quantity_on_hand -')));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO orders')));
});
