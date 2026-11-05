import { HttpError } from '../shared/errors.js';
import { query, audit, findProduct } from './store.js';
async function requireCurrentInventoryOrder(orderId, transaction) {
  const [order] = await query(
    'SELECT payload FROM product_checkouts WHERE id=:id FOR UPDATE',
    { id: orderId },
    transaction,
  );
  if (order?.payload?.inventorySchema !== 'team-v1')
    throw new HttpError(
      409,
      'Order predates the inventory schema reset; reconcile it before changing stock',
    );
}
export async function reserveTeamStock(orderId, items, transaction) {
  await requireCurrentInventoryOrder(orderId, transaction);
  const prior = await query(
    'SELECT * FROM order_stock_reservations WHERE order_id=:order ORDER BY inventory_id FOR UPDATE',
    { order: orderId },
    transaction,
  );
  if (prior.some((r) => r.state !== 'released')) {
    if (
      prior.every((r) => ['reserved', 'deducted'].includes(r.state)) &&
      new Set(prior.map((r) => r.state)).size === 1
    )
      return;
    throw new HttpError(409, 'Inventory reservations require reconciliation');
  }
  const plan = new Map();
  for (const item of [...items].sort((a, b) =>
    a.id.localeCompare(b.id, 'en', { numeric: true }),
  )) {
    if (
      !/^product:[1-9]\d*$/.test(item.id) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1
    )
      throw new HttpError(422, 'Invalid product inventory request');
    const id = item.id.slice(8);
    const p = await findProduct(id, transaction, true);
    if (!p.is_active || p.product_status !== 'active')
      throw new HttpError(409, 'Product is unavailable');
    const rows = await query(
      'SELECT i.* FROM product_inventory i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.product_id=:id AND i.is_active AND w.is_active ORDER BY i.id FOR UPDATE OF i',
      { id },
      transaction,
    );
    let remaining = item.quantity;
    for (const row of rows) {
      const quantity = Math.min(
        remaining,
        Math.max(0, row.available_quantity - (plan.get(row.id)?.quantity ?? 0)),
      );
      if (quantity)
        plan.set(row.id, {
          ...row,
          quantity: quantity + (plan.get(row.id)?.quantity ?? 0),
        });
      remaining -= quantity;
    }
    if (remaining)
      throw new HttpError(409, 'Stock changed during checkout. Please review your cart.');
  }
  for (const row of plan.values()) {
    const [after] = await query(
      'UPDATE product_inventory SET available_quantity=available_quantity - :quantity,reserved_quantity=reserved_quantity + :quantity,last_stock_updated_at=now(),last_stock_check_at=NULL,updated_at=now() WHERE id=:id RETURNING *',
      { id: row.id, quantity: row.quantity },
      transaction,
    );
    await query(
      "INSERT INTO order_stock_reservations(order_id,inventory_id,quantity,state) VALUES(:order,:id,:quantity,'reserved') ON CONFLICT(order_id,inventory_id) DO UPDATE SET quantity=EXCLUDED.quantity,state='reserved',updated_at=now() RETURNING inventory_id",
      { order: orderId, id: row.id, quantity: row.quantity },
      transaction,
    );
    await synchronizeStock(row.product_id, transaction);
    await audit(
      null,
      'product_inventory',
      row.id,
      row,
      after,
      transaction,
      'reservation',
    );
  }
}
export async function synchronizeStock(product, transaction) {
  await query(
    'UPDATE products SET stock_quantity=(SELECT COALESCE(sum(CASE WHEN i.is_active AND w.is_active THEN i.available_quantity ELSE 0 END),0) FROM product_inventory i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.product_id=:id),updated_at=now() WHERE id=:id RETURNING id',
    { id: product },
    transaction,
  );
}
export async function settleTeamStock(orderId, deduct, transaction) {
  const [{ pending }] = await query(
    "SELECT count(*)::int pending FROM order_stock_reservations WHERE order_id=:id AND state='reserved'",
    { id: orderId },
    transaction,
  );
  if (!pending) return;
  await requireCurrentInventoryOrder(orderId, transaction);
  // Product -> inventory lock order matches admin writes and reservation paths.
  const owners = await query(
    "SELECT DISTINCT i.product_id FROM order_stock_reservations r JOIN product_inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='reserved' ORDER BY i.product_id",
    { order: orderId },
    transaction,
  );
  for (const r of owners)
    await query(
      'SELECT id FROM products WHERE id=:id FOR UPDATE',
      { id: r.product_id },
      transaction,
    );
  const rows = await query(
    "SELECT i.*,r.quantity FROM order_stock_reservations r JOIN product_inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='reserved' ORDER BY i.id FOR UPDATE OF i,r",
    { order: orderId },
    transaction,
  );
  const [{ n }] = await query(
    "SELECT count(*)::int n FROM order_stock_reservations WHERE order_id=:order AND state='reserved'",
    { order: orderId },
    transaction,
  );
  if (n !== rows.length)
    throw new HttpError(
      409,
      'A reservation refers to removed inventory; reconciliation required',
    );
  for (const row of rows) {
    const [after] = await query(
      `UPDATE product_inventory SET reserved_quantity=reserved_quantity - :quantity,${deduct ? 'total_quantity=total_quantity - :quantity' : 'available_quantity=available_quantity + :quantity'},last_stock_updated_at=now(),last_stock_check_at=NULL,updated_at=now() WHERE id=:id AND reserved_quantity>= :quantity AND total_quantity>= :quantity RETURNING *`,
      { id: row.id, quantity: row.quantity },
      transaction,
    );
    if (!after) throw new HttpError(409, 'Inventory reconciliation required');
    await synchronizeStock(row.product_id, transaction);
    await audit(
      null,
      'product_inventory',
      row.id,
      row,
      after,
      transaction,
      deduct ? 'purchase' : 'release',
    );
  }
  await query(
    "UPDATE order_stock_reservations SET state=:state,updated_at=now() WHERE order_id=:order AND state='reserved' RETURNING inventory_id",
    { state: deduct ? 'deducted' : 'released', order: orderId },
    transaction,
  );
}

