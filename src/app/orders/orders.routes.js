import { z } from 'zod';
import { couponCodeSchema } from '../coupons/routes.js';
import { addressSchema } from '../customers/customer.schema.js';
import { createOrder, getOrder, listOrders } from './orders.controller.js';
export const orderSchema = z
  .object({
    couponCode: couponCodeSchema,
    requestKey: z.string().min(10).max(100),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length),
    address: addressSchema,
    notes: z.string().trim().max(1000).default(''),
    coupon: z.literal(false).optional(),
  })
  .strict();
export const orderRoutes = [
  { method: 'post', path: '/orders', schema: orderSchema, handler: createOrder },
  { method: 'get', path: '/orders', handler: listOrders },
  {
    method: 'get',
    path: '/orders/:id',
    params: z.object({ id: z.string().regex(/^MB[a-f0-9]{18}$/) }),
    handler: getOrder,
  },
];
