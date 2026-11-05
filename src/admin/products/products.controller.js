import { audit, validateReferences } from '../../catalog/store.js';
import {
  catalogMutation,
  sendMutation,
  fingerprint,
} from '../../shared/catalog-idempotency.js';

import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { productImageUpload } from '../../shared/image_upload.js';
import { MAX_PRODUCT_IMAGES } from '../../shared/product-images.js';
import {
  reserveImage,
  stageImage,
  imageUrl,
  queueImageCleanup,
  finishImageCleanup,
} from '../../shared/image-storage.js';

// =====================================================
// MERABETTA - PRODUCT MANAGEMENT
// New database schema:
// products.id = one independently purchasable variant
// =====================================================

const PRODUCT_COLUMNS = [
  'product_code',
  'product_name',
  'slug',
  'sku',
  'barcode',
  'brand_id',
  'category_id',
  'subcategory_id',
  'vendor_id',
  'product_type',
  'product_status',
  'selling_price',
  'mrp',
  'cost_price',
  'tax_rate',
  'hsn_code',
  'min_stock_quantity',
  'is_featured',
  'is_active',
];

const DETAIL_COLUMNS = [
  'short_description',
  'full_description',
  'key_features',
  'highlights',
  'manufacturer_name',
  'manufacturer_part_number',
  'country_of_origin',
  'imported_by',
  'marketed_by',
  'product_weight',
  'weight_unit',
  'product_length',
  'product_width',
  'product_height',
  'dimension_unit',
  'material',
  'colour',
  'size',
  'model_number',
  'model_name',
  'warranty',
  'package_contents',
  'package_weight',
  'package_length',
  'package_width',
  'package_height',
  'usage_instructions',
  'care_instructions',
  'safety_information',
  'return_policy',
  'meta_title',
  'meta_description',
  'meta_keywords',
  'canonical_url',
  'specifications',
  'additional_attributes',
];

const JSON_FIELDS = new Set([
  'key_features',
  'highlights',
  'package_contents',
  'specifications',
  'additional_attributes',
]);

const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// =====================================================
// DATABASE HELPERS
// =====================================================

async function query(sql, replacements = {}, transaction) {
  return sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
    transaction,
  });
}

function databaseError(error) {
  const code = error?.parent?.code ?? error?.original?.code;

  if (code === '23505') {
    return new HttpError(
      409,
      'Product code, SKU, slug, or another unique value already exists',
    );
  }

  if (code === '23503') {
    return new HttpError(
      422,
      'Referenced category, brand, vendor, product, or warehouse does not exist',
    );
  }

  if (code === '23514') {
    return new HttpError(422, 'Value violates a database constraint');
  }

  if (code === '23502') {
    return new HttpError(422, 'A required database value is missing');
  }

  return error;
}

async function findProduct(id, transaction, lock = false) {
  const rows = await query(
    `
    SELECT *
    FROM public.products
    WHERE id = :id
      AND COALESCE(is_deleted, false) = false
    ${lock ? 'FOR UPDATE' : ''}
    `,
    { id },
    transaction,
  );

  if (!rows[0]) {
    throw new HttpError(404, 'Product not found');
  }

  return rows[0];
}

// =====================================================
// PRICE MAPPING
// =====================================================

function pricesFrom(data, current = {}) {
  if (has(data, 'mrp') && has(data, 'regular_price') && data.mrp !== data.regular_price) {
    throw new HttpError(422, 'regular_price must match mrp');
  }

  if (
    has(data, 'selling_price') &&
    has(data, 'sale_price') &&
    data.selling_price !== data.sale_price
  ) {
    throw new HttpError(422, 'sale_price must match selling_price');
  }

  const mrp = data.mrp ?? data.regular_price ?? current.mrp ?? 0;

  const selling = data.selling_price ?? data.sale_price ?? current.selling_price ?? mrp;

  if (Number(selling) > Number(mrp)) {
    throw new HttpError(422, 'selling_price cannot exceed mrp');
  }

  return {
    mrp,
    selling_price: selling,
  };
}

