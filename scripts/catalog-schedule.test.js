import test from 'node:test';
import assert from 'node:assert/strict';
import { latestCatalogSlot, catalogSyncDue } from '../src/app/redcliffe-labs/catalog-schedule.js';

test('IST schedule changes only at 04:00 and 16:00, including midnight/year boundary', () => {
  for (const [now, expected] of [
    ['2026-10-15T03:59:59+05:30', '2026-10-14T16:00:00+05:30'],
    ['2026-10-15T04:00:00+05:30', '2026-10-15T04:00:00+05:30'],
    ['2026-10-15T15:59:59+05:30', '2026-10-15T04:00:00+05:30'],
    ['2026-10-15T16:00:00+05:30', '2026-10-15T16:00:00+05:30'],
    ['2027-01-01T00:01:00+05:30', '2026-12-31T16:00:00+05:30'],
  ]) assert.equal(+latestCatalogSlot(new Date(now)), +new Date(expected));
});
test('completed slot does not repeat; interrupted work resumes; missed slot catches up', () => {
  const now = new Date('2026-10-15T10:00:00+05:30');
  assert.equal(catalogSyncDue({ status: 'complete', started_at: '2026-10-15T04:00:05+05:30' }, now), false);
  assert.equal(catalogSyncDue({ status: 'complete', started_at: '2026-10-14T16:00:00+05:30' }, now), true);
  assert.equal(catalogSyncDue({ status: 'retrying', started_at: now }, now), true);
  assert.equal(catalogSyncDue({ status: 'idle' }, now), true);
});
