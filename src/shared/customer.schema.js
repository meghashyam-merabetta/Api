import { z } from 'zod';

export const customerPhone = z.string().regex(/^[6-9]\d{9}$/);
export const customerEmail = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
