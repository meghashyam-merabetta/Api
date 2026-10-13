
import { z } from 'zod';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  category_id: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(255).optional(),
}).strict();

export const productIdParamsSchema = z.object({
  productId: z.coerce.number().int().positive(),
}).strict();

export const createProductSchema = z.object({
  product_name: z.string().trim().min(1).max(255),
  prescription_required: z.boolean().optional().default(false),
  age_group: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
}).strict();

export const updateProductSchema = z.object({
  product_name: z.string().trim().min(1).max(255).optional(),
  prescription_required: z.boolean().optional(),
  age_group: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
})
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for an update',
  });