import 'dotenv/config';
import { z } from 'zod';

const secret = z
  .string()
  .min(32)
  .refine((v) => !v.startsWith('replace-'), 'Generate a random secret');
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    OTP_MODE: z.enum(['development', 'disabled']).default('disabled'),
    LOG_API_PAYLOADS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    LOG_SQL: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    DB_HOST: z.string().trim().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().trim().min(1),
    DB_USER: z.string().trim().min(1),
    DB_PASSWORD: z.string(),
    DB_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    DB_SSL_CA_FILE: z.string().optional(),
    APP_JWT_SECRET: secret,
    ADMIN_JWT_SECRET: secret,
    ALLOWED_ORIGINS: z
      .string()
      .transform((v) => v.split(',').map((s) => s.trim()))
      .pipe(
        z
          .array(
            z
              .url()
              .refine((v) => new URL(v).origin === v, 'Use exact origins without paths'),
          )
          .min(1),
      ),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((v, ctx) => {
    if (v.APP_JWT_SECRET === v.ADMIN_JWT_SECRET)
      ctx.addIssue({ code: 'custom', message: 'JWT secrets must differ' });
    if (v.COOKIE_SAME_SITE === 'none' && v.NODE_ENV !== 'production')
      ctx.addIssue({
        code: 'custom',
        message: 'SameSite=None requires production HTTPS',
      });
    if (
      v.NODE_ENV === 'production' &&
      v.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Production origins require HTTPS',
      });
  });
const result = schema.safeParse(process.env);
if (!result.success)
  throw new Error(
    `Invalid environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  );
export const env = result.data;
