import test from 'node:test';
import assert from 'node:assert/strict';
import { editableBooking } from '../src/app/redcliffe-labs/eligibility.js';

test('provider pending bookings are editable only before agent assignment', () => {
  for (const status of ['Pending', 'Booking pending', 'Confirmation pending', 'Confirmed']) {
    assert.equal(editableBooking({ booking_status: status, phlebo: null }), true);
    assert.equal(editableBooking({ booking_status: { value: status }, phlebo: { id: 12 } }), false);
  }
  for (const status of ['Phlebo Assigned', 'Sample collected', 'Cancelled', 'Completed', 'Unknown']) {
    assert.equal(editableBooking({ booking_status: status }), false);
  }
  assert.equal(editableBooking(undefined), false);
});