function productValues(data, current = null) {
  const values = Object.fromEntries(
    PRODUCT_COLUMNS.filter((key) => has(data, key)).map((key) => [key, data[key]]),
  );

  const prices = pricesFrom(data, current ?? {});

  if (!current || has(data, 'mrp') || has(data, 'regular_price')) {
    values.mrp = prices.mrp;
  }

  if (!current || has(data, 'selling_price') || has(data, 'sale_price')) {
    values.selling_price = prices.selling_price;
  }

  return values;
}

// =====================================================
// PRODUCT DETAILS - ONE TO ONE
// =====================================================

async function detailsValues(data, id, transaction) {
  const details = Object.fromEntries(
    DETAIL_COLUMNS.filter((key) => has(data.details ?? {}, key)).map((key) => [
      key,
      data.details[key],
    ]),
  );

  if (has(data, 'short_description') && !has(details, 'short_description')) {
    details.short_description = data.short_description;
  }

  if (has(data, 'description') && !has(details, 'full_description')) {
    details.full_description = data.description;
  }

  // Optional grouping is metadata, not a parent product.
  if (has(data, 'product_group_code')) {
    const [existing] = await query(
      `
      SELECT additional_attributes
      FROM public.product_details
      WHERE product_id = :id
      `,
      { id },
      transaction,
    );

    const attributes = {
      ...(existing?.additional_attributes ?? {}),
      ...(details.additional_attributes ?? {}),
    };

    if (data.product_group_code === null) {
      delete attributes.product_group_code;
    } else {
      attributes.product_group_code = data.product_group_code;
    }

    details.additional_attributes = attributes;
  }

  return details;
}

async function saveDetails(id, data, transaction) {
  const values = await detailsValues(data, id, transaction);

  const columns = Object.keys(values);

  if (!columns.length) {
    await query(
      `
      INSERT INTO public.product_details (product_id)
      VALUES (:id)
      ON CONFLICT (product_id) DO NOTHING
      RETURNING id
      `,
      { id },
      transaction,
    );

    return;
  }

  const parameters = {
    productId: id,
  };

  const placeholders = columns.map((column) => {
    parameters[`d_${column}`] = JSON_FIELDS.has(column)
      ? JSON.stringify(values[column])
      : values[column];

    return JSON_FIELDS.has(column) ? `CAST(:d_${column} AS jsonb)` : `:d_${column}`;
  });

  const updates = columns.map((column) => `${column} = EXCLUDED.${column}`);

  await query(
    `
    INSERT INTO public.product_details (
      product_id,
      ${columns.join(', ')}
    )
    VALUES (
      :productId,
      ${placeholders.join(', ')}
    )
    ON CONFLICT (product_id)
    DO UPDATE SET
      ${updates.join(', ')},
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
    `,
    parameters,
    transaction,
  );
}

// =====================================================
// INITIAL PRODUCT INVENTORY
// =====================================================

function prepareInitialInventory(input) {
  if (!input) return null;

  const reserved = input.reserved_quantity ?? 0;
  if (reserved !== 0)
    throw new HttpError(
      422,
      'Initial reserved stock must be zero; orders own reservations',
    );
  const damaged = input.damaged_quantity ?? 0;
  const inTransit = input.in_transit_quantity ?? 0;

  const available = input.available_quantity ?? input.total_quantity - reserved - damaged;

  if (available < 0 || available + reserved + damaged > input.total_quantity) {
    throw new HttpError(
      422,
      'Available + reserved + damaged stock cannot exceed total stock',
    );
  }

  const min = input.minimum_stock_level ?? 0;
  const max = input.maximum_stock_level ?? 0;

  if (max !== 0 && min > max) {
    throw new HttpError(422, 'minimum_stock_level exceeds maximum_stock_level');
  }

  return {
    ...input,
    available_quantity: available,
    reserved_quantity: reserved,
    damaged_quantity: damaged,
    in_transit_quantity: inTransit,
  };
}

