import { z } from 'zod';
import { catalogFields } from '../../shared/catalog-fields.js';
const token = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !value.includes(','), 'Each option must be a separate value');
const attribute = z
  .object({
    name: token,
    values: z
      .array(token)
      .min(1)
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        'Options must be unique',
      ),
  })
  .strict();
const attributeParams = z
  .object({ attributeId: z.coerce.number().int().positive() })
  .strict();
const productParams = z
  .object({ productId: z.coerce.number().int().positive() })
  .strict();
const variantParams = productParams.extend({
  variantId: z.coerce.number().int().positive(),
});
const pagination = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
const variant = z
  .object({
    sku: z.string().trim().min(1).max(100),
    variant_name: z.string().trim().min(1).max(200).nullable().optional(),
    barcode: z.string().trim().min(1).max(100).nullable().optional(),
    weight_grams: z.number().int().min(0).max(2147483647).nullable().optional(),
    attributes: z
      .record(token, token)
      .refine(
        (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20,
        'Provide 1–20 attributes',
      ),
    regular_price: catalogFields.regular_price,
    sale_price: catalogFields.sale_price,
    stock_quantity: catalogFields.stock_quantity,
    is_active: z.boolean().optional(),
  })
  .strict();
export const updateVariantAttributeSchema = attribute
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export const updateVariantSchema = variant
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export {
  attribute as createVariantAttributeSchema,
  attributeParams as variantAttributeParamsSchema,
  productParams as variantProductParamsSchema,
  variantParams as productVariantParamsSchema,
  pagination as listVariantQuerySchema,
  variant as createVariantSchema,
};
