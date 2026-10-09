import { z } from 'zod';
import { email, password } from '../../shared/schema.js';

export const recordIdSchema = z.object({ id: z.uuid() }).strict();

const permissionsSchema = z.array(z.string().trim().min(1).max(100)).max(100).default([]);

const approvalSchema = z
  .object({
    requireSuperAdminApproval: z.boolean().default(false),
  })
  .strict();

export const createAdminSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email,
    password,
    city: z.string().trim().min(2).max(100),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    state: z.string().trim().min(2).max(100),
    adminApproval: approvalSchema.default({ requireSuperAdminApproval: false }),
    permissions: permissionsSchema,
  })
  .strict();

export const updateAdminSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: email.optional(),
    city: z.string().trim().min(2).max(100).optional(),
    pincode: z
      .string()
      .regex(/^[1-9]\d{5}$/)
      .optional(),
    state: z.string().trim().min(2).max(100).optional(),
    adminApproval: z
      .object({ requireSuperAdminApproval: z.boolean() })
      .strict()
      .optional(),
    permissions: permissionsSchema.optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: password.optional(),
    newPassword: password,
  })
  .strict();

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
