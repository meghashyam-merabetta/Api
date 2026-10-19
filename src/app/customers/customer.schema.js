import { z } from 'zod';
import { ageFromBirthdate } from '../../shared/birthdate.js';
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
    houseNumber: z.string().trim().max(100).default(''),
    buildingName: z.string().trim().max(200).default(''),
    location: z
      .object({
        provider: z.literal('locationiq'),
        placeId: z.string().max(200),
        displayName: z.string().min(1).max(2000),
        latitude: z.number().min(-85).max(85),
        longitude: z.number().min(-180).max(180),
        address: z.record(z.string(), z.string()),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (address) => !address.location || !!address.houseNumber,
    'Enter your house / flat number.',
  );

export const savedAddressSchema = addressSchema.refine(
  (address) => !!address.location,
  'Select an area / locality before saving your address.',
);

export const familyMemberSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    relationship: z.enum(['Self', 'Mother', 'Father', 'Spouse', 'Grandparent', 'Other']),
    dateOfBirth: z
      .string()
      .refine(
        (value) => ageFromBirthdate(value) !== null,
        'Enter a valid birthdate (age 0 to 120 years, not in the future)',
      ),
    gender: z.enum(['Male', 'Female']),
    phone: z
      .union([customerPhone, z.literal('')])
      .optional()
      .default(''),
  })
  .strict()
  .transform((member) => ({ ...member, age: ageFromBirthdate(member.dateOfBirth) }));

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
    gender: z.enum(['Male', 'Female']),
    address: savedAddressSchema.optional(),
  })
  .strict();
