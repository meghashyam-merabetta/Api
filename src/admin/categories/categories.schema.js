import { z } from 'zod';

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    roots_only: z.enum(['true', 'false']).optional(),
    parent_category_id: z.coerce.number().int().positive().optional(),
    search: z.string().trim().min(1).max(150).optional(),
    is_active: z.enum(['true', 'false']).optional(),
  })
  .strict()
  .refine(
    (data) =>
      !(data.roots_only === 'true' && data.parent_category_id !== undefined),
    {
      message: 'roots_only cannot be combined with parent_category_id',
      path: ['parent_category_id'],
    }
  );

export const categoryIdParamsSchema = z
  .object({
    categoryId: z.coerce.number().int().positive(),
  })
  .strict();

export const createCategorySchema = z
  .object({
    category_name: z.string().trim().min(1).max(150),
    slug: slugSchema,
    category_image: z.string().trim().nullable().optional(),
    parent_category_id: z.number().int().positive().nullable().optional(),
    description: z.string().trim().nullable().optional(),
    sort_order: z.number().int().min(0).optional().default(0),
    is_active: z.boolean().optional().default(true),
  })
  .strict();

export const updateCategorySchema = z
  .object({
    category_name: z.string().trim().min(1).max(150).optional(),
    slug: slugSchema.optional(),
    category_image: z.string().trim().nullable().optional(),
    parent_category_id: z.number().int().positive().nullable().optional(),
    description: z.string().trim().nullable().optional(),
    sort_order: z.number().int().min(0).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for an update',
  });

export const treeQuerySchema = z
  .object({ is_active: z.enum(['true', 'false']).optional() })
  .strict();