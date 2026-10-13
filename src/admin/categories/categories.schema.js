
import { z } from 'zod';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  parent_category_id: z.coerce.number().int().positive().optional(),
}).strict();

export const categoryIdParamsSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
}).strict();

export const createCategorySchema = z.object({
  category_name: z.string().trim().min(1).max(255),
  category_image: z.string().trim().max(2048).nullable().optional(),
  parent_category_id: z.number().int().positive().nullable().optional(),
  description: z.string().trim().nullable().optional(),
}).strict();

export const updateCategorySchema = z.object({
  category_name: z.string().trim().min(1).max(255).optional(),
  category_image: z.string().trim().max(2048).nullable().optional(),
  parent_category_id: z.number().int().positive().nullable().optional(),
  description: z.string().trim().nullable().optional(),
})
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for an update',
  });