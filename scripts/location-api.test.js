import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { locationRoutes, normalizeLocation } from '../src/app/locations/locations.routes.js';

test('provider address normalization preserves full address and village fallback', () => {
  const result = normalizeLocation({ place_id: 12, lat: '18.5', lon: '73.8', display_name: 'Village, Maharashtra, India', address: { village: 'Village', state: 'Maharashtra', postcode: '411045', country_code: 'in' } });
  assert.equal(result.city, 'Village');
  assert.equal(result.postalCode, '411045');
  assert.equal(result.latitude, 18.5);
  assert.equal(result.address.country_code, 'in');
});
test('LocationIQ integration protects token, filters India and preserves adjusted coordinates', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.LOCATIONIQ_API_KEY;
  let result;
  const res = { json(value) { result = value; } };
  const route = path => locationRoutes.find(route => route.path === path);
  try {
    env.LOCATIONIQ_API_KEY = '';
    await assert.rejects(route('/search').handler({ validatedQuery: { q: 'Baner' } }, res), /not configured/);
    env.LOCATIONIQ_API_KEY = 'test-server-only-token';
    globalThis.fetch = async url => {
      assert.equal(url.searchParams.get('key'), 'test-server-only-token');
      assert.equal(url.searchParams.get('countrycodes'), 'in');
      return new Response(JSON.stringify([{ place_id: 1, display_name: 'Baner', lat: '18.56', lon: '73.78', address: { city: 'Pune', country_code: 'in' } }]), { status: 200 });
    };
    await route('/search').handler({ validatedQuery: { q: 'Baner' } }, res);
    assert.equal(result.data[0].city, 'Pune');
    assert.ok(!JSON.stringify(result).includes('test-server-only-token'));
    globalThis.fetch = async () => new Response(JSON.stringify({ place_id: 1, display_name: 'Baner', lat: '18.5601', lon: '73.7801', address: { city: 'Pune', country_code: 'in' } }), { status: 200 });
    await route('/reverse').handler({ validatedQuery: { lat: 18.562, lon: 73.783 } }, res);
    assert.equal(result.latitude, 18.562); assert.equal(result.longitude, 73.783);
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    await assert.rejects(route('/reverse').handler({ validatedQuery: { lat: 18.56, lon: 73.78 } }, res), error => error.status === 429);
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    await route('/search').handler({ validatedQuery: { q: 'Unknown place' } }, res);
    assert.deepEqual(result.data, []);
    await assert.rejects(route('/reverse').handler({ validatedQuery: { lat: 18.56, lon: 73.78 } }, res), /No address found/);
  } finally { globalThis.fetch = originalFetch; env.LOCATIONIQ_API_KEY = originalKey; }
});
