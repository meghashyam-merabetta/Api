import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

export async function nextOrderId(transaction) {
  const [row] = await sequelize.query(
    `INSERT INTO product_order_counters(order_day,last_number)
     VALUES ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,1)
     ON CONFLICT(order_day) DO UPDATE
       SET last_number=product_order_counters.last_number+1
       WHERE product_order_counters.last_number < 99999
     RETURNING 'MB' || to_char(order_day,'YYMMDD') || lpad(last_number::text,5,'0') AS id`,
    { type: QueryTypes.SELECT, transaction },
  );
  if (!row) throw new HttpError(503, 'Daily order limit reached. Please try later.');
  return row.id;
}
