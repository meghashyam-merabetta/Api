import { QueryTypes, Op } from 'sequelize';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { env } from '../config/env.js';
import { HttpError } from './errors.js';
import { auditContext } from './catalog-audit.js';
import { assignProductCategories } from './product-category-assignments.js';

const select = (sql, transaction, replacements = {}) =>
  sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
export async function configurationLink({ variantId, productId }, transaction) {
  if (!env.CONFIGURATION_PRODUCTS_ENABLED) return null;
  const [row] = await select(
    `SELECT * FROM product_configuration_links WHERE ${variantId !== undefined ? 'variant_id' : 'product_id'}=:id`,
    transaction,
    { id: variantId ?? productId },
  );
  return row ?? null;
}
export async function lockConfigurationGroup(productId, transaction) {
  const link = await configurationLink({ productId }, transaction);
  if (link)
    await select('SELECT id FROM products WHERE id=:id FOR UPDATE', transaction, {
      id: link.group_product_id,
    });
  return link;
}
export async function configurationStock(productId, transaction) {
  const [row] = await select(
    'SELECT COALESCE(sum(quantity_on_hand-quantity_reserved),0)::int AS available FROM inventory WHERE product_id=:id',
    transaction,
    { id: productId },
  );
  return row.available;
}
export async function setConfigurationStock(
  req,
  productId,
  available,
  transaction,
  initial = false,
) {
  if (!Number.isSafeInteger(available) || available < 0)
    throw new HttpError(422, 'Invalid configuration stock');
  if (!initial) {
    const profile = await models.adminProfile.findOne({
      where: { userId: req.auth.userId },
      transaction,
    });
    if (
      !profile?.permissions?.some((x) =>
        ['*', 'inventory.adjust', 'admin.manage'].includes(x),
      )
    )
      throw new HttpError(403, 'Inventory adjustment permission required');
  }
  await auditContext(req, transaction, {
    movement: initial ? 'initial_stock' : 'manual_adjustment',
    reason: 'Configuration product save',
  });
  const rows = await select(
    'SELECT * FROM inventory WHERE product_id=:id ORDER BY id FOR UPDATE',
    transaction,
    { id: productId },
  );
  if (rows.some((x) => x.warehouse_code !== 'DEFAULT') || rows.length > 1)
    throw new HttpError(
      409,
      'Use warehouse-specific inventory adjustments for this product',
    );
  const onHand = available + (rows[0]?.quantity_reserved ?? 0);
  if (!Number.isSafeInteger(onHand) || onHand > 2147483647)
    throw new HttpError(422, 'Stock exceeds the supported range');
  if (rows.length)
    await sequelize.query(
      'UPDATE inventory SET quantity_on_hand=:quantity WHERE id=:id',
      { replacements: { id: rows[0].id, quantity: onHand }, transaction },
    );
  else
    await sequelize.query(
      "INSERT INTO inventory(product_id,warehouse_code,quantity_on_hand) VALUES(:id,'DEFAULT',:quantity)",
      { replacements: { id: productId, quantity: onHand }, transaction },
    );
}
function valuesFor(group, variant) {
  const excluded = new Set([
    'product_id',
    'effective_price',
    'created_at',
    'updated_at',
    'created_by',
    'updated_by',
    'deleted_at',
    'slug',
    'sku',
    'barcode',
    'product_code',
  ]);
  const values = Object.fromEntries(
    Object.keys(models.product.getAttributes())
      .filter((k) => !excluded.has(k))
      .map((k) => [k, group[k]]),
  );
  const attributes = variant.attributes ?? {};
  const name =
    variant.variant_name ||
    Object.entries(attributes)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') ||
    variant.sku;
  return {
    ...values,
    product_type: 'simple',
    is_configuration_group: false,
    inventory_managed: true,
    product_group_code: group.product_group_code ?? `group-${group.product_id}`,
    attributes,
    product_name: `${group.product_name} - ${name}`.slice(0, 255),
    sku: variant.sku,
    barcode: variant.barcode ?? null,
    product_status: variant.is_active ? group.product_status : 'inactive',
    regular_price: variant.regular_price ?? group.regular_price,
    sale_price:
      variant.regular_price === null || variant.regular_price === undefined
        ? group.sale_price
        : variant.sale_price,
    offer_percent: null,
    stock_quantity: variant.stock_quantity,
  };
}
export async function synchronizeConfiguration(
  req,
  group,
  variant,
  transaction,
  { initial = false, stockChanged = false, inventoryRows } = {},
) {
  if (!env.CONFIGURATION_PRODUCTS_ENABLED) return null;
  if (await configurationLink({ productId: group.product_id }, transaction))
    throw new HttpError(409, 'A configuration product cannot contain nested variants');
  if (initial && group.inventory_managed && !group.is_configuration_group) {
    const rows = await select(
      'SELECT * FROM inventory WHERE product_id=:id FOR UPDATE',
      transaction,
      { id: group.product_id },
    );
    if (rows.some((r) => r.quantity_on_hand > 0 || r.quantity_reserved > 0))
      throw new HttpError(
        409,
        'Allocate existing simple-product inventory before adding configurations',
      );
  }
  let link = await configurationLink({ variantId: variant.id }, transaction);
  // Existing records stay editable until their separately approved conversion.
  if (!link && !initial) return null;
  await auditContext(req, transaction, {
    reason: 'Independent configuration product save',
  });
  const values = valuesFor(group, variant);
  let product;
  if (link) {
    product = await models.product.findByPk(link.product_id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw new HttpError(409, 'Configuration product is archived');
    delete values.stock_quantity;
    await product.update(values, { transaction });
  } else {
    product = await models.product.create(
      {
        ...values,
        slug: `${group.slug.slice(0, 210)}-configuration-${variant.id}`,
        product_code: null,
      },
      { transaction },
    );
    await sequelize.query(
      'INSERT INTO product_configuration_links(variant_id,product_id,group_product_id) VALUES(:variant,:product,:group)',
      {
        replacements: {
          variant: variant.id,
          product: product.product_id,
          group: group.product_id,
        },
        transaction,
      },
    );
    await group.update(
      { is_configuration_group: true, inventory_managed: false },
      { transaction },
    );
    link = {
      variant_id: variant.id,
      product_id: product.product_id,
      group_product_id: group.product_id,
    };
  }
  if (inventoryRows !== undefined) {
    for (const row of inventoryRows) {
      if (row.product_id !== null && row.product_id !== undefined)
        throw new HttpError(409, 'Existing warehouse ownership cannot be reassigned');
      await sequelize.query(
        'UPDATE inventory SET product_id=:product WHERE id=:id AND product_id IS NULL',
        { replacements: { product: product.product_id, id: row.id }, transaction },
      );
    }
    if (!inventoryRows.length)
      await setConfigurationStock(
        req,
        product.product_id,
        variant.stock_quantity,
        transaction,
        true,
      );
  } else if (initial || stockChanged)
    await setConfigurationStock(
      req,
      product.product_id,
      variant.stock_quantity,
      transaction,
      initial,
    );
  const categories = await models.productCategory.findAll({
    where: { product_id: group.product_id },
    transaction,
  });
  await assignProductCategories(
    product.product_id,
    categories.map((c) => c.category_id),
    categories.find((c) => c.is_primary)?.category_id ?? null,
    transaction,
  );
  return link;
}
export async function refreshGroupConfigurations(req, group, transaction) {
  if (!env.CONFIGURATION_PRODUCTS_ENABLED) return;
  const links = await select(
    'SELECT * FROM product_configuration_links WHERE group_product_id=:id ORDER BY product_id',
    transaction,
    { id: group.product_id },
  );
  for (const link of links) {
    const variant = await models.productVariant.findByPk(link.variant_id, {
      transaction,
    });
    if (variant) await synchronizeConfiguration(req, group, variant, transaction);
  }
}
export async function archiveConfigurations(req, groupId, transaction, variantId) {
  if (!env.CONFIGURATION_PRODUCTS_ENABLED) return;
  const links = await select(
    `SELECT * FROM product_configuration_links WHERE group_product_id=:id ${variantId === undefined ? '' : 'AND variant_id=:variant'} ORDER BY product_id`,
    transaction,
    { id: groupId, ...(variantId === undefined ? {} : { variant: variantId }) },
  );
  await auditContext(req, transaction, { reason: 'Archive independent configuration' });
  if (links.length) {
    const ids = links.map((l) => l.product_id);
    await models.product.update(
      { product_status: 'archived' },
      { where: { product_id: { [Op.in]: ids } }, transaction },
    );
    await models.product.destroy({
      where: { product_id: { [Op.in]: ids } },
      transaction,
    });
    await models.productCatalog.update(
      { active: false },
      {
        where: {
          [Op.or]: [
            { 'data.individual_product_id': { [Op.in]: ids.map(String) } },
            { 'data.source_product_id': { [Op.in]: ids.map(String) } },
          ],
        },
        transaction,
      },
    );
  }
}
export async function configurationVariantFields(variant, transaction) {
  const link = await configurationLink({ variantId: variant.id }, transaction);
  if (!link) return {};
  return {
    individual_product_id: String(link.product_id),
    group_product_id: String(link.group_product_id),
    stock_quantity: await configurationStock(link.product_id, transaction),
  };
}

export async function assertConfigurationSchemaReady() {
  if (!env.CONFIGURATION_PRODUCTS_ENABLED) return;
  const [row] = await select(
    "SELECT to_regclass('public.product_configuration_links') IS NOT NULL AS ready",
  );
  if (!row.ready)
    throw Error(
      'Configuration schema 039 must be separately approved and installed before activation',
    );
}
