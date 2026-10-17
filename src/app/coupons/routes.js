import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{1,40}$/)
  .optional();
export async function activeCoupons(scope, transaction) {
  return sequelize.query(
    "SELECT code,scope,percent,max_discount_paise FROM coupons WHERE active AND scope IN (:scope,'both') AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now()) ORDER BY code",
    { replacements: { scope }, type: QueryTypes.SELECT, transaction },
  );
}
export async function resolveCoupon(code, scope, transaction) {
  if (!code) return null;
  const coupon = (await activeCoupons(scope, transaction)).find((c) => c.code === code);
  if (!coupon)
    throw new HttpError(
      422,
      'This coupon is invalid, expired or unavailable for this checkout.',
    );
  return coupon;
}
export const couponRoutes = [
  {
    method: 'get',
    path: '/coupons',
    query: z.object({ scope: z.enum(['labs', 'products']) }).strict(),
    handler: async (req, res) =>
      res.json({ data: await activeCoupons(req.validatedQuery.scope) }),
  },
];
