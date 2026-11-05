import { z } from 'zod';

// Each products row is one independently purchasable variant.
// No parent_product_id, product_variants table, or base_price.

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const queryId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const money = z.number().finite().min(0).max(9999999999.99).multipleOf(0.01);
const quantity = z.number().int().min(0).max(2147483647);

const nonnegative = (max) => z.number().finite().min(0).max(max).nullable();

const optionalText = (max) => z.string().trim().max(max).nullable();

const productStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);

// ======================================
// PRODUCTS TABLE FIELDS
// ======================================

const productFields = {
  product_code: z.string().trim().min(1).max(50),
  product_name: z.string().trim().min(1).max(255),

  slug: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),

  sku: optionalText(100),
  barcode: optionalText(100),

  brand_id: id.nullable(),
  category_id: id.nullable(),
  subcategory_id: id.nullable(),
  vendor_id: id.nullable(),

  product_type: z.enum(['simple', 'variable', 'grouped', 'bundle']),
  product_status: productStatusSchema,

  selling_price: money,
  mrp: money,
  cost_price: money,

  tax_rate: z.number().finite().min(0).max(100),
  hsn_code: optionalText(30),

  stock_quantity: quantity,
  min_stock_quantity: quantity,

  is_featured: z.boolean(),
  is_active: z.boolean(),
};

// ======================================
// PRODUCT_DETAILS TABLE FIELDS
// ======================================

const detailFields = {
  short_description: z.string().nullable(),
  full_description: z.string().nullable(),

  key_features: z.array(z.unknown()),
  highlights: z.array(z.unknown()),

  manufacturer_name: optionalText(255),
  manufacturer_part_number: optionalText(100),
  country_of_origin: optionalText(100),
  imported_by: optionalText(255),
  marketed_by: optionalText(255),

  product_weight: nonnegative(9999999.999),
  weight_unit: optionalText(20),

  product_length: nonnegative(99999999.99),
  product_width: nonnegative(99999999.99),
  product_height: nonnegative(99999999.99),
  dimension_unit: optionalText(20),

  material: optionalText(255),
  colour: optionalText(100),
  size: optionalText(100),

  model_number: optionalText(100),
  model_name: optionalText(255),
  warranty: optionalText(255),

  package_contents: z.array(z.unknown()),
  package_weight: nonnegative(9999999.999),
  package_length: nonnegative(99999999.99),
  package_width: nonnegative(99999999.99),
  package_height: nonnegative(99999999.99),

  usage_instructions: z.string().nullable(),
  care_instructions: z.string().nullable(),
  safety_information: z.string().nullable(),
  return_policy: z.string().nullable(),

  meta_title: optionalText(255),
  meta_description: z.string().nullable(),
  meta_keywords: z.string().nullable(),
  canonical_url: z.string().nullable(),

  specifications: z.record(z.string(), z.unknown()),

  additional_attributes: z.record(z.string(), z.unknown()),
};

export const productDetailsSchema = z.object(detailFields).partial().strict();

// ======================================
// INITIAL WAREHOUSE INVENTORY
// ======================================

export const initialInventorySchema = z
  .object({
    warehouse_id: id,

    total_quantity: quantity,
    available_quantity: quantity.optional(),
    reserved_quantity: quantity.optional(),
    damaged_quantity: quantity.optional(),
    in_transit_quantity: quantity.optional(),

    minimum_stock_level: quantity.optional(),
    maximum_stock_level: quantity.optional(),
    reorder_quantity: quantity.optional(),

    rack_number: optionalText(100).optional(),
    shelf_number: optionalText(100).optional(),
    bin_number: optionalText(100).optional(),
  })
  .strict();

// ======================================
// COMMON PRODUCT INPUT FIELDS
// ======================================

const inputFields = {
  ...Object.fromEntries(
    Object.entries(productFields).map(([key, schema]) => [key, schema.optional()]),
  ),

  // Existing CMS aliases.
  // Controller will map these to new database columns.
  regular_price: money.optional(),
  sale_price: money.optional(),

  short_description: z.string().nullable().optional(),
  description: z.string().nullable().optional(),

  // Stored in product_details.additional_attributes,
  // not as a products table column.
  product_group_code: z.string().trim().min(1).max(100).nullable().optional(),

  details: productDetailsSchema.optional(),
};

// ======================================
// GET /api/admin/products
// ======================================

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),

    offset: z.coerce.number().int().min(0).default(0),

    product_group_code: z.string().trim().min(1).max(100).optional(),

    brand_id: queryId.optional(),
    category_id: queryId.optional(),
    subcategory_id: queryId.optional(),
    vendor_id: queryId.optional(),

    search: z.string().trim().min(1).max(255).optional(),

    product_status: productStatusSchema.optional(),

    is_active: z.enum(['true', 'false']).optional(),

    sort_by: z
      .enum(['product_id', 'product_name', 'product_code', 'sku'])
      .default('product_id'),

    sort_order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

// ======================================
// PRODUCT ID PARAMETERS
// ======================================

export const productIdParamsSchema = z
  .object({
    productId: queryId,
  })
  .strict();

export const productImageParamsSchema = z
  .object({
    productId: queryId,
    imageId: queryId,
  })
  .strict();

// ======================================
// CREATE PRODUCT
// POST /api/admin/products
// ======================================

export const createProductSchema = z
  .object({
    ...inputFields,

    product_code: productFields.product_code,
    product_name: productFields.product_name,
    slug: productFields.slug,

    product_type: productFields.product_type.default('simple'),

    product_status: productStatusSchema.default('draft'),

    mrp: money.optional(),
    selling_price: money.optional(),
    cost_price: money.default(0),

    tax_rate: z.number().finite().min(0).max(100).default(0),

    initial_inventory: initialInventorySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const mrp = data.mrp ?? data.regular_price ?? 0;

    const selling = data.selling_price ?? data.sale_price ?? mrp;

    if (
      data.mrp !== undefined &&
      data.regular_price !== undefined &&
      data.mrp !== data.regular_price
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['regular_price'],
        message: 'regular_price must match mrp',
      });
    }

    if (
      data.selling_price !== undefined &&
      data.sale_price !== undefined &&
      data.selling_price !== data.sale_price
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sale_price'],
        message: 'sale_price must match selling_price',
      });
    }

    if (selling > mrp) {
      ctx.addIssue({
        code: 'custom',
        path: ['selling_price'],
        message: 'selling_price cannot exceed mrp',
      });
    }
  });

// ======================================
// UPDATE PRODUCT
// PATCH /api/admin/products/:productId
// ======================================

export const updateProductSchema = z
  .object(inputFields)
  .strict()
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one field must be provided for an update',
  )
  .superRefine((data, ctx) => {
    if (
      data.mrp !== undefined &&
      data.regular_price !== undefined &&
      data.mrp !== data.regular_price
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['regular_price'],
        message: 'regular_price must match mrp',
      });
    }

    if (
      data.selling_price !== undefined &&
      data.sale_price !== undefined &&
      data.selling_price !== data.sale_price
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sale_price'],
        message: 'sale_price must match selling_price',
      });
    }

    // Controller must also validate prices against
    // existing database values when updating.
  });
