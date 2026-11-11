import { z } from 'zod';

const bannerKey = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, numbers, underscores, or hyphens');
const nullableText = (max) => z.string().trim().max(max).nullable();
const dateTime = z.iso.datetime({ offset: true });
const fields = {
  banner_key: bannerKey,
  page_name: z.string().trim().min(1).max(100),
  banner_name: z.string().trim().min(1).max(150),
  image_path: z.string().trim().min(1).max(2048),
  width_px: z.coerce.number().int().min(1).max(10000),
  height_px: z.coerce.number().int().min(1).max(10000),
  is_active: z.boolean().optional(),
  banner_type: z.string().trim().min(1).max(20).optional(),
  banner_description: nullableText(10000).optional(),
  cta_text: nullableText(100).optional(),
  link_url: nullableText(2048).optional(),
  mobile_image_path: nullableText(2048).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  display_order: z.coerce.number().int().min(0).max(2147483647).optional(),
  is_published: z.boolean().optional(),
  publish_start_at: dateTime.nullable().optional(),
  publish_end_at: dateTime.nullable().optional(),
};
const validWindow = (value) =>
  !value.publish_start_at ||
  !value.publish_end_at ||
  new Date(value.publish_end_at) > new Date(value.publish_start_at);

export const createBannerSchema = z
  .object(fields)
  .strict()
  .refine(validWindow, {
    message: 'publish_end_at must be after publish_start_at',
    path: ['publish_end_at'],
  });
export const updateBannerSchema = z
  .object(fields)
  .omit({ banner_key: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field')
  .refine(validWindow, {
    message: 'publish_end_at must be after publish_start_at',
    path: ['publish_end_at'],
  });
export const bannerKeyParamsSchema = z.object({ bannerKey }).strict();
export const listBannersQuerySchema = z
  .object({
    status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
    is_published: z.enum(['true', 'false']).optional(),
    is_active: z.enum(['true', 'false']).optional(),
    page_name: z.string().trim().min(1).max(100).optional(),
    search: z.string().trim().min(1).max(150).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    sort_by: z
      .enum(['banner_id', 'display_order', 'created_at', 'updated_at'])
      .default('display_order'),
    sort_order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
