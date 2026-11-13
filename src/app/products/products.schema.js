import { z } from 'zod';
export const listQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().min(1).max(255).optional(),
    category_id: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const productParamsSchema = z
  .object({ id: z.string().trim().min(1).max(100) })
  .strict();