export async function returnTeamStock(orderId, transaction, req) {
  await requireCurrentInventoryOrder(orderId, transaction);
  const owners = await query(
    "SELECT DISTINCT i.product_id FROM order_stock_reservations r JOIN product_inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='deducted' ORDER BY i.product_id",
    { order: orderId },
    transaction,
  );
  for (const owner of owners)
    await query(
      'SELECT id FROM products WHERE id=:id FOR UPDATE',
      { id: owner.product_id },
      transaction,
    );
  const rows = await query(
    "SELECT i.*,r.quantity FROM order_stock_reservations r JOIN product_inventory i ON i.id=r.inventory_id WHERE r.order_id=:order AND r.state='deducted' ORDER BY i.id FOR UPDATE OF i,r",
    { order: orderId },
    transaction,
  );
  const [{ count }] = await query(
    "SELECT count(*)::int count FROM order_stock_reservations WHERE order_id=:order AND state='deducted'",
    { order: orderId },
    transaction,
  );
  if (count !== rows.length)
    throw new HttpError(409, 'Inventory reconciliation required');
  for (const row of rows) {
    const inserted = await query(
      'INSERT INTO order_inventory_returns(order_id,inventory_id) VALUES(:order,:id) ON CONFLICT DO NOTHING RETURNING order_id',
      { order: orderId, id: row.id },
      transaction,
    );
    if (!inserted.length) continue;
    const [after] = await query(
      'UPDATE product_inventory SET total_quantity=total_quantity + :qty,available_quantity=available_quantity + :qty,last_stock_updated_at=now(),last_stock_check_at=NULL,updated_at=now() WHERE id=:id RETURNING *',
      { id: row.id, qty: row.quantity },
      transaction,
    );
    await synchronizeStock(row.product_id, transaction);
    await audit(req, 'product_inventory', row.id, row, after, transaction, 'return');
  }
}
