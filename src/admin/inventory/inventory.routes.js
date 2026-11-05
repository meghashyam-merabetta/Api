import { audit } from '../../catalog/store.js';

import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

// One products.id represents one independent variant.
// Warehouse stock belongs to product_inventory.

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const qty = z.number().int().min(0).max(2147483647);

const slot = z.string().trim().max(100).nullable();

const params = z
  .object({
    productId: id,
  })
  .strict();

const paging = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

// =======================================
// INVENTORY REQUEST VALIDATION
// =======================================

const stockSchema = z
  .object({
    warehouse_id: id,

    total_quantity: qty.optional(),
    available_quantity: qty.optional(),
    reserved_quantity: qty.optional(),
    damaged_quantity: qty.optional(),
    in_transit_quantity: qty.optional(),

    minimum_stock_level: qty.optional(),
    maximum_stock_level: qty.optional(),
    reorder_quantity: qty.optional(),

    rack_number: slot.optional(),
    shelf_number: slot.optional(),
    bin_number: slot.optional(),
  })
  .strict();

const editable = [
  'total_quantity',
  'available_quantity',
  'reserved_quantity',
  'damaged_quantity',
  'in_transit_quantity',
  'minimum_stock_level',
  'maximum_stock_level',
  'reorder_quantity',
  'rack_number',
  'shelf_number',
  'bin_number',
];

// =======================================
// DATABASE HELPER
// =======================================

async function rows(sql, replacements = {}, transaction) {
  return sequelize.query(sql, {
    replacements,
    type: QueryTypes.SELECT,
    transaction,
  });
}

async function requirePermission(req) {
  const profile = await models.adminProfile.findOne({
    where: {
      userId: req.auth.userId,
    },
  });

  if (
    !profile?.permissions?.some((permission) =>
      ['*', 'admin.manage', 'inventory.adjust'].includes(permission),
    )
  ) {
    throw new HttpError(403, 'Inventory adjustment permission required');
  }
}

function translateDbError(error) {
  const code = error?.parent?.code ?? error?.original?.code;

  if (code === '23503') {
    return new HttpError(422, 'Invalid warehouse or product ID');
  }

  if (code === '23505') {
    return new HttpError(409, 'Duplicate warehouse inventory row');
  }

  if (code === '23514') {
    return new HttpError(422, 'Invalid stock quantities');
  }

  return error;
}

// =======================================
// GET INVENTORY SUMMARY
// =======================================

async function inventorySummary(productId, transaction) {
  const [product] = await rows(
    `
    SELECT
      id::text AS id,
      sku,
      product_status,
      is_active
    FROM public.products
    WHERE id = :productId
      AND COALESCE(is_deleted, false) = false
    `,
    { productId },
    transaction,
  );

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  const warehouses = await rows(
    `
    SELECT
      i.id::text AS id,
      i.product_id::text AS product_id,
      i.warehouse_id::text AS warehouse_id,

      w.warehouse_code,
      w.warehouse_name,
      w.is_active AS warehouse_active,

      i.total_quantity,
      i.available_quantity,
      i.reserved_quantity,
      i.damaged_quantity,
      i.in_transit_quantity,

      i.minimum_stock_level,
      i.maximum_stock_level,
      i.reorder_quantity,

      i.rack_number,
      i.shelf_number,
      i.bin_number,

      i.is_active,
      i.last_stock_updated_at,
      i.last_stock_check_at,
      i.created_at,
      i.updated_at

    FROM public.product_inventory i

    JOIN public.warehouses w
      ON w.id = i.warehouse_id

    WHERE i.product_id = :productId
    ORDER BY i.warehouse_id
    `,
    { productId },
    transaction,
  );

  const totals = {
    total_quantity: 0,
    available_quantity: 0,
    reserved_quantity: 0,
    damaged_quantity: 0,
    in_transit_quantity: 0,
    minimum_stock_level: 0,
  };

  for (const warehouse of warehouses) {
    if (!warehouse.is_active || !warehouse.warehouse_active) continue;

    for (const key of Object.keys(totals)) {
      totals[key] += Number(warehouse[key] ?? 0);
    }
  }

  return {
    product_id: product.id,
    sku: product.sku,
    ...totals,

    status:
      !product.is_active || product.product_status !== 'active'
        ? 'inactive'
        : totals.available_quantity > 0
          ? 'available'
          : 'sold_out',

    warehouses,
  };
}

