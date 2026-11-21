import { z } from 'zod';
import { createProductSchema, updateProductSchema } from '../products/products.schema.js';

// PostgreSQL BIGINT identities must never pass through an unsafe JS number.
const identity = z
  .union([z.string().regex(/^[1-9]\d{0,18}$/), z.number().int().positive().safe()])
  .transform(String)
  .refine((value) => BigInt(value) <= 9223372036854775807n, 'ID exceeds BIGINT range');
const money = z.number().finite().min(0).max(9999999999.99).multipleOf(0.01);
const quantity = z.number().int().min(0).max(2147483647);
const token = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => s === s.trim(), 'Remove surrounding whitespace');
const attributes = z
  .record(token, token)
  .refine(
    (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 20,
    'Provide 1–20 variant attributes',
  );
const variantFields = {
  sku: z.string().trim().min(1).max(100),
  attributes,
  regular_price: money,
  sale_price: money.nullable().optional(),
  variant_name: z.string().trim().min(1).max(200).nullable().optional(),
  barcode: z.string().trim().min(1).max(100).nullable().optional(),
  weight_grams: quantity.nullable().optional(),
  stock_quantity: quantity.optional(),
  use_product_images: z.boolean().optional(),
  is_active: z.boolean().optional(),
};
const variant = z.object(variantFields).strict();
const newVariant = variant.superRefine((value, ctx) => {
  if (
    value.sale_price !== null &&
    value.sale_price !== undefined &&
    value.sale_price > value.regular_price
  )
    ctx.addIssue({
      code: 'custom',
      path: ['sale_price'],
      message: 'sale_price cannot exceed regular_price',
    });
});
const variantPatch = z.union([
  variant.partial().extend({ id: identity }).strict(),
  newVariant,
]);

export const variableProductParamsSchema = z.object({ id: identity }).strict();
export const createVariableProductSchema = createProductSchema.safeExtend({
  product_type: z.literal('variable').default('variable'),
  // Variant stock belongs to public.product_variants, not parent inventory.
  initial_inventory: z.never().optional(),
  stock_quantity: z.never().optional(),
  variants: z.array(newVariant).min(1).max(500),
});
export const updateVariableProductSchema = updateProductSchema.safeExtend({
  product_type: z.literal('variable').optional(),
  stock_quantity: z.never().optional(),
  variants: z.array(variantPatch).min(1).max(500).optional(),
});
