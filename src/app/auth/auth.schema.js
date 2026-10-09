import { z } from 'zod';
import { customerPhone, customerEmail } from '../../shared/customer.schema.js';

export const requestOtpSchema = z
  .object({
    method: z.enum(['phone', 'email']),
    contact: z.string().trim().max(254),
  })
  .strict()
  .transform((payload, context) => {
    const contactSchema = payload.method === 'phone' ? customerPhone : customerEmail;
    const result = contactSchema.safeParse(payload.contact);
    if (!result.success) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a valid mobile number or email',
      });
      return z.NEVER;
    }
    return { ...payload, contact: result.data };
  });

export const verifyOtpSchema = z
  .object({
    challengeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
    deviceInfo: z
      .object({
        platform: z.string().max(30),
        osVersion: z.string().max(100).optional(),
        model: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
