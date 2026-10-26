import { z } from 'zod';
import { catalogFields } from './catalog-fields.js';

const productStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    brand_id: z.coerce.number().int().positive().optional(),
    sort_by: z
      .enum(['product_id', 'product_name', 'product_code', 'sku'])
      .default('product_id'),
    sort_order: z.enum(['asc', 'desc']).default('asc'),
    category_id: z.coerce.number().int().positive().optional(),
    search: z.string().trim().min(1).max(255).optional(),
    product_status: productStatusSchema.optional(),
  })
  .strict();

export const productIdParamsSchema = z
  .object({
    productId: z.coerce.number().int().positive(),
  })
  .strict();

export const createProductSchema = z
  .object({
    ...catalogFields,
    product_name: z.string().trim().min(1).max(255),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    brand_id: z.number().int().positive().nullable().optional(),
    short_description: z.string().trim().nullable().optional(),
    description: z.string().trim().nullable().optional(),
    product_status: productStatusSchema.optional().default('draft'),
    category_ids: z.array(z.number().int().positive()).optional().default([]),
    primary_category_id: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.primary_category_id === null ||
      data.primary_category_id === undefined ||
      data.category_ids.includes(data.primary_category_id),
    {
      message: 'primary_category_id must be included in category_ids',
      path: ['primary_category_id'],
    },
  );

export const updateProductSchema = z
  .object({
    ...catalogFields,
    product_name: z.string().trim().min(1).max(255).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    short_description: z.string().trim().nullable().optional(),
    description: z.string().trim().nullable().optional(),
    product_status: productStatusSchema.optional(),
    category_ids: z.array(z.number().int().positive()).optional(),
    primary_category_id: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for an update',
  })
  .refine(
    (data) =>
      data.primary_category_id === null ||
      data.primary_category_id === undefined ||
      data.category_ids === undefined ||
      data.category_ids.includes(data.primary_category_id),
    {
      message: 'primary_category_id must be included in category_ids',
      path: ['primary_category_id'],
    },
  );

export const productImageParamsSchema = z
  .object({
    productId: z.coerce.number().int().positive(),
    imageId: z.coerce.number().int().positive(),
  })
  .strict();
