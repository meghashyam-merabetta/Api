import { z } from 'zod';
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const password = z
  .string()
  .min(12)
  .refine(
    (v) => Buffer.byteLength(v, 'utf8') <= 72,
    'Password must be at most 72 UTF-8 bytes',
  );
