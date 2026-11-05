import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { auditContext } from './catalog-audit.js';
import { inspectProductMigration } from './product-migration-plan.js';
import { assignProductCategories } from './product-category-assignments.js';

// Invoked only by explicit apply after backup/review. Entire conversion is atomic.
export async function convertIndependentProducts(expectedFingerprint) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
    await sequelize.query("SET LOCAL lock_timeout='10s'", { transaction });
    await sequelize.query(
      'LOCK TABLE products,product_variants,vendor_products,inventory,product_categories,product_images,order_details,order_stock_reservations,product_checkouts,orders IN SHARE ROW EXCLUSIVE MODE',
      { transaction },
    );
    const { plan, snapshot } = await inspectProductMigration(transaction);
    if (!expectedFingerprint || expectedFingerprint !== plan.fingerprint)
      throw new Error(
        'Migration report is stale or missing; generate and approve a fresh fingerprint',
      );
    if (!plan.can_apply)
      throw new Error('Manual reconciliation is required before conversion');
    await auditContext(null, transaction, {
      movement: 'migration',
      reason: 'Approved independent product conversion',
    });
    const mappings = [];
    for (const item of plan.planned_products) {
      const source = snapshot.products.find(
        (row) => String(row.id) === String(item.source_product_id),
      );
      const variant = snapshot.variants.find(
        (row) => String(row.id) === String(item.variant_id),
      );
      const values = {};
      for (const [name, attr] of Object.entries(models.product.getAttributes())) {
        const column = attr.field ?? name;
        if (
          ![
            'product_id',
            'created_at',
            'updated_at',
            'created_by',
            'updated_by',
            'effective_price',
          ].includes(name) &&
          Object.hasOwn(source, column)
        )
          values[name] = source[column];
      }
      Object.assign(values, {
        product_type: 'simple',
        inventory_managed: true,
        attributes: variant?.attributes ?? source.attributes ?? {},
        sku: item.sku,
        regular_price: item.price,
        sale_price: item.sale_price,
        offer_percent: null,
        product_group_code:
          source.product_group_code ?? (variant ? `legacy-${source.id}` : null),
        stock_quantity: 0,
      });
      let product;
      if (item.reuse_product_id) {
        product = await models.product.findByPk(item.reuse_product_id, { transaction });
        await product.update(values, { transaction });
      } else {
        values.product_code = null;
        values.product_name =
          `${source.name} ${variant.variant_name || Object.values(variant.attributes).join(' ') || variant.sku}`.slice(
            0,
            255,
          );
        values.slug = `${source.slug.slice(0, 220)}-configuration-${variant.id}`;
        if (!variant.is_active || variant.deleted_at || source.deleted_at)
          values.product_status = 'inactive';
        product = await models.product.create(values, { transaction });
        const assigned = await models.productCategory.findAll({
          where: { product_id: source.id },
          transaction,
        });
        await assignProductCategories(
          product.product_id,
          assigned.map((row) => row.category_id),
          assigned.find((row) => row.is_primary)?.category_id ?? null,
          transaction,
        );
        // Copy DB references only. Shared immutable S3 objects remain protected by reference checks.
        const images = await models.productImage.findAll({
          where: { product_id: source.id },
          transaction,
        });
        // A separate link table preserves existing globally unique storage keys (no S3 writes).
        for (const image of images)
          await sequelize.query(
            'INSERT INTO independent_product_images(product_id,source_image_id,sort_order,is_primary) VALUES(:product,:image,:sort,:primary) ON CONFLICT DO NOTHING',
            {
              replacements: {
                product: product.product_id,
                image: image.id,
                sort: image.sort_order,
                primary: image.is_primary,
              },
              transaction,
            },
          );
      }
      if (item.inventory_ids.length) {
        await sequelize.query(
          'UPDATE inventory SET product_id=:product WHERE id IN (:ids) AND product_id IS NULL',
          {
            replacements: { product: product.product_id, ids: item.inventory_ids },
            transaction,
          },
        );
      } else {
        await sequelize.query(
          "INSERT INTO inventory(product_id,warehouse_code,quantity_on_hand) VALUES(:product,'DEFAULT',:stock) ON CONFLICT(product_id,warehouse_code) WHERE product_id IS NOT NULL DO NOTHING",
          {
            replacements: { product: product.product_id, stock: item.initial_stock },
            transaction,
          },
        );
      }
      if (item.variant_id) {
        await sequelize.query(
          'INSERT INTO legacy_variant_products(variant_id,independent_product_id,source_product_id) VALUES(:variant,:product,:source)',
          {
            replacements: {
              variant: item.variant_id,
              product: product.product_id,
              source: source.id,
            },
            transaction,
          },
        );
        mappings.push({ variant_id: item.variant_id, product_id: product.product_id });
      }
    }
    // Containers with multiple legacy configurations are retained as archived evidence.
    await sequelize.query(
      `UPDATE products p SET product_status='archived' WHERE NOT inventory_managed
      AND EXISTS(SELECT 1 FROM legacy_variant_products m WHERE m.source_product_id=p.id)`,
      { transaction },
    );
    await sequelize.query(
      `UPDATE order_details d SET independent_product_id=m.independent_product_id FROM vendor_products o JOIN legacy_variant_products m ON m.variant_id=o.variant_id WHERE d.product_id='shop:'||o.id AND d.independent_product_id IS NULL`,
      { transaction },
    );
    return {
      converted: plan.planned_products.length,
      mappings,
      preserved_categories: true,
      preserved_orders: true,
      s3_writes: 0,
    };
  });
}
