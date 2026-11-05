import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

export async function reserveCheckoutItems(items, transaction) {
  const initial = await sequelize.query(
    'SELECT id,data FROM product_catalog WHERE id IN (:ids) AND active',
    {
      replacements: { ids: items.map((item) => item.id) },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  if (initial.length !== items.length)
    throw new HttpError(422, 'A product is no longer available.');
  const productIds = [
    ...new Set(initial.map((row) => row.data.source_product_id).filter(Boolean)),
  ];
  // Match the admin lock order: parent products before their published catalog rows.
  if (productIds.length)
    await sequelize.query(
      'SELECT id FROM products WHERE id IN (:ids) ORDER BY id FOR UPDATE',
      {
        replacements: { ids: productIds },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
  const snapshots = new Map();
  let tracked = false;
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const [row] = await sequelize.query(
      'SELECT data FROM product_catalog WHERE id=:id AND active FOR UPDATE',
      {
        replacements: { id: item.id },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (!row) throw new HttpError(422, 'A product is no longer available.');
    const data = row.data;
    if (
      item.quantity < (data.min_order_quantity ?? 1) ||
      (data.max_order_quantity !== null &&
        data.max_order_quantity !== undefined &&
        item.quantity > data.max_order_quantity)
    )
      throw new HttpError(422, 'Product quantity is outside its order limits.');
    let remaining;
    if (data.source_product_id) {
      if (!productIds.includes(data.source_product_id))
        throw new HttpError(409, 'Product changed. Please retry checkout.');
      const variant = data.source_variant_id;
      const sql = variant
        ? 'UPDATE product_variants SET stock_quantity = stock_quantity - :quantity,updated_at=now() WHERE id=:variant AND product_id=:product AND is_active AND stock_quantity>=:quantity RETURNING stock_quantity'
        : "UPDATE products SET stock_quantity = stock_quantity - :quantity,updated_at=now() WHERE id=:product AND product_status='active' AND stock_quantity>=:quantity RETURNING stock_quantity";
      const updated = await sequelize.query(sql, {
        replacements: {
          quantity: item.quantity,
          product: data.source_product_id,
          variant: variant ?? null,
        },
        type: QueryTypes.SELECT,
        transaction,
      });
      if (!updated.length) throw new HttpError(409, 'Insufficient product stock.');
      remaining = updated[0].stock_quantity;
    } else if (data.stock_quantity !== undefined) {
      if (
        !Number.isSafeInteger(data.stock_quantity) ||
        data.stock_quantity < item.quantity
      )
        throw new HttpError(409, 'Insufficient product stock.');
      remaining = data.stock_quantity - item.quantity;
    }
    if (remaining !== undefined) {
      tracked = true;
      await sequelize.query(
        "UPDATE product_catalog SET data=jsonb_set(data,'{stock_quantity}',to_jsonb(CAST(:stock AS integer))) WHERE id=:id",
        {
          replacements: { id: item.id, stock: remaining },
          transaction,
        },
      );
    }
    snapshots.set(item.id, { ...item, snapshot: data });
  }
  return {
    items: items.map((item) => snapshots.get(item.id)),
    stockState: tracked ? 'reserved' : 'unmanaged',
  };
}

export async function nextOrderNumber(transaction) {
  const [row] = await sequelize.query(
    `INSERT INTO product_order_counters(order_day,last_number)
    VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date,1)
    ON CONFLICT(order_day) DO UPDATE SET last_number=product_order_counters.last_number+1
    WHERE product_order_counters.last_number<99999
    RETURNING to_char(order_day,'YYMMDD') AS day,last_number`,
    { type: QueryTypes.SELECT, transaction },
  );
  if (!row) throw new HttpError(503, 'Daily order capacity reached. Please try later.');
  return `MB${row.day}${String(row.last_number).padStart(5, '0')}`;
}