async function getInventory(req, res) {
  res.json({
    data: await inventorySummary(req.validatedParams.productId),
  });
}

// =======================================
// PUT / PATCH WAREHOUSE INVENTORY
// =======================================

// Uses absolute quantities, not increments.
// Repeating an identical request cannot add stock twice.

async function setInventory(req, res) {
  await requirePermission(req);

  const productId = req.validatedParams.productId;
  const input = req.validated;

  try {
    const result = await sequelize.transaction(async (transaction) => {
      // Lock product before inventory.
      const [product] = await rows(
        `
          SELECT id
          FROM public.products
          WHERE id = :productId
            AND COALESCE(is_deleted, false) = false
          FOR UPDATE
          `,
        { productId },
        transaction,
      );

      if (!product) {
        throw new HttpError(404, 'Product not found');
      }

      const [warehouse] = await rows(
        `
          SELECT id
          FROM public.warehouses
          WHERE id = :warehouseId
            AND is_active = true
          `,
        { warehouseId: input.warehouse_id },
        transaction,
      );

      if (!warehouse) {
        throw new HttpError(422, 'Active warehouse not found');
      }

      const [existing] = await rows(
        `
          SELECT *
          FROM public.product_inventory
          WHERE product_id = :productId
            AND warehouse_id = :warehouseId
          FOR UPDATE
          `,
        {
          productId,
          warehouseId: input.warehouse_id,
        },
        transaction,
      );

      if (existing && !existing.is_active) {
        throw new HttpError(409, 'Warehouse inventory is inactive');
      }

      // Protect active order reservations.
      if (
        input.reserved_quantity !== undefined &&
        input.reserved_quantity !== Number(existing?.reserved_quantity ?? 0)
      ) {
        throw new HttpError(409, 'Reserved stock must be changed by order settlement');
      }

      const values = {
        total_quantity: 0,
        available_quantity: 0,
        reserved_quantity: 0,
        damaged_quantity: 0,
        in_transit_quantity: 0,

        minimum_stock_level: 0,
        maximum_stock_level: 0,
        reorder_quantity: 0,

        rack_number: null,
        shelf_number: null,
        bin_number: null,

        ...existing,
      };

      for (const field of editable) {
        if (Object.hasOwn(input, field)) {
          values[field] = input[field];
        }
      }

      // In-transit quantity is tracked separately.
      if (
        values.available_quantity + values.reserved_quantity + values.damaged_quantity >
        values.total_quantity
      ) {
        throw new HttpError(
          422,
          'Available + reserved + damaged stock cannot exceed total stock',
        );
      }

      if (
        values.maximum_stock_level > 0 &&
        values.minimum_stock_level > values.maximum_stock_level
      ) {
        throw new HttpError(422, 'Minimum stock exceeds maximum stock');
      }

      const replacements = {
        productId,
        warehouseId: input.warehouse_id,

        ...Object.fromEntries(editable.map((field) => [field, values[field]])),
      };

      if (existing) {
        await rows(
          `
            UPDATE public.product_inventory
            SET
              ${editable.map((field) => `${field} = :${field}`).join(', ')},

              last_stock_updated_at = NOW(),
              last_stock_check_at = NULL,
              updated_at = NOW()

            WHERE product_id = :productId
              AND warehouse_id = :warehouseId

            RETURNING id
            `,
          replacements,
          transaction,
        );
      } else {
        await rows(
          `
            INSERT INTO public.product_inventory (
              product_id,
              warehouse_id,
              ${editable.join(', ')}
            )
            VALUES (
              :productId,
              :warehouseId,
              ${editable.map((field) => `:${field}`).join(', ')}
            )
            RETURNING id
            `,
          replacements,
          transaction,
        );
      }

      // Maintain aggregate sellable quantity.
      await rows(
        `
          UPDATE public.products
          SET
            stock_quantity = COALESCE(
              (
                SELECT SUM(available_quantity)::int
                FROM public.product_inventory i JOIN public.warehouses w ON w.id=i.warehouse_id
                WHERE i.product_id = :productId
                  AND i.is_active = true AND w.is_active = true
              ),
              0
            ),
            updated_at = NOW()
          WHERE id = :productId
          RETURNING id
          `,
        { productId },
        transaction,
      );

      const [after] = await rows(
        'SELECT * FROM product_inventory WHERE product_id=:productId AND warehouse_id=:warehouseId',
        replacements,
        transaction,
      );
      await audit(
        req,
        'product_inventory',
        after.id,
        existing ?? null,
        after,
        transaction,
        'adjustment',
      );
      return inventorySummary(productId, transaction);
    });

    res.json({ data: result });
  } catch (error) {
    throw translateDbError(error);
  }
}

