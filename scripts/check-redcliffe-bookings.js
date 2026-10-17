import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { createBooking } from '../src/app/redcliffe-labs/booking.js';
import { normalizePackage } from '../src/app/redcliffe-labs/catalog.js';
import { collectionDates } from '../src/app/redcliffe-labs/slots.js';
import { bookingSchema } from '../src/app/bookings/bookings.routes.js';

const customerId = randomUUID(), code = 'TEST-' + randomUUID(), packageId = 'redcliffe:' + code;
const originalFetch = globalThis.fetch, originalBase = env.REDCLIFFE_BASE_URL, originalKey = env.REDCLIFFE_API_KEY;
let createCalls = 0, confirmCalls = 0, timeout = false, expectedDiscount;
const couponCode = "CHECK_" + randomUUID().replaceAll("-", "").toUpperCase();
try {
  env.REDCLIFFE_BASE_URL = 'https://test.invalid'; env.REDCLIFFE_API_KEY = 'test-key';
  globalThis.fetch = async (url, options) => {
    assert.equal(url.hostname, 'test.invalid');
    if (url.pathname.includes('get-time-slot-list')) return new Response(JSON.stringify({ status: 'success', results: [{ id: 27, available_slot: 3, format_24_hrs: { start_time: '15:30', end_time: '16:30' }, format_12_hrs: { start_time: '03:30 PM', end_time: '04:30 PM' } }] }));
    if (url.pathname.includes('center-create-booking')) {
      createCalls++;
      if (timeout) throw new Error('Simulated unknown transport outcome');
      const body = JSON.parse(options.body);
      assert.equal(body.client_refid, customerId); assert.equal(body.is_credit, false); assert.equal(body.center_discount, expectedDiscount);
      assert.equal(body.customer_phonenumber, '9123456789'); assert.equal(body.customer_altphonenumber, '9876543210');
      return new Response(JSON.stringify({ status: 'success', booking_id: 'mock-' + randomUUID(), discounted_price: { final_total_price: 250 } }));
    }
    if (url.pathname.includes('center-confirm-booking')) { confirmCalls++; assert.equal(JSON.parse(options.body).is_confirmed, true); return new Response(JSON.stringify({ status: 'Success', booking_status: 'confirmed' })); }
    throw new Error('Unexpected provider endpoint');
  };
  const customer = await models.customer.create({ id: customerId, firstName: 'Test', lastName: 'Customer', phone: '9876543210', email: 'test@example.com' });
  const member = await models.customerFamilyMember.create({ customerId, name: 'Test Patient', relationship: 'Mother', phone: '9123456789', dateOfBirth: '1961-01-01', gender: 'Female' });
  const raw = { code, name: 'Integration test', parameters: 3, package_center_prices: { offer_price: 250, package_price: 500 } };
  await sequelize.query("INSERT INTO lab_packages(id,lab_id,package_code,catalog_data,provider_data) VALUES(:id,'redcliffe',:code,CAST(:data AS jsonb),CAST(:raw AS jsonb))", { replacements: { id: packageId, code, data: JSON.stringify(normalizePackage(raw)), raw: JSON.stringify(raw) } });
  const body = bookingSchema.parse({ requestKey: randomUUID(), memberId: member.id, collectionDate: collectionDates()[1], slotId: '27', items: [{ id: packageId, quantity: 1 }], address: { line1: 'Flat 12, Building', line2: '', city: 'Pune', state: 'Maharashtra', postalCode: '411045', houseNumber: '12', landmark: 'Gate 2', location: { provider: 'locationiq', placeId: 'fixture', displayName: 'Baner, Pune', latitude: 18.56, longitude: 73.78, address: { country_code: 'in' } } } });
  let result;
  const response = { status() { return this; }, json(value) { result = value; } };
  const req = { credential: customer.get({ plain: true }), validated: body };
  await createBooking(req, response);
  assert.equal(result.status, 'Confirmed'); assert.equal(result.total, 400); assert.equal(result.collection, 150);
  const id = result.id;
  await createBooking(req, response);
  assert.equal(result.id, id); assert.equal(createCalls, 1); assert.equal(confirmCalls, 1);
  const [saved] = await sequelize.query('SELECT provider_booking_id,provider_request,provider_response,confirmation_response,integration_status FROM lab_bookings WHERE id=:id', { replacements: { id } });
  assert.equal(saved[0].integration_status, 'confirmed'); assert.ok(saved[0].provider_booking_id); assert.ok(saved[0].provider_response); assert.ok(saved[0].confirmation_response);
  await assert.rejects(createBooking({ ...req, validated: { ...body, slotId: '28' } }, response), /different details/);
  timeout = true;
  const unknown = { ...req, validated: { ...body, requestKey: randomUUID() } };
  await createBooking(unknown, response);
  assert.equal(result.status, 'Booking verification pending');
  assert.equal(createCalls, 2);
  const pendingId = result.id;
  await createBooking(unknown, response);
  assert.equal(result.id, pendingId);
  assert.equal(result.status, 'Booking verification pending');
  await assert.rejects(createBooking({ ...unknown, validated: { ...unknown.validated, requestKey: randomUUID() } }, response), /already being processed/);
  assert.equal(createCalls, 2);
  timeout = false;
  await createBooking({ ...req, validated: { ...body, requestKey: randomUUID(), collectionDate: collectionDates()[2] } }, response);
  assert.equal(result.status, 'Confirmed');
  assert.equal(createCalls, 3);
  await sequelize.query("INSERT INTO coupons(code,scope,percent,max_discount_paise,active) VALUES(:code,'labs',10,10000,true)", { replacements: { code: couponCode } });
  expectedDiscount = 25;
  await createBooking({ ...req, validated: { ...body, requestKey: randomUUID(), couponCode, collectionDate: collectionDates()[3] } }, response);
  assert.equal(result.discount, 25); assert.equal(result.total, 375); assert.equal(result.couponCode, couponCode);
  const couponBookingId = result.id;
  const [couponSaved] = await sequelize.query('SELECT provider_request FROM lab_bookings WHERE id=:id', { replacements: { id: couponBookingId } });
  assert.equal(couponSaved[0].provider_request.center_discount, 25);
  console.log('PASS: provider payload/contact mapping, durable create + confirm, retry idempotency, changed-payload conflict, uncertain outcome blocks duplicate submission. No real provider bookings were sent.');
} finally {
  globalThis.fetch = originalFetch; env.REDCLIFFE_BASE_URL = originalBase; env.REDCLIFFE_API_KEY = originalKey;
  await sequelize.query('DELETE FROM lab_bookings WHERE customer_id=:customerId', { replacements: { customerId } });
  await sequelize.query('DELETE FROM lab_packages WHERE id=:id', { replacements: { id: packageId } });
  await models.customerFamilyMember.destroy({ where: { customerId }, force: true });
  await models.customer.destroy({ where: { id: customerId }, force: true });
  await sequelize.query('DELETE FROM coupons WHERE code=:code', { replacements: { code: couponCode } });
  await sequelize.close();
}
