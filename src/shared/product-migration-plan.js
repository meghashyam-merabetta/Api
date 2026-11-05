import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export function planIndependentProducts({
  products,
  variants,
  offers,
  inventory,
  mappings = [],
}) {
  const mapped = new Set(mappings.map((row) => String(row.variant_id)));
  const skuOwners = new Map(
    products.filter((row) => row.sku).map((row) => [row.sku, String(row.id)]),
  );
  const conflicts = [],
    plans = [];
  for (const source of products) {
    if (source.inventory_managed || source.deleted_at) continue;
    const children = variants.filter(
      (row) => String(row.product_id) === String(source.id),
    );
    if (children.length > 1 && source.stock_quantity > 0)
      conflicts.push({
        product_id: source.id,
        reason: 'Shared legacy product stock cannot be allocated across configurations',
        quantity: source.stock_quantity,
      });
    if (!children.length) {
      plans.push({
        source_product_id: source.id,
        reuse_product_id: source.id,
        variant_id: null,
        sku: source.sku,
        initial_stock: source.stock_quantity,
        inventory_ids: [],
        price: source.regular_price,
        sale_price: source.sale_price,
      });
      continue;
    }
    for (const variant of children) {
      if (mapped.has(String(variant.id))) continue;
      const linkedOffers = offers.filter(
        (row) => String(row.variant_id) === String(variant.id),
      );
      const rows = inventory.filter((row) =>
        linkedOffers.some((offer) => String(offer.id) === String(row.vendor_product_id)),
      );
      const warehouses = rows.map((row) => row.warehouse_code);
      if (new Set(warehouses).size !== warehouses.length)
        conflicts.push({
          variant_id: variant.id,
          reason:
            'Multiple vendor inventories share a warehouse; allocation needs review',
        });
      const prices = [
        ...new Set(
          linkedOffers
            .filter((row) => row.offer_status === 'active')
            .map((row) => JSON.stringify([row.mrp, row.selling_price, row.currency])),
        ),
      ];
      if (prices.length > 1)
        conflicts.push({
          variant_id: variant.id,
          reason: 'Multiple active offer prices require an explicit pricing decision',
        });
      if (linkedOffers.some((row) => row.currency !== 'INR'))
        conflicts.push({
          variant_id: variant.id,
          reason: 'Non-INR offer requires review',
        });
      const reuse = children.length === 1 && (!source.sku || source.sku === variant.sku);
      const owner = skuOwners.get(variant.sku);
      if (owner && !(reuse && owner === String(source.id)))
        conflicts.push({
          variant_id: variant.id,
          sku: variant.sku,
          reason: 'SKU already belongs to another retained product',
          product_id: owner,
        });
      if (
        rows.some(
          (row) =>
            (row.quantity_on_hand > 0 || row.quantity_reserved > 0) &&
            linkedOffers.some(
              (offer) =>
                String(offer.id) === String(row.vendor_product_id) &&
                (offer.offer_status !== 'active' ||
                  (offer.vendor_status && offer.vendor_status !== 'active')),
            ),
        )
      )
        conflicts.push({
          variant_id: variant.id,
          reason: 'Inactive vendor or offer holds stock; availability requires review',
        });
      const available = rows.reduce(
        (sum, row) => sum + row.quantity_on_hand - row.quantity_reserved,
        0,
      );
      if (
        rows.length &&
        variant.stock_quantity > 0 &&
        variant.stock_quantity !== available
      )
        conflicts.push({
          variant_id: variant.id,
          reason: 'Legacy variant quantity conflicts with authoritative warehouse stock',
          legacy: variant.stock_quantity,
          available,
        });
      if (
        children.length === 1 &&
        rows.length &&
        source.stock_quantity > 0 &&
        source.stock_quantity !== available
      )
        conflicts.push({
          product_id: source.id,
          reason: 'Legacy product quantity conflicts with warehouse stock',
        });
      const offer = linkedOffers.find((row) => row.offer_status === 'active');
      const initial = rows.length
        ? 0
        : variant.stock_quantity || (children.length === 1 ? source.stock_quantity : 0);
      if (
        !rows.length &&
        children.length === 1 &&
        variant.stock_quantity > 0 &&
        source.stock_quantity > 0 &&
        variant.stock_quantity !== source.stock_quantity
      )
        conflicts.push({
          variant_id: variant.id,
          reason: 'Product and variant stock disagree',
        });
      plans.push({
        variant_id: variant.id,
        source_product_id: source.id,
        reuse_product_id: reuse ? source.id : null,
        sku: variant.sku,
        initial_stock: initial,
        inventory_ids: rows.map((row) => row.id),
        price: offer?.mrp ?? variant.regular_price ?? source.regular_price,
        sale_price: offer?.selling_price ?? variant.sale_price ?? source.sale_price,
      });
    }
  }
  for (const row of inventory) {
    if (
      row.quantity_on_hand < row.quantity_reserved ||
      row.quantity_reserved < 0 ||
      row.quantity_on_hand < 0
    )
      conflicts.push({ inventory_id: row.id, reason: 'Invalid stock quantities' });
    if (
      !row.product_id &&
      !offers.some((offer) => String(offer.id) === String(row.vendor_product_id))
    )
      conflicts.push({
        inventory_id: row.id,
        reason: 'Inventory has no resolvable offer',
      });
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ products, variants, offers, inventory, mappings }))
    .digest('hex');
  return {
    fingerprint,
    counts: {
      products: products.length,
      variants: variants.length,
      inventory: inventory.length,
      offers: offers.length,
      existing_mappings: mappings.length,
    },
    planned_products: plans,
    conflicts,
    can_apply: conflicts.length === 0,
  };
}

