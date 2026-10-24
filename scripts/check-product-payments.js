import {readPricingSettings, chargeBelow} from '../src/app/pricing/settings.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import {
  createOrder,
  findOrder,
  syncOrder,
  applyPaymentStatus,
  verifiedStatus,
  listOrders,
} from '../src/app/orders/orders.controller.js';
import { paymentWebhook } from '../src/app/hdfc/callbacks.js';
assert.notEqual(env.NODE_ENV, 'production', 'Run against non-production data only');
const marker = 'paymentcheck-' + randomUUID(),
  customerId = randomUUID();
const saved = { ...env },
  originalFetch = global.fetch;
let productId,
  variantId,
  offerId,
  inventoryId,
  sessionCalls = 0;
let rejectSession = true;
const responses = new Map(),
  orderIds = [];
const couponCode = 'CHECK_' + randomUUID().replaceAll('-', '').toUpperCase();
const query = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
async function stock() {
  return (
    await query('SELECT quantity_on_hand,quantity_reserved FROM inventory WHERE id=:id', {
      id: inventoryId,
    })
  )[0];
}
let customer;
async function checkout(quantity, key = randomUUID(), paymentMethod = 'online') {
  let result;
  const req = {
    credential: customer.get({ plain: true }),
    validated: {
      paymentMethod,
      requestKey: key,
      items: [{ id: 'shop:' + offerId, quantity }],
      address: {
        line1: 'Payment fixture only',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
      },
      notes: marker,
      couponCode,
    },
  };
  await createOrder(req, {
    status() {
      return this;
    },
    json(value) {
      result = value;
    },
  });
  return result;
}
try {
  Object.assign(env, {
    HDFC_ENVIRONMENT: 'production',
    HDFC_API_KEY: 'test-key',
    HDFC_MERCHANT_ID: 'test-merchant',
    HDFC_CLIENT_ID: 'test-client',
    HDFC_RETURN_URL: 'https://merchant.example/api/payments/hdfc/return',
    HDFC_WEBHOOK_USER: 'test-hook',
    HDFC_WEBHOOK_PASSWORD: 'test-password',
  });
  global.fetch = async (url, options) => {
    assert.equal(
      options.headers.Authorization,
      'Basic ' + Buffer.from('test-key:').toString('base64'),
    );
    assert.ok(String(url).startsWith('https://smartgateway.hdfc.bank.in/'));
    if (options.method === 'POST') {
      sessionCalls++;
      const body = JSON.parse(options.body);
      orderIds.push(body.order_id);
      if (rejectSession) return Response.json({ status: 'error', error_code: 'access_denied' }, { status: 401 });
      assert.equal(body.payment_page_client_id, 'test-client');
      const result = {
        order_id: body.order_id,
        merchant_id: 'test-merchant',
        currency: 'INR',
        amount: body.amount,
        status: 'PENDING',
        txn_id: marker,
        txn_detail: { gateway: 'HDFC' },
        gateway_id: 1,
      };
      responses.set(body.order_id, result);
      return Response.json({
        order_id: body.order_id,
        payment_links: {
          web: 'https://smartgateway.hdfc.bank.in/payment-page/' + body.order_id,
        },
      });
    }
    const id = String(url).split('/').pop();
    assert.ok(responses.has(id));
    return Response.json(responses.get(id));
  };
  customer = await models.customer.create({
    id: customerId,
    firstName: 'Payment',
    lastName: 'Fixture',
    phone: '9876543210',
    email: marker + '@example.com',
  });
  const [vendor] = await query(
    "SELECT id FROM vendors WHERE vendor_status='active' LIMIT 1",
  );
  const [category] = await query('SELECT id FROM categories WHERE is_active LIMIT 1');
  assert.ok(vendor && category);
  [{ id: productId }] = await query(
    "INSERT INTO products(name,slug,product_status) VALUES(:name,:name,'active') RETURNING id",
    { name: marker },
  );
  await query(
    'INSERT INTO product_categories(product_id,category_id,is_primary) VALUES(:product,:category,true)',
    { product: productId, category: category.id },
  );
  [{ id: variantId }] = await query(
    "INSERT INTO product_variants(product_id,sku,variant_name,is_active) VALUES(:product,:sku,'Test',true) RETURNING id",
    { product: productId, sku: marker },
  );
  [{ id: offerId }] = await query(
    "INSERT INTO vendor_products(vendor_id,variant_id,selling_price,mrp,currency,offer_status) VALUES(:vendor,:variant,100,199,'INR','active') RETURNING id",
    { vendor: vendor.id, variant: variantId },
  );
  [{ id: inventoryId }] = await query(
    'INSERT INTO inventory(vendor_product_id,warehouse_code,quantity_on_hand,quantity_reserved) VALUES(:offer,:code,3,0) RETURNING id',
    { offer: offerId, code: marker },
  );
  await query(
    "INSERT INTO coupons(code,scope,percent,max_discount_paise,active) VALUES(:code,'products',10,10000,true)",
    { code: couponCode },
  );
  const key = randomUUID();
  await assert.rejects(checkout(2, key), /HDFC payment access was rejected/);
  assert.equal((await findOrder(orderIds[0])).session_state, 'created');
  assert.deepEqual(await stock(), { quantity_on_hand: 3, quantity_reserved: 2 });
  rejectSession = false;
  const first = await checkout(2, key);
  assert.equal(first.id, orderIds[0], 'Credential fix retries the same checkout without duplicate stock reservations');
  const policy = await readPricingSettings();
  const expectedTotal = 180 + (chargeBelow(20000, policy.product_delivery_below_paise, policy.product_delivery_charge_paise) + chargeBelow(20000, policy.product_handling_below_paise, policy.product_handling_charge_paise)) / 100;
  assert.equal(first.total, expectedTotal);
  assert.equal(first.discount, 20);
  assert.equal((await query('SELECT id FROM orders WHERE customer_id=:id', { id: customerId })).length, 0, 'No order exists before payment');
  assert.equal((await query('SELECT order_id FROM order_details WHERE order_id=:id', { id: first.id })).length, 0, 'No order lines exist before payment');
  let visible;
  const listed = async () => {
    await listOrders({ credential: { id: customerId } }, { json: value => { visible = value.data; } });
    return visible;
  };
  assert.equal((await listed()).length, 0, 'Unpaid checkout must not appear as a placed order');
  assert.equal(responses.get(first.id).amount, expectedTotal.toFixed(2));
  assert.deepEqual(await stock(), { quantity_on_hand: 3, quantity_reserved: 2 });
  await checkout(2, key);
  await checkout(2);
  assert.equal(sessionCalls, 2);
  await assert.rejects(checkout(3));
  await assert.rejects(
    applyPaymentStatus(first.id, {
      ...responses.get(first.id),
      amount: '1',
      status: 'CHARGED',
    }),
  );
  assert.deepEqual(await stock(), { quantity_on_hand: 3, quantity_reserved: 2 });
  const paidFixture = { ...responses.get(first.id), status: 'CHARGED' };
  const checkoutFixture = await findOrder(first.id);
  assert.equal(verifiedStatus(checkoutFixture, { ...paidFixture, txn_detail: { gateway: 'DUMMY' }, gateway_id: 100 }), 'FAILED');
  assert.equal(verifiedStatus(checkoutFixture, { ...paidFixture, test_mode: true }), 'FAILED');
  assert.equal(verifiedStatus({ ...checkoutFixture, payload: { ...checkoutFixture.payload, paymentEnvironment: 'sandbox' } }, paidFixture), 'FAILED');
  assert.equal(verifiedStatus(checkoutFixture, { ...paidFixture, txn_detail: {}, gateway_id: null }), 'FAILED');
  responses.get(first.id).status = 'CHARGED';
  const before = await findOrder(first.id, customerId);
  await Promise.all([syncOrder(before), syncOrder(before)]);
  assert.deepEqual(await stock(), { quantity_on_hand: 1, quantity_reserved: 0 });
  assert.equal((await findOrder(first.id)).stock_state, 'deducted');
  assert.equal((await query('SELECT id FROM orders WHERE id=:id', { id: first.id })).length, 1, 'Concurrent verified callbacks create exactly one order');
  assert.equal((await query('SELECT order_id FROM order_details WHERE order_id=:id', { id: first.id })).length, 1);
  assert.deepEqual((await listed()).map(order => order.id), [first.id]);
  await paymentWebhook(
    {
      get: () => 'Basic ' + Buffer.from('test-hook:test-password').toString('base64'),
      body: { content: { order: { order_id: first.id, status: 'FAILED' } } },
    },
    { json() {} },
  );
  assert.deepEqual(await stock(), { quantity_on_hand: 1, quantity_reserved: 0 });
  await assert.rejects(paymentWebhook({ get: () => '', body: {} }, { json() {} }));
  const failed = await checkout(1);
  responses.get(failed.id).status = 'AUTHORIZATION_FAILED';
  await syncOrder(await findOrder(failed.id));
  assert.deepEqual(await stock(), { quantity_on_hand: 1, quantity_reserved: 0 });
  assert.equal((await findOrder(failed.id)).payment_url, null);
  assert.equal((await query('SELECT id FROM orders WHERE id=:id', { id: failed.id })).length, 0, 'Failed payment creates no order');
  assert.ok(!(await listed()).some(order => order.id === failed.id), 'Failed payment must not appear as a placed order');
  const retry = await checkout(1);
  assert.notEqual(retry.id, failed.id);
  responses.get(retry.id).status = 'CHARGED';
  await syncOrder(await findOrder(retry.id));
  assert.deepEqual(await stock(), { quantity_on_hand: 0, quantity_reserved: 0 });
  responses.get(failed.id).status = 'CHARGED';
  await syncOrder(await findOrder(failed.id));
  assert.equal((await findOrder(failed.id)).stock_state, 'review');
  assert.equal((await findOrder(failed.id)).payment_status, 'CHARGED');
  assert.deepEqual(await stock(), { quantity_on_hand: 0, quantity_reserved: 0 });
  await query('UPDATE inventory SET quantity_on_hand=2 WHERE id=:id', { id: inventoryId });
  const callsBeforeCod = sessionCalls;
  const codKey = randomUUID();
  const cod = await checkout(1, codKey, 'cod');
  orderIds.push(cod.id);
  assert.equal(cod.paymentMethod, 'cod');
  assert.equal(cod.paymentStatus, 'Cash on delivery');
  assert.equal(cod.paymentUrl, null);
  assert.equal(sessionCalls, callsBeforeCod);
  assert.ok((await listed()).some(order => order.id === cod.id), 'COD is a placed order without online payment');
  assert.equal((await checkout(1, codKey, 'cod')).id, cod.id);
  assert.deepEqual(await stock(), { quantity_on_hand: 1, quantity_reserved: 0 });
  assert.equal((await syncOrder(await findOrder(cod.id))).payment_status, 'COD');
  assert.equal(sessionCalls, callsBeforeCod);
  console.log('PASS: COD saves without gateway, deducts stock once, remains unpaid and replays safely.');
  console.log(
    'PASS: real DB checkout/reservation, coupon amount, session retry, concurrent duplicate success, stock deduction once, failed-payment release, webhook auth, amount mismatch and late-success stock review. All gateway calls mocked; no real payment sent.',
  );
} finally {
  global.fetch = originalFetch;
  Object.assign(env, saved);
  await query(
    'DELETE FROM order_stock_reservations WHERE order_id IN (SELECT id FROM product_checkouts WHERE customer_id=:id)',
    { id: customerId },
  );
  await query(
    'DELETE FROM order_details WHERE order_id IN (SELECT id FROM orders WHERE customer_id=:id)',
    { id: customerId },
  );
  await query('DELETE FROM orders WHERE customer_id=:id', { id: customerId });
  await query('DELETE FROM product_checkouts WHERE customer_id=:id', { id: customerId });
  if (inventoryId) await query('DELETE FROM inventory WHERE id=:id', { id: inventoryId });
  if (offerId) await query('DELETE FROM vendor_products WHERE id=:id', { id: offerId });
  if (variantId)
    await query('DELETE FROM product_variants WHERE id=:id', { id: variantId });
  if (productId) {
    await query('DELETE FROM product_categories WHERE product_id=:id', { id: productId });
    await query('DELETE FROM products WHERE id=:id', { id: productId });
  }
  await models.customer.destroy({ where: { id: customerId }, force: true });
  await query('DELETE FROM coupons WHERE code=:code', { code: couponCode });
  for (const id of orderIds)
    await query(
      "DELETE FROM third_party_api_logs WHERE provider='hdfc' AND (endpoint=:endpoint OR response_body LIKE :pattern)",
      { endpoint: '/orders/' + id, pattern: '%' + id + '%' },
    );
  await sequelize.close();
}
