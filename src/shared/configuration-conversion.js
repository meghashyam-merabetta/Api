import { createHash } from 'node:crypto';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { synchronizeConfiguration } from './configuration-products.js';
import { auditContext } from './catalog-audit.js';

export function planConfigurationConversion(snapshot, { stockSource = 'strict' } = {}) {
  if (!['strict', 'variants'].includes(stockSource))
    throw Error('Unsupported stock policy');
  const planned = [],
    conflicts = [];
  const mapped = new Set(snapshot.links.map((l) => String(l.variant_id)));
  for (const source of snapshot.products) {
    if (source.deleted_at || (source.inventory_managed && !source.is_configuration_group))
      continue;
    const children = snapshot.variants.filter(
      (v) => String(v.product_id) === String(source.id) && !v.deleted_at,
    );
    for (const variant of children) {
      if (mapped.has(String(variant.id))) continue;
      const offers = snapshot.offers.filter(
        (o) => String(o.variant_id) === String(variant.id),
      );
      const inventory = snapshot.inventory.filter((i) =>
        offers.some((o) => String(o.id) === String(i.vendor_product_id)),
      );
      const warehouses = inventory.map((i) => i.warehouse_code);
      const available = inventory.reduce(
        (n, i) => n + i.quantity_on_hand - i.quantity_reserved,
        0,
      );
      const problems = [];
      if (inventory.some((i) => i.product_id !== null && i.product_id !== undefined))
        problems.push(
          'Existing immutable inventory ownership requires separate reconciliation',
        );
      if (new Set(warehouses).size !== warehouses.length)
        problems.push('Multiple inventories share a warehouse');
      if (inventory.length && available !== variant.stock_quantity)
        problems.push('Variant stock and warehouse availability disagree');
      const declaredTotal = children.reduce((n, v) => n + v.stock_quantity, 0);
      if (
        children.length > 1 &&
        source.stock_quantity > 0 &&
        source.stock_quantity !== declaredTotal &&
        stockSource !== 'variants'
      )
        problems.push('Shared group stock needs allocation review');
      if (
        snapshot.inventory.some(
          (i) =>
            String(i.product_id) === String(source.id) &&
            !snapshot.offers.some((o) => String(o.id) === String(i.vendor_product_id)) &&
            (i.quantity_on_hand > 0 || i.quantity_reserved > 0),
        )
      )
        problems.push('Unallocated group warehouse inventory needs review');
      if (
        offers.some(
          (o) =>
            o.offer_status !== 'active' ||
            (o.vendor_status !== undefined && o.vendor_status !== 'active'),
        )
      )
        problems.push(
          'Vendor/offer availability requires explicit review before independent publication',
        );
      const prices = new Set(
        offers
          .filter((o) => o.offer_status === 'active')
          .map((o) => JSON.stringify([o.currency, o.mrp, o.selling_price])),
      );
      if (prices.size > 1) problems.push('Active vendor offer prices disagree');
      if (offers.some((o) => o.currency !== 'INR'))
        problems.push('Non-INR offer needs review');
      // Do not silently replace vendor price with a conflicting legacy editor value.
      const regular = variant.regular_price ?? source.regular_price;
      const sale =
        variant.regular_price === null ? source.sale_price : variant.sale_price;
      if (
        offers.some(
          (o) =>
            o.offer_status === 'active' &&
            (Number(o.mrp) !== Number(regular) ||
              Number(o.selling_price) !== Number(sale ?? regular)),
        )
      )
        problems.push('Vendor offer and editor prices disagree');
      if (problems.length)
        conflicts.push({
          group_product_id: String(source.id),
          variant_id: String(variant.id),
          reasons: problems,
        });
      planned.push({
        group_product_id: String(source.id),
        variant_id: String(variant.id),
        sku: variant.sku,
        attributes: variant.attributes,
        initial_available: inventory.length ? available : variant.stock_quantity,
        inventory_ids: inventory.map((i) => String(i.id)),
        product_status: variant.is_active ? source.product_status : 'inactive',
      });
    }
  }
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ snapshot, stockSource }))
      .digest('hex'),
    stock_source: stockSource,
    planned,
    conflicts,
    can_apply: conflicts.length === 0,
  };
}
export async function inspectConfigurationConversion(
  transaction,
  groupIds = [],
  options = {},
) {
  const select = (s, replacements = {}) =>
    sequelize.query(s, { type: 'SELECT', transaction, replacements });
  const products = await select(
    `SELECT * FROM products ${groupIds.length ? 'WHERE id IN (:ids)' : ''} ORDER BY id`,
    { ids: groupIds },
  );
  const ids = products.map((p) => p.id);
  const variants = ids.length
    ? await select(
        'SELECT * FROM product_variants WHERE product_id IN (:ids) ORDER BY id',
        { ids },
      )
    : [];
  const variantIds = variants.map((v) => v.id);
  const offers = variantIds.length
    ? await select(
        'SELECT o.*,vendor.vendor_status FROM vendor_products o JOIN vendors vendor ON vendor.id=o.vendor_id WHERE o.variant_id IN (:ids) ORDER BY o.id',
        { ids: variantIds },
      )
    : [];
  const offerIds = offers.map((o) => o.id);
  const inventory = ids.length
    ? await select(
        `SELECT * FROM inventory WHERE product_id IN (:groups) ${offerIds.length ? 'OR vendor_product_id IN (:offers)' : ''} ORDER BY id`,
        { groups: ids, ...(offerIds.length ? { offers: offerIds } : {}) },
      )
    : [];
  const [schema] = await select(
    "SELECT to_regclass('public.product_configuration_links') IS NOT NULL AS ready",
  );
  const links = schema.ready
    ? await select('SELECT * FROM product_configuration_links ORDER BY variant_id')
    : [];
  const snapshot = { products, variants, offers, inventory, links };
  return {
    ...planConfigurationConversion(snapshot, options),
    schema_ready: schema.ready,
    group_ids: groupIds.map(String),
  };
}
export async function applyConfigurationConversion(
  expectedFingerprint,
  groupIds = [],
  options = {},
) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SET LOCAL lock_timeout='10s'", { transaction });
    await sequelize.query(
      'LOCK TABLE products,product_variants,vendor_products,inventory,product_categories,product_configuration_links IN SHARE ROW EXCLUSIVE MODE',
      { transaction },
    );
    const plan = await inspectConfigurationConversion(transaction, groupIds, options);
    if (!expectedFingerprint || plan.fingerprint !== expectedFingerprint)
      throw Error('Missing or stale approved conversion fingerprint');
    if (!plan.schema_ready || !plan.can_apply)
      throw Error(
        'Schema and stock/pricing reconciliation must be completed before conversion',
      );
    await auditContext(null, transaction, {
      movement: 'migration',
      reason: 'Approved individual configuration conversion',
    });
    const converted = [];
    for (const item of plan.planned) {
      const group = await models.product.findByPk(item.group_product_id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const variant = await models.productVariant.findByPk(item.variant_id, {
        transaction,
      });
      const inventoryRows = item.inventory_ids.length
        ? await sequelize.query(
            'SELECT * FROM inventory WHERE id IN (:ids) ORDER BY id FOR UPDATE',
            { replacements: { ids: item.inventory_ids }, type: 'SELECT', transaction },
          )
        : [];
      const link = await synchronizeConfiguration(null, group, variant, transaction, {
        initial: true,
        inventoryRows,
      });
      if (!link)
        throw Error('Configuration feature must be explicitly enabled for conversion');
      converted.push({
        variant_id: item.variant_id,
        product_id: String(link.product_id),
      });
    }
    return { converted, group_ids: plan.group_ids };
  });
}
