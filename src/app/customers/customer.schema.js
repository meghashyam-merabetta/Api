import { z } from 'zod';
import { customerPhone, customerEmail } from '../../shared/customer.schema.js';

export const recordIdSchema = z.object({ id: z.uuid() }).strict();

export const addressSchema = z
  .object({
    line1: z.string().trim().min(5).max(200),
    line2: z.string().trim().max(200).default(''),
    landmark: z.string().trim().max(200).default(''),
    state: z.string().trim().min(2).max(100),
    city: z.string().trim().min(2).max(100),
    postalCode: z.string().regex(/^[1-9]\d{5}$/),
  })
  .strict();

export const familyMemberSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    relationship: z.enum(['Self', 'Mother', 'Father', 'Spouse', 'Grandparent', 'Other']),
    phone: z
      .union([customerPhone, z.literal('')])
      .optional()
      .default(''),
  })
  .strict();

function isValidBirthDate(value) {
  const date = new Date(value + 'T00:00:00Z');
  const today = new Date().toISOString().slice(0, 10);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= '1900-01-01' &&
    value <= today
  );
}

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: customerPhone,
    email: customerEmail,
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isValidBirthDate, 'Invalid date of birth'),
    gender: z.enum(['Female', 'Male', 'Other', 'Prefer not to say']),
    address: addressSchema,
  })
  .strict();
