import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

// Caller holds the order lock. Lock warehouses in deterministic order across orders.
export async function reserveStock(orderId, items, transaction) {
  const plan = [];
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^shop:\d+$/.test(item.id))
      throw new HttpError(422, 'Product inventory is unavailable.');
    const rows = await sequelize.query(
      'SELECT id,quantity_on_hand,quantity_reserved FROM inventory WHERE vendor_product_id=:offer ORDER BY id FOR UPDATE',
      { replacements: { offer: item.id.slice(5) }, type: QueryTypes.SELECT, transaction },
    );
    let remaining = item.quantity;
    for (const row of rows) {
      const quantity = Math.min(
        remaining,
        Math.max(0, row.quantity_on_hand - row.quantity_reserved),
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
      'UPDATE inventory SET quantity_reserved=quantity_reserved + :quantity,updated_at=now() WHERE id=:inventory',
      { replacements: line, transaction },
    );
    await sequelize.query(
      "INSERT INTO order_stock_reservations(order_id,inventory_id,quantity,state) VALUES(:order,:inventory,:quantity,'reserved') ON CONFLICT(order_id,inventory_id) DO UPDATE SET quantity=EXCLUDED.quantity,state='reserved',updated_at=now()",
      { replacements: { ...line, order: orderId }, transaction },
    );
  }
}
export async function settleStock(orderId, deduct, transaction) {
  const lines = await sequelize.query(
    "SELECT r.inventory_id,r.quantity FROM order_stock_reservations r JOIN inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='reserved' ORDER BY i.vendor_product_id::text,i.id FOR UPDATE OF i,r",
    { replacements: { order: orderId }, type: QueryTypes.SELECT, transaction },
  );
  for (const line of lines) {
    const changed = await sequelize.query(
      `UPDATE inventory SET quantity_reserved=quantity_reserved - :quantity${deduct ? ',quantity_on_hand=quantity_on_hand - :quantity' : ''},updated_at=now() WHERE id=:inventory AND quantity_reserved>= :quantity AND quantity_on_hand>= :quantity RETURNING id`,
      {
        replacements: { inventory: line.inventory_id, quantity: line.quantity },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (!changed.length) throw new HttpError(409, 'Inventory reconciliation required.');
  }
  await sequelize.query(
    "UPDATE order_stock_reservations SET state=:state,updated_at=now() WHERE order_id=:order AND state='reserved'",
    {
      replacements: { order: orderId, state: deduct ? 'deducted' : 'released' },
      transaction,
    },
  );
}
