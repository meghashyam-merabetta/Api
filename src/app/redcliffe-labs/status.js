import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../shared/errors.js';
import { reportsFromBooking } from './reports.js';
import {
  paths,
  providerRequest,
  providerSucceeded,
  findProviderBooking,
} from './client.js';

export async function refreshBooking(row) {
  const interruptedCancellation =
    row.integration_status === 'cancelling' &&
    Date.now() - new Date(row.updated_at).getTime() > 120000;
  if (
    !row.provider_booking_id ||
    (!['confirmed', 'cancel_unknown', 'confirmation_unknown'].includes(
      row.integration_status,
    ) &&
      !interruptedCancellation)
  )
    return row.payload;
  const body = await providerRequest(paths.booking, {
    query: { booking_id: String(row.provider_booking_id) },
  });
  const remote = findProviderBooking(body, row.provider_booking_id);
  const status = remote?.booking_status?.value || remote?.booking_status;
  if (typeof status !== 'string' || !status.trim())
    throw new HttpError(502, 'Latest booking status is unavailable.');
  const cancelled = /^(cancelled|canceled)$/i.test(status.trim());
  const payload = {
    ...row.payload,
    status: cancelled ? 'Cancelled' : status.trim(),
    statusSyncedAt: new Date().toISOString(),
    reports: reportsFromBooking(remote),
  };
  const updated = await sequelize.query(
    `UPDATE lab_bookings SET payload=CAST(:payload AS jsonb), integration_status=:next, updated_at=now() WHERE id=:id AND integration_status=:previous AND (CAST(:observed AS timestamptz) IS NULL OR updated_at=CAST(:observed AS timestamptz)) RETURNING payload`,
    {
      replacements: {
        id: row.id,
        previous: row.integration_status,
        observed: row.observed_at ?? null,
        next: cancelled
          ? 'cancelled'
          : row.integration_status === 'confirmation_unknown'
            ? 'confirmed'
            : row.integration_status,
        payload: JSON.stringify(payload),
      },
      type: QueryTypes.SELECT,
    },
  );
  if (updated.length && row.payload.status !== payload.status)
    logger.info(
      { bookingId: row.id, previousStatus: row.payload.status, status: payload.status },
      'Lab booking status updated',
    );
  return updated[0]?.payload || row.payload;
}

export async function cancelBooking(req, res) {
  const replacements = { id: req.validatedParams.id, customer: req.credential.id };
  const rows = await sequelize.query(
    'SELECT *, updated_at::text AS observed_at FROM lab_bookings WHERE id=:id AND customer_id=:customer',
    { replacements, type: QueryTypes.SELECT },
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Booking not found.');
  if (row.integration_status === 'cancelled') return res.json(row.payload);
  if (!row.provider_booking_id || row.integration_status !== 'confirmed')
    throw new HttpError(
      409,
      'Booking cannot be cancelled now. Refresh My Orders to check its status.',
    );
  const claimed = await sequelize.query(
    "UPDATE lab_bookings SET integration_status='cancelling',updated_at=now() WHERE id=:id AND customer_id=:customer AND integration_status='confirmed' RETURNING id",
    { replacements, type: QueryTypes.SELECT },
  );
  if (!claimed.length) throw new HttpError(409, 'Cancellation is already in progress.');
  let body;
  try {
    body = await providerRequest(paths.update, {
      body: {
        booking_id: Number(row.provider_booking_id),
        booking_status: 'cancelled',
        remark: req.validated.reason,
      },
    });
  } catch (error) {
    await sequelize.query(
      "UPDATE lab_bookings SET integration_status='cancel_unknown',last_error='Cancellation response unverified',updated_at=now() WHERE id=:id",
      { replacements },
    );
    throw error;
  }
  const success =
    providerSucceeded(body) &&
    String(body.booking_id) === String(row.provider_booking_id) &&
    body.booking_status === 'cancelled';
  const payload = success
    ? { ...row.payload, status: 'Cancelled', statusSyncedAt: new Date().toISOString() }
    : row.payload;
  await sequelize.query(
    'UPDATE lab_bookings SET integration_status=:state,payload=CAST(:payload AS jsonb),updated_at=now() WHERE id=:id',
    {
      replacements: {
        ...replacements,
        state: success ? 'cancelled' : 'cancel_unknown',
        payload: JSON.stringify(payload),
      },
    },
  );
  if (!success)
    throw new HttpError(
      409,
      'Cancellation was not confirmed by Redcliffe. Refresh My Orders or contact support.',
    );
  logger.info(
    { bookingId: row.id, previousStatus: row.payload.status, status: payload.status },
    'Lab booking cancelled',
  );
  res.json(payload);
}
