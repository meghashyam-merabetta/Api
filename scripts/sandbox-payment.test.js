import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { verifiedStatus, applyPaymentStatus } from '../src/app/orders/orders.controller.js';
import { sequelize } from '../src/config/database.js';

test('sandbox verification uses gateway environment even in production runtime', () => {
  const original = { ...env };
  try {
    Object.assign(env, { NODE_ENV: 'test', HDFC_ENVIRONMENT: 'sandbox', HDFC_MERCHANT_ID: 'sandbox-test' });
    const row = { id: 'MB123', amount_paise: 10000, payload: { paymentEnvironment: 'sandbox' }, payment_url: 'https://smartgateway.hdfcuat.bank.in/pay/test' };
    const paid = { order_id: row.id, amount: '100.00', currency: 'INR', merchant_id: 'sandbox-test', status: 'CHARGED', txn_id: 'test-transaction', gateway: 'DUMMY', test_mode: true };
    assert.equal(verifiedStatus(row, paid), 'CHARGED');
    assert.equal(verifiedStatus(row, { ...paid, status: 'AUTHORIZATION_FAILED' }), 'FAILED');
    assert.equal(verifiedStatus(row, { ...paid, status: 'PENDING' }), 'PENDING');
    assert.equal(verifiedStatus(row, { ...paid, status: 'PENDING_VBV' }), 'PENDING');
    assert.equal(verifiedStatus(row, { ...paid, status: 'AUTHORIZING' }), 'PENDING');
    for (const change of [{ amount: '99.00' }, { currency: 'USD' }, { merchant_id: 'wrong' }, { order_id: 'wrong' }])
      assert.throws(() => verifiedStatus(row, { ...paid, ...change }), /could not be verified/);
    assert.equal(verifiedStatus(row, { ...paid, txn_id: '' }), 'FAILED');
    assert.equal(verifiedStatus({ ...row, payload: {} }, paid), 'FAILED');
    assert.equal(verifiedStatus({ ...row, payment_url: 'https://smartgateway.hdfcuat.bank.in.evil.test/pay' }, paid), 'FAILED');
    env.NODE_ENV = 'production';
    assert.equal(verifiedStatus(row, paid), 'CHARGED');
    env.NODE_ENV = 'test'; env.HDFC_ENVIRONMENT = 'production';
    assert.equal(verifiedStatus(row, paid), 'FAILED');
  } finally { Object.assign(env, original); }
});

test('pending gateway statuses never promote a checkout to an order or deduct stock', async (t) => {
  const original = { ...env };
  Object.assign(env, { NODE_ENV: 'test', HDFC_ENVIRONMENT: 'sandbox', HDFC_MERCHANT_ID: 'sandbox-test' });
  t.after(() => Object.assign(env, original));
  const row = { id: 'MB123', amount_paise: 10000, payment_status: 'PENDING', stock_state: 'reserved', payload: { paymentEnvironment: 'sandbox', paymentMethod: 'online' }, payment_url: 'https://smartgateway.hdfcuat.bank.in/pay/test' };
  t.mock.method(sequelize, 'transaction', async (fn) => fn({}));
  const writes = [];
  t.mock.method(sequelize, 'query', async (sql, options) => {
    if (sql.startsWith('SELECT * FROM product_checkouts')) return [row];
    assert.ok(sql.startsWith('UPDATE product_checkouts SET'), 'Pending must not write orders or inventory');
    writes.push(options.replacements);
    return [];
  });
  for (const status of ['NEW', 'PENDING_VBV', 'AUTHORIZING']) {
    const result = await applyPaymentStatus(row.id, { order_id: row.id, amount: '100.00', currency: 'INR', merchant_id: 'sandbox-test', status });
    assert.equal(result.payment_status, 'PENDING');
    assert.equal(result.payload.paymentStatus, 'Pending');
    assert.equal(result.payload.status, 'Payment pending');
    assert.equal(result.stock_state, 'reserved');
  }
  assert.equal(writes.length, 3);
  assert.ok(writes.every(write => write.status === 'PENDING'));
});
