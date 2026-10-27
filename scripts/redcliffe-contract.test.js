import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingPayload } from '../src/app/redcliffe-labs/booking.js';
import { normalizePackage } from '../src/app/redcliffe-labs/catalog.js';
import { collectionDates, normalizeSlots } from '../src/app/redcliffe-labs/slots.js';
import { paths, providerRequest } from '../src/app/redcliffe-labs/client.js';
import { env } from '../src/config/env.js';

const customer = { id: 'customer-1', phone: '9876543210', email: 'customer@example.com' };
const member = { name: 'Patient Name', dateOfBirth: '1990-01-01', gender: 'Female', phone: '' };
const address = { line1: 'Flat 12', line2: 'Baner Road', city: 'Pune', state: 'Maharashtra', postalCode: '411045', landmark: 'Gate 2', location: { latitude: 18.56, longitude: 73.78, displayName: 'Baner, Pune' } };
test('patient details, customer reference and phone fallback follow the booking contract', () => {
  const body = bookingPayload(customer, member, address, ['PKG1'], '2026-10-08', '27', 'local-booking-id');
  assert.equal(body.client_refid, customer.id);
  assert.equal(body.customer_name, member.name);
  assert.equal(body.customer_phonenumber, customer.phone);
  assert.equal(body.customer_altphonenumber, undefined);
  assert.equal(body.customer_whatsapppnumber, customer.phone);
  assert.equal(body.is_credit, false);
  assert.equal(body.booking_type, 'Homedx');
  assert.equal(body.center_discount, undefined);
  assert.equal(body.is_payment, undefined);
  assert.equal(body.reference_data, 'local-booking-id');
  const withPhone = bookingPayload(customer, { ...member, phone: '9123456789' }, address, ['PKG1'], '2026-10-08', '27', 'local-id');
  assert.equal(withPhone.customer_phonenumber, '9123456789');
  assert.equal(withPhone.customer_altphonenumber, customer.phone);
  assert.throws(() => bookingPayload(customer, member, { ...address, location: null }, [], '', '', ''), /area \/ locality/);
  assert.throws(() => bookingPayload(customer, { ...member, gender: 'Other' }, address, [], '', '', ''), /supports bookings/);
});
test('five India dates, serviceability and slot capacity are authoritative', () => {
  assert.deepEqual(collectionDates(new Date('2026-12-31T20:00:00Z')), ['2027-01-01','2027-01-02','2027-01-03','2027-01-04','2027-01-05']);
  assert.equal(normalizeSlots({ status: 'failure', message: 'Location is non-serviceable.' }, '2026-10-07').serviceable, false);
  const data = normalizeSlots({ status: 'success', results: [{ id: 27, available_slot: 2, format_24_hrs: { start_time: '15:30', end_time: '16:30' } }, { id: 28, available_slot: 0, format_24_hrs: { start_time: '16:00', end_time: '17:00' } }] }, '2026-10-07', new Date('2026-10-07T03:00:00Z'));
  assert.equal(data.slots[0].available, true); assert.equal(data.slots[1].available, false);
  assert.deepEqual(normalizeSlots({ status: 'success', data: [] }, '2026-10-07').slots, []);
});
test('packages use mapped prices and the thyroid image; invalid prices are rejected', () => {
  const raw = { code: 'PKG1', name: 'Test', parameters: 3, package_center_prices: { offer_price: 100, package_price: 200 } };
  assert.equal(normalizePackage(raw).price, 110); assert.equal(normalizePackage(raw).image, 'lab.png');
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 199, package_price: 300 } }).price, 219);
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 100.01, package_price: 200 } }).price, 111);
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 100, package_price: 110 } }).price, 110);
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 199, package_price: 210 } }).price, 210);
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 100, package_price: 100 } }).price, 100);
  assert.equal(normalizePackage({ ...raw, package_center_prices: { offer_price: 100, package_price: 105.50 } }).price, 105.50);
  assert.equal(normalizePackage(raw).mrp, 200);
  assert.throws(() => normalizePackage({ ...raw, package_center_prices: { offer_price: -10, package_price: 200 } }), /invalid package/);
});
test('provider client uses only fixed endpoints and a private Key header', async () => {
  const oldBase = env.REDCLIFFE_BASE_URL, oldKey = env.REDCLIFFE_API_KEY;
  try {
    env.REDCLIFFE_BASE_URL = 'https://provider.example'; env.REDCLIFFE_API_KEY = 'test-key';
    await providerRequest(paths.packages, { query: { page: '2' }, fetchImpl: async (url, options) => {
      assert.equal(url.origin, 'https://provider.example'); assert.equal(url.searchParams.get('page'), '2');
      assert.equal(options.headers.Key, 'test-key'); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ status: 'success', data: [] }));
    } });
    await assert.rejects(providerRequest('https://other.example'), /Unknown provider endpoint/);
  } finally { env.REDCLIFFE_BASE_URL = oldBase; env.REDCLIFFE_API_KEY = oldKey; }
});
