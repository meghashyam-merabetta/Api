import { z } from 'zod';
const fields = {
  brand_name: z.string().trim().min(1).max(150),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(10000).nullable().optional(),
  image_url: z.url().nullable().optional(),
  is_active: z.boolean().optional(),
};
const create = z.object(fields).strict();
const update = create
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
const params = z.object({ brandId: z.coerce.number().int().positive() }).strict();
const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().min(1).max(150).optional(),
    is_active: z.enum(['true', 'false']).optional(),
    all: z.enum(['true', 'false']).optional(),
  })
  .strict();
export {
  create as createBrandSchema,
  update as updateBrandSchema,
  params as brandIdParamsSchema,
  query as listBrandsQuerySchema,
};