async function createInventory(productId, input, transaction) {
  const columns = [
    'product_id',
    'warehouse_id',
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

  const values = {
    product_id: productId,
    ...input,
  };

  const present = columns.filter((column) => values[column] !== undefined);

  await query(
    `
    INSERT INTO public.product_inventory (
      ${present.join(', ')}
    )
    VALUES (
      ${present.map((column) => `:${column}`).join(', ')}
    )
    RETURNING id
    `,
    values,
    transaction,
  );
}

async function inventoryFor(id, transaction) {
  const warehouses = await query(
    `
    SELECT i.*, w.is_active AS warehouse_active
    FROM public.product_inventory i JOIN public.warehouses w ON w.id=i.warehouse_id
    WHERE i.product_id = :id
    ORDER BY i.warehouse_id
    `,
    { id },
    transaction,
  );

  const summary = {
    total_quantity: 0,
    available_quantity: 0,
    reserved_quantity: 0,
    damaged_quantity: 0,
    in_transit_quantity: 0,
  };

  for (const warehouse of warehouses) {
    if (!warehouse.is_active || !warehouse.warehouse_active) continue;

    for (const field of Object.keys(summary)) {
      summary[field] += Number(warehouse[field] ?? 0);
    }
  }

  return {
    ...summary,
    warehouses,
  };
}

// =====================================================
// PRODUCT IMAGES - EXISTING S3 IMPLEMENTATION
// =====================================================

async function loadImages(productIds, transaction) {
  if (!productIds.length) return new Map();

  const records = await models.productImage.findAll({
    where: {
      product_id: {
        [Op.in]: productIds,
      },
    },
    order: [
      ['is_primary', 'DESC'],
      ['sort_order', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  const result = new Map();

  for (const record of records) {
    const row = record.toJSON();
    const key = String(row.product_id);

    if (!result.has(key)) {
      result.set(key, []);
    }

    result.get(key).push(row);
  }

  return result;
}

// =====================================================
// FORMAT PRODUCT RESPONSE
// =====================================================

function productResponse(product, images = [], inventory) {
  const { details, warehouse_available, ...record } = product;

  const extra = details ?? {};

  return {
    ...record,

    stock_quantity: Number(warehouse_available ?? record.stock_quantity ?? 0),

    details: extra,
    images,

    product_group_code: extra.additional_attributes?.product_group_code ?? null,

    // API compatibility only. Not database columns.
    regular_price: record.mrp,
    sale_price: record.selling_price,

    short_description: extra.short_description ?? null,

    description: extra.full_description ?? null,

    ...(inventory ? { inventory } : {}),
  };
}

// =====================================================
// GET COMPLETE PRODUCT
// =====================================================

async function getFullProduct(id, transaction) {
  const [product] = await query(
    `
    SELECT
      p.*,
      (to_jsonb(d) - 'product_id') AS details,

      COALESCE(
        (
          SELECT SUM(available_quantity)::int
          FROM public.product_inventory i JOIN public.warehouses w ON w.id=i.warehouse_id
          WHERE i.product_id = p.id
            AND i.is_active = true AND w.is_active = true
        ),
        0
      ) AS warehouse_available

    FROM public.products p

    LEFT JOIN public.product_details d
      ON d.product_id = p.id

    WHERE p.id = :id
      AND COALESCE(p.is_deleted, false) = false
    `,
    { id },
    transaction,
  );

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  const images = await loadImages([product.id], transaction);

  const inventory = await inventoryFor(id, transaction);

  return productResponse(product, images.get(String(id)) ?? [], inventory);
}

// =====================================================
// GET /api/admin/products
// =====================================================

export async function listProducts(req, res) {
  const filters = req.validatedQuery;

  const replacements = {
    limit: filters.limit,
    offset: filters.offset,
  };

  const where = ['COALESCE(p.is_deleted, false) = false'];

  for (const field of [
    'brand_id',
    'category_id',
    'subcategory_id',
    'vendor_id',
    'product_status',
  ]) {
    if (filters[field] !== undefined) {
      where.push(`p.${field} = :${field}`);
      replacements[field] = filters[field];
    }
  }

  if (filters.is_active !== undefined) {
    where.push('p.is_active = :is_active');
    replacements.is_active = filters.is_active === 'true';
  }

  if (filters.product_group_code) {
    where.push("d.additional_attributes ->> 'product_group_code' = :product_group_code");

    replacements.product_group_code = filters.product_group_code;
  }

  if (filters.search) {
    where.push(
      `
      (
        p.product_name ILIKE :search
        OR p.product_code ILIKE :search
        OR p.sku ILIKE :search
        OR p.barcode ILIKE :search
      )
      `,
    );

    replacements.search = `%${filters.search}%`;
  }

  const from = `
    FROM public.products p

    LEFT JOIN public.product_details d
      ON d.product_id = p.id

    WHERE ${where.join(' AND ')}
  `;

  const [{ total }] = await query(`SELECT COUNT(*)::int AS total ${from}`, replacements);

  const sortBy =
    {
      product_id: 'p.id',
      product_name: 'p.product_name',
      product_code: 'p.product_code',
      sku: 'p.sku',
    }[filters.sort_by] ?? 'p.id';

  const direction = filters.sort_order === 'desc' ? 'DESC' : 'ASC';

  const rows = await query(
    `
    SELECT
      p.*,
      (to_jsonb(d) - 'product_id') AS details,

      COALESCE(
        (
          SELECT SUM(available_quantity)::int
          FROM public.product_inventory i JOIN public.warehouses w ON w.id=i.warehouse_id
          WHERE i.product_id = p.id
            AND i.is_active = true AND w.is_active = true
        ),
        0
      ) AS warehouse_available

    ${from}

    ORDER BY ${sortBy} ${direction}, p.id ASC

    LIMIT :limit
    OFFSET :offset
    `,
    replacements,
  );

  const images = await loadImages(rows.map((row) => row.id));

  res.json({
    data: rows.map((row) => productResponse(row, images.get(String(row.id)) ?? [])),

    pagination: {
      total,
      limit: filters.limit,
      offset: filters.offset,
      hasMore: filters.offset + rows.length < total,
    },
  });
}

// =====================================================
// GET /api/admin/products/:productId
// =====================================================

export async function getProduct(req, res) {
  res.json({
    data: await getFullProduct(req.validatedParams.productId),
  });
}

// =====================================================
// POST /api/admin/products
// =====================================================

export async function createProduct(req, res) {
  const data = req.validated;

  try {
    const result = await catalogMutation(req, data, 201, async (transaction) => {
      const values = productValues(data);
      await validateReferences(values, transaction);

      const inventory = prepareInitialInventory(data.initial_inventory);

      if (inventory) {
        const [warehouse] = await query(
          'SELECT id FROM warehouses WHERE id=:id AND is_active FOR SHARE',
          { id: inventory.warehouse_id },
          transaction,
        );
        if (!warehouse) throw new HttpError(422, 'Active warehouse not found');
      }
      const available = inventory?.available_quantity ?? 0;

      if (has(data, 'stock_quantity') && data.stock_quantity !== available) {
        throw new HttpError(
          422,
          'Use initial_inventory for stock; stock_quantity must equal its available_quantity',
        );
      }

      values.stock_quantity = available;

      const columns = Object.keys(values);

      const [created] = await query(
        `
          INSERT INTO public.products (
            ${columns.join(', ')}
          )
          VALUES (
            ${columns.map((column) => `:${column}`).join(', ')}
          )
          RETURNING id
          `,
        values,
        transaction,
      );

      await saveDetails(created.id, data, transaction);

      if (inventory) {
        await createInventory(created.id, inventory, transaction);
      }

      const product = await getFullProduct(created.id, transaction);
      await audit(req, 'product', created.id, null, product, transaction);
      return product;
    });

    res.location(`/api/admin/products/${result.body.data.id}`);
    sendMutation(res, result);
  } catch (error) {
    throw databaseError(error);
  }
}

// =====================================================
// PATCH /api/admin/products/:productId
// =====================================================

export async function updateProduct(req, res) {
  const { productId } = req.validatedParams;

  try {
    const product = await sequelize.transaction(async (transaction) => {
      const previous = await findProduct(productId, transaction, true);

      const data = req.validated;

      const changes = productValues(data, previous);

      if (
        has(data, 'stock_quantity') &&
        data.stock_quantity !== previous.stock_quantity
      ) {
        throw new HttpError(
          409,
          'Change stock through the product warehouse inventory endpoint',
        );
      }

      await validateReferences({ ...previous, ...changes }, transaction);
      const columns = Object.keys(changes);

      if (columns.length) {
        await query(
          `
            UPDATE public.products
            SET
              ${columns.map((column) => `${column} = :${column}`).join(', ')},
              updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
            RETURNING id
            `,
          {
            ...changes,
            id: productId,
          },
          transaction,
        );
      } else {
        await query(
          `
            UPDATE public.products
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
            RETURNING id
            `,
          { id: productId },
          transaction,
        );
      }

      await saveDetails(productId, data, transaction);

      const product = await getFullProduct(productId, transaction);
      await audit(req, 'product', productId, previous, product, transaction);
      return product;
    });

    res.json({ data: product });
  } catch (error) {
    throw databaseError(error);
  }
}

// =====================================================
// DELETE /api/admin/products/:productId
// SOFT DELETE
// =====================================================

export async function deleteProduct(req, res) {
  try {
    await sequelize.transaction(async (transaction) => {
      const before = await findProduct(req.validatedParams.productId, transaction, true);

      const [after] = await query(
        `
          UPDATE public.products
          SET
            product_status = 'archived',
            is_active = false,
            is_deleted = true,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = :id
          RETURNING *
          `,
        {
          id: req.validatedParams.productId,
        },
        transaction,
      );
      await audit(req, 'product', before.id, before, after, transaction, 'delete');
    });

    res.status(204).end();
  } catch (error) {
    throw databaseError(error);
  }
}

// =====================================================
// POST /api/admin/products/:productId/images
// EXISTING AWS S3 IMAGE UPLOAD
// =====================================================

export function uploadImagesProduct(req, res, next) {
  productImageUpload(req, res, async (error) => {
    if (error) {
      return next(new HttpError(400, error.message));
    }

    try {
      const id = req.validatedParams.productId;

      await findProduct(id);

      const files = req.files ?? [];
      const reserved = [];

      for (const file of files) {
        reserved.push(await reserveImage('products', id, file));
      }

      const saved = await catalogMutation(
        req,
        files.map((file) => ({
          type: file.mimetype,
          hash: fingerprint(file.buffer.toString('base64')),
        })),
        201,
        async (transaction) => {
          await findProduct(id, transaction, true);

          const existing = await models.productImage.findAll({
            where: {
              product_id: id,
            },
            transaction,
            order: [['sort_order', 'DESC']],
          });

          if (existing.length + files.length > MAX_PRODUCT_IMAGES) {
            throw new HttpError(
              400,
              `A product can have at most ${MAX_PRODUCT_IMAGES} images`,
            );
          }

          let primary = existing.some((image) => image.is_primary);

          let sortOrder = Math.max(0, ...existing.map((image) => image.sort_order));

          const results = [];

          for (const [index, file] of files.entries()) {
            const { key, journal } = await stageImage(reserved[index], file, transaction);

            const added = await models.productImage.create(
              {
                product_id: id,
                s3_key: key,
                image_url: imageUrl(key),
                sort_order: ++sortOrder,
                is_primary: !primary,
              },
              { transaction },
            );

            primary = true;

            await journal.destroy({
              transaction,
            });

            results.push(added.toJSON());
          }

          return results;
        },
      );

      sendMutation(res, saved);
    } catch (uploadError) {
      next(databaseError(uploadError));
    }
  });
}

// =====================================================
// GET /api/admin/products/:productId/images
// =====================================================

export async function listProductImages(req, res) {
  const id = req.validatedParams.productId;

  await findProduct(id);

  const images = await loadImages([id]);

  res.json({
    data: images.get(String(id)) ?? [],
  });
}

// =====================================================
// PATCH /:productId/images/:imageId/primary
// =====================================================

export async function setPrimaryProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;

  const updated = await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction, true);

    const selected = await models.productImage.findOne({
      where: {
        id: imageId,
        product_id: productId,
      },
      transaction,
    });

    if (!selected) {
      throw new HttpError(404, 'Product image not found');
    }

    await models.productImage.update(
      { is_primary: false },
      {
        where: {
          product_id: productId,
        },
        transaction,
      },
    );

    await selected.update({ is_primary: true }, { transaction });

    return selected.toJSON();
  });

  res.json({
    data: updated,
  });
}

// =====================================================
// PUT /:productId/images/:imageId
// REPLACE IMAGE
// =====================================================

export function replaceProductImage(req, res, next) {
  productImageUpload(req, res, async (error) => {
    if (error) {
      return next(new HttpError(400, error.message));
    }

    try {
      const { productId, imageId } = req.validatedParams;

      const files = req.files ?? [];

      if (files.length !== 1) {
        throw new HttpError(400, 'Upload exactly one image using uploadimage');
      }

      await findProduct(productId);

      const reserved = await reserveImage('products', productId, files[0]);

      let oldKey;

      const result = await catalogMutation(
        req,
        {
          type: files[0].mimetype,
          hash: fingerprint(files[0].buffer.toString('base64')),
        },
        200,
        async (transaction) => {
          await findProduct(productId, transaction, true);

          const image = await models.productImage.findOne({
            where: {
              id: imageId,
              product_id: productId,
            },
            transaction,
          });

          if (!image) {
            throw new HttpError(404, 'Product image not found');
          }

          const staged = await stageImage(reserved, files[0], transaction);

          oldKey = image.s3_key;

          await queueImageCleanup(oldKey, transaction);

          await image.update(
            {
              s3_key: staged.key,
              image_url: imageUrl(staged.key),
            },
            { transaction },
          );

          await staged.journal.destroy({
            transaction,
          });

          return image.toJSON();
        },
      );

      if (oldKey) await finishImageCleanup([oldKey]);

      sendMutation(res, result);
    } catch (replaceError) {
      next(databaseError(replaceError));
    }
  });
}

// =====================================================
// DELETE /:productId/images/:imageId
// =====================================================

export async function deleteProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;

  let oldKey;

  await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction, true);

    const image = await models.productImage.findOne({
      where: {
        id: imageId,
        product_id: productId,
      },
      transaction,
    });

    if (!image) {
      throw new HttpError(404, 'Product image not found');
    }

    oldKey = image.s3_key;

    await queueImageCleanup(oldKey, transaction);

    const wasPrimary = image.is_primary;

    await image.destroy({
      transaction,
    });

    if (wasPrimary) {
      const nextImage = await models.productImage.findOne({
        where: {
          product_id: productId,
        },
        transaction,
        order: [
          ['sort_order', 'ASC'],
          ['id', 'ASC'],
        ],
      });

      if (nextImage) {
        await nextImage.update({ is_primary: true }, { transaction });
      }
    }
  });

  if (oldKey) await finishImageCleanup([oldKey]);

  res.status(204).end();
}
