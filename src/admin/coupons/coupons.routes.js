import {
  createCoupon,
  deleteCoupon,
  getCoupon,
  listCoupons,
  updateCoupon,
} from './coupons.controller.js';
import {
  couponCodeParamsSchema,
  createCouponSchema,
  listCouponsQuerySchema,
  updateCouponSchema,
} from './coupons.schema.js';

export const couponRoutes = [
  { method: 'get', path: '/', query: listCouponsQuerySchema, handler: listCoupons },
  { method: 'post', path: '/', schema: createCouponSchema, handler: createCoupon },
  { method: 'get', path: '/:code', params: couponCodeParamsSchema, handler: getCoupon },
  {
    method: 'patch',
    path: '/:code',
    params: couponCodeParamsSchema,
    schema: updateCouponSchema,
    handler: updateCoupon,
  },
  {
    method: 'delete',
    path: '/:code',
    params: couponCodeParamsSchema,
    handler: deleteCoupon,
  },
];
