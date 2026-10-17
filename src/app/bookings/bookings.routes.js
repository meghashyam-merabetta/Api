import { z } from 'zod';
import { couponCodeSchema } from '../coupons/routes.js';
import * as controller from './bookings.controller.js';
import { addressSchema } from '../customers/customer.schema.js';
import { cancelBooking } from '../redcliffe-labs/status.js';
import { amendBooking } from '../redcliffe-labs/amendment.js';
import { downloadReport } from '../redcliffe-labs/reports.js';
export const bookingSchema = z
  .object({
    couponCode: couponCodeSchema,
    requestKey: z.string().min(10).max(100),
    memberId: z.uuid(),
    address: addressSchema,
    notes: z.string().trim().max(1000).default(''),
    collectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotId: z.string().regex(/^[1-9]\d{0,9}$/),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            quantity: z.literal(1),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine(
    (b) => new Set(b.items.map((i) => i.id)).size === b.items.length,
    'Duplicate tests',
  );
export const bookingRoutes = [
  {
    method: 'get',
    path: '/lab-bookings/:id/reports/:reportId',
    params: z.object({
      id: z.string().min(1).max(100),
      reportId: z.string().regex(/^[a-f0-9]{24}$/),
    }),
    handler: downloadReport,
  },
  {
    method: 'post',
    path: '/lab-bookings/:id/amend',
    params: z.object({ id: z.string().min(1).max(100) }).strict(),
    schema: z
      .object({
        requestKey: z.uuid(),
        memberId: z.uuid().optional(),
        testIds: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(50)
          .refine((ids) => new Set(ids).size === ids.length),
      })
      .strict(),
    handler: amendBooking,
  },
  {
    method: 'post',
    path: '/lab-bookings/:id/cancel',
    params: z.object({ id: z.string().min(1).max(100) }).strict(),
    schema: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
    handler: cancelBooking,
  },
  {
    method: 'get',
    path: '/lab-areas',
    query: z
      .object({ q: z.string().trim().min(2).max(100), labId: z.string().min(1).max(100) })
      .strict(),
    handler: controller.searchAreas,
  },
  { method: 'get', path: '/lab-bookings', handler: controller.listBookings },
  {
    method: 'post',
    path: '/lab-bookings',
    schema: bookingSchema,
    handler: controller.createBooking,
  },
];
