import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { orderingSummary as summary } from './ordering-presentation.js';

export const EXPORT_LIMIT = 10000;
const select = (kind) => {
  const product = kind === 'products';
  return `SELECT o.id::text AS id, o.customer_id AS "customerId",
    ${product ? 'COALESCE(o.order_number,o.id)' : "COALESCE(o.provider_booking_id,o.payload->>'providerBookingId')"} AS "bookingNumber",
    o.created_at AS "createdAt", o.updated_at AS "updatedAt",
    o.payload->>'status' AS status,
    ${product ? 'o.payment_status' : "o.payload->>'paymentStatus'"} AS "paymentStatus",
    ${product ? "CASE WHEN o.payment_status='COD' THEN 'cod' ELSE 'online' END" : 'NULL::text'} AS "paymentMethod",
    ${product ? 'o.amount_paise::numeric/100' : "CASE WHEN o.payload->>'total' ~ '^[0-9]+([.][0-9]+)?$' THEN (o.payload->>'total')::numeric END"} AS total,
    o.payload#>>'{orderedBy,name}' AS "customerName",
    o.payload#>>'{orderedBy,email}' AS email, o.payload#>>'{orderedBy,phone}' AS phone,
    o.payload->>'couponCode' AS "couponCode",
    ${product ? 'NULL::text' : 'o.lab_id'} AS "labId",
    ${product ? 'NULL::text' : 'o.integration_status'} AS "integrationStatus",
    ${product ? 'NULL::text' : 'o.provider_booking_id'} AS "providerBookingId",
    o.payload FROM ${product ? 'orders' : 'lab_bookings'} o`;
};

export function buildFilter(kind, query) {
  if ((kind === 'products' && query.bookingId) || (kind === 'labs' && query.orderId))
    throw new HttpError(422, 'Use bookingId for labs and orderId for products');
  if (kind === 'products' && query.labId)
    throw new HttpError(422, 'Lab filters are only supported for lab bookings');
  if (kind === 'labs' && query.paymentMethod)
    throw new HttpError(422, 'paymentMethod is only supported for product orders');
  const clauses = [], replacements = {};
  const number = kind === 'labs' ? query.bookingId : query.orderId;
  if (number) {
    clauses.push('"bookingNumber"=:number');
    replacements.number = number;
  }
  for (const field of ['status', 'paymentMethod', 'labId']) {
    if (query[field] !== undefined) {
      clauses.push(`"${field}"=:${field}`);
      replacements[field] = query[field];
    }
  }

  if (query.from) {
    clauses.push(`"createdAt">=(CAST(:from AS date)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    replacements.from = query.from;
  }
  if (query.to) {
    clauses.push(`"createdAt"<((CAST(:to AS date)+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    replacements.to = query.to;
  }

  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', replacements };
}
// Quote every field, and neutralize formulas in spreadsheet applications.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  // Include control characters that spreadsheet importers may strip before evaluation.
  // eslint-disable-next-line no-control-regex
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const columns = ['id', 'bookingNumber', 'customerId', 'customerName', 'email', 'phone', 'status', 'paymentStatus', 'paymentMethod', 'itemNames', 'itemCount', 'totalQuantity', 'items', 'totalMrp', 'offerDiscount', 'subtotal', 'couponCode', 'couponPercent', 'couponMaxDiscount', 'couponDiscount', 'priceAfterCoupon', 'collectionCharges', 'deliveryCharges', 'charges', 'finalAmount', 'total', 'labId', 'providerBookingId', 'integrationStatus', 'createdAt', 'updatedAt'];

export const listOrdering = (kind, csv = false) => async (req, res) => {
  const query = req.validatedQuery;
  const filter = buildFilter(kind, query);
  const base = `WITH records AS (${select(kind)})`;
  const result = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
    const options = { replacements: filter.replacements, type: QueryTypes.SELECT, transaction };
    const [count] = await sequelize.query(`${base} SELECT count(*) AS total FROM records${filter.sql}`, options);
    const total = Number(count.total);
    if (csv && total > EXPORT_LIMIT) throw new HttpError(422, `Export exceeds ${EXPORT_LIMIT} rows. Narrow the filters or date range.`);
    const data = await sequelize.query(`${base} SELECT * FROM records${filter.sql} ORDER BY "createdAt" DESC,id DESC LIMIT :limit OFFSET :offset`, {
      ...options, replacements: { ...filter.replacements, limit: csv ? EXPORT_LIMIT : query.limit, offset: csv ? 0 : (query.page - 1) * query.limit },
    });
    return { total, data: data.map(summary) };
  });
  if (csv) {
    res.set('Content-Disposition', `attachment; filename="${kind}-bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.type('text/csv; charset=utf-8').send('\uFEFF' + [columns.map(csvCell).join(','), ...result.data.map(row => columns.map(key => csvCell(key === 'items' ? JSON.stringify(row.items) : row[key])).join(','))].join('\r\n') + '\r\n');
  }
  res.json({ data: result.data, pagination: { page: query.page, limit: query.limit, total: result.total, totalPages: Math.ceil(result.total / query.limit), hasNext: query.page * query.limit < result.total } });
};

export const getOrdering = kind => async (req, res) => {
  const [row] = await sequelize.query(`WITH records AS (${select(kind)}) SELECT * FROM records WHERE "bookingNumber"=:id`, {
    replacements: { id: req.validatedParams.id }, type: QueryTypes.SELECT,
  });
  if (!row) throw new HttpError(404, 'Booking not found');
  res.json({ data: { ...summary(row), details: row.payload } });
};
