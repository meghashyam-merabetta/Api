import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

// Caller holds the order lock. Lock warehouses in deterministic order across orders.
export async function reserveStock(orderId, items, transaction) {
  const plan = [];
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^product:\d+$/.test(item.id))
      throw new HttpError(422, 'Product inventory is unavailable.');
    const rows = await sequelize.query(
      'SELECT id,available_quantity FROM product_inventory WHERE product_id=:product AND is_active ORDER BY id FOR UPDATE',
      { replacements: { product: item.id.slice(8) }, type: QueryTypes.SELECT, transaction },
    );
    let remaining = item.quantity;
    for (const row of rows) {
      const quantity = Math.min(
        remaining,
        Math.max(0, row.available_quantity),
      );
      if (quantity) plan.push({ inventory: row.id, quantity });
      remaining -= quantity;
    }
    if (remaining)
      throw new HttpError(409, 'Stock changed during checkout. Please review your cart.');
  }
  // No writes before every item is available, including late payment recovery.
  for (const line of plan) {
    await sequelize.query(
      'UPDATE product_inventory SET available_quantity=available_quantity - :quantity,reserved_quantity=reserved_quantity + :quantity,updated_at=now() WHERE id=:inventory',
      { replacements: line, transaction },
    );
    await sequelize.query(
      "INSERT INTO product_inventory_reservations(order_id,inventory_id,quantity,state) VALUES(:order,:inventory,:quantity,'reserved') ON CONFLICT(order_id,inventory_id) DO UPDATE SET quantity=EXCLUDED.quantity,state='reserved',updated_at=now()",
      { replacements: { ...line, order: orderId }, transaction },
    );
  }
}
export async function settleStock(orderId, deduct, transaction) {
  const lines = await sequelize.query(
    "SELECT r.inventory_id,r.quantity FROM product_inventory_reservations r JOIN product_inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='reserved' ORDER BY i.product_id,i.id FOR UPDATE OF i,r",
    { replacements: { order: orderId }, type: QueryTypes.SELECT, transaction },
  );
  if (!lines.length) throw new HttpError(409, 'Inventory reservation requires review.');
  for (const line of lines) {
    const changed = await sequelize.query(
      `UPDATE product_inventory SET reserved_quantity=reserved_quantity - :quantity${deduct ? ',total_quantity=total_quantity - :quantity' : ',available_quantity=available_quantity + :quantity'},updated_at=now() WHERE id=:inventory AND reserved_quantity>= :quantity AND total_quantity>= :quantity RETURNING id`,
      {
        replacements: { inventory: line.inventory_id, quantity: line.quantity },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (!changed.length) throw new HttpError(409, 'Inventory reconciliation required.');
  }
  await sequelize.query(
    "UPDATE product_inventory_reservations SET state=:state,updated_at=now() WHERE order_id=:order AND state='reserved'",
    {
      replacements: { order: orderId, state: deduct ? 'deducted' : 'released' },
      transaction,
    },
  );
}