export async function inspectProductMigration(transaction) {
  const select = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction });
  const exists = async (table) =>
    !!(await select(`SELECT to_regclass('public.${table}') AS name`))[0].name;
  const [products, variants] = await Promise.all([
    select('SELECT * FROM products ORDER BY id'),
    select('SELECT * FROM product_variants ORDER BY id'),
  ]);
  const offers = (await exists('vendor_products'))
    ? await select(
        'SELECT o.*,v.vendor_status FROM vendor_products o JOIN vendors v ON v.id=o.vendor_id ORDER BY o.id',
      )
    : [];
  const inventory = (await exists('inventory'))
    ? await select('SELECT * FROM inventory ORDER BY id')
    : [];
  const mappings = (await exists('legacy_variant_products'))
    ? await select('SELECT * FROM legacy_variant_products ORDER BY variant_id')
    : [];
  const plan = planIndependentProducts({
    products,
    variants,
    offers,
    inventory,
    mappings,
  });
  const tableNames = [
    'products',
    'product_variants',
    'inventory',
    'vendor_products',
    'order_stock_reservations',
    'order_details',
    'product_categories',
    'customer_cart_items',
    'customer_wishlist_items',
  ];
  plan.constraints = await sequelize.query(
    `SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND (conrelid::regclass::text IN (:names) OR confrelid::regclass::text IN (:names)) ORDER BY conrelid::regclass::text,conname`,
    { replacements: { names: tableNames }, type: QueryTypes.SELECT, transaction },
  );
  plan.indexes = await sequelize.query(
    'SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN (:names) ORDER BY tablename,indexname',
    { replacements: { names: tableNames }, type: QueryTypes.SELECT, transaction },
  );
  plan.references = {};
  for (const table of [
    'order_stock_reservations',
    'order_details',
    'customer_cart_items',
    'customer_wishlist_items',
  ])
    if (await exists(table))
      plan.references[table] = Number(
        (await select(`SELECT count(*) AS count FROM ${table}`))[0].count,
      );
  plan.duplicate_skus = await select(
    `SELECT sku,count(*) AS count FROM (SELECT sku FROM products WHERE sku IS NOT NULL UNION ALL SELECT sku FROM product_variants WHERE sku IS NOT NULL) s GROUP BY sku HAVING count(*)>1 ORDER BY sku`,
  );
  plan.category_review = await select(
    "SELECT id,parent_id,name,slug,image_url FROM categories WHERE lower(trim(name)) IN ('daily living','healthcare products') ORDER BY id",
  );
  plan.category_action =
    'Report only; retain all category IDs, links, hierarchy, and URLs';
  plan.unmapped_order_items = (await exists('order_details'))
    ? await select(
        "SELECT product_id,count(*) AS references FROM order_details WHERE product_id !~ '^shop:[0-9]+$' GROUP BY product_id ORDER BY product_id",
      )
    : [];
  plan.id_generation = await select(
    "SELECT column_name,is_identity,identity_generation,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='products' AND column_name='id'",
  );
  plan.sequences = await select(
    "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() AND sequencename=split_part(pg_get_serial_sequence('products','id'),'.',2)",
  );
  const highId = products.reduce(
    (max, row) => (BigInt(row.id) > max ? BigInt(row.id) : max),
    0n,
  );
  if (
    plan.sequences.length &&
    plan.sequences[0].last_value !== null &&
    BigInt(plan.sequences[0].last_value) < highId &&
    plan.planned_products.some((row) => !row.reuse_product_id)
  ) {
    plan.conflicts.push({
      reason:
        'Product identity sequence is behind existing IDs; review and advance it explicitly before conversion',
    });
    plan.can_apply = false;
  }
  plan.generated_at = new Date().toISOString();
  return { plan, snapshot: { products, variants, offers, inventory, mappings } };
}
