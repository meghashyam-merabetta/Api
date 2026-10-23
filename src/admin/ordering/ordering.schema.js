import { z } from 'zod';

const text = z.string().trim().min(1).max(150).optional();
export const orderingQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),


  status: text,
  bookingId: z.string().trim().regex(/^\d{1,100}$/).optional(),
  orderId: z.string().trim().regex(/^MB\d{11}$/).optional(),

  paymentMethod: z.enum(['online', 'cod']).optional(),

  labId: text,

  from: z.iso.date().optional(),
  to: z.iso.date().optional(),




}).strict().superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to)
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be on or after from' });
});
export const productParams = z.object({ id: z.string().regex(/^MB\d{11}$/) });
export const labParams = z.object({ id: z.string().regex(/^\d{1,100}$/) });
