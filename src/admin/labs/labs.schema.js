import { z } from 'zod';

const labId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and hyphens');
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #e26570');

const fields = {
  id: labId,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10000),
  rating: z.coerce.number().min(0).max(5).multipleOf(0.1),
  image: z.string().trim().min(1).max(500),
  color: hexColor,
  bg: hexColor,
  active: z.boolean(),
  city: z.string().trim().min(1).max(100),
  homeCollection: z.boolean(),
};

export const createLabSchema = z.object(fields).strict();

export const updateLabSchema = z
  .object(fields)
  .omit({ id: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');

export const labIdParamsSchema = z.object({ labId }).strict();

export const listLabsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    active: z.enum(['true', 'false']).optional(),
    homeCollection: z.enum(['true', 'false']).optional(),
    sort_by: z
      .enum(['id', 'name', 'city', 'rating', 'createdAt', 'updatedAt'])
      .default('name'),
    sort_order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
