import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { contactRoutes } from '../src/app/contact/routes.js';
import { deliverContactNotification } from '../src/app/contact/notifications.js';
import { couponRoutes, resolveCoupon } from '../src/app/coupons/routes.js';
import { couponDiscount, labPricing as configuredLabPricing } from '../src/app/coupons/pricing.js';
import { buildRouter } from '../src/shared/routes.js';
import { csrfGuard } from '../src/shared/security.js';
import { sequelize } from '../src/config/database.js';
import { env } from '../src/config/env.js';

test('offer-price discounts, cap and collection boundary use paise', () => {
  const coupon = { percent: 10, max_discount_paise: 5000 };
  assert.deepEqual(labPricing(10000, coupon), { subtotal: 100, discount: 10, collection: 150, total: 240 });
  assert.equal(labPricing(30000, coupon).discount, 30);
  assert.equal(couponDiscount(100000, coupon), 5000);
  assert.equal(couponDiscount(101, coupon), 100);
  assert.equal(labPricing(59900, null).collection, 0);
  assert.equal(labPricing(59899, null).collection, 150);
  assert.equal(labPricing(60000, coupon).collection, 150);
  assert.equal(labPricing(0, null).collection, 150);
  assert.equal(labPricing(10000, null).discount, 0);
});

test('public contact submission validates and saves without authentication or Origin', async () => {
  const original = sequelize.query;
  const saved = [];
  sequelize.query = async (_sql, options) => { saved.push(options.replacements); return []; };
  const app = express();
  app.use(csrfGuard, express.json());
  app.use('/api/app', buildRouter(() => { throw Error('Must not authenticate'); }, contactRoutes));
  app.use((error, _req, res, _next) => res.status(error.name === 'ZodError' ? 422 : 500).json({ error: error.message }));
  try {
    const body = { name: ' Test User ', email: 'test@example.com', phone: '9876543210', message: 'Please contact me.' };
    const response = await request(app).post('/api/app/contact-enquiries').send(body);
    assert.equal(response.status, 201);
    assert.match(response.body.enquiryId, /^[a-f0-9-]{36}$/);
    assert.ok(response.body.confirmation);
    assert.equal(saved[0].name, 'Test User');
    for (const invalid of [{ ...body, email: 'bad' }, { ...body, phone: '123' }, { ...body, message: ' ' }]) {
      assert.equal((await request(app).post('/api/app/contact-enquiries').send(invalid)).status, 422);
    }
    assert.equal(saved.length, 1);
  } finally { sequelize.query = original; }
});

test('coupon lookup rejects wrong scope and expiry, lists active suggestions only', async () => {
  const original = sequelize.query;
  sequelize.query = async (sql, options) => {
    assert.match(sql, /active AND scope/); assert.match(sql, /ends_at>now/);
    return [{ code: 'BOTH10', scope: 'both', percent: 10, max_discount_paise: 10000 }, ...(options.replacements.scope === 'labs' ? [{ code: 'LAB10' }] : [])];
  };
  try {
    assert.equal(await resolveCoupon(undefined, 'labs'), null);
    assert.equal((await resolveCoupon('BOTH10', 'products')).code, 'BOTH10');
    await assert.rejects(resolveCoupon('LAB10', 'products'), /invalid/);
    await assert.rejects(resolveCoupon('EXPIRED', 'labs'), /invalid/);
    let result;
    await couponRoutes[0].handler({ validatedQuery: { scope: 'labs' } }, { json: value => { result = value; } });
    assert.equal(result.data.length, 2);
  } finally { sequelize.query = original; }
});

test('contact email goes to support and failed delivery remains retryable', async () => {
  const query = sequelize.query, transaction = sequelize.transaction;
  const config = { SMTP_HOST: env.SMTP_HOST, SMTP_USER: env.SMTP_USER, SMTP_PASSWORD: env.SMTP_PASSWORD, SMTP_FROM: env.SMTP_FROM };
  Object.assign(env, { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'test', SMTP_PASSWORD: 'test', SMTP_FROM: 'sender@example.com' });
  let outcome, fail = false;
  sequelize.transaction = async callback => callback({});
  sequelize.query = async (sql, options) => {
    if (sql.startsWith('SELECT')) return [{ id: 'id', name: 'User', email: 'user@example.com', phone: '9876543210', message: 'Hello' }];
    outcome = options.replacements.sent; return [];
  };
  try {
    const transport = () => ({ close() {}, async sendMail(mail) { assert.equal(mail.to, 'support@merabetta.com'); assert.equal(mail.replyTo, 'user@example.com'); if (fail) throw Error('SMTP failed'); return { accepted: [mail.to], rejected: [] }; } });
    await deliverContactNotification(transport); assert.equal(outcome, true);
    fail = true; await deliverContactNotification(transport); assert.equal(outcome, false);
  } finally { sequelize.query = query; sequelize.transaction = transaction; Object.assign(env, config); }
});

function labPricing(subtotal, coupon) { return configuredLabPricing(subtotal, coupon, {lab_collection_below_paise:59900,lab_collection_charge_paise:15000}); }
