
import { z } from 'zod';

const identifier = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const optionalText = (max) =>
  z.string().trim().max(max).nullable().optional();

// Matches the team's new public.warehouses table.
const warehouseFields = {
  warehouse_code: z.string().trim().min(1).max(50),
  warehouse_name: z.string().trim().min(1).max(255),

  warehouse_type: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .optional(),

  contact_person: optionalText(150),
  contact_number: optionalText(20),

  email: z.email().max(150).nullable().optional(),

  address_line1: z.string().trim().nullable().optional(),
  address_line2: z.string().trim().nullable().optional(),

  city: optionalText(100),
  state: optionalText(100),

  country: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),

  pincode: optionalText(20),
  is_active: z.boolean().optional(),
};

// POST /api/admin/warehouses
export const createWarehouseSchema = z
  .object(warehouseFields)
  .strict();

// PATCH /api/admin/warehouses/:warehouseId
export const updateWarehouseSchema =
  createWarehouseSchema
    .partial()
    .refine(
      (input) => Object.keys(input).length > 0,
      'Provide at least one field',
    );

// URL parameter refers to warehouses.id.
export const warehouseParams = z
  .object({
    warehouseId: identifier,
  })
  .strict();

// GET /api/admin/warehouses
export const warehouseQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20),

    offset: z.coerce
      .number()
      .int()
      .min(0)
      .default(0),

    search: z
      .string()
      .trim()
      .min(1)
      .max(150)
      .optional(),

    is_active: z.enum(['true', 'false']).optional(),

    // Compatibility with existing CMS query filters.
    active: z.enum(['true', 'false']).optional(),
  })
  .strict()
  .refine(
    ({ is_active, active }) =>
      is_active === undefined ||
      active === undefined ||
      is_active === active,
    'active and is_active must match when both are supplied',
  );
