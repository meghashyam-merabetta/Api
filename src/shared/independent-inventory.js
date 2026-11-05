import { independentProductId } from './product-identity.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { HttpError } from './errors.js';
import { auditContext } from './catalog-audit.js';

export async function inventorySummary(productId, transaction) {
  const [row] = await sequelize.query(
    `SELECT p.id::text AS product_id,p.sku,p.inventory_managed,
    COALESCE(sum(i.quantity_on_hand),0)::bigint AS on_hand_quantity,
    COALESCE(sum(i.quantity_reserved),0)::bigint AS reserved_quantity,
    COALESCE(sum(i.quantity_on_hand-i.quantity_reserved),0)::bigint AS available_quantity,
    max(i.updated_at) AS last_stock_update_at,
    (SELECT updated_by FROM inventory latest WHERE latest.product_id=p.id ORDER BY updated_at DESC,id DESC LIMIT 1) AS last_updated_by
    FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=:id GROUP BY p.id`,
    {
      replacements: { id: productId },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  if (!row) throw new HttpError(404, 'Product not found');
  for (const key of ['on_hand_quantity', 'reserved_quantity', 'available_quantity'])
    row[key] = Number(row[key]);
  row.status = !row.inventory_managed
    ? 'legacy_pending_conversion'
    : row.available_quantity > 0
      ? 'available'
      : 'sold_out';
  row.warehouses = await sequelize.query(
    'SELECT id,warehouse_code,quantity_on_hand,quantity_reserved,quantity_on_hand-quantity_reserved AS available_quantity,updated_at,updated_by FROM inventory WHERE product_id=:id ORDER BY id',
    { replacements: { id: productId }, type: QueryTypes.SELECT, transaction },
  );
  return row;
}
export async function initializeInventory(req, product, quantity, transaction) {
  await auditContext(req, transaction, {
    movement: 'initial_stock',
    reason: 'Validated product creation',
  });
  await sequelize.query(
    "INSERT INTO inventory(product_id,warehouse_code,quantity_on_hand) VALUES(:id,'DEFAULT',:quantity)",
    { replacements: { id: product.product_id, quantity: quantity ?? 0 }, transaction },
  );
}
export async function changeInventory(
  req,
  productId,
  {
    warehouse_code = 'DEFAULT',
    delta,
    available,
    reason,
    movement_type = 'manual_adjustment',
  },
  transaction,
) {
  if (req?.auth?.realm === 'admin') {
    const profile = await models.adminProfile.findOne({
      where: { userId: req.auth.userId },
      transaction,
    });
    if (
      !profile?.permissions?.some((value) =>
        ['*', 'admin.manage', 'inventory.adjust'].includes(value),
      )
    )
      throw new HttpError(403, 'Inventory adjustment permission required');
  }
  const [product] = await sequelize.query(
    'SELECT id,inventory_managed FROM products WHERE id=:id FOR UPDATE',
    { replacements: { id: productId }, type: QueryTypes.SELECT, transaction },
  );
  if (!product) throw new HttpError(404, 'Product not found');
  if (!product.inventory_managed)
    throw new HttpError(409, 'Product inventory requires legacy conversion first');
  await auditContext(req, transaction, { movement: movement_type, reason });
  const [row] = await sequelize.query(
    'SELECT * FROM inventory WHERE product_id=:id AND warehouse_code=:warehouse FOR UPDATE',
    {
      replacements: { id: productId, warehouse: warehouse_code },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  const quantity =
    available !== undefined
      ? (row?.quantity_reserved ?? 0) + available
      : (row?.quantity_on_hand ?? 0) + delta;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < (row?.quantity_reserved ?? 0) ||
    quantity > 2147483647
  )
    throw new HttpError(
      409,
      'Stock cannot be negative, exceed its limit, or remove reserved units',
    );
  if (!row) {
    await sequelize.query(
      'INSERT INTO inventory(product_id,warehouse_code,quantity_on_hand) VALUES(:product,:warehouse,:quantity)',
      {
        replacements: { product: productId, warehouse: warehouse_code, quantity },
        transaction,
      },
    );
    return inventorySummary(productId, transaction);
  }
  await sequelize.query(
    'UPDATE inventory SET quantity_on_hand=:quantity WHERE id=:id AND quantity_on_hand<>:quantity',
    { replacements: { id: row.id, quantity }, transaction },
  );
  return inventorySummary(productId, transaction);
}
// The selected product ID, never its group code, owns every reservation.
export async function reserveIndependentStock(orderId, items, transaction) {
  const resolved = [];
  for (const item of items)
    resolved.push({
      ...item,
      selectedProductId: await independentProductId(item.id, transaction),
    });
  const ids = [...new Set(resolved.map((item) => item.selectedProductId))];
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:id,0))', {
    replacements: { id: 'stock:' + orderId },
    transaction,
  });
  const prior = await sequelize.query(
    'SELECT i.product_id::text AS product_id,r.quantity,r.state FROM order_stock_reservations r JOIN inventory i ON i.id=r.inventory_id WHERE r.order_id=:id',
    { replacements: { id: orderId }, type: QueryTypes.SELECT, transaction },
  );
  const expected = new Map();
  for (const item of resolved)
    expected.set(
      item.selectedProductId,
      (expected.get(item.selectedProductId) ?? 0) + item.quantity,
    );
  if (prior.some((row) => row.state !== 'released')) {
    const existing = new Map();
    for (const row of prior.filter((row) => row.state !== 'released'))
      existing.set(row.product_id, (existing.get(row.product_id) ?? 0) + row.quantity);
    if (
      existing.size === expected.size &&
      [...expected].every(([id, quantity]) => existing.get(id) === quantity)
    )
      return;
    throw new HttpError(409, 'Existing reservation differs from this request');
  }
  const products = await sequelize.query(
    "SELECT id,min_order_quantity,max_order_quantity FROM products WHERE id IN (:ids) AND inventory_managed AND product_status='active' ORDER BY id FOR UPDATE",
    { replacements: { ids }, type: QueryTypes.SELECT, transaction },
  );
  if (products.length !== ids.length)
    throw new HttpError(409, 'Product inventory is unavailable');
  const rows = await sequelize.query(
    'SELECT * FROM inventory WHERE product_id IN (:ids) ORDER BY id FOR UPDATE',
    { replacements: { ids }, type: QueryTypes.SELECT, transaction },
  );
  const requested = new Map();
  for (const item of resolved) {
    const id = item.selectedProductId;
    requested.set(id, (requested.get(id) ?? 0) + item.quantity);
  }
  const plan = [];
  for (const [productId, quantity] of requested) {
    const product = products.find((row) => String(row.id) === productId);
    if (
      quantity < product.min_order_quantity ||
      (product.max_order_quantity !== null && quantity > product.max_order_quantity)
    )
      throw new HttpError(422, 'Product quantity is outside its order limits');
    let remaining = quantity;
    for (const row of rows.filter((row) => String(row.product_id) === productId)) {
      const take = Math.min(remaining, row.quantity_on_hand - row.quantity_reserved);
      if (take > 0) plan.push({ inventory: row.id, quantity: take });
      remaining -= take;
    }
    if (remaining) throw new HttpError(409, 'Insufficient product stock');
  }
  // The order lifecycle invokes this under its order lock; only released rows may be re-reserved.
  await auditContext(null, transaction, { movement: 'reservation', order: orderId });
  for (const line of plan) {
    const [existing] = await sequelize.query(
      'SELECT state,quantity FROM order_stock_reservations WHERE order_id=:order AND inventory_id=:inventory FOR UPDATE',
      {
        replacements: { order: orderId, inventory: line.inventory },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (existing && existing.state !== 'released') {
      if (existing.quantity !== line.quantity)
        throw new HttpError(409, 'Reservation details changed');
      continue;
    }
    await sequelize.query(
      'UPDATE inventory SET quantity_reserved=quantity_reserved + :quantity WHERE id=:inventory',
      { replacements: line, transaction },
    );
    await sequelize.query(
      `INSERT INTO order_stock_reservations(order_id,inventory_id,quantity,state) VALUES(:order,:inventory,:quantity,'reserved')
      ON CONFLICT(order_id,inventory_id) DO UPDATE SET quantity=EXCLUDED.quantity,state='reserved',updated_at=now()`,
      { replacements: { ...line, order: orderId }, transaction },
    );
  }
}
