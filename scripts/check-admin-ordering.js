import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sequelize } from '../src/config/database.js';
import { orderingQuery } from '../src/admin/ordering/ordering.schema.js';
import { buildFilter, csvCell, listOrdering, getOrdering } from '../src/admin/ordering/ordering.controller.js';
import { orderingRoutes } from '../src/admin/ordering/ordering.routes.js';
import { adminAuth } from '../src/admin/auth/auth.controller.js';
import { orderingSummary } from '../src/admin/ordering/ordering-presentation.js';

const response = () => ({ headers: {}, set(k, v) { this.headers[k] = v; return this; }, type(v) { this.contentType = v; return this; }, json(v) { this.body = v; }, send(v) { this.body = v; } });
try {
  const priced = orderingSummary({ total: '420', labId: 'redcliffe', payload: {
    kind: 'labs', subtotal: 300, discount: 30, collection: 150, couponCode: 'HAPPY10',
    coupon: { percent: 10, max_discount_paise: 10000 },
    items: [{ id: 'test1', quantity: 2, snapshot: { name: 'Test', mrp: 199, price: 100 } }],
    additionalMembers: [{ name: 'Second patient', items: [{ id: 'test1', quantity: 1, snapshot: { name: 'Test', mrp: 199, price: 100 } }] }],
  } });
  assert.equal(priced.items.length, 2);
  assert.equal(priced.totalQuantity, 3);
  assert.equal(priced.totalMrp, 597);
  assert.equal(priced.offerDiscount, 297);
  assert.equal(priced.couponDiscount, 30);
  assert.equal(priced.priceAfterCoupon, 270);
  assert.equal(priced.charges, 150);
  assert.equal(priced.finalAmount, 420);
  assert.equal(priced.couponMaxDiscount, 100);
  const historical = orderingSummary({ total: 250, payload: { items: [{ id: 'old', quantity: 1 }] } });
  assert.equal(historical.totalMrp, null);
  assert.equal(historical.charges, null);
  assert.equal(historical.finalAmount, 250);
  assert.equal(historical.couponDiscount, 0);
  assert.equal(orderingRoutes.length, 6);
  assert.ok(orderingRoutes.every(route => route.auth !== false));
  await assert.rejects(adminAuth.authenticate({ cookies: {} }, {}, () => {}), error => error.status === 401);
  for (const query of [{ page: 0 }, { limit: 101 }, { sortBy: 'id; DROP TABLE orders' }, { from: '2026-02-30' }, { from: '2026-10-20', to: '2026-10-01' }, { minTotal: 20 }, { q: 'test' }, { customerId: randomUUID() }, { paymentStatus: 'CHARGED' }, { providerBookingId: '123' }, { integrationStatus: 'confirmed' }])
    assert.equal(orderingQuery.safeParse(query).success, false);
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell(null), '""');
  assert.throws(() => buildFilter('labs', { paymentMethod: 'cod' }));
  assert.throws(() => buildFilter('products', { labId: 'redcliffe' }));
  for (const kind of ['labs', 'products']) {
    const req = { validatedQuery: orderingQuery.parse({ limit: 1 }) }, res = response();
    await listOrdering(kind)(req, res);
    assert.ok(res.body.data.length <= 1);
    const table = kind === 'labs' ? 'lab_bookings' : 'orders';
    const [[count]] = await sequelize.query(`SELECT count(*) AS total FROM ${table}`, { logging: false });
    assert.equal(res.body.pagination.total, Number(count.total));
    if (res.body.data.length && res.body.data[0].bookingNumber) {
      const item = res.body.data[0], detail = response();
      await getOrdering(kind)({ validatedParams: { id: item.bookingNumber } }, detail);
      assert.equal(detail.body.data.id, item.id);
      assert.ok(detail.body.data.details);
      assert.ok(Array.isArray(detail.body.data.items));
      assert.equal(detail.body.data.finalAmount, detail.body.data.total);
      const byNumber = response();
      await listOrdering(kind)({ validatedQuery: orderingQuery.parse(kind === 'labs' ? { bookingId: item.bookingNumber } : { orderId: item.bookingNumber }) }, byNumber);
      assert.equal(byNumber.body.data.length, 1);
      assert.equal(byNumber.body.data[0].id, item.id);
      const filtered = response();
      await listOrdering(kind)({ validatedQuery: orderingQuery.parse({ status: item.status }) }, filtered);
      assert.ok(filtered.body.data.length > 0);
      assert.ok(filtered.body.data.every(row => row.status === item.status));
      const csv = response();
      await listOrdering(kind, true)({ validatedQuery: orderingQuery.parse({ status: item.status, page: 999 }) }, csv);
      assert.ok(csv.body.startsWith('\uFEFF"id"'));
      assert.ok(csv.body.includes(item.id));
      for (const field of ['items', 'totalMrp', 'offerDiscount', 'couponDiscount', 'charges', 'finalAmount']) assert.ok(csv.body.includes('"' + field + '"'));
      assert.ok(csv.headers['Content-Disposition'].includes('.csv'));
    }
    const empty = response();
    await listOrdering(kind)({ validatedQuery: orderingQuery.parse({ status: 'nonexistent-' + randomUUID(), from: '2026-01-01', to: '2026-12-31' }) }, empty);
    assert.equal(empty.body.pagination.total, 0);
    await assert.rejects(getOrdering(kind)({ validatedParams: { id: kind === 'labs' ? '9999999999999999999999999999' : 'MB00000000000' } }, response()), error => error.status === 404);
  }
  console.log('PASS: admin auth required, validation, DB pagination/count, filters, details/404, filtered CSV and formula escaping. Read-only checks; no provider calls.');
} finally { await sequelize.close(); }
