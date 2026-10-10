import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionDays, selectedCollectionSlot } from '../src/app/bookings/collection-slots.js';

test('collection dates start today in India and cross month/year boundaries', () => {
  const days = collectionDays(new Date('2026-12-31T19:00:00Z'));
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2027-01-01');
  assert.equal(days[6].date, '2027-01-07');
  assert.equal(days[0].slots.length, 4);
});
test('past times, dates outside seven days, and invalid slots cannot be booked', () => {
  const now = new Date('2026-10-06T03:30:00Z'); // 9 AM IST
  assert.equal(selectedCollectionSlot('2026-10-06', '07-09', now), undefined);
  assert.equal(selectedCollectionSlot('2026-10-06', '09-11', now), undefined);
  assert.equal(selectedCollectionSlot('2026-10-06', '11-13', now)?.id, '11-13');
  assert.equal(selectedCollectionSlot('2026-10-12', '07-09', now)?.id, '07-09');
  assert.equal(selectedCollectionSlot('2026-10-13', '07-09', now), undefined);
  assert.equal(selectedCollectionSlot('2026-10-05', '07-09', now), undefined);
  assert.equal(selectedCollectionSlot('2026-10-07', 'bad', now), undefined);
});
