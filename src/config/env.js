
import 'dotenv/config';
import { z } from 'zod';

const secret = z
  .string()
  .min(32)
  .refine((v) => !v.startsWith('replace-'), 'Generate a random secret');

const schema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    LOCATIONIQ_API_KEY: z.string().trim().default(''),
    REDCLIFFE_BASE_URL: z.string().trim().default(''),
    REDCLIFFE_API_KEY: z.string().trim().default(''),

    HDFC_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    HDFC_MERCHANT_ID: z.string().trim().default(''),
    HDFC_API_KEY: z.string().trim().default(''),
    HDFC_CLIENT_ID: z.string().trim().default(''),
    HDFC_RETURN_URL: z.string().trim().default(''),
    HDFC_WEBHOOK_USER: z.string().trim().default(''),
    HDFC_WEBHOOK_PASSWORD: z.string().default(''),

    ANDROID_MIN_BUILD: z.coerce.number().int().min(0).default(0),
    IOS_MIN_BUILD: z.coerce.number().int().min(0).default(0),

    ANDROID_STORE_URL: z
      .string()
      .trim()
      .default(
        'https://play.google.com/store/apps/details?id=com.merabetta.app',
      ),

    IOS_STORE_URL: z.string().trim().default(''),
<<<<<<< HEAD
    OTP_MODE: z.enum(['development', 'disabled', 'stpl', 'msg91']).default('disabled'),
    EMAIL_OTP_MODE: z.enum(['inherit', 'disabled', 'smtp']).default('inherit'),
    SMTP_HOST: z.string().trim().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().trim().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z.string().trim().default(''),
    MSG91_AUTH_KEY: z.string().trim().default(''),
    MSG91_TEMPLATE_ID: z.string().trim().default(''),
=======

    OTP_MODE: z
      .enum(['development', 'disabled', 'stpl'])
      .default('disabled'),

>>>>>>> a8d4ef8 (Fix product and category CRUD)
    STPL_BASE_URL: z.string().trim().default(''),
    STPL_USERNAME: z.string().trim().default(''),
    STPL_PASSWORD: z.string().default(''),
    STPL_SENDER_ID: z.string().trim().default(''),
    STPL_TEMPLATE_ID: z.string().trim().default(''),
    STPL_DLT_CONTENT_ID: z.string().trim().default(''),
    STPL_OTP_TEMPLATE: z.string().default(''),

    STPL_UNICODE: z
      .enum(['true', 'false'])
      .default('false'),

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
      .transform((v) => {
        const origins = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        // Wildcard means allow all origins.
        if (origins.includes('*')) {
          return ['*'];
        }

        return origins;
      })
      .pipe(
        z
          .array(
            z.union([
              z.literal('*'),
              z.url().refine(
                (v) => new URL(v).origin === v,
                'Use exact origins without paths',
              ),
            ]),
          )
          .min(1),
      ),

    COOKIE_SAME_SITE: z
      .enum(['lax', 'strict', 'none'])
      .default('lax'),

    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    LOG_LEVEL: z
      .enum([
        'fatal',
        'error',
        'warn',
        'info',
        'debug',
        'trace',
        'silent',
      ])
      .default('info'),
  })
  .superRefine((v, ctx) => {
    if (v.APP_JWT_SECRET === v.ADMIN_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        message: 'JWT secrets must differ',
      });
    }

    if (
      v.COOKIE_SAME_SITE === 'none' &&
      v.NODE_ENV !== 'production'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'SameSite=None requires production HTTPS',
      });
    }

    if (
      v.NODE_ENV === 'production' &&
      !v.ALLOWED_ORIGINS.includes('*') &&
      v.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Production origins require HTTPS',
      });
    }
  });

const result = schema.safeParse(process.env);

if (!result.success) {
  throw new Error(
    `Invalid environment: ${result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`,
  );
}

export const env = result.data;
