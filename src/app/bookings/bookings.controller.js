import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { refreshBooking } from '../redcliffe-labs/status.js';
export { createBooking } from '../redcliffe-labs/booking.js';
export async function searchAreas(req, res) {
  const { q, labId } = req.validatedQuery;
  const rows = await sequelize.query(
    `SELECT id,name,city,state,postal_code AS "postalCode", (active AND lab_ids ? :labId AND EXISTS (SELECT 1 FROM labs WHERE id=:labId AND active AND home_collection)) AS serviceable FROM lab_service_areas WHERE position(lower(:q) in lower(name || ' ' || city || ' ' || postal_code)) > 0 ORDER BY name,city,id LIMIT 25`,
    { replacements: { q, labId }, type: QueryTypes.SELECT },
  );
  res.json({ data: rows });
}
export async function listBookings(req, res) {
  const rows = await sequelize.query(
    'SELECT id,payload,provider_booking_id,integration_status,updated_at,updated_at::text AS observed_at FROM lab_bookings WHERE customer_id=:customerId ORDER BY created_at DESC',
    { replacements: { customerId: req.credential.id }, type: QueryTypes.SELECT },
  );
  let statusRefreshFailed = false;
  const data = await Promise.all(
    rows.map(async (row) => {
      try {
        return await refreshBooking(row);
      } catch {
        statusRefreshFailed = true;
        return row.payload;
      }
    }),
  );
  res.json({ data, statusRefreshFailed });
}
