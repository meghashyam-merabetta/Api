import { env } from '../../config/env.js';
import { auditContext } from '../../shared/catalog-audit.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

// Caller holds the order lock. Lock warehouses in deterministic order across orders.
export async function reserveStock(orderId, items, transaction) {
  if (env.CONFIGURATION_PRODUCTS_ENABLED) {
    const prior = await sequelize.query(
      'SELECT state FROM order_stock_reservations WHERE order_id=:order FOR UPDATE',
      { replacements: { order: orderId }, type: QueryTypes.SELECT, transaction },
    );
    if (prior.some((r) => r.state !== 'released')) {
      if (
        prior.every((r) => r.state === 'reserved') ||
        prior.every((r) => r.state === 'deducted')
      )
        return;
      throw new HttpError(409, 'Inventory reservation requires reconciliation');
    }
  }
  const plan = new Map();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const canonical = env.CONFIGURATION_PRODUCTS_ENABLED && /^product:\d+$/.test(item.id);
    if (!canonical && !/^shop:\d+$/.test(item.id))
      throw new HttpError(422, 'Product inventory is unavailable.');
    const owner = canonical ? item.id.slice(8) : null;
    if (owner) {
      const [product] = await sequelize.query(
        "SELECT id FROM products WHERE id=:id AND inventory_managed AND NOT is_configuration_group AND product_status='active' AND deleted_at IS NULL FOR UPDATE",
        { replacements: { id: owner }, type: QueryTypes.SELECT, transaction },
      );
      if (!product) throw new HttpError(409, 'Product configuration is unavailable');
    }
    const rows = await sequelize.query(
      `SELECT id,quantity_on_hand,quantity_reserved FROM inventory WHERE ${canonical ? 'product_id' : 'vendor_product_id'}=:owner ORDER BY id FOR UPDATE`,
      {
        replacements: { owner: owner ?? item.id.slice(5) },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    let remaining = item.quantity;
    for (const row of rows) {
      const quantity = Math.min(
        remaining,
        Math.max(
          0,
          row.quantity_on_hand -
            row.quantity_reserved -
            (plan.get(row.id)?.quantity ?? 0),
        ),
      );
      if (quantity)
        plan.set(row.id, {
          inventory: row.id,
          quantity: quantity + (plan.get(row.id)?.quantity ?? 0),
        });
      remaining -= quantity;
    }
    if (remaining)
      throw new HttpError(409, 'Stock changed during checkout. Please review your cart.');
  }
  // No writes before every item is available, including late payment recovery.
  if (env.CONFIGURATION_PRODUCTS_ENABLED)
    await auditContext(null, transaction, { movement: 'reservation', order: orderId });
  for (const line of plan.values()) {
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
  if (env.CONFIGURATION_PRODUCTS_ENABLED)
    await auditContext(null, transaction, {
      movement: deduct ? 'purchase' : 'release',
      order: orderId,
    });
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