// =======================================
// RELATED INDEPENDENT PRODUCTS
// =======================================

async function relatedProducts(req, res) {
  const productId = req.validatedParams.productId;
  const { limit, offset } = req.validatedQuery;

  const [source] = await rows(
    `
    SELECT
      p.id,
      d.additional_attributes
        ->> 'product_group_code' AS group_code
    FROM public.products p
    LEFT JOIN public.product_details d
      ON d.product_id = p.id
    WHERE p.id = :productId
      AND COALESCE(p.is_deleted, false) = false
    `,
    { productId },
  );

  if (!source) {
    throw new HttpError(404, 'Product not found');
  }

  if (!source.group_code) {
    return res.json({
      data: [],
      pagination: {
        total: 0,
        limit,
        offset,
        hasMore: false,
      },
    });
  }

  const replacements = {
    productId,
    code: source.group_code,
    limit,
    offset,
  };

  const from = `
    FROM public.products p
    JOIN public.product_details d
      ON d.product_id = p.id
    WHERE d.additional_attributes
      ->> 'product_group_code' = :code
      AND p.id <> :productId
      AND COALESCE(p.is_deleted, false) = false
  `;

  const [count] = await rows(`SELECT COUNT(*)::int AS total ${from}`, replacements);

  const data = await rows(
    `
    SELECT
      p.id::text AS id,
      p.product_name,
      p.product_code,
      p.sku,
      p.mrp,
      p.selling_price,
      p.stock_quantity,
      d.size,
      d.colour
    ${from}
    ORDER BY p.id
    LIMIT :limit
    OFFSET :offset
    `,
    replacements,
  );

  res.json({
    data,
    pagination: {
      total: count.total,
      limit,
      offset,
      hasMore: offset + data.length < count.total,
    },
  });
}

// =======================================
// LEGACY ENDPOINT SAFETY
// =======================================

// Native writes use the existing audit_logs table; no replacement table is created.

async function history(req, res) {
  await inventorySummary(req.validatedParams.productId);
  const { limit, offset } = req.validatedQuery;
  const inventoryOnly = req.path.endsWith('/inventory-history');
  const condition = `(entity_type='product_inventory' AND (new_values->>'product_id'=:id OR old_values->>'product_id'=:id))${inventoryOnly ? '' : " OR (entity_type='product' AND entity_id=:id)"}`;
  const args = { id: String(req.validatedParams.productId), limit, offset };
  const [{ total }] = await rows(
    `SELECT count(*)::int total FROM audit_logs WHERE ${condition}`,
    args,
  );
  const data = await rows(
    `SELECT * FROM audit_logs WHERE ${condition} ORDER BY id DESC LIMIT :limit OFFSET :offset`,
    args,
  );
  res.json({
    data,
    pagination: { total, limit, offset, hasMore: offset + data.length < total },
  });
}

// Delta adjustments need durable idempotency
// and an inventory movement audit before use.

function unavailableAdjustment() {
  throw new HttpError(
    409,
    'Delta adjustments are disabled until stock audit and idempotency are migrated. Use PUT inventory with absolute quantities.',
  );
}

// =======================================
// ROUTES
// =======================================

export const inventoryRoutes = [
  {
    method: 'get',
    path: '/:productId/related',
    params,
    query: paging,
    handler: relatedProducts,
  },
  {
    method: 'get',
    path: '/:productId/inventory',
    params,
    handler: getInventory,
  },
  {
    method: 'put',
    path: '/:productId/inventory',
    params,
    schema: stockSchema,
    handler: setInventory,
  },
  {
    method: 'patch',
    path: '/:productId/inventory',
    params,
    schema: stockSchema,
    handler: setInventory,
  },
  {
    method: 'post',
    path: '/:productId/inventory/adjustments',
    params,
    handler: unavailableAdjustment,
  },
  {
    method: 'get',
    path: '/:productId/inventory-history',
    params,
    query: paging,
    handler: history,
  },
  {
    method: 'get',
    path: '/:productId/audit-history',
    params,
    query: paging,
    handler: history,
  },
];
