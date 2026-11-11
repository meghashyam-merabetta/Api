import { z } from 'zod';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{1,40}$/);
const dateTime = z.iso.datetime({ offset: true });
const fields = {
  code,
  scope: z.enum(['labs', 'products', 'both']),
  percent: z.coerce.number().positive().max(100).multipleOf(0.01),
  max_discount_paise: z.coerce.number().int().positive().max(2147483647),
  active: z.boolean().optional(),
  starts_at: dateTime.optional(),
  ends_at: dateTime.nullable().optional(),
};
const validWindow = (value) =>
  !value.starts_at ||
  !value.ends_at ||
  new Date(value.ends_at) > new Date(value.starts_at);

export const createCouponSchema = z
  .object(fields)
  .strict()
  .refine(validWindow, {
    message: 'ends_at must be after starts_at',
    path: ['ends_at'],
  });
export const updateCouponSchema = z
  .object(fields)
  .omit({ code: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field')
  .refine(validWindow, { message: 'ends_at must be after starts_at', path: ['ends_at'] });
export const couponCodeParamsSchema = z.object({ code }).strict();
export const listCouponsQuerySchema = z
  .object({
    scope: z.enum(['labs', 'products', 'both']).optional(),
    active: z.enum(['true', 'false']).optional(),
    state: z.enum(['scheduled', 'current', 'expired']).optional(),
    search: z.string().trim().min(1).max(40).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
